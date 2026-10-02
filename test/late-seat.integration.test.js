import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function waitUntil(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('condition did not become true');
}

function waitState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket update timed out')); }, 3000);
    function cleanup() { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose); }
    function onClose() { cleanup(); reject(new Error('socket closed')); }
    function onMessage(raw) {
      let packet;
      try { packet = JSON.parse(String(raw)); } catch { return; }
      if (packet.type !== 'state' || !predicate(packet.state)) return;
      cleanup(); resolve(packet.state);
    }
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

test('late arrivals can reserve and change a seat without joining the running hand, then receive cards next hand',
  { timeout: 18000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-late-seat-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-late-seat-records-'));
    let child, socket;
    t.after(async () => {
      socket?.terminate();
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
    });
    await waitForServer(port, child);
    const request = async (method, route, body, token) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    };
    const created = await request('POST', '/api/rooms', { capacity: 4 });
    assert.equal(created.status, 201);
    const code = created.data.roomCode;
    const tokens = [];
    for (const nickname of ['甲', '乙', '后到者']) {
      const joined = await request('POST', `/api/rooms/${code}/join`, { nickname });
      assert.equal(joined.status, 200);
      tokens.push(joined.data.token);
    }
    const [a, b, late] = tokens;
    const command = (token, body) => request('POST', `/api/rooms/${code}/command`, body, token);
    const state = async token => {
      const result = await request('GET', `/api/rooms/${code}/state`, undefined, token);
      assert.equal(result.status, 200);
      return result.data.state;
    };
    assert.equal((await command(a, { type: 'sit', seat: 0, buyIn: 2000 })).status, 200);
    assert.equal((await command(b, { type: 'sit', seat: 1, buyIn: 2000 })).status, 200);
    const opened = await command(a, { type: 'nextHand' });
    assert.equal(opened.status, 200);
    const before = opened.data.state;
    assert.equal(before.status, 'playing');
    assert.equal(before.pot, 30);
    const cardsA = before.hero.cards;
    const cardsB = (await state(b)).hero.cards;
    assert.equal(cardsA.length, 2);
    assert.equal(cardsB.length, 2);

    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${a}`, {
      origin: `http://127.0.0.1:${port}`
    });
    await once(socket, 'open');
    const seatBroadcast = waitState(socket, value => value.seats[2]?.nickname === '后到者');
    const firstSit = await command(late, { type: 'sit', seat: 2, buyIn: 1350 });
    assert.equal(firstSit.status, 200, JSON.stringify(firstSit.data));
    const notified = await seatBroadcast;
    assert.equal(notified.seats[2].stack, 1350);
    assert.equal(notified.seats[2].inHand, false);
    assert.equal(notified.seats[2].waitingNextHand, true);
    const lateView = firstSit.data.state;
    assert.equal(lateView.hero.seat, 2);
    assert.equal(lateView.hero.waitingNextHand, true);
    assert.deepEqual(lateView.hero.cards, []);
    assert.equal(lateView.hero.canAct, false);
    assert.equal(lateView.seats[2].totalCommit, 0);
    assert.equal(lateView.seats[2].shownCards, null);
    assert.equal(lateView.seats[0].shownCards, null);
    assert.equal(lateView.seats[1].shownCards, null);
    for (const key of ['handNo', 'pot', 'actingSeat', 'actionDeadline', 'dealerSeat',
      'smallBlindSeat', 'bigBlindSeat', 'currentBet']) assert.equal(lateView[key], before[key], key);
    assert.deepEqual(lateView.board, before.board);
    assert.deepEqual((await state(a)).hero.cards, cardsA);
    assert.deepEqual((await state(b)).hero.cards, cardsB);

    const stood = await command(late, { type: 'stand' });
    assert.equal(stood.status, 200, JSON.stringify(stood.data));
    assert.equal(stood.data.state.hero.seat, null);
    assert.equal(stood.data.state.seats[2], null);
    const afterMove = await command(late, { type: 'sit', seat: 3, buyIn: 2200 });
    assert.equal(afterMove.status, 200, JSON.stringify(afterMove.data));
    assert.equal(afterMove.data.state.hero.seat, 3);
    assert.equal(afterMove.data.state.hero.waitingNextHand, true);
    assert.deepEqual(afterMove.data.state.hero.cards, []);
    assert.equal(afterMove.data.state.seats[3].stack, 2200);
    assert.equal(afterMove.data.state.pot, before.pot);
    assert.equal(afterMove.data.state.actingSeat, before.actingSeat);
    assert.equal(afterMove.data.state.actionDeadline, before.actionDeadline);
    assert.equal((await command(late, { type: 'action', action: 'fold' })).status, 400);
    const ledger = afterMove.data.state.ledger.find(item => item.nickname === '后到者');
    assert.equal(ledger.buyInTotal, 3550);
    assert.equal(ledger.cashOutTotal, 1350);
    assert.equal(ledger.stack, 2200);
    assert.equal(ledger.profitLoss, 0);

    const actor = before.actingSeat === 0 ? a : b;
    assert.equal((await command(actor, { type: 'action', action: 'fold' })).status, 200);
    const ended = await state(late);
    assert.equal(ended.status, 'finished');
    assert.equal(ended.pot, 30);
    assert.equal(ended.seats[3].stack, 2200);
    const privateRecord = readFileSync(path.join(recordsDir, code, '1.txt'), 'utf8');
    assert.match(privateRecord, /4 号位 后到者：未发牌/);
    const next = await waitUntil(() => state(late), value => value.handNo === 2);
    assert.equal(next.status, 'playing');
    assert.equal(next.hero.seat, 3);
    assert.equal(next.hero.waitingNextHand, false);
    assert.equal(next.hero.cards.length, 2);
    assert.equal(next.seats[3].inHand, true);
    assert.equal(next.seats[next.smallBlindSeat].totalCommit, 10);
    assert.equal(next.seats[next.bigBlindSeat].totalCommit, 20);
    const nextA = await state(a), nextB = await state(b);
    assert.equal(new Set([...nextA.hero.cards, ...nextB.hero.cards, ...next.hero.cards]).size, 6);
  });
