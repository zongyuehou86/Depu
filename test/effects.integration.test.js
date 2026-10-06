import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function waitCount(items, count) {
  const deadline = Date.now() + 3000;
  while (items.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(items.length, count, 'expected room effect count');
}

test('Kelly/like effects reach only the current room, and do not replay on reconnect or failed commands',
  { timeout: 15000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-effects-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-effects-records-'));
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
    });
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.close();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
      }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
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
    const connect = async (code, token) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}`, {
        origin: `http://127.0.0.1:${port}`
      });
      const effects = [];
      socket.on('message', raw => {
        const packet = JSON.parse(String(raw));
        if (packet.type === 'roomEffect') effects.push(packet);
      });
      sockets.push(socket);
      await once(socket, 'open');
      return { socket, effects };
    };
    const roomA = (await request('POST', '/api/rooms', { nickname: '观众甲', phone: '+12025550101' })).data.roomCode;
    const roomB = (await request('POST', '/api/rooms', { nickname: '观众乙', phone: '+12025550102' })).data.roomCode;
    const observerA = (await request('POST', `/api/rooms/${roomA}/join`, { nickname: '观众甲', phone: '+12025550101' })).data.token;
    const observerB = (await request('POST', `/api/rooms/${roomB}/join`, { nickname: '观众乙', phone: '+12025550102' })).data.token;
    const a = await connect(roomA, observerA);
    const b = await connect(roomB, observerB);

    const joined = await request('POST', `/api/rooms/${roomA}/join`, { nickname: 'KeLlY', phone: '+12025550103', enter: true });
    assert.equal(joined.status, 200);
    assert.equal(joined.data.effect.trigger, 'join');
    assert.equal(joined.data.effect.style, 'fireworks');
    assert.equal(joined.data.effect.text, '欢迎可可姐');
    assert.equal(joined.data.effect.roomCode, roomA);
    assert.equal(joined.data.effect.seat, null);
    await waitCount(a.effects, 1);
    assert.deepEqual(a.effects[0], joined.data.effect);
    assert.equal(b.effects.length, 0);

    const kelly = joined.data.token;
    const own = await connect(roomA, kelly);
    assert.equal(own.effects.length, 0, 'welcome comes in join response before first socket');
    const duplicate = await request('POST', `/api/rooms/${roomA}/join`, { nickname: 'KeLlY', phone: '+12025550103', token: kelly, enter: true });
    assert.equal(duplicate.data.effect, undefined, 'a second tab does not cause another welcome');
    const refreshed = await request('GET', `/api/rooms/${roomA}/state`, undefined, kelly);
    assert.equal(refreshed.data.effect, undefined);

    const sit = await request('POST', `/api/rooms/${roomA}/command`, { type: 'sit', seat: 0, buyIn: 2000 }, kelly);
    assert.equal(sit.status, 200);
    assert.equal(sit.data.effect.trigger, 'sit');
    assert.equal(sit.data.effect.style, 'pixel');
    assert.equal(sit.data.effect.text, '收手吧Kelly🥹');
    assert.equal(sit.data.effect.seat, 0);
    await waitCount(a.effects, 2);
    await waitCount(own.effects, 1);
    assert.deepEqual(a.effects[1], sit.data.effect);
    assert.deepEqual(own.effects[0], sit.data.effect);
    assert.equal(b.effects.length, 0);

    const badSit = await request('POST', `/api/rooms/${roomA}/command`, { type: 'sit', seat: 1 }, kelly);
    assert.equal(badSit.status, 400);
    const badRebuy = await request('POST', `/api/rooms/${roomA}/command`, { type: 'rebuy', amount: 0 }, kelly);
    assert.equal(badRebuy.status, 400);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(a.effects.length, 2);
    assert.equal(own.effects.length, 1);

    const rebuy = await request('POST', `/api/rooms/${roomA}/command`, { type: 'rebuy', amount: 2000, requestId: randomUUID() }, kelly);
    assert.equal(rebuy.status, 200);
    assert.equal(rebuy.data.effect.trigger, 'rebuy');
    await waitCount(a.effects, 3);
    await waitCount(own.effects, 2);
    assert.deepEqual(a.effects[2], rebuy.data.effect);
    assert.equal(b.effects.length, 0);

    const secondView = await connect(roomA, kelly);
    assert.equal(secondView.effects.length, 0, 'opening another view is not an entry event');
    own.socket.send(JSON.stringify({ type: 'rebuy', amount: 2000, requestId: randomUUID() }));
    await waitCount(a.effects, 4);
    await waitCount(own.effects, 3);
    await waitCount(secondView.effects, 1);
    assert.equal(a.effects[3].trigger, 'rebuy');
    assert.deepEqual(secondView.effects[0], a.effects[3]);
    own.socket.send(JSON.stringify({ type: 'rebuy', amount: 0, requestId: randomUUID() }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(a.effects.length, 4, 'failed WebSocket command does not trigger an effect');

    own.socket.close();
    await once(own.socket, 'close');
    secondView.socket.close();
    await once(secondView.socket, 'close');
    const reconnect = await connect(roomA, kelly);
    assert.equal(reconnect.effects.length, 0, 'plain WebSocket reconnect does not welcome');
    assert.equal(a.effects.length, 4);
    reconnect.socket.close();
    await once(reconnect.socket, 'close');
    const reentered = await request('POST', `/api/rooms/${roomA}/join`, {
      nickname: 'KeLlY', phone: '+12025550103', token: kelly, enter: true
    });
    assert.equal(reentered.status, 200);
    assert.equal(reentered.data.effect, undefined, 'unchanged lobby reentry does not welcome an offline guest again');
    const rapidRepeat = await request('POST', `/api/rooms/${roomA}/join`, {
      nickname: 'KeLlY', phone: '+12025550103', token: kelly, enter: true
    });
    assert.equal(rapidRepeat.status, 200);
    assert.equal(rapidRepeat.data.effect, undefined, 'unchanged double-entry does not replay a welcome');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(a.effects.length, 4, 'unchanged entries never broadcast welcome effects');

    const like = await request('POST', `/api/rooms/${roomA}/join`, { nickname: 'LiKe', phone: '+12025550104', enter: true });
    assert.equal(like.data.effect.text, '欢迎可可姐');
    await waitCount(a.effects, 5);
    const plain = await request('POST', `/api/rooms/${roomA}/join`, { nickname: 'Kelly #2', phone: '+12025550105', enter: true });
    assert.equal(plain.data.effect, undefined, 'only exact requested special nicknames count');
    const state = await request('GET', `/api/rooms/${roomA}/state`, undefined, observerA);
    assert.ok(!JSON.stringify(state.data.state.events).includes('欢迎可可姐'));
    assert.ok(!JSON.stringify(state.data.state.events).includes('收手吧Kelly'));
    assert.equal(b.effects.length, 0);
  });
