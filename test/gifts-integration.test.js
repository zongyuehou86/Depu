import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; }
    catch { /* Server is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

async function waitCount(items, count) {
  const deadline = Date.now() + 3000;
  while (items.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(items.length, count);
}

test('gifts are private or room-wide by count, preserve chips, log locally, pause only this room and replay WAL once',
  { timeout: 15000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gifts-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gifts-records-'));
    let child;
    const sockets = [];
    const start = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
      });
      await waitForServer(port, child);
    };
    const stop = async () => {
      if (child?.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    };
    t.after(async () => {
      for (const socket of sockets) socket.close();
      await stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    await start();
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
        if (packet.type === 'giftEffect') effects.push(packet);
      });
      sockets.push(socket);
      await once(socket, 'open');
      return effects;
    };
    const code = (await request('POST', '/api/rooms', { nickname: '甲', phone: '+12025550101' })).data.roomCode;
    const otherCode = (await request('POST', '/api/rooms', { nickname: '别桌', phone: '+12025550104' })).data.roomCode;
    const senderJoin = (await request('POST', `/api/rooms/${code}/join`, { nickname: '甲', phone: '+12025550101' })).data;
    const receiverJoin = (await request('POST', `/api/rooms/${code}/join`, { nickname: '乙', phone: '+12025550102' })).data;
    const observer = (await request('POST', `/api/rooms/${code}/join`, { nickname: '观众', phone: '+12025550103' })).data;
    const other = (await request('POST', `/api/rooms/${otherCode}/join`, { nickname: '别桌', phone: '+12025550104' })).data;
    const senderId = senderJoin.state.hero.playerId;
    const receiverId = receiverJoin.state.hero.playerId;
    const sender = senderJoin.token, receiver = receiverJoin.token;
    for (const [token, seat] of [[sender, 0], [receiver, 1]]) {
      const seated = await request('POST', `/api/rooms/${code}/command`, { type: 'sit', seat, buyIn: 10_000 }, token);
      assert.equal(seated.status, 200);
    }
    const senderEffects = await connect(code, sender);
    const receiverEffects = await connect(code, receiver);
    const watcherEffects = await connect(code, observer.token);
    const otherEffects = await connect(otherCode, other.token);
    const beforeGiftSnapshot = readFileSync(path.join(dataDir, `${code}.json`), 'utf8');
    const giftId = randomUUID();
    const gifted = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: receiverId, quantity: 2, requestId: giftId
    }, sender);
    assert.equal(gifted.status, 200, JSON.stringify(gifted.data));
    assert.equal(gifted.data.effect.scope, 'private');
    assert.equal(gifted.data.effect.cost, 100);
    assert.equal(gifted.data.state.seats[0].stack, 9900);
    assert.equal(gifted.data.state.seats[1].stack, 10100);
    await waitCount(senderEffects, 1);
    await waitCount(receiverEffects, 1);
    assert.deepEqual(senderEffects[0], gifted.data.effect);
    assert.deepEqual(receiverEffects[0], gifted.data.effect);
    assert.equal(watcherEffects.length, 0);
    assert.equal(otherEffects.length, 0);
    const duplicate = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: receiverId, quantity: 2, requestId: giftId
    }, sender);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.effect, undefined);
    assert.equal(duplicate.data.state.seats[0].stack, 9900);
    assert.equal(senderEffects.length, 1);

    const directory = path.join(recordsDir, code, 'transactions');
    const giftFile = readdirSync(directory).find(file => file.includes(`gift-${giftId}`));
    assert.ok(giftFile);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, giftFile)).mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(directory, giftFile), 'utf8'), /筹码转移：100/);

    // Simulate a crash after the durable write-ahead gift log but before snapshot commit.
    await stop();
    writeFileSync(path.join(dataDir, `${code}.json`), beforeGiftSnapshot, { mode: 0o600 });
    await start();
    const recovered = await request('GET', `/api/rooms/${code}/state`, undefined, sender);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.state.seats[0].stack, 9900);
    assert.equal(recovered.data.state.seats[1].stack, 10100);
    const replay = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: receiverId, quantity: 2, requestId: giftId
    }, sender);
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.state.seats[0].stack, 9900);

    const sneaked = await request('POST', `/api/rooms/${code}/command`, {
      type: 'sneak', requestId: randomUUID()
    }, observer.token);
    assert.equal(sneaked.status, 200);
    assert.deepEqual(sneaked.data.effect.messages, ['悄悄地进村', '打枪的不要']);
    const unloadId = randomUUID();
    const unloaded = await request('POST', `/api/rooms/${code}/command`, {
      type: 'unload', requestId: unloadId
    }, receiver);
    assert.equal(unloaded.status, 200);
    assert.equal(unloaded.data.state.seats[1].stack, 8100);
    assert.equal(unloaded.data.state.ledger.find(item => item.playerId === receiverId).cashOutTotal, 2000);
    const again = await request('POST', `/api/rooms/${code}/command`, { type: 'unload', requestId: unloadId }, receiver);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.state.seats[1].stack, 8100);

    const grand = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: receiverId, quantity: 99, requestId: randomUUID()
    }, sender);
    assert.equal(grand.status, 200, JSON.stringify(grand.data));
    assert.equal(grand.data.effect.scope, 'grand');
    assert.equal(grand.data.state.pause.endAt - grand.data.state.pause.startAt, 10_000);
    assert.deepEqual(grand.data.state.pause.effect, grand.data.effect);
    const blocked = await request('POST', `/api/rooms/${code}/command`, { type: 'nextHand' }, sender);
    assert.equal(blocked.status, 400);
    const unaffected = await request('GET', `/api/rooms/${otherCode}/state`, undefined, other.token);
    assert.equal(unaffected.data.state.pause, null);
  });

test('failed private gift log leaves chips and sequence unchanged', { timeout: 10000 }, async t => {
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gift-fail-data-'));
  const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gift-fail-records-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
      HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(recordsDir, { recursive: true, force: true });
  });
  await waitForServer(port, child);
  const request = async (method, route, body, token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  const code = (await request('POST', '/api/rooms', { nickname: '甲', phone: '+12025550101' })).data.roomCode;
  const a = (await request('POST', `/api/rooms/${code}/join`, { nickname: '甲', phone: '+12025550101' })).data;
  const b = (await request('POST', `/api/rooms/${code}/join`, { nickname: '乙', phone: '+12025550102' })).data;
  for (const [token, seat] of [[a.token, 0], [b.token, 1]]) {
    assert.equal((await request('POST', `/api/rooms/${code}/command`, { type: 'sit', seat, buyIn: 2000 }, token)).status, 200);
  }
  const roomDir = path.join(recordsDir, code);
  mkdirSync(roomDir, { mode: 0o700 });
  writeFileSync(path.join(roomDir, 'transactions'), 'blocked');
  const failed = await request('POST', `/api/rooms/${code}/command`, {
    type: 'gift', recipientId: b.state.hero.playerId, quantity: 1, requestId: randomUUID()
  }, a.token);
  assert.equal(failed.status, 503);
  const state = await request('GET', `/api/rooms/${code}/state`, undefined, a.token);
  assert.equal(state.data.state.seats[0].stack, 2000);
  assert.equal(state.data.state.seats[1].stack, 2000);
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, `${code}.json`), 'utf8')).transactionSeq, 0);
  assert.equal(existsSync(path.join(roomDir, 'transactions')), true);
});

test('WAL recovery restores a deferred grand gift and pays it only after the poker hand ends',
  { timeout: 22000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gift-finish-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-gift-finish-records-'));
    let child;
    const start = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
          HAND_RECORDS_DIR: recordsDir }, stdio: 'ignore'
      });
      await waitForServer(port, child);
    };
    const stop = async () => {
      if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    };
    t.after(async () => {
      await stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    await start();
    const request = async (method, route, body, token) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    };
    const code = (await request('POST', '/api/rooms', { nickname: '按钮', phone: '+12025550101' })).data.roomCode;
    const joined = [];
    for (const [index, nickname] of ['按钮', '赠送者', '接收者'].entries()) {
      joined.push((await request('POST', `/api/rooms/${code}/join`, { nickname, phone: `+1202555010${index + 1}` })).data);
    }
    for (const [seat, person] of joined.entries()) {
      const buyIn = 2000;
      assert.equal((await request('POST', `/api/rooms/${code}/command`,
        { type: 'sit', seat, buyIn }, person.token)).status, 200);
    }
    assert.equal((await request('POST', `/api/rooms/${code}/command`,
      { type: 'nextHand' }, joined[0].token)).status, 200);
    const folded = await request('POST', `/api/rooms/${code}/command`,
      { type: 'action', action: 'fold' }, joined[0].token);
    assert.equal(folded.status, 200);
    assert.equal(folded.data.state.actingSeat, 1);
    const snapshotBeforeFinance = readFileSync(path.join(dataDir, `${code}.json`), 'utf8');
    const rebuyId = randomUUID(), unloadId = randomUUID();
    assert.equal((await request('POST', `/api/rooms/${code}/command`,
      { type: 'rebuy', amount: 2000, requestId: rebuyId }, joined[1].token)).status, 200);
    assert.equal((await request('POST', `/api/rooms/${code}/command`,
      { type: 'unload', requestId: unloadId }, joined[1].token)).status, 200);
    const giftId = randomUUID();
    const sent = await request('POST', `/api/rooms/${code}/command`, {
      type: 'gift', recipientId: joined[2].state.hero.playerId, quantity: 99,
      roseType: 'redRose', requestId: giftId
    }, joined[1].token);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.state.status, 'playing');
    assert.equal(sent.data.effect.settlementPending, true);
    assert.equal(sent.data.state.hero.pendingRebuy, 2000);
    assert.equal(sent.data.state.hero.pendingUnload, 2000);
    assert.equal(sent.data.state.hero.pendingGiftSent, 4950);
    assert.equal(sent.data.state.seats[1].stack, folded.data.state.seats[1].stack);
    assert.equal(sent.data.state.seats[2].stack, folded.data.state.seats[2].stack);
    await stop();
    writeFileSync(path.join(dataDir, `${code}.json`), snapshotBeforeFinance, { mode: 0o600 });
    await start();
    const restored = await request('GET', `/api/rooms/${code}/state`, undefined, joined[0].token);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.state.status, 'playing');
    assert.equal(restored.data.state.pause.endAt, sent.data.effect.endAt);
    assert.equal(restored.data.state.hero.pendingRebuy, 0); // viewer is seat 0
    assert.equal(restored.data.state.pot, sent.data.state.pot);
    assert.equal(restored.data.state.seats[1].stack, sent.data.state.seats[1].stack);
    assert.equal(restored.data.state.seats[2].stack, sent.data.state.seats[2].stack);
    const own = await request('GET', `/api/rooms/${code}/state`, undefined, joined[1].token);
    assert.equal(own.data.state.hero.pendingRebuy, 2000);
    assert.equal(own.data.state.hero.pendingUnload, 2000);
    assert.equal(own.data.state.hero.pendingGiftSent, 4950);
    for (const repeated of [
      { type: 'rebuy', amount: 2000, requestId: rebuyId },
      { type: 'unload', requestId: unloadId },
      { type: 'gift', recipientId: joined[2].state.hero.playerId, quantity: 99, requestId: giftId }
    ]) {
      const retry = await request('POST', `/api/rooms/${code}/command`, repeated, joined[1].token);
      assert.equal(retry.data.duplicate, true);
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, sent.data.effect.endAt - Date.now() + 30)));
    const ended = await request('POST', `/api/rooms/${code}/command`,
      { type: 'action', action: 'fold' }, joined[1].token);
    assert.equal(ended.status, 200, JSON.stringify(ended.data));
    assert.equal(ended.data.state.status, 'finished');
    assert.equal(ended.data.state.hero.pendingGiftSent, 0);
    assert.ok(ended.data.state.nextHandAt >= sent.data.effect.endAt + 5000);
    assert.equal(ended.data.state.seats[1].stack, 1040);
    assert.equal(ended.data.state.hero.lastFinancialNotice.type, 'unloadCanceled');
    assert.equal(ended.data.state.hero.lastFinancialSettlement.autoRebuys[0].amount, 2000);
    assert.equal(ended.data.state.seats[1].rebuyTotal, 4000);
    const handRecord = readFileSync(path.join(recordsDir, code, '1.txt'), 'utf8');
    assert.match(handRecord, /本手礼物结算/);
    assert.match(handRecord, /手动补码.*2000/);
    assert.match(handRecord, /礼物不足自动补码.*2000/);
    assert.match(handRecord, /99 束红玫瑰，转移 4950 筹码/);
    assert.match(handRecord, /卸码.*取消/);
  });
