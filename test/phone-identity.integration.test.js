import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Room } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const phoneA = '+12025550101', phoneB = '+12025550102';

async function app(t, { legacy = null, inject = false } = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'phone-identity-'));
  const dataDir = path.join(temp, 'data'), records = path.join(temp, 'records');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir);
  if (legacy) writeFileSync(path.join(dataDir, `${legacy.code}.json`), JSON.stringify(legacy));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let child, output = '';
  const flag = path.join(temp, 'fail-directory-fsync');
  const loader = path.join(temp, 'fault.mjs');
  if (inject) writeFileSync(loader, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const originalWrite=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(String(file).startsWith(${JSON.stringify(dataDir)})&&String(file).endsWith('.tmp')&&fs.existsSync(${JSON.stringify(flag)})&&fs.readFileSync(${JSON.stringify(flag)},'utf8')==='before')throw new Error('injected precommit write failure');return originalWrite.call(fs,file,...args)};const orig=fs.fsyncSync;fs.fsyncSync=function(fd){if(fs.existsSync(${JSON.stringify(flag)})&&fs.fstatSync(fd).isDirectory())throw new Error('injected directory durability failure');return orig(fd)};syncBuiltinESMExports();await import(${JSON.stringify(pathToFileURL(path.join(root, 'server.js')).href)});`);
  const stop = async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } };
  const start = async () => {
    child = spawn(process.execPath, [inject ? loader : 'server.js'], { cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, HAND_RECORDS_DIR: records },
      stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`isolated server failed: ${output}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await pause(30);
    }
    throw new Error('isolated server did not start');
  };
  t.after(async () => { await stop(); rmSync(temp, { recursive: true, force: true }); });
  await start();
  const request = async (method, route, body, token) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, data: JSON.parse(text), text, bytes: Buffer.byteLength(text) };
  };
  const socket = async (code, token) => {
    const packets = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}&token=${token}&compact=1`);
    ws.on('message', data => { packets.push(JSON.parse(String(data))); });
    await once(ws, 'open');
    t.after(() => ws.terminate());
    return { ws, packets };
  };
  return { request, socket, start, stop, dataDir, records, flag, output: () => output };
}

function privateFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? privateFiles(path.join(directory, item.name)) : [readFileSync(path.join(directory, item.name), 'utf8')]);
}

test('HTTP phone identities create atomically, rename history, survive restart, and never expose phone', { timeout: 12000 }, async t => {
  const a = await app(t);
  assert.equal((await a.request('POST', '/api/rooms', { nickname: 'Missing phone' })).status, 400);
  assert.equal(readdirSync(a.dataDir).length, 0);
  const created = await a.request('POST', '/api/rooms?compact=1', { nickname: 'Old A', phone: phoneA });
  assert.equal(created.status, 201);
  assert.equal(created.data.state.hero.isOwner, true);
  assert.equal(Object.hasOwn(created.data.state, 'history'), false);
  const code = created.data.roomCode, token = created.data.token, id = created.data.state.hero.playerId;
  const base = `/api/rooms/${code}`;
  const b = await a.request('POST', `${base}/join?compact=1`, { nickname: 'Old B', phone: phoneB });
  for (const [seat, bearer] of [token, b.data.token].entries()) assert.equal((await a.request('POST', `${base}/command`, { type: 'sit', seat, buyIn: 2000 }, bearer)).status, 200);
  const started = await a.request('POST', `${base}/command`, { type: 'nextHand' }, token);
  const actor = started.data.state.actingSeat === 0 ? token : b.data.token;
  assert.equal((await a.request('POST', `${base}/command`, { type: 'action', action: 'fold' }, actor)).status, 200);
  for (const bearer of [token, b.data.token]) await a.request('POST', `${base}/command`, { type: 'sitOut' }, bearer);
  const archived = readFileSync(path.join(a.records, code, '1.txt'), 'utf8');
  const oldVersion = (await a.request('GET', `${base}/state?compact=1`, undefined, token)).data.state.stateVersion;
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => a.request('POST', `${base}/join?compact=1`, { nickname: 'Current A', phone: '0012025550101' })));
  assert.ok(concurrent.every(result => result.status === 200 && result.data.token === token && result.data.state.hero.playerId === id));
  assert.ok(concurrent.every(result => result.data.state.stateVersion === oldVersion + 1), 'one rename for twenty concurrent identical logins');
  const history = await a.request('GET', `${base}/history`, undefined, token);
  assert.equal(history.text.includes('Old A'), false);
  assert.equal(history.text.includes('Current A'), true);
  assert.equal(readFileSync(path.join(a.records, code, '1.txt'), 'utf8'), archived, 'private audit text is immutable');
  const before = await a.request('GET', `${base}/state?compact=1`, undefined, token);
  await a.stop(); await a.start();
  const resumed = await a.request('POST', `${base}/join?compact=1`, { nickname: 'Latest A', phone: phoneA });
  assert.equal(resumed.data.token, token);
  assert.equal(resumed.data.state.hero.playerId, id);
  assert.equal(resumed.data.state.hero.stack, before.data.state.hero.stack);
  assert.equal(resumed.data.state.hero.seat, 0);
  assert.equal(resumed.data.state.hero.isOwner, true);
  assert.notEqual(resumed.data.state.stateEpoch, before.data.state.stateEpoch);
  const serialized = JSON.stringify([created.data, b.data, resumed.data, history.data]);
  const snapshot = JSON.parse(readFileSync(path.join(a.dataDir, `${code}.json`), 'utf8'));
  assert.equal(snapshot.members.length, 2);
  for (const secret of [phoneA, phoneB, snapshot.phoneIdentity.key, ...snapshot.members.map(member => member.phoneKey)]) assert.equal(serialized.includes(secret), false);
  for (const text of [...privateFiles(a.dataDir), ...privateFiles(a.records), a.output()]) {
    assert.equal(text.includes(phoneA), false); assert.equal(text.includes(phoneB), false);
  }
});

test('legacy browser token binds safely and post-rename durability failure does not roll memory back', { timeout: 10000 }, async t => {
  const original = new Room('810201');
  const member = original.join('Legacy');
  original.command(member.token, { type: 'sit', seat: 0, buyIn: 2345 });
  const legacy = JSON.parse(JSON.stringify(original.toJSON()));
  delete legacy.phoneIdentity; delete legacy.displayIdentityVersion;
  const a = await app(t, { legacy, inject: true });
  const base = `/api/rooms/${original.code}`;
  assert.equal((await a.request('GET', `${base}/state`, undefined, member.token)).data.state.hero.needsPhone, true);
  writeFileSync(a.flag, 'fail');
  const failed = await a.request('POST', `${base}/join`, { nickname: 'New', phone: phoneA, token: member.token });
  assert.equal(failed.status, 503);
  const disk = JSON.parse(readFileSync(path.join(a.dataDir, `${original.code}.json`), 'utf8'));
  assert.equal(disk.members[0].nickname, 'New');
  const memory = await a.request('GET', `${base}/state`, undefined, member.token);
  assert.equal(memory.data.state.hero.nickname, 'New');
  assert.equal(memory.data.state.hero.needsPhone, false);
  assert.equal((await a.request('POST', `${base}/command`, { type: 'stand' }, member.token)).status, 503);
  rmSync(a.flag);
  const retry = await a.request('POST', `${base}/join`, { nickname: 'New', phone: phoneA });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.token, member.token);
  assert.equal(retry.data.state.hero.stack, 2345);
  assert.equal(retry.data.state.hero.isOwner, true);
  assert.equal(retry.data.state.hero.seat, 0);
});

test('same-player refresh storm is bounded, writes no snapshot/history and does not block another player', { timeout: 15000 }, async t => {
  const a = await app(t);
  const created = (await a.request('POST', '/api/rooms?compact=1', { nickname: 'Kelly', phone: phoneA })).data;
  const code = created.roomCode, base = `/api/rooms/${code}`, token = created.token;
  const other = (await a.request('POST', `${base}/join?compact=1`, { nickname: 'Other', phone: phoneB })).data;
  const observed = await a.socket(code, other.token);
  const stable = await a.socket(code, token);
  await pause(350);
  const target = path.join(a.dataDir, `${code}.json`);
  const bytes = readFileSync(target, 'utf8'), mtime = statSync(target).mtimeMs;
  const version = (await a.request('GET', `${base}/state?compact=1`, undefined, token)).data.state.stateVersion;
  observed.packets.length = 0;
  let totalBytes = 0, limited = 0;
  for (let batch = 0; batch < 7; batch++) {
    const requests = await Promise.all(Array.from({ length: 20 }, () => a.request('POST', `${base}/join?compact=1`, { nickname: 'Kelly', phone: phoneA, enter: true })));
    for (const result of requests) {
      totalBytes += result.bytes;
      if (result.status === 429) { limited++; continue; }
      assert.equal(result.status, 200);
      assert.equal(result.data.state.stateVersion, version);
      assert.equal(Object.hasOwn(result.data.state, 'history'), false);
      assert.equal(Object.hasOwn(result.data, 'effect'), false);
    }
  }
  assert.ok(limited > 0 && limited <= 25);
  assert.ok(totalBytes < 1_000_000, `bounded compact refresh bytes: ${totalBytes}`);
  assert.equal(readFileSync(target, 'utf8'), bytes);
  assert.equal(statSync(target).mtimeMs, mtime);
  assert.equal(observed.packets.filter(packet => ['state', 'roomEffect'].includes(packet.type)).length, 0);
  for (let i = 0; i < 12; i++) { const refresh = await a.socket(code, token); refresh.ws.terminate(); }
  await pause(350);
  assert.equal(readFileSync(target, 'utf8'), bytes);
  assert.equal(statSync(target).mtimeMs, mtime);
  assert.equal(observed.packets.filter(packet => packet.type === 'state').length, 0, 'extra tabs do not change already-connected presence');
  for (const [seat, bearer] of [token, other.token].entries()) assert.equal((await a.request('POST', `${base}/command?compact=1`, { type: 'sit', seat, buyIn: 2000 }, bearer)).status, 200);
  const started = await a.request('POST', `${base}/command?compact=1`, { type: 'nextHand' }, token);
  assert.equal(started.status, 200);
  const actor = started.data.state.actingSeat === 0 ? token : other.token;
  const actionStartedAt = Date.now();
  const [action, burst] = await Promise.all([
    a.request('POST', `${base}/command?compact=1`, { type: 'action', action: 'fold' }, actor),
    Promise.all(Array.from({ length: 50 }, () => a.request('POST', `${base}/join?compact=1`, { nickname: 'Kelly', phone: phoneA, enter: true })))
  ]);
  assert.equal(action.status, 200);
  assert.equal(action.data.state.status, 'finished');
  assert.ok(burst.every(result => result.status === 200 || result.status === 429));
  const actionDuringBurstMs = Date.now() - actionStartedAt;
  assert.ok(actionDuringBurstMs < 5000, `game action completed during burst: ${actionDuringBurstMs} ms`);
  assert.equal((await a.request('POST', `${base}/join?compact=1`, { nickname: 'Other', phone: phoneB })).status, 200, 'shared-IP player has independent quota');
  t.diagnostic(`Refresh stress: 140 initial joins, ${limited} rate-limited, ${totalBytes} response bytes, zero unchanged-state broadcasts/writes, 12 extra socket reconnects, game action completed with 50 concurrent joins in ${actionDuringBurstMs} ms`);
  stable.ws.terminate(); observed.ws.terminate();
});

test('presence-only revisions never write disk and restart epoch permits lower restored revision', { timeout: 10000 }, async t => {
  const a = await app(t);
  const created = (await a.request('POST', '/api/rooms?compact=1', { nickname: 'Presence', phone: phoneA })).data;
  const code = created.roomCode, token = created.token, base = `/api/rooms/${code}`;
  const target = path.join(a.dataDir, `${code}.json`), snapshot = readFileSync(target, 'utf8');
  const connected = await a.socket(code, token);
  await pause(350); connected.ws.close(); await once(connected.ws, 'close'); await pause(350);
  const before = (await a.request('GET', `${base}/state?compact=1`, undefined, token)).data.state;
  assert.equal(before.stateVersion, created.state.stateVersion + 2);
  assert.equal(readFileSync(target, 'utf8'), snapshot);
  await a.stop(); await a.start();
  const after = (await a.request('GET', `${base}/state?compact=1`, undefined, token)).data.state;
  assert.equal(after.stateVersion, created.state.stateVersion);
  assert.notEqual(after.stateEpoch, before.stateEpoch);
  assert.equal(after.hero.playerId, before.hero.playerId);
});

test('creation postcommit failure returns a recoverable room and failed new-member write rolls back cleanly', { timeout: 10000 }, async t => {
  const a = await app(t, { inject: true });
  writeFileSync(a.flag, 'before');
  assert.equal((await a.request('POST', '/api/rooms', { nickname: 'Creator', phone: phoneA })).status, 500);
  assert.equal(readdirSync(a.dataDir).length, 0);
  writeFileSync(a.flag, 'after');
  const pending = await a.request('POST', '/api/rooms', { nickname: 'Creator', phone: phoneA });
  assert.equal(pending.status, 503);
  assert.equal(pending.data.errorCode, 'IDENTITY_SAVE_PENDING');
  assert.match(pending.data.roomCode, /^\d{6}$/);
  const code = pending.data.roomCode, base = `/api/rooms/${code}`;
  const disk = JSON.parse(readFileSync(path.join(a.dataDir, `${code}.json`), 'utf8'));
  rmSync(a.flag);
  const retry = await a.request('POST', `${base}/join?compact=1`, { nickname: 'Creator', phone: phoneA });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.token, disk.ownerToken);
  assert.equal(retry.data.state.hero.playerId, disk.members[0].id);
  assert.equal(retry.data.state.hero.isOwner, true);
  const target = path.join(a.dataDir, `${code}.json`), bytes = readFileSync(target, 'utf8');
  writeFileSync(a.flag, 'before');
  const failed = await a.request('POST', `${base}/join`, { nickname: 'New guest', phone: phoneB });
  assert.equal(failed.status, 500);
  assert.equal(readFileSync(target, 'utf8'), bytes);
  const unchanged = (await a.request('GET', `${base}/state`, undefined, retry.data.token)).data.state;
  assert.equal(unchanged.stateVersion, retry.data.state.stateVersion);
  assert.equal(unchanged.hero.playerId, retry.data.state.hero.playerId);
  assert.equal(unchanged.nextHandAt, null);
  rmSync(a.flag);
  assert.equal((await a.request('POST', `${base}/join`, { nickname: 'New guest', phone: phoneB })).status, 200);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).members.length, 2);
});
