import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Room, ROOM_IDLE_MS } from '../room.js';

// Phone fixtures use the reserved fictional +1 202-555-01xx range.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function stamp(value) { return typeof value === 'number' ? value : Date.parse(value); }

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
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; }
    catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function isolatedServer(t) {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-expiry-data-'));
  const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-expiry-records-'));
  let child;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await stopServer(child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(recordsDir, { recursive: true, force: true });
  });
  return {
    port, dataDir, recordsDir, sockets,
    async start() {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir },
        stdio: 'ignore'
      });
      await waitForServer(port, child);
    },
    async stop() { await stopServer(child); child = null; },
    async request(method, route, body, token) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    },
    async connect(code, token) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}`, {
        origin: `http://127.0.0.1:${port}`
      });
      const packets = [];
      socket.on('message', raw => packets.push(JSON.parse(String(raw))));
      const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
      sockets.push(socket);
      await once(socket, 'open');
      return { socket, packets, closed };
    }
  };
}

function snapshotPath(dataDir, code) { return path.join(dataDir, `${code}.json`); }
function readSnapshot(dataDir, code) { return JSON.parse(readFileSync(snapshotPath(dataDir, code), 'utf8')); }
async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('idle deadline tracks creation or the latest successful hand, and closure preserves an active hand', () => {
  assert.equal(ROOM_IDLE_MS, 86_400_000);
  const room = new Room('7501');
  const createdAt = stamp(room.createdAt);
  assert.equal(room.expiryAt(), createdAt + ROOM_IDLE_MS);
  const a = room.join('甲');
  const b = room.join('乙');
  room.sit(a, 0, 2000);
  room.sit(b, 1, 2000);
  assert.equal(room.expiryAt(), createdAt + ROOM_IDLE_MS, 'join and seating must not extend the deadline');
  room.nextHand(a);
  const handStartedAt = stamp(room.lastHandStartedAt);
  assert.ok(Math.abs(handStartedAt - Date.now()) < 2000);
  assert.equal(room.expiryAt(), handStartedAt + ROOM_IDLE_MS);
  const restored = Room.fromJSON(room.toJSON());
  assert.equal(restored.expiryAt(), room.expiryAt());
  const beforeHand = structuredClone(restored.hand);
  const beforeStacks = [...restored.members.values()].map(member => member.stack);
  assert.equal(restored.isExpired(restored.expiryAt() - 1), false);
  assert.equal(restored.isExpired(restored.expiryAt()), true);
  restored.markClosedInactive(restored.expiryAt());
  assert.equal(restored.closeReason, 'inactive');
  assert.equal(stamp(restored.closedAt), restored.expiryAt());
  assert.deepEqual(restored.hand, beforeHand, 'closing an in-progress hand must not settle or redeal it');
  assert.deepEqual([...restored.members.values()].map(member => member.stack), beforeStacks);
  assert.equal(Room.fromJSON(restored.toJSON()).closeReason, 'inactive');
});

