import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('server did not become ready');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

test('spectator blind change applies next hand and survives HTTP restart without changing the previous record',
  { timeout: 12000 }, async t => {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-blinds-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-blinds-records-'));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });
    const start = async () => {
      child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore',
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
          DATA_DIR: dataDir, HAND_RECORDS_DIR: recordsDir } });
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
    const created = await request('POST', '/api/rooms', { capacity: 4 });
    assert.equal(created.status, 201);
    const code = created.data.roomCode;
    const tokens = [];
    for (const nickname of ['玩家甲', '玩家乙', '观众']) {
      const joined = await request('POST', `/api/rooms/${code}/join`, { nickname });
      assert.equal(joined.status, 200);
      tokens.push(joined.data.token);
    }
    const [first, second, spectator] = tokens;
    const command = (token, body) => request('POST', `/api/rooms/${code}/command`, body, token);
    const configured = await command(spectator, { type: 'setBigBlind', amount: 51 });
    assert.equal(configured.status, 200);
    assert.equal(configured.data.state.bigBlind, 51);
    assert.equal(configured.data.state.smallBlind, 25);
    assert.equal((await command(first, { type: 'sit', seat: 0, buyIn: 2000 })).status, 200);
    assert.equal((await command(second, { type: 'sit', seat: 1, buyIn: 2000 })).status, 200);
    const started = await command(first, { type: 'nextHand' });
    assert.equal(started.status, 200);
    assert.equal(started.data.state.handBigBlind, 51);
    assert.equal(started.data.state.handSmallBlind, 25);
    assert.equal(started.data.state.pot, 76);
    assert.equal(started.data.state.minRaiseTo, 102);
    const during = await command(spectator, { type: 'setBigBlind', amount: 37 });
    assert.equal(during.status, 400);
    assert.match(during.data.error, /当前手结束后才能调整大盲/);
    const folded = await command(first, { type: 'action', action: 'fold' });
    assert.equal(folded.status, 200);
    assert.equal(folded.data.state.status, 'finished');
    const after = await command(spectator, { type: 'setBigBlind', amount: 37 });
    assert.equal(after.status, 200);
    assert.equal(after.data.state.bigBlind, 37);
    assert.equal(after.data.state.handBigBlind, 51);
    const textBefore = readFileSync(path.join(recordsDir, code, '1.txt'), 'utf8');
    assert.match(textBefore, /本手盲注：小盲 25；大盲 51/);
    await stopServer(child);
    await start();
    const state = await request('GET', `/api/rooms/${code}/state`, undefined, spectator);
    assert.equal(state.status, 200);
    assert.equal(state.data.state.bigBlind, 37);
    assert.equal(state.data.state.smallBlind, 18);
    const history = await request('GET', `/api/rooms/${code}/history`, undefined, spectator);
    assert.equal(history.status, 200);
    assert.equal(history.data.items[0].smallBlind, 25);
    assert.equal(history.data.items[0].bigBlind, 51);
    assert.equal(readFileSync(path.join(recordsDir, code, '1.txt'), 'utf8'), textBefore);
  });
