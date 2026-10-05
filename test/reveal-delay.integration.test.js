import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Room } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function waitUntil(read, predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(30);
  }
  throw new Error('condition did not become true');
}

function nextState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('state broadcast timed out')); }, 3000);
    const onClose = () => { cleanup(); reject(new Error('socket closed before state')); };
    const onMessage = raw => {
      const packet = JSON.parse(String(raw));
      if (packet.type !== 'state' || !predicate(packet.state)) return;
      cleanup(); resolve(packet.state);
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    }
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

async function fixture(t, { delay = 60_000, blockedRecord = false } = {}) {
  const room = new Room('584216');
  const players = ['甲', '乙'].map(name => room.join(name));
  players.forEach((player, seat) => room.command(player.token, { type: 'sit', seat, buyIn: 2000 }));
  room.command(players[0].token, { type: 'nextHand' });
  room.command(room.seatMember(room.hand.actingSeat).token, { type: 'action', action: 'fold' });
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-reveal-delay-data-'));
  const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-reveal-delay-records-'));
  const snapshotPath = path.join(dataDir, `${room.code}.json`);
  const recordPath = path.join(recordsDir, room.code, `${room.handNo}.txt`);
  if (blockedRecord) {
    mkdirSync(path.dirname(recordPath), { mode: 0o700 });
    writeFileSync(recordPath, 'invalid private hand record', { mode: 0o600 });
  }
  const port = await freePort();
  let child, logs = '';
  const sockets = [];
  const request = async (method, operation, body, player = players[0]) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/${operation}`, {
      method, headers: { Authorization: `Bearer ${player.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async player => {
    const response = await request('GET', 'state', undefined, player);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.state;
  };
  const command = async (player, body) => {
    const response = await request('POST', 'command', body, player);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data.state;
  };
  const stop = async () => {
    sockets.splice(0).forEach(socket => socket.terminate());
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    await waitUntil(async () => {
      assert.equal(child.exitCode, null, logs);
      try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; }
      catch { return false; }
    }, Boolean);
  };
  const connect = async player => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.code}&token=${player.token}`,
      { origin: `http://127.0.0.1:${port}` });
    sockets.push(socket);
    const initial = nextState(socket, () => true);
    await once(socket, 'open');
    await initial;
    return socket;
  };
  t.after(async () => {
    await stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(recordsDir, { recursive: true, force: true });
  });
  room.nextHandAt = Date.now() + delay;
  writeFileSync(snapshotPath, JSON.stringify(room.toJSON()), { mode: 0o600 });
  await start();
  return { room, players, request, command, state, connect, start, stop,
    snapshotPath, recordPath, saved: () => JSON.parse(readFileSync(snapshotPath, 'utf8')) };
}

test('WS reveal broadcasts and persists the extension, replaces the old timer, and survives restart',
  { timeout: 16_000 }, async t => {
    const f = await fixture(t, { delay: 2500 });
    const [first, second] = f.players;
    const a = await f.connect(first);
    const b = await f.connect(second);
    const original = (await f.state()).nextHandAt;
    const expected = original + 5000;
    const aUpdate = nextState(a, state => state.nextHandAt === expected);
    const bUpdate = nextState(b, state => state.nextHandAt === expected);
    a.send(JSON.stringify({ type: 'reveal', handNo: f.room.handNo }));
    const updates = await Promise.all([aUpdate, bUpdate]);
    assert.equal(updates[0].stateVersion, updates[1].stateVersion);
    assert.equal(updates[1].seats[0].shownCards.length, 2);
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
    assert.equal(f.saved().nextHandAt, expected);
    await sleep(Math.max(0, original + 100 - Date.now()));
    assert.equal((await f.state()).status, 'finished', 'the original timer cannot start the next hand');
    await f.stop();
    await f.start();
    assert.equal((await f.state()).nextHandAt, expected);
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
    const otherReveal = await f.command(second, { type: 'reveal', handNo: f.room.handNo });
    assert.equal(otherReveal.nextHandAt, expected);
    assert.equal((await f.request('POST', 'command', { type: 'reveal' }, first)).status, 400);
    assert.equal((await f.state()).nextHandAt, expected);
    const next = await waitUntil(() => f.state(), value => value.handNo === f.room.handNo + 1,
      Math.max(1000, expected - Date.now() + 2000));
    assert.equal(next.status, 'playing');
    assert.ok(Date.now() >= expected);
    assert.equal(f.saved().hand.voluntaryRevealHandled, false);
    assert.equal(f.saved().nextHandAt, null);
  });

test('a private-record failure stays held through reveal, restart, and a later reveal after repair',
  { timeout: 10_000 }, async t => {
    const f = await fixture(t, { blockedRecord: true });
    assert.equal((await f.state()).nextHandAt, null);
    const first = await f.command(f.players[0], { type: 'reveal', handNo: f.room.handNo });
    assert.equal(first.nextHandAt, null);
    assert.equal(f.saved().nextHandAt, null);
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
    await f.stop();
    await f.start();
    assert.equal((await f.state()).nextHandAt, null, 'the unresolved record failure still blocks startup');
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
    rmSync(f.recordPath);
    const second = await f.command(f.players[1], { type: 'reveal', handNo: f.room.handNo });
    assert.equal(second.nextHandAt, null, 'reveal does not resume the room when its record becomes writable');
    assert.equal(f.saved().nextHandAt, null);
    assert.match(readFileSync(f.recordPath, 'utf8'), /记录完毕/);
  });

test('snapshot-write failure never stores a half-applied extension and later persistence cannot stack it',
  { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const original = f.saved();
    const backup = `${f.snapshotPath}.saved`;
    renameSync(f.snapshotPath, backup);
    mkdirSync(f.snapshotPath);
    const failed = await f.request('POST', 'command', { type: 'reveal', handNo: f.room.handNo }, f.players[0]);
    assert.equal(failed.status, 500, 'the failed persistence must not be acknowledged as success');
    const durable = JSON.parse(readFileSync(backup, 'utf8'));
    assert.equal(durable.hand.voluntaryRevealHandled, false);
    assert.equal(durable.nextHandAt, original.nextHandAt);
    const live = await f.state();
    assert.equal(live.nextHandAt, original.nextHandAt + 5000,
      'existing mutation-before-persist semantics retain the full change in memory');
    assert.equal(live.seats[0].shownCards.length, 2);
    rmSync(f.snapshotPath, { recursive: true });
    renameSync(backup, f.snapshotPath);
    await f.command(f.players[1], { type: 'reveal', handNo: f.room.handNo });
    assert.equal(f.saved().nextHandAt, original.nextHandAt + 5000);
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
    await f.stop();
    await f.start();
    assert.equal((await f.state()).nextHandAt, original.nextHandAt + 5000);
    assert.equal(f.saved().hand.voluntaryRevealHandled, true);
  });