test('startup closes legacy idle snapshots but protects a recent hand and preserves archived bytes',
  { timeout: 15000 }, async t => {
    const app = await isolatedServer(t);
    const idle = new Room('7502');
    const idleMember = idle.join('留在旧房');
    const idleSnapshot = idle.toJSON();
    idleSnapshot.createdAt = new Date(Date.now() - ROOM_IDLE_MS - 2000).toISOString();
    delete idleSnapshot.lastHandStartedAt;
    delete idleSnapshot.closedAt;
    delete idleSnapshot.closeReason;
    writeFileSync(snapshotPath(app.dataDir, idle.code), JSON.stringify(idleSnapshot), { mode: 0o600 });
    const recordFolder = path.join(app.recordsDir, idle.code);
    mkdirSync(recordFolder, { recursive: true, mode: 0o700 });
    const recordPath = path.join(recordFolder, '1.txt');
    const recordBytes = Buffer.from('private historic record\n', 'utf8');
    writeFileSync(recordPath, recordBytes, { mode: 0o600 });

    const recent = new Room('7503');
    const a = recent.join('A');
    const b = recent.join('B');
    recent.sit(a, 0, 2000);
    recent.sit(b, 1, 2000);
    recent.nextHand(a);
    const recentSnapshot = recent.toJSON();
    recentSnapshot.createdAt = new Date(Date.now() - ROOM_IDLE_MS - 2000).toISOString();
    delete recentSnapshot.lastHandStartedAt; // An old snapshot must recover from hand.startedAt.
    writeFileSync(snapshotPath(app.dataDir, recent.code), JSON.stringify(recentSnapshot), { mode: 0o600 });

    const interrupted = new Room('7505');
    const x = interrupted.join('X');
    const y = interrupted.join('Y');
    interrupted.sit(x, 0, 2000);
    interrupted.sit(y, 1, 2000);
    interrupted.nextHand(x);
    const interruptedSnapshot = interrupted.toJSON();
    interruptedSnapshot.hand.startedAt = new Date(Date.now() - ROOM_IDLE_MS - 2000).toISOString();
    delete interruptedSnapshot.lastHandStartedAt;
    const interruptedHand = structuredClone(interruptedSnapshot.hand);
    const interruptedStacks = interruptedSnapshot.members.map(member => [member.id, member.stack]);
    writeFileSync(snapshotPath(app.dataDir, interrupted.code), JSON.stringify(interruptedSnapshot), { mode: 0o600 });

    await app.start();
    const closed = readSnapshot(app.dataDir, idle.code);
    assert.equal(closed.closeReason, 'inactive');
    assert.ok(stamp(closed.closedAt) >= Date.now() - 5000);
    assert.equal((await app.request('POST', `/api/rooms/${idle.code}/join`, { nickname: '新人', phone: '+12025550101' })).status, 410);
    const live = await app.request('GET', `/api/rooms/${recent.code}/state`, undefined, a.token);
    assert.equal(live.status, 200, JSON.stringify(live.data));
    assert.equal(live.data.state.status, 'playing');
    assert.equal(readSnapshot(app.dataDir, recent.code).closeReason, null);
    const archivedInterrupted = readSnapshot(app.dataDir, interrupted.code);
    assert.equal(archivedInterrupted.closeReason, 'inactive');
    assert.equal(archivedInterrupted.status, 'playing');
    assert.deepEqual(archivedInterrupted.hand, interruptedHand, 'expiry must not settle an unfinished hand');
    assert.deepEqual(archivedInterrupted.members.map(member => [member.id, member.stack]), interruptedStacks);
    assert.deepEqual(readFileSync(recordPath), recordBytes);
    await app.stop();
    await app.start();
    assert.equal(readSnapshot(app.dataDir, idle.code).closeReason, 'inactive');
    assert.deepEqual(readFileSync(recordPath), recordBytes);
    assert.equal((await app.request('POST', '/api/rooms', { roomCode: idle.code, nickname: '新人', phone: '+12025550101' })).status, 409);
    assert.equal((await app.request('GET', `/api/rooms/${idle.code}/state`, undefined, idleMember.token)).status, 410);
  });

test('an automatically started hand renews the 24-hour deadline before the old one fires',
  { timeout: 10000 }, async t => {
    const app = await isolatedServer(t);
    const room = new Room('7506');
    const a = room.join('甲');
    const b = room.join('乙');
    room.sit(a, 0, 2000);
    room.sit(b, 1, 2000);
    room.createdAt = new Date(Date.now() - ROOM_IDLE_MS + 2000).toISOString();
    const oldExpiry = stamp(room.createdAt) + ROOM_IDLE_MS;
    room.nextHandAt = Date.now() + 300;
    writeFileSync(snapshotPath(app.dataDir, room.code), JSON.stringify(room.toJSON()), { mode: 0o600 });
    await app.start();
    let state;
    await within((async () => {
      do {
        const response = await app.request('GET', `/api/rooms/${room.code}/state`, undefined, a.token);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        state = response.data.state;
        if (state.handNo === 1) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (true);
    })(), 3000, 'automatic next hand did not start');
    assert.equal(state.status, 'playing');
    const afterStart = readSnapshot(app.dataDir, room.code);
    assert.ok(stamp(afterStart.lastHandStartedAt) >= oldExpiry - 2000);
    assert.ok(stamp(afterStart.lastHandStartedAt) + ROOM_IDLE_MS > oldExpiry);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, oldExpiry - Date.now() + 150)));
    const stillOpen = await app.request('GET', `/api/rooms/${room.code}/state`, undefined, b.token);
    assert.equal(stillOpen.status, 200, JSON.stringify(stillOpen.data));
    assert.equal(readSnapshot(app.dataDir, room.code).closeReason, null);
  });

