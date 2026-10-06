import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Room } from '../room.js';
import { cardLabel } from '../engine.js';

// Phone fixtures use the reserved fictional +1 202-555-01xx range.
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
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch { /* Still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('server did not stop')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

function waitState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('state broadcast timed out')); }, 3000);
    function cleanup() { clearTimeout(timer); socket.off('message', onMessage); socket.off('close', onClose); }
    function onClose() { cleanup(); reject(new Error('socket closed before state')); }
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

async function waitUntil(read, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error('condition did not become true');
}

test('HTTP/WS privacy, rebuy, voluntary reveal and restart recovery', { timeout: 30000 }, async t => {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-integration-'));
  const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-records-'));
  let child;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(recordsDir, { recursive: true, force: true });
  });
  const startServer = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir },
      stdio: 'ignore'
    });
    await waitForServer(port, child);
  };
  const request = async (method, route, body, token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  const command = async (code, token, body) => {
    const result = await request('POST', `/api/rooms/${code}/command`, body, token);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.state;
  };
  const state = async (code, token) => {
    const result = await request('GET', `/api/rooms/${code}/state`, undefined, token);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data.state;
  };
  const connect = async (code, token) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}`, {
      origin: `http://127.0.0.1:${port}`
    });
    sockets.push(socket);
    const first = waitState(socket);
    await once(socket, 'open');
    await first;
    return socket;
  };

  await startServer();
  const created = await request('POST', '/api/rooms', { capacity: 4, nickname: '甲', phone: '+12025550101' });
  assert.equal(created.status, 201);
  const code = created.data.roomCode;
  assert.equal((await fetch(`http://127.0.0.1:${port}/data/${code}.json`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status, 404);
  const tokens = [];
  for (const [index, name] of ['甲', '乙', '旁观者'].entries()) {
    const joined = await request('POST', `/api/rooms/${code}/join`, { nickname: name, phone: `+1202555010${index + 1}` });
    assert.equal(joined.status, 200);
    tokens.push(joined.data.token);
  }
  const [a, b, observer] = tokens;
  await command(code, a, { type: 'sit', seat: 0, buyIn: 2000 });
  await command(code, b, { type: 'sit', seat: 1, buyIn: 2000 });
  const firstPlayerSocket = await connect(code, a);
  const secondPlayerSocket = await connect(code, a);
  const observerSocket = await connect(code, observer);
  for (let index = 0; index < 11; index++) {
    const joined = await request('POST', `/api/rooms/${code}/join`, {
      nickname: `观战${index + 1}`, phone: `+120255501${index + 20}`
    });
    assert.equal(joined.status, 200);
    await connect(code, joined.data.token);
  }
  assert.equal((await state(code, observer)).spectatorCount, 12);
  const nextBroadcast = waitState(observerSocket, value => value.status === 'playing');
  const firstPlayerBroadcast = waitState(firstPlayerSocket, value => value.status === 'playing');
  const secondPlayerBroadcast = waitState(secondPlayerSocket, value => value.status === 'playing');
  await command(code, a, { type: 'nextHand' });
  const watching = await nextBroadcast;
  const firstPlayerView = await firstPlayerBroadcast;
  const secondPlayerView = await secondPlayerBroadcast;
  assert.deepEqual(firstPlayerView.hero.cards, secondPlayerView.hero.cards);
  assert.equal(firstPlayerView.hero.seat, 0);
  assert.deepEqual(watching.hero.cards, []);
  assert.ok(watching.seats.every(seat => !seat?.shownCards));
  const aState = await state(code, a), bState = await state(code, b);
  assert.equal(aState.hero.cards.length, 2);
  assert.equal(bState.hero.cards.length, 2);
  assert.equal(new Set([...aState.hero.cards, ...bState.hero.cards]).size, 4);
  assert.equal(aState.seats[1].shownCards, null);
  assert.equal(bState.seats[0].shownCards, null);
  assert.equal((await request('GET', `/api/rooms/${code}/state`, undefined, 'x'.repeat(43))).status, 401);
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'action', action: 'fold' }, observer)).status, 400);
  const nonActor = aState.actingSeat === 0 ? b : a;
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'action', action: 'fold' }, nonActor)).status, 400);
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'reveal' }, a)).status, 400);

  const beforeRebuy = aState.seats[0].stack;
  const rebought = await command(code, a, { type: 'rebuy', amount: 2000, requestId: randomUUID() });
  assert.equal(rebought.seats[0].stack, beforeRebuy);
  assert.equal(rebought.seats[0].pendingRebuy, 2000);
  const actor = rebought.actingSeat;
  await command(code, tokens[actor], { type: 'action', action: 'fold' });
  const ended = await state(code, observer);
  assert.equal(ended.status, 'finished');
  assert.equal(ended.seats[0].pendingRebuy, 0);
  assert.equal(ended.seats[0].rebuyCount, 1);
  assert.equal(ended.seats[0].rebuyTotal, 2000);
  assert.ok(ended.seats.every(seat => !seat?.shownCards));
  const recordPath = path.join(recordsDir, code, `${ended.handNo}.txt`);
  const privateRecord = readFileSync(recordPath, 'utf8');
  assert.match(privateRecord, /开始时间 \(UTC\)/);
  assert.match(privateRecord, /公共牌：无/);
  assert.match(privateRecord, /逐条操作：/);
  assert.match(privateRecord, /小盲.*实际支付 10/);
  assert.match(privateRecord, /大盲.*实际支付 20/);
  assert.match(privateRecord, /弃牌.*实际支付 0/);
  assert.match(privateRecord, /结算：/);
  assert.ok(privateRecord.includes(`1 号位 甲：${aState.hero.cards.join(' ')}`));
  assert.ok(privateRecord.includes(`2 号位 乙：${bState.hero.cards.join(' ')}`));
  assert.ok(!privateRecord.includes(a) && !privateRecord.includes(b) && !privateRecord.includes(observer));
  const hiddenSeed = JSON.parse(readFileSync(path.join(dataDir, `${code}.json`), 'utf8')).hand.fair.seed;
  assert.ok(!privateRecord.includes(hiddenSeed));
  assert.equal(statSync(recordsDir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(recordsDir, code)).mode & 0o777, 0o700);
  assert.equal(statSync(recordPath).mode & 0o777, 0o600);
  assert.equal((await fetch(`http://127.0.0.1:${port}/hand-records/${code}/${ended.handNo}.txt`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/hand-records/${code}/${ended.handNo}.txt`)).status, 404);
  assert.ok(!JSON.stringify(ended).includes(bState.hero.cards.join(' ')));
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'reveal' }, observer)).status, 400);
  await command(code, a, { type: 'reveal' });
  const revealed = await state(code, observer);
  assert.deepEqual(revealed.seats[0].shownCards, aState.hero.cards);
  assert.equal(revealed.seats[1].shownCards, null);
  assert.equal(revealed.history.at(-1).shownHands.length, 1);

  const stackBefore = revealed.seats[0].stack;
  assert.equal(revealed.nextHandAt, ended.nextHandAt + 5000);
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'nextHand' }, a)).status, 400);
  const scheduledAt = revealed.nextHandAt;
  await stopServer(child);
  for (const socket of sockets) socket.terminate();
  await startServer();
  assert.equal(readFileSync(recordPath, 'utf8'), privateRecord);
  assert.equal((await state(code, a)).nextHandAt, scheduledAt);
  const second = await waitUntil(() => state(code, a), value => value.handNo === revealed.handNo + 1, 12_000);
  assert.equal(second.status, 'playing');
  assert.equal(second.seats[0].pendingRebuy, 0);
  assert.equal(second.seats[0].rebuyCount, 1);
  assert.equal(second.seats[0].rebuyTotal, 2000);
  assert.ok(second.seats[0].stack >= stackBefore - 20);
  assert.equal((await request('POST', `/api/rooms/${code}/command`,
    { type: 'reveal', handNo: revealed.handNo }, b)).status, 400);
  const pastReveal = await state(code, observer);
  assert.equal(pastReveal.history.find(record => record.handNo === revealed.handNo).shownHands.length, 1);
  assert.ok(pastReveal.seats.every(seat => !seat?.shownCards));
  const snapshot = { handNo: second.handNo, cards: second.hero.cards, root: second.fairness.deckRoot,
    actor: second.actingSeat, pot: second.pot };

  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(dataDir, `${code}.json`)).mode & 0o777, 0o600);
  await stopServer(child);
  for (const socket of sockets) socket.terminate();
  await startServer();
  const restored = await state(code, a);
  assert.equal(restored.status, 'playing');
  assert.equal(restored.handNo, snapshot.handNo);
  assert.deepEqual(restored.hero.cards, snapshot.cards);
  assert.equal(restored.fairness.deckRoot, snapshot.root);
  assert.equal(restored.actingSeat, snapshot.actor);
  assert.equal(restored.pot, snapshot.pot);
  const resumed = await request('POST', `/api/rooms/${code}/join`, { nickname: '甲', phone: '+12025550101', token: a });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.state.hero.seat, 0);
  assert.equal(readdirSync(dataDir).filter(name => name.endsWith('.json')).length, 1);
});

test('failed private record blocks the next hand and startup retries it before resuming', { timeout: 25000 }, async t => {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-record-retry-data-'));
  const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-record-retry-'));
  let child;
  t.after(async () => {
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(recordsDir, { recursive: true, force: true });
  });
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
    });
    await waitForServer(port, child);
  };
  const request = async (method, route, body, token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  await start();
  const created = await request('POST', '/api/rooms', { capacity: 4, nickname: '甲', phone: '+12025550101' });
  const code = created.data.roomCode;
  const a = (await request('POST', `/api/rooms/${code}/join`, { nickname: '甲', phone: '+12025550101' })).data.token;
  const b = (await request('POST', `/api/rooms/${code}/join`, { nickname: '乙', phone: '+12025550102' })).data.token;
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'sit', seat: 0, buyIn: 2000 }, a)).status, 200);
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'sit', seat: 1, buyIn: 2000 }, b)).status, 200);
  const started = await request('POST', `/api/rooms/${code}/command`, { type: 'nextHand' }, a);
  assert.equal(started.status, 200);
  const blockedFile = path.join(recordsDir, code, '1.txt');
  mkdirSync(blockedFile, { recursive: true });
  const actor = started.data.state.actingSeat === 0 ? a : b;
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'action', action: 'fold' }, actor)).status, 200);
  const blocked = await request('GET', `/api/rooms/${code}/state`, undefined, a);
  assert.equal(blocked.data.state.status, 'finished');
  assert.equal(blocked.data.state.nextHandAt, null);
  assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'nextHand' }, a)).status, 503);
  await stopServer(child);
  await start();
  const stillBlocked = await request('GET', `/api/rooms/${code}/state`, undefined, a);
  assert.equal(stillBlocked.data.state.handNo, 1);
  assert.equal(stillBlocked.data.state.nextHandAt, null);
  await stopServer(child);
  rmSync(blockedFile, { recursive: true, force: true });
  await start();
  const resumed = await request('GET', `/api/rooms/${code}/state`, undefined, a);
  assert.ok(resumed.data.state.nextHandAt > Date.now());
  assert.match(readFileSync(blockedFile, 'utf8'), /逐条操作：/);
  const next = await waitUntil(async () => (await request('GET', `/api/rooms/${code}/state`, undefined, a)).data.state,
    value => value.handNo === 2, 8000);
  assert.equal(next.status, 'playing');
});

test('upgraded in-progress hand logs old public events plus remaining actions without inventing missing historic cards',
  { timeout: 10000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-old-hand-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-old-hand-records-'));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    const oldHand = new Room('765432');
    const first = oldHand.join('老玩家甲'), second = oldHand.join('老玩家乙');
    oldHand.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
    oldHand.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
    oldHand.command(first.token, { type: 'nextHand' });
    const holeLines = oldHand.handPlayers().map(player =>
      `${player.hand.seat + 1} 号位 ${player.nickname}：${player.hand.hole.map(item => cardLabel(item.card)).join(' ')}`);
    delete oldHand.hand.recordVersion;
    delete oldHand.hand.actions;
    writeFileSync(path.join(dataDir, '765432.json'), JSON.stringify(oldHand.toJSON()));

    const missingHistoric = new Room('765433');
    const historicA = missingHistoric.join('旧甲'), historicB = missingHistoric.join('旧乙');
    missingHistoric.command(historicA.token, { type: 'sit', seat: 0, buyIn: 2000 });
    missingHistoric.command(historicB.token, { type: 'sit', seat: 1, buyIn: 2000 });
    missingHistoric.command(historicA.token, { type: 'nextHand' });
    const historicActor = missingHistoric.seatMember(missingHistoric.hand.actingSeat);
    missingHistoric.command(historicActor.token, { type: 'action', action: 'fold' });
    delete missingHistoric.hand.recordVersion;
    delete missingHistoric.hand.actions;
    missingHistoric.handPlayers()[0].hand.hole = [];
    writeFileSync(path.join(dataDir, '765433.json'), JSON.stringify(missingHistoric.toJSON()));

    child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
    });
    await waitForServer(port, child);
    assert.equal(existsSync(path.join(recordsDir, '765433', '1.txt')), false);
    const actor = oldHand.seatMember(oldHand.hand.actingSeat);
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/765432/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}` },
      body: JSON.stringify({ type: 'action', action: 'fold' })
    });
    assert.equal(response.status, 200);
    const text = readFileSync(path.join(recordsDir, '765432', '1.txt'), 'utf8');
    assert.match(text, /结构化操作不完整/);
    assert.match(text, /第 1 手开始/);
    assert.match(text, /弃牌.*实际支付 0/);
    for (const line of holeLines) assert.ok(text.includes(line));
    assert.ok(!text.includes(first.token) && !text.includes(second.token));
  });
