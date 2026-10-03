#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Synthetic players only. Run against an isolated copy; public targets require
// an explicit flag. Tokens, private cards and server snapshots are never logged.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let baseURL, local = false, allowRemote = false, hands = 40;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--local') local = true;
  else if (arg === '--allow-remote') allowRemote = true;
  else if (arg === '--hands') hands = Number(args[++index]);
  else if (arg.startsWith('--hands=')) hands = Number(arg.slice(8));
  else if (arg === '--base-url') baseURL = args[++index];
  else if (arg === '--help') {
    console.log('Usage: node scripts/load-ten-players.mjs --local [--hands 40]\n'
      + '   or: node scripts/load-ten-players.mjs BASE_URL [--hands 40] [--allow-remote]\n'
      + 'Use an isolated test server. Real hand and runout timers are retained.');
    process.exit(0);
  } else if (!arg.startsWith('-') && !baseURL) baseURL = arg;
  else throw new Error('Unknown argument; use --help');
}
if (!Number.isInteger(hands) || hands < 1 || hands > 100) throw new Error('--hands must be between 1 and 100');
if (local && baseURL) throw new Error('--local cannot be combined with a base URL');
if (!local && !baseURL) throw new Error('Pass a base URL or --local; use --help');
if (baseURL) {
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !allowRemote) {
    throw new Error('External targets require --allow-remote. Use an isolated test copy.');
  }
  baseURL = url.origin;
}

const players = Array.from({ length: 10 }, (_, seat) => ({ seat, nickname: `LoadPlayer${seat + 1}`,
  token: '', socket: null, state: null, receipts: new Map() }));
const connections = [];
const metrics = { commands: [], broadcasts: [], stateBytes: [], health: [], totalWsBytes: 0,
  stateMessages: 0, privacyChecks: 0, conservationChecks: 0, reconnects: 0 };
let roomCode = '', child, tempRoot, fatal, phase = 'setup', healthRunning = false, healthTask;
let workerStartedAt = null, workerCompletedAt = null, runoutFinishedAt = null;
const startedAt = performance.now();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const round = value => Math.round(value * 100) / 100;

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = fraction => sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]) : null;
  return { count: sorted.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: pct(1) };
}

function transportSummary() {
  // Track every transport, including the two replaced connections. Node's
  // socket byte counter includes upgrade/control traffic; TLS cost is approximate.
  const approxWsTransportBytes = connections.reduce((sum, connection) => {
    const bytes = Math.max(connection.bytesRead, connection.socket._socket?.bytesRead || 0);
    assert.ok(Number.isSafeInteger(bytes) && bytes > 0, 'WebSocket transport byte counters must be available');
    return sum + bytes;
  }, 0);
  return { approxWsTransportBytes,
    approxWsTransportReductionPct: round(100 * (1 - approxWsTransportBytes / metrics.totalWsBytes)),
    webSocketCompression: { connections: connections.length,
      enabledConnections: connections.filter(connection => connection.extensions.includes('permessage-deflate')).length,
      negotiatedExtensions: [...new Set(connections.map(connection => connection.extensions || 'none'))] },
    transportEstimateNote: 'Inbound Node socket bytesRead across all connections; upgrade/control bytes included, precise TLS overhead excluded.' };
}