test('near-expiry timer closes every WebSocket tab and rejects every endpoint without extending for join or money commands',
  { timeout: 20000 }, async t => {
    const app = await isolatedServer(t);
    const room = new Room('7504');
    const a = room.join('甲');
    const b = room.join('乙');
    const watcher = room.join('观众');
    room.sit(a, 0, 2000);
    room.sit(b, 1, 2000);
    room.nextHandAt = Date.now() + 60_000; // This fixture must not open a new hand before expiry.
    room.createdAt = new Date(Date.now() - ROOM_IDLE_MS + 5000).toISOString();
    writeFileSync(snapshotPath(app.dataDir, room.code), JSON.stringify(room.toJSON()), { mode: 0o600 });
    await app.start();
    const tabs = await Promise.all([
      app.connect(room.code, a.token), app.connect(room.code, a.token), app.connect(room.code, watcher.token)
    ]);
    const originalExpiry = stamp(readSnapshot(app.dataDir, room.code).createdAt) + ROOM_IDLE_MS;
    const lateJoin = await app.request('POST', `/api/rooms/${room.code}/join`, { nickname: '稍后加入', phone: '+12025550102' });
    assert.equal(lateJoin.status, 200);
    const rebuy = await app.request('POST', `/api/rooms/${room.code}/command`, {
      type: 'rebuy', amount: 2000, requestId: randomUUID()
    }, a.token);
    assert.equal(rebuy.status, 200, JSON.stringify(rebuy.data));
    const gift = await app.request('POST', `/api/rooms/${room.code}/command`, {
      type: 'gift', recipientId: b.id, quantity: 1, requestId: randomUUID()
    }, a.token);
    assert.equal(gift.status, 200, JSON.stringify(gift.data));
    const afterCommands = readSnapshot(app.dataDir, room.code);
    assert.equal(stamp(afterCommands.createdAt) + ROOM_IDLE_MS, originalExpiry);
    assert.equal(afterCommands.lastHandStartedAt, null);
    const stacksAtClosure = afterCommands.members.filter(member => member.seat !== null)
      .map(member => [member.id, member.stack]);
    const privateFiles = readdirSync(path.join(app.recordsDir, room.code, 'transactions'));
    const privateContents = privateFiles.map(file => [file,
      readFileSync(path.join(app.recordsDir, room.code, 'transactions', file))]);

    const closed = await within(Promise.all(tabs.map(tab => tab.closed)), 8000,
      'room did not close on its original deadline');
    for (let index = 0; index < tabs.length; index++) {
      assert.equal(closed[index].code, 4004);
      const notice = tabs[index].packets.find(packet => packet.type === 'roomClosed');
      assert.ok(notice, 'every active tab and spectator must see roomClosed');
      assert.equal(notice.roomCode, room.code);
      assert.equal(notice.reason, 'inactive');
      assert.equal(notice.message, '房间连续 24 小时未开局，已自动关闭。');
    }
    const archived = readSnapshot(app.dataDir, room.code);
    assert.equal(archived.closeReason, 'inactive');
    assert.ok(stamp(archived.closedAt) >= originalExpiry);
    assert.ok(stamp(archived.closedAt) < originalExpiry + 1500, 'join and money commands must not move expiry');
    assert.deepEqual(archived.members.filter(member => member.seat !== null)
      .map(member => [member.id, member.stack]), stacksAtClosure);
    for (const [method, route, body, token] of [
      ['POST', `/api/rooms/${room.code}/join`, { nickname: '又一新人', phone: '+12025550103' }],
      ['GET', `/api/rooms/${room.code}/state`, undefined, a.token],
      ['GET', `/api/rooms/${room.code}/ledger`, undefined, a.token],
      ['GET', `/api/rooms/${room.code}/history`, undefined, a.token],
      ['POST', `/api/rooms/${room.code}/command`, { type: 'rebuy', amount: 2000, requestId: randomUUID() }, a.token]
    ]) {
      const response = await app.request(method, route, body, token);
      assert.equal(response.status, 410, `${method} ${route}: ${JSON.stringify(response.data)}`);
      assert.equal(response.data.errorCode, 'ROOM_CLOSED');
    }
    assert.equal((await app.request('POST', '/api/rooms', { roomCode: room.code, nickname: '甲', phone: '+12025550101' })).status, 409);
    await app.stop();
    await app.start();
    assert.equal(readSnapshot(app.dataDir, room.code).closeReason, 'inactive');
    assert.equal((await app.request('POST', `/api/rooms/${room.code}/join`, { nickname: '甲', phone: '+12025550101', token: a.token })).status, 410);
    assert.equal((await app.request('POST', '/api/rooms', { roomCode: room.code, nickname: '甲', phone: '+12025550101' })).status, 409);
    for (const [file, content] of privateContents) {
      assert.deepEqual(readFileSync(path.join(app.recordsDir, room.code, 'transactions', file)), content);
    }
  });
