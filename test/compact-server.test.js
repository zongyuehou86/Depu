import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { verifyCardProof } from '../engine.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function packet(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('packet timed out')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timeout); socket.off('message', receive); socket.off('error', fail); };
    const fail = error => { cleanup(); reject(error); };
    const receive = raw => {
      const value = JSON.parse(String(raw));
      if (predicate(value)) { cleanup(); resolve(value); }
    };
    socket.on('message', receive);
    socket.on('error', fail);
  });
}

async function fixture(t) {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'poker-compact-'));
  const dataDir = path.join(directory, 'data');
  const recordsDir = path.join(directory, 'records');
  // Instrument only a disposable test copy. No debug routes, heartbeat knobs,
  // or fake sockets are introduced into the production server.
  let source = readFileSync(path.join(root, 'server.js'), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.join(root, relative)).href)}`)
    .replace("from 'ws'", `from ${JSON.stringify(import.meta.resolve('ws'))}`)
    .replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(root)};`);
  assert.ok(source.includes('const WS_HEARTBEAT_MS = 30_000;'));
  source = source.replace('const WS_HEARTBEAT_MS = 30_000;', 'const WS_HEARTBEAT_MS = 150;');
  source += `\nprocess.on('message', message => {
    if (message.kind !== 'bufferProbe') return;
    let sent = 0, terminated = 0;
    const fake = { readyState: WebSocket.OPEN, bufferedAmount: message.buffered,
      terminate() { terminated++; }, send(packet, callback) { sent++; callback(null); } };
    const accepted = sendSocketPacket(fake, 'x'.repeat(message.bytes));
    process.send({ id: message.id, sent, terminated, accepted });
  });\n`;
  const sourceFile = path.join(directory, 'test-server.mjs');
  writeFileSync(sourceFile, source);
  let stderr = '';
  const child = spawn(process.execPath, [sourceFile], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, HAND_RECORDS_DIR: recordsDir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', data => { stderr += data; });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* Starting. */ }
    if (ready) break;
    await delay(30);
  }
  assert.ok(ready, stderr);
  const request = async (route, { method = 'GET', body, token, origin } = {}) => {
    const response = await fetch(`${base}${route}`, { method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const { data: { roomCode: code } } = await request('/api/rooms', { method: 'POST', body: { capacity: 4 } });
  const api = `/api/rooms/${code}`;
  const join = async nickname => {
    const joined = await request(`${api}/join?compact=1`, { method: 'POST', body: { nickname } });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.state.compact, true);
    return joined.data.token;
  };
  const connect = async (token, { compact = true, autoPong = true } = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}${compact ? '&compact=1' : ''}`,
      { origin: base, autoPong });
    sockets.push(socket);
    const initial = await packet(socket, value => value.type === 'state');
    return { socket, state: initial.state };
  };
  return { child, request, join, connect, api, dataDir, code, base, port };
}

test('compact HTTP and WS preserve legacy API; on-demand history/proofs retain auth and privacy', { timeout: 15000 }, async t => {
  const { request, join, connect, api, dataDir, code, port } = await fixture(t);
  const tokens = [await join('甲'), await join('乙')];
  const observer = await join('旁观者');
  const command = async (token, body) => {
    const response = await request(`${api}/command?compact=1`, { method: 'POST', token, body });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.state.compact, true);
    assert.equal(Object.hasOwn(response.data.state, 'history'), false);
    return response.data.state;
  };
  await command(tokens[0], { type: 'sit', seat: 0, buyIn: 2000 });
  await command(tokens[1], { type: 'sit', seat: 1, buyIn: 2000 });
  const playing = await command(tokens[0], { type: 'nextHand' });
  assert.equal(playing.fairness.visibleCardCount, 0);
  const { socket, state: watching } = await connect(observer);
  const { state: legacy } = await connect(observer, { compact: false });
  assert.equal(watching.compact, true);
  assert.equal(Object.hasOwn(watching, 'history'), false);
  assert.ok(Array.isArray(legacy.history));
  assert.ok(Array.isArray(legacy.fairness.visibleCardProofs));
  assert.deepEqual(watching.hero.cards, []);
  assert.ok(watching.seats.every(seat => !seat?.shownCards));
  for (const route of [`${api}/fairness`, `${api}/history`, `${api}/state?compact=1`]) {
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, { token: 'x'.repeat(43) })).status, 401);
    assert.equal((await request(route, { token: observer, origin: 'https://evil.example' })).status, 403);
  }
  for (const [token, origin, status] of [[observer, 'https://evil.example', 403], ['x'.repeat(43), undefined, 401]]) {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}&compact=1`, { origin });
    const [error] = await once(denied, 'error');
    assert.match(error.message, new RegExp(String(status)));
  }
  const hiddenProofs = await request(`${api}/fairness?handNo=${playing.handNo}`, { token: tokens[0] });
  assert.deepEqual(hiddenProofs.data.fairness.visibleCardProofs, []);
  assert.equal((await request(`${api}/fairness?handNo=-1`, { token: observer })).status, 400);
  assert.equal((await request(`${api}/fairness?handNo=999`, { token: observer })).status, 404);
  const foldedToken = tokens[playing.actingSeat];
  const before = await command(foldedToken, { type: 'action', action: 'fold' });
  const revealedBroadcast = packet(socket, value => value.type === 'state' && value.state.fairness.visibleCardCount === 2);
  const after = await command(foldedToken, { type: 'reveal', handNo: playing.handNo });
  assert.notEqual(after.historyVersion, before.historyVersion);
  await revealedBroadcast;
  const proofResult = await request(`${api}/fairness?handNo=${playing.handNo}`, { token: observer });
  const fair = proofResult.data.fairness;
  assert.equal(fair.visibleCardProofs.length, 2);
  for (const proof of fair.visibleCardProofs) assert.ok(verifyCardProof(fair.deckRoot, proof));
  const history = await request(`${api}/history?offset=0&limit=1`, { token: observer });
  assert.equal(history.data.total, 1);
  assert.equal(history.data.items[0].shownHands.length, 1);
  assert.deepEqual(history.data.items[0].fairness, fair);
  const snapshot = JSON.parse(readFileSync(path.join(dataDir, `${code}.json`), 'utf8'));
  const serialized = JSON.stringify([watching, after, proofResult.data, history.data]);
  assert.ok(!serialized.includes(snapshot.hand.fair.seed));
  const hidden = snapshot.members.find(member => member.token !== foldedToken && member.hand);
  assert.ok(!fair.visibleCardProofs.some(proof => hidden.hand.hole.some(card => card.position === proof.position)));
  const next = await packet(socket, value => value.type === 'state' && value.state.handNo > playing.handNo, 8000);
  assert.ok(next.state.handNo > playing.handNo);
  assert.deepEqual((await request(`${api}/fairness?handNo=${playing.handNo}`, { token: observer })).data.fairness, fair);
});