async function request(method, suffix, body, player, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseURL}${suffix}`, { method, signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(player?.token ? { Authorization: `Bearer ${player.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.message || data.error || 'request failed'}`);
    return data;
  } finally { clearTimeout(timer); }
}

function validateState(state) {
  assert.ok(Number.isSafeInteger(state.stateVersion), 'Every live state needs a version');
  const ledger = state.ledger || [];
  const supplied = ledger.reduce((sum, row) => sum + row.buyInTotal + row.rebuyTotal, 0);
  const held = ledger.reduce((sum, row) => sum + row.stack + row.cashOutTotal, 0)
    + (state.status === 'playing' ? state.pot : 0);
  assert.equal(held, supplied, 'Synthetic chips must be conserved');
  metrics.conservationChecks++;
  if (state.status === 'playing' && !state.runout) {
    for (const seat of state.seats.filter(Boolean)) {
      if (seat.playerId !== state.hero.playerId) {
        assert.ok(seat.shownCards === null, 'An opponent private hand must remain hidden before showdown');
        assert.equal(Object.hasOwn(seat, 'hole'), false, 'An opponent hole field must never leak');
      }
    }
    assert.equal(state.fairness.visibleCardProofs.length, state.board.length,
      'Only already public board cards may appear in live public proofs');
    assert.equal(Object.hasOwn(state.fairness, 'seed'), false, 'The dealing seed must stay private');
    metrics.privacyChecks++;
  }
}

async function probeHealth() {
  const start = performance.now(), during = phase;
  const data = await request('GET', '/api/health', undefined, undefined, 3000);
  assert.equal(data.ok, true, 'Health must stay responsive');
  metrics.health.push({ phase: during, ms: performance.now() - start });
}

async function connect(player) {
  const url = new URL('/ws', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('room', roomCode);
  url.searchParams.set('token', player.token);
  const socket = new WebSocket(url, { headers: { Origin: baseURL }, handshakeTimeout: 5000 });
  const connection = { socket, bytesRead: 0, extensions: '' };
  connections.push(connection);
  socket.once('open', () => { connection.extensions = socket.extensions || ''; });
  socket.once('close', () => { connection.bytesRead = socket._socket?.bytesRead || 0; });
  player.socket = socket;
  let resolveFirst, rejectFirst;
  const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  const timer = setTimeout(() => rejectFirst(new Error('Synthetic client initial state timed out')), 5000);
  socket.on('message', raw => {
    if (player.socket !== socket) return;
    metrics.totalWsBytes += raw.byteLength;
    try {
      const packet = JSON.parse(String(raw));
      if (packet.type === 'error') throw new Error('Synthetic WebSocket command error');
      if (packet.type !== 'state') return;
      const state = packet.state, at = performance.now();
      validateState(state);
      if (player.state) assert.ok(state.stateVersion >= player.state.stateVersion, 'WebSocket versions cannot go backwards');
      player.state = state;
      player.receipts.set(state.stateVersion, at);
      while (player.receipts.size > 80) player.receipts.delete(player.receipts.keys().next().value);
      metrics.stateMessages++;
      metrics.stateBytes.push(raw.byteLength);
      if (state.runout?.phase === 'calculating' && workerStartedAt === null) {
        workerStartedAt = at;
        phase = 'equity';
        void probeHealth().catch(error => { fatal ||= error; });
      }
      if (workerStartedAt !== null && workerCompletedAt === null && state.runout?.equity?.length === 10) {
        workerCompletedAt = at;
        phase = 'runout';
      }
      if (workerStartedAt !== null && state.status === 'finished' && runoutFinishedAt === null) runoutFinishedAt = at;
      clearTimeout(timer);
      resolveFirst(state);
    } catch (error) { fatal ||= error; clearTimeout(timer); rejectFirst(error); }
  });
  socket.on('error', () => {
    if (player.socket !== socket) return;
    const error = new Error('Synthetic client WebSocket transport failed');
    fatal ||= error;
    clearTimeout(timer);
    rejectFirst(error);
  });
  await first;
}

async function waitUntil(predicate, timeoutMs = 8000, description = 'state synchronization') {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (fatal) throw fatal;
    const result = predicate();
    if (result) return result;
    await sleep(15);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function synchronized(version, start) {
  await waitUntil(() => players.every(player => player.socket?.readyState === WebSocket.OPEN
    && player.state?.stateVersion >= version), 5000, 'all 10 WebSocket clients');
  if (start !== undefined) {
    for (const player of players) {
      const receivedAt = player.receipts.get(version)
        ?? [...player.receipts].find(([receivedVersion]) => receivedVersion > version)?.[1];
      assert.ok(receivedAt !== undefined, 'Every synthetic client receives an acknowledged version');
      metrics.broadcasts.push(Math.max(0, receivedAt - start));
    }
  }
}

async function command(player, body, measure = true) {
  const start = performance.now(), during = phase;
  const data = await request('POST', `/api/rooms/${roomCode}/command`, body, player);
  if (measure) metrics.commands.push({ phase: during, ms: performance.now() - start });
  validateState(data.state);
  await synchronized(data.state.stateVersion, measure ? start : undefined);
  return data.state;
}

function actionGuard(state) {
  return { handNo: state.handNo, streetIndex: state.streetIndex, actingSeat: state.actingSeat,
    actionDeadline: state.actionDeadline, currentBet: state.currentBet };
}

function latestState() {
  return players.map(player => player.state).filter(Boolean)
    .reduce((latest, state) => !latest || state.stateVersion > latest.stateVersion ? state : latest, null);
}

async function playHand(allIn = false) {
  let state = await waitUntil(() => {
    const latest = latestState();
    return latest?.status === 'playing' && !latest.runout ? latest : false;
  }, 10_000, 'the next real hand timer');
  const handNo = state.handNo;
  assert.equal(state.seats.filter(seat => seat?.inHand).length, 10, 'All 10 players participate');
  let actions = 0;
  while (state.status === 'playing' && !state.runout) {
    assert.equal(state.handNo, handNo, 'The hand cannot change before settlement');
    const player = players[state.actingSeat];
    assert.ok(player, 'A real client owns the acting seat');
    await synchronized(state.stateVersion);
    const own = player.state;
    assert.equal(own.hero.canAct, true, 'The acting client must be enabled');
    const action = allIn && own.hero.canRaise && own.hero.maxRaiseTo > own.currentBet
      ? { action: 'raise', amount: own.hero.maxRaiseTo }
      : { action: own.hero.toCall ? 'call' : 'check' };
    state = await command(player, { type: 'action', ...action, expectedAction: actionGuard(own) });
    actions++;
    assert.ok(actions <= 80, 'A passive or all-in hand must advance promptly');
  }
  if (!allIn) {
    assert.equal(state.status, 'finished', 'A normal passive hand reaches showdown');
    assert.equal(state.result.type, 'showdown');
  }
  return { state, actions };
}

async function reconnectTwo() {
  for (const player of [players[2], players[7]]) {
    const old = player.socket;
    player.socket = null;
    old.terminate();
  }
  await sleep(80);
  await Promise.all([connect(players[2]), connect(players[7])]);
  const data = await request('GET', `/api/rooms/${roomCode}/state`, undefined, players[0]);
  await synchronized(data.state.stateVersion);
  for (const player of [players[2], players[7]]) {
    assert.equal(player.state.hero.seat, player.seat, 'Reconnection preserves the original seat');
    assert.equal(player.state.handNo, data.state.handNo, 'Reconnection catches up to the current hand');
  }
  metrics.reconnects += 2;
}

async function startLocalServer() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'depu-ten-player-load-'));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
      DATA_DIR: path.join(tempRoot, 'data'), HAND_RECORDS_DIR: path.join(tempRoot, 'records') }, stdio: 'ignore' });
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Isolated test server exited during startup');
    try { if ((await request('GET', '/api/health')).ok) return; } catch { /* Starting. */ }
    await sleep(40);
  }
  throw new Error('Isolated test server did not become ready');
}

async function cleanupRoom() {
  if (!roomCode) return;
  // Temporary synthetic players leave the room unable to auto-start even if
  // cleanup begins during an unfinished test hand.
  for (const player of players.filter(player => player.token)) {
    try {
      const { state } = await request('GET', `/api/rooms/${roomCode}/state`, undefined, player);
      if (state.hero.seat !== null && !state.hero.sittingOut && !state.hero.pendingSitOut) {
        await request('POST', `/api/rooms/${roomCode}/command`, { type: 'sitOut' }, player);
      }
    } catch { /* Continue cleaning the other synthetic clients. */ }
  }
  const deadline = performance.now() + 35_000;
  while (performance.now() < deadline) {
    const { state } = await request('GET', `/api/rooms/${roomCode}/state`, undefined, players.find(player => player.token));
    if (state.status !== 'playing') {
      await Promise.allSettled(players.filter(player => player.token).map(async player => {
        const { state: own } = await request('GET', `/api/rooms/${roomCode}/state`, undefined, player);
        if (own.hero.seat !== null) await request('POST', `/api/rooms/${roomCode}/command`, { type: 'stand' }, player);
      }));
      return;
    }
    await sleep(100);
  }
  throw new Error('Synthetic room cleanup did not finish');
}

try {
  if (local) await startLocalServer();
  await probeHealth();
  healthRunning = true;
  healthTask = (async () => {
    while (healthRunning) {
      try { await probeHealth(); } catch (error) { fatal ||= error; }
      await sleep(200);
    }
  })();
  ({ roomCode } = await request('POST', '/api/rooms', { capacity: 10 }));
  for (const player of players) {
    const joined = await request('POST', `/api/rooms/${roomCode}/join`, { nickname: player.nickname });
    player.token = joined.token;
  }
  await Promise.all(players.map(connect));
  for (const player of players) {
    await command(player, { type: 'sit', seat: player.seat, buyIn: 2000 }, false);
    await command(player, { type: 'sitOut' }, false);
  }
  for (const player of players) await command(player, { type: 'return' }, false);
  await command(players[0], { type: 'nextHand' }, false);
  phase = 'normal';
  let normalActions = 0;
  for (let index = 0; index < hands; index++) {
    const completed = await playHand();
    normalActions += completed.actions;
    if (index === Math.floor(hands / 2)) await reconnectTwo();
    if ((index + 1) % 10 === 0 || index + 1 === hands) {
      console.log(JSON.stringify({ progress: 'normal-hands', completed: index + 1, actions: normalActions }));
    }
  }
  phase = 'all-in';
  const allIn = await playHand(true);
  assert.equal(allIn.state.streetIndex, 0, 'The all-in test starts before the flop');
  assert.ok(allIn.state.runout, 'Ten preflop all-ins enter the runout flow');
  // Preserve all 10 participants in this runout, but prevent a subsequent hand.
  for (const player of players) await command(player, { type: 'sitOut' }, false);
  await waitUntil(() => latestState()?.runout?.equity?.length === 10, 15_000, 'worker equity calculation');
  const equityState = latestState();
  assert.equal(equityState.runout.reason, 'multiway');
  assert.equal(equityState.runout.equityMethod, 'monteCarlo');
  assert.equal(round(equityState.runout.equity.reduce((sum, row) => sum + row.equityPct, 0)), 100);
  assert.ok(metrics.health.some(row => row.phase === 'equity'), 'Health responds while the CPU worker is calculating');
  await waitUntil(() => latestState()?.status === 'finished', 25_000, 'real 5 + 10 second runout timers');
  assert.ok(runoutFinishedAt - workerCompletedAt >= 14_500, 'Real runout timers are retained');
  phase = 'cleanup';
  for (const player of players) await command(player, { type: 'stand' }, false);
  const final = (await request('GET', `/api/rooms/${roomCode}/state`, undefined, players[0])).state;
  await synchronized(final.stateVersion);
  assert.ok(players.every(player => player.state.stateVersion === final.stateVersion), 'All 10 clients converge to the same final version');
  assert.equal(final.seats.filter(Boolean).length, 0, 'Synthetic players leave no active seats');
  assert.equal(final.nextHandAt, null, 'The test room cannot auto-start another hand');
  validateState(final);
  healthRunning = false;
  await healthTask;
  console.log(JSON.stringify({ result: 'PASS', players: 10, normalHands: hands, normalActions,
    allInActions: allIn.actions, reconnects: metrics.reconnects,
    elapsedSeconds: round((performance.now() - startedAt) / 1000),
    commandMs: distribution(metrics.commands.map(row => row.ms)),
    normalCommandMs: distribution(metrics.commands.filter(row => row.phase === 'normal').map(row => row.ms)),
    allInCommandMs: distribution(metrics.commands.filter(row => row.phase === 'all-in' || row.phase === 'equity').map(row => row.ms)),
    broadcastMs: distribution(metrics.broadcasts), stateMessageBytes: distribution(metrics.stateBytes),
    stateMessages: metrics.stateMessages, totalWsBytes: metrics.totalWsBytes, ...transportSummary(),
    healthMs: distribution(metrics.health.map(row => row.ms)),
    equityHealthMs: distribution(metrics.health.filter(row => row.phase === 'equity').map(row => row.ms)),
    workerMs: round(workerCompletedAt - workerStartedAt),
    runoutMs: round(runoutFinishedAt - workerCompletedAt), finalVersion: final.stateVersion,
    privacyChecks: metrics.privacyChecks, conservationChecks: metrics.conservationChecks,
    allClientsConverged: true, chipsConserved: true, opponentsHidden: true, seatsCleared: true }));
} catch (error) {
  let message = error.message;
  for (const player of players) if (player.token) message = message.replaceAll(player.token, '[redacted]');
  console.error(JSON.stringify({ result: 'FAIL', message }));
  process.exitCode = 1;
} finally {
  healthRunning = false;
  if (healthTask) await healthTask;
  try { await cleanupRoom(); } catch { console.error('Synthetic room cleanup incomplete'); process.exitCode = 1; }
  for (const player of players) { const socket = player.socket; player.socket = null; socket?.terminate(); }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}
