import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cardLabel } from '../engine.js';
import { Room } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* Starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function waitUntil(read, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('condition did not become true');
}

async function firstWebSocketState(port, code, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}`, {
    headers: { Origin: `http://127.0.0.1:${port}` }
  });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket state timed out')), 3000);
      socket.on('message', raw => {
        let packet;
        try { packet = JSON.parse(String(raw)); } catch { return; }
        if (packet.type !== 'state') return;
        clearTimeout(timer);
        resolve(packet.state);
      });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed before state')); });
    });
  } finally { socket.terminate(); }
}

function twoPlayerVoteRoom(code) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const room = new Room(code);
    const a = room.join('甲'), b = room.join('乙'), observer = room.join('观战者');
    room.command(a.token, { type: 'sit', seat: 0, buyIn: 100 });
    room.command(b.token, { type: 'sit', seat: 1, buyIn: 100 });
    room.command(a.token, { type: 'nextHand' });
    room.command(a.token, { type: 'action', action: 'raise', amount: 100 });
    room.command(b.token, { type: 'action', action: 'call' });
    if (room.hand.runout?.eligibleForTwice) return { room, a, b, observer };
  }
  throw new Error('could not obtain a non-tied equity fixture');
}

test('runout vote deadline and staged card timer survive process restart without future card disclosure',
  { timeout: 18000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-timer-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-timer-records-'));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    const { room, observer } = twoPlayerVoteRoom('456781');
    const snapshotPath = path.join(dataDir, `${room.code}.json`);
    writeFileSync(snapshotPath, JSON.stringify(room.toJSON()));
    const originalDeadline = room.hand.runout.deadline;
    const deckRoot = room.hand.fair.deckRoot;
    const flop = room.hand.fair.deck.slice(room.hand.nextCard + 1, room.hand.nextCard + 4)
      .map(cardLabel);
    const turn = cardLabel(room.hand.fair.deck[room.hand.nextCard + 5]);
    const launch = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
      });
      await waitForServer(port, child);
    };
    const state = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/state`, {
        headers: { Authorization: `Bearer ${observer.token}` }
      });
      assert.equal(response.status, 200);
      return (await response.json()).state;
    };
    await launch();
    let view = await state();
    assert.equal(view.runout.phase, 'trailingVote');
    assert.equal(view.runout.deadline, originalDeadline);
    assert.equal(view.fairness.deckRoot, deckRoot);
    assert.equal(view.runout.boards[0].length, 0);
    assert.equal(view.fairness.visibleCardProofs.length, 4);
    assert.equal(view.runout.equityMethod, 'monteCarlo');
    assert.equal(view.runout.equitySamples, 20_000);
    for (const card of flop) assert.ok(!JSON.stringify(view).includes(`"${card}"`));
    assert.ok(!JSON.stringify(view).includes(`"${turn}"`));
    const socketVote = await firstWebSocketState(port, room.code, observer.token);
    assert.deepEqual(socketVote.runout.boards, [[]]);
    assert.equal(socketVote.fairness.visibleCardProofs.length, 4);
    for (const card of flop) assert.ok(!JSON.stringify(socketVote).includes(`"${card}"`));
    await stopServer(child);
    const timedOut = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    timedOut.hand.runout.deadline = Date.now() - 1;
    writeFileSync(snapshotPath, JSON.stringify(timedOut));
    await launch();
    view = await waitUntil(state, value => value.runout?.phase === 'dealing');
    assert.equal(view.runout.times, 1);
    assert.equal(view.runout.proposal, 1);
    assert.deepEqual(view.runout.boards[0], flop);
    assert.equal(view.fairness.visibleCardProofs.length, 7);
    assert.ok(view.runout.nextCardAt >= Date.now() + 4_500);
    assert.equal(view.fairness.deckRoot, deckRoot);
    assert.ok(!JSON.stringify(view).includes(`"${turn}"`));
    const socketFlop = await firstWebSocketState(port, room.code, observer.token);
    assert.deepEqual(socketFlop.runout.boards[0], flop);
    assert.ok(!JSON.stringify(socketFlop).includes(`"${turn}"`));
    await stopServer(child);
    const dueTurn = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    dueTurn.hand.runout.nextCardAt = Date.now() - 1;
    writeFileSync(snapshotPath, JSON.stringify(dueTurn));
    await launch();
    view = await waitUntil(state, value => value.runout?.boards?.[0]?.length === 4);
    assert.equal(view.runout.boards[0][3], turn);
    assert.ok(view.runout.nextCardAt >= Date.now() + 9_000);
    assert.equal(view.fairness.deckRoot, deckRoot);
  });

test('first-board pause survives restart and never publishes the second-board turn early',
  { timeout: 10000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-pause-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-pause-records-'));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    const { room, observer } = twoPlayerVoteRoom('456783');
    const trailing = room.seatMember(room.hand.runout.trailingSeat);
    const leading = room.seatMember(room.hand.runout.leadingSeat);
    room.command(trailing.token, { type: 'runoutChoice', times: 2 });
    room.command(leading.token, { type: 'runoutResponse', accept: true });
    for (let step = 0; step < 2; step++) {
      room.hand.runout.nextCardAt = Date.now() - 1;
      assert.equal(room.advanceRunoutIfDue(), true);
    }
    assert.equal(room.hand.runout.phase, 'firstBoardPause');
    const originalPauseEnd = room.hand.runout.nextCardAt;
    const secondFlopFirst = cardLabel(room.hand.fair.deck[room.hand.nextCard + 1]);
    const secondTurn = cardLabel(room.hand.fair.deck[room.hand.nextCard + 5]);
    const snapshotPath = path.join(dataDir, `${room.code}.json`);
    const recordPath = path.join(recordsDir, room.code, '1.txt');
    writeFileSync(snapshotPath, JSON.stringify(room.toJSON()));
    const launch = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
      });
      await waitForServer(port, child);
    };
    const state = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/state`, {
        headers: { Authorization: `Bearer ${observer.token}` }
      });
      assert.equal(response.status, 200);
      return (await response.json()).state;
    };
    await launch();
    let view = await state();
    assert.equal(view.status, 'playing');
    assert.equal(view.runout.phase, 'firstBoardPause');
    assert.equal(view.runout.nextCardAt, originalPauseEnd);
    assert.equal(view.runout.boardResults.length, 1);
    assert.deepEqual(view.runout.boards.map(board => board.length), [5, 0]);
    assert.ok(!JSON.stringify(view).includes(`"${secondFlopFirst}"`));
    assert.ok(!JSON.stringify(view).includes(`"${secondTurn}"`));
    assert.equal(existsSync(recordPath), false);

    await stopServer(child);
    const due = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    due.hand.runout.nextCardAt = Date.now() - 1;
    writeFileSync(snapshotPath, JSON.stringify(due));
    await launch();
    view = await waitUntil(state, value => value.runout?.boardIndex === 1);
    assert.equal(view.runout.phase, 'dealing');
    assert.equal(view.runout.boards[1].length, 3);
    assert.equal(view.runout.boardResults.length, 1);
    assert.ok(view.runout.nextCardAt >= Date.now() + 4_500);
    assert.equal(view.runout.boards[1][0], secondFlopFirst);
    assert.ok(!JSON.stringify(view).includes(`"${secondTurn}"`));
    assert.equal(existsSync(recordPath), false);
  });

