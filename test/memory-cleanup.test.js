import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    if (child.exitCode !== null) throw new Error(`probe server exited: ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; }
    catch { /* Waiting for the isolated server. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('probe server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

function makeProbeSource(source, directory) {
  assert.match(source, /const rooms = new Map\(\)/);
  assert.match(source, /const transactionIndex = new Map\(\)/);
  assert.match(source, /const expiryTimers = new Map\(\)/);
  // This file exists only in the test's temporary directory. The real server
  // source and its HTTP API are never changed or given a debug endpoint.
  const relocated = source
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.join(root, relative)).href)}`)
    .replace("from 'ws'", `from ${JSON.stringify(import.meta.resolve('ws'))}`)
    .replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(root)};`);
  assert.ok(relocated.includes(`const here = ${JSON.stringify(root)};`));
  const probe = `
const __testWeakRefs = new Map();
process.on('message', packet => {
  const answer = value => process.send({ id: packet.id, ...value });
  if (packet.kind === 'mark') {
    const room = rooms.get(packet.code);
    const index = transactionIndex.get(packet.code);
    const transaction = index && [...index.values()][0];
    if (!room || !index || !transaction) return answer({ ok: false });
    __testWeakRefs.set(packet.code, {
      room: new WeakRef(room), index: new WeakRef(index), transaction: new WeakRef(transaction)
    });
    return answer({ ok: true, indexedTransactions: index.size });
  }
  if (packet.kind === 'expireSoon') {
    const room = rooms.get(packet.code);
    if (!room) return answer({ ok: false });
    room.createdAt = new Date(Date.now() - 86400000 + packet.delayMs).toISOString();
    room.changed();
    return answer({ ok: true, expiryAt: room.expiryAt() });
  }
  if (packet.kind === 'collect') {
    const cycle = left => {
      if (left > 0) {
        global.gc();
        return setTimeout(() => cycle(left - 1), 20);
      }
      const refs = __testWeakRefs.get(packet.code);
      return answer({ ok: true,
        roomIndexed: rooms.has(packet.code),
        transactionIndexed: transactionIndex.has(packet.code),
        timersIndexed: [deadlines, nextHandTimers, pauseTimers, expiryTimers]
          .some(timers => timers.has(packet.code)),
        retained: {
          room: refs?.room.deref() !== undefined,
          index: refs?.index.deref() !== undefined,
          transaction: refs?.transaction.deref() !== undefined
        }
      });
    };
    return cycle(packet.cycles);
  }
});
`;
  const file = path.join(directory, 'instrumented-server.mjs');
  writeFileSync(file, `${relocated}\n${probe}`, { mode: 0o600 });
  return file;
}

test('closed rooms release Room and transaction objects while their archive remains immutable',
  { timeout: 20000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-memory-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-memory-records-'));
    const sourceDir = mkdtempSync(path.join(os.tmpdir(), 'poker-memory-probe-'));
    const source = readFileSync(path.join(root, 'server.js'), 'utf8');
    const probeFile = makeProbeSource(source, sourceDir);
    let child;
    const sockets = [];
    const pending = new Map();
    let nextProbeId = 0;
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await stopServer(child);
      for (const directory of [dataDir, recordsDir, sourceDir]) rmSync(directory, { recursive: true, force: true });
    });
    const start = async () => {
      child = spawn(process.execPath, ['--expose-gc', probeFile], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      });
      child.on('message', message => {
        const request = pending.get(message?.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.resolve(message);
      });
      await waitForServer(port, child);
    };
    const probe = message => new Promise((resolve, reject) => {
      const id = ++nextProbeId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`probe ${message.kind} timed out`)); }, 5000);
      pending.set(id, { resolve, timer });
      child.send({ ...message, id });
    });
    const request = async (method, route, body, token) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    };
    const connect = async (code, token) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}`, {
        origin: `http://127.0.0.1:${port}`
      });
      const packets = [];
      socket.on('message', raw => packets.push(JSON.parse(String(raw))));
      const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
      sockets.push(socket);
      await once(socket, 'open');
      return { socket, packets, closed };
    };

    await start();
    const code = '7801';
    assert.equal((await request('POST', '/api/rooms', { roomCode: code })).status, 201);
    const joinedA = await request('POST', `/api/rooms/${code}/join`, { nickname: '甲' });
    const joinedB = await request('POST', `/api/rooms/${code}/join`, { nickname: '乙' });
    assert.equal(joinedA.status, 200);
    assert.equal(joinedB.status, 200);
    const a = joinedA.data.token;
    const b = joinedB.data.token;
    const bId = joinedB.data.state.hero.playerId;
    for (const [token, seat] of [[a, 0], [b, 1]]) {
      assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'sit', seat, buyIn: 2000 }, token)).status, 200);
    }
    const gift = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: bId, quantity: 1, requestId: randomUUID()
    }, a);
    assert.equal(gift.status, 200, JSON.stringify(gift.data));
    const transactionDir = path.join(recordsDir, code, 'transactions');
    const transactionFiles = readdirSync(transactionDir);
    assert.equal(transactionFiles.length, 1);
    const transactionBytes = readFileSync(path.join(transactionDir, transactionFiles[0]));
    const tabs = await Promise.all([connect(code, a), connect(code, a), connect(code, b)]);
    const marked = await probe({ kind: 'mark', code });
    assert.equal(marked.ok, true);
    assert.equal(marked.indexedTransactions, 1);
    const expiry = await probe({ kind: 'expireSoon', code, delayMs: 2800 });
    assert.equal(expiry.ok, true);
    assert.ok(expiry.expiryAt > Date.now());
    assert.deepEqual(await Promise.all(tabs.map(tab => tab.closed)), [4004, 4004, 4004]);
    for (const tab of tabs) assert.equal(tab.packets.filter(packet => packet.type === 'roomClosed').length, 1);
    const archivePath = path.join(dataDir, `${code}.json`);
    const archiveBytes = readFileSync(archivePath);
    assert.equal(JSON.parse(archiveBytes).closeReason, 'inactive');
    await new Promise(resolve => setTimeout(resolve, 100));
    const collected = await probe({ kind: 'collect', code, cycles: 8 });
    assert.equal(collected.roomIndexed, false);
    assert.equal(collected.transactionIndexed, false);
    assert.equal(collected.timersIndexed, false);
    assert.deepEqual(collected.retained, { room: false, index: false, transaction: false },
      'closed room and its transaction objects should be collectable');
    for (const [method, route, body, token] of [
      ['POST', `/api/rooms/${code}/join`, { nickname: '新人' }],
      ['GET', `/api/rooms/${code}/state`, undefined, a],
      ['POST', `/api/rooms/${code}/command`, { type: 'rebuy', amount: 2000, requestId: randomUUID() }, a]
    ]) {
      const response = await request(method, route, body, token);
      assert.equal(response.status, 410);
      assert.equal(response.data.errorCode, 'ROOM_CLOSED');
    }
    assert.equal((await request('POST', '/api/rooms', { roomCode: code })).status, 409);
    await stopServer(child);
    child = null;
    await start();
    assert.equal((await request('POST', `/api/rooms/${code}/join`, { nickname: '重启后' })).status, 410);
    assert.equal((await request('POST', '/api/rooms', { roomCode: code })).status, 409);
    assert.deepEqual(readFileSync(archivePath), archiveBytes);
    assert.deepEqual(readFileSync(path.join(transactionDir, transactionFiles[0])), transactionBytes);
  });
