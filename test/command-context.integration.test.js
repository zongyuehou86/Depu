import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const actionContext = view => ({ handNo: view.handNo, streetIndex: view.streetIndex,
  actingSeat: view.actingSeat, actionDeadline: view.actionDeadline, currentBet: view.currentBet });
const runoutContext = room => ({ handNo: room.handNo,
  phase: room.hand.runout.phase, deadline: room.hand.runout.deadline });

async function app(t, room) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'poker-command-context-'));
  writeFileSync(path.join(directory, `${room.code}.json`), JSON.stringify(room.toJSON()));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
      HAND_RECORDS_DIR: path.join(directory, 'records') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); await once(child, 'exit');
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (attempt === 99) throw new Error(`isolated server did not start: ${output}`);
    await pause(30);
  }
  const request = async (token, body) => {
    const response = await fetch(`${base}/api/rooms/${room.code}/${body ? 'command' : 'state'}?compact=1`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  const delayedCommand = (token, body) => {
    const text = JSON.stringify(body);
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(`${base}/api/rooms/${room.code}/command?compact=1`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
      }, incoming => {
        let received = '';
        incoming.on('data', chunk => { received += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode, ...JSON.parse(received) }));
      });
      request.on('error', reject);
      request.write(text.slice(0, -1));
    });
    t.after(() => request.destroy());
    return { finish: () => { request.end('}'); return response; } };
  };
  return { request, delayedCommand };
}

function table(code) {
  const room = new Room(code, 4, () => {}, { deferEquity: true });
  const players = ['First', 'Second'].map(name => room.join(name));
  players.forEach((player, seat) => room.command(player.token, { type: 'sit', seat, buyIn: 2000 }));
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players };
}

test('a real HTTP timebank body delayed across automatic next-hand start cannot enable the new hand',
  { timeout: 15_000 }, async t => {
    const { room, players } = table('819201');
    const a = await app(t, room);
    const actor = room.seatMember(room.hand.actingSeat);
    const first = (await a.request(actor.token)).state;
    const delayed = a.delayedCommand(actor.token, { type: 'timebank', enabled: true,
      expectedTimebank: actionContext(first) });
    // A second tab makes the old choice obsolete while its HTTP body is in flight.
    assert.equal((await a.request(actor.token, { type: 'action', action: 'fold' })).status, 200);
    let next;
    for (let attempt = 0; attempt < 45; attempt++) {
      next = (await a.request(actor.token)).state;
      if (next.handNo > first.handNo) break;
      await pause(250);
    }
    assert.equal(next.handNo, first.handNo + 1);
    assert.equal(next.hero.timebankEnabled, false);
    const obsolete = await delayed.finish();
    assert.equal(obsolete.status, 400, 'the old hand must not enable a paid timebank in the new hand');
    assert.match(obsolete.error, /行动已更新/);
    const fresh = (await a.request(actor.token)).state;
    assert.equal(fresh.hero.timebankEnabled, false);
    assert.equal(fresh.stateVersion, next.stateVersion);
    const enabled = await a.request(actor.token, { type: 'timebank', enabled: true,
      expectedTimebank: actionContext(fresh) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.state.hero.timebankEnabled, true);
    const legacy = await a.request(actor.token, { type: 'timebank', enabled: false });
    assert.equal(legacy.status, 200, 'clients predating context guards retain their command format');
    assert.equal(legacy.state.hero.timebankEnabled, false);
  });

function enterRunout(room) {
  while (!room.hand.runout) {
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: room.canRaise(actor) ? 'raise' : 'call',
      amount: room.maxRaiseTo(actor) });
  }
  const players = room.runoutEquityInput().players;
  room.completeRunoutEquity({ method: 'exact', scenarios: 100,
    scores: players.map((player, index) => ({ seat: player.seat, share: index ? 20 : 80 })),
    equity: players.map((player, index) => ({ seat: player.seat, winPct: index ? 20 : 80,
      tiePct: 0, equityPct: index ? 20 : 80 })) });
}

for (const type of ['runoutChoice', 'runoutResponse']) {
  test(`${type} from a completed hand cannot decide the next hand over HTTP`, async t => {
    const { room, players } = table(type === 'runoutChoice' ? '819202' : '819203');
    enterRunout(room);
    if (type === 'runoutResponse') room.command(room.seatMember(room.hand.runout.trailingSeat).token,
      { type: 'runoutChoice', times: 2 });
    const old = runoutContext(room);
    room.decideRunout(1);
    while (room.status === 'playing') {
      room.hand.runout.nextCardAt = Date.now() - 1;
      room.advanceRunoutIfDue();
    }
    for (const player of players) room.command(player.token, { type: 'rebuy', amount: 2000 });
    room.nextHandAt = Date.now() - 1;
    assert.equal(room.autoStartIfDue(), true);
    enterRunout(room);
    if (type === 'runoutResponse') room.command(room.seatMember(room.hand.runout.trailingSeat).token,
      { type: 'runoutChoice', times: 2 });
    const player = room.seatMember(type === 'runoutChoice' ? room.hand.runout.trailingSeat : room.hand.runout.leadingSeat);
    const a = await app(t, room);
    const before = (await a.request(player.token)).state;
    const payload = { type, ...(type === 'runoutChoice' ? { times: 2 } : { accept: true }) };
    const obsolete = await a.request(player.token, { ...payload, expectedRunout: old });
    assert.equal(obsolete.status, 400, 'a previous-hand choice must be rejected before changing the current vote');
    assert.match(obsolete.error, /行动已更新/);
    const after = (await a.request(player.token)).state;
    assert.equal(after.stateVersion, before.stateVersion);
    assert.deepEqual(after.runout, before.runout);
    const accepted = await a.request(player.token, { ...payload, expectedRunout: runoutContext(room) });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.state.runout.phase, type === 'runoutChoice' ? 'leaderVote' : 'dealing');
  });
}