test('financial success and duplicate responses honor compact mode without changing retry semantics', { timeout: 10000 }, async t => {
  const { request, join, api, dataDir, code } = await fixture(t);
  const first = await join('甲'), second = await join('乙');
  const command = async (token, body) => {
    const result = await request(`${api}/command?compact=1`, { method: 'POST', token, body });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.state.compact, true);
    assert.equal(Object.hasOwn(result.data.state, 'history'), false);
    if (result.data.state.fairness) assert.equal(Object.hasOwn(result.data.state.fairness, 'visibleCardProofs'), false);
    return result.data;
  };
  await command(first, { type: 'sit', seat: 0, buyIn: 2000 });
  await command(second, { type: 'sit', seat: 1, buyIn: 2000 });
  const { state } = await command(first, { type: 'nextHand' });
  for (const body of [
    { type: 'rebuy', amount: 2000 },
    { type: 'unload' },
    { type: 'gift', recipientId: state.seats[1].playerId, quantity: 1, roseType: 'whiteRose' },
    { type: 'sneak' }
  ]) {
    const payload = { ...body, requestId: randomUUID() };
    await command(first, payload);
    const snapshot = readFileSync(path.join(dataDir, `${code}.json`), 'utf8');
    const duplicate = await command(first, payload);
    assert.equal(duplicate.duplicate, true, body.type);
    assert.equal(readFileSync(path.join(dataDir, `${code}.json`), 'utf8'), snapshot, body.type);
  }
});

test('application heartbeat is mutation-free; native heartbeat evicts half-open peers and permits resync', { timeout: 10000 }, async t => {
  const { request, join, connect, api, dataDir, code } = await fixture(t);
  const token = await join('甲');
  const { socket } = await connect(token);
  const before = readFileSync(path.join(dataDir, `${code}.json`), 'utf8');
  const pong = packet(socket, value => value.type === 'pong');
  socket.send(JSON.stringify({ type: 'ping', nonce: 'probe-1' }));
  const reply = await pong;
  assert.equal(reply.nonce, 'probe-1');
  assert.ok(Number.isFinite(reply.serverTime));
  socket.send(JSON.stringify({ type: 'pong', nonce: 'unsolicited' }));
  await delay(30);
  assert.equal(readFileSync(path.join(dataDir, `${code}.json`), 'utf8'), before);
  const { socket: silent } = await connect(token, { autoPong: false });
  const [closeCode] = await once(silent, 'close');
  assert.equal(closeCode, 1006);
  assert.equal(socket.readyState, WebSocket.OPEN);
  const { state: resumed } = await connect(token);
  assert.equal(resumed.hero.playerId, (await request(`${api}/state?compact=1`, { token })).data.state.hero.playerId);
  const malformed = packet(socket, value => value.type === 'error');
  socket.send(JSON.stringify({ type: 'ping', nonce: 'x'.repeat(129) }));
  assert.match((await malformed).message, /心跳/);
});

test('slow-client send queues are bounded and healthy packets still send', { timeout: 10000 }, async t => {
  const { child } = await fixture(t);
  let id = 0;
  const probe = (buffered, bytes) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { cleanup(); reject(new Error('buffer probe timed out')); }, 3000);
    const cleanup = () => { clearTimeout(timeout); child.off('message', receive); };
    const receive = result => { if (result.id === requestId) { cleanup(); resolve(result); } };
    child.on('message', receive);
    child.send({ kind: 'bufferProbe', id: requestId, buffered, bytes });
  });
  for (const [buffered, bytes] of [[1024 * 1024 + 1, 1], [100, 1024 * 1024]]) {
    const result = await probe(buffered, bytes);
    assert.equal(result.accepted, false);
    assert.equal(result.sent, 0);
    assert.equal(result.terminated, 1);
  }
  const healthy = await probe(0, 1024);
  assert.equal(healthy.accepted, true);
  assert.equal(healthy.sent, 1);
  assert.equal(healthy.terminated, 0);
});