test('recovered completed double run writes an idempotent private two-board settlement record',
  { timeout: 8000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-record-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-runout-records-'));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    const { room, observer } = twoPlayerVoteRoom('456782');
    const trailing = room.seatMember(room.hand.runout.trailingSeat);
    const leading = room.seatMember(room.hand.runout.leadingSeat);
    room.command(trailing.token, { type: 'runoutChoice', times: 2 });
    room.command(leading.token, { type: 'runoutResponse', accept: true });
    for (let step = 0; step < 5; step++) {
      room.hand.runout.nextCardAt = Date.now() - 1;
      assert.equal(room.advanceRunoutIfDue(), true);
    }
    assert.equal(room.status, 'finished');
    writeFileSync(path.join(dataDir, `${room.code}.json`), JSON.stringify(room.toJSON()));
    const launch = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
      });
      await waitForServer(port, child);
    };
    await launch();
    const recordPath = path.join(recordsDir, room.code, '1.txt');
    const text = readFileSync(recordPath, 'utf8');
    const result = room.hand.result;
    assert.ok(text.includes(`第 1 次公共牌：${result.boards[0].join(' ')}`));
    assert.ok(text.includes(`第 2 次公共牌：${result.boards[1].join(' ')}`));
    assert.match(text, /跑马：2 次/);
    assert.match(text, /分池 1 本次份额/);
    assert.match(text, /选择跑马次数/);
    assert.match(text, /回应跑马提议/);
    for (const member of room.members.values()) assert.ok(!text.includes(member.token));
    assert.ok(!text.includes(room.hand.fair.seed));
    assert.equal(statSync(path.join(recordsDir, room.code)).mode & 0o777, 0o700);
    assert.equal(statSync(recordPath).mode & 0o777, 0o600);
    const publicRead = await fetch(`http://127.0.0.1:${port}/hand-records/${room.code}/1.txt`);
    assert.equal(publicRead.status, 404);
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/state`, {
      headers: { Authorization: `Bearer ${observer.token}` }
    });
    assert.equal(response.status, 200);
    const view = (await response.json()).state;
    assert.deepEqual(view.result.boards, result.boards);
    assert.equal(view.history.at(-1).result.runouts.length, 2);
    await stopServer(child);
    await launch();
    assert.equal(readFileSync(recordPath, 'utf8'), text);
  });
