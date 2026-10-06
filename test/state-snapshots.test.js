import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardLabel, verifyCardProof } from '../engine.js';
import { Room, RUNOUT_VOTE_MS, RUNOUT_TURN_MS } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function table(count = 10, options = {}) {
  const room = new Room('314159', Math.max(4, count), () => {}, options);
  const players = Array.from({ length: count }, (_, index) => room.join(`玩家${index + 1}`));
  players.forEach((player, seat) => room.command(player.token, { type: 'sit', seat, buyIn: 100_000 }));
  return { room, players };
}

function finishCheckedHand(room, first) {
  if (room.status === 'finished') room.nextHandAt = Date.now() - 1;
  room.command(first.token, { type: 'nextHand' });
  let actions = 0;
  while (room.status === 'playing') {
    assert.ok(++actions <= 40, 'a ten-player check/call hand must finish in four betting rounds');
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: room.toCall(actor) ? 'call' : 'check' });
  }
}

test('state versions order changes made in one millisecond and survive restoration', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const published = [];
  const room = new Room('271828', 4, changed => published.push(changed.stateVersion));
  assert.equal(room.stateVersion, 0);
  const first = room.join('甲');
  const joined = room.stateFor(first.token);
  const second = room.join('乙');
  const seated = room.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
  assert.equal(seated.serverTime, joined.serverTime);
  assert.ok(seated.stateVersion > joined.stateVersion);
  room.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
  assert.deepEqual(published, [1, 2, 3, 4]);
  const version = room.stateVersion;
  room.stateFor(first.token);
  room.toJSON();
  assert.throws(() => room.command(first.token, { type: 'unknown' }), /未知命令/);
  assert.equal(room.stateVersion, version, 'reads and rejected commands do not create changes');
  const snapshot = JSON.parse(JSON.stringify(room.toJSON()));
  assert.equal(snapshot.stateVersion, version);
  const restored = Room.fromJSON(snapshot);
  assert.equal(restored.stateFor(first.token).stateVersion, version);
  restored.changed();
  assert.equal(restored.stateVersion, version + 1);
  delete snapshot.stateVersion;
  assert.equal(Room.fromJSON(snapshot).stateVersion, 0, 'old snapshots start with a valid revision');
});

test('twenty real ten-player hands stay within the live-state bandwidth budget without losing archives', () => {
  const { room, players } = table();
  for (let hand = 0; hand < 20; hand++) finishCheckedHand(room, players[0]);
  const fullHistory = JSON.stringify(room.history);
  const packets = players.map(player => room.stateFor(player.token));
  const packetBytes = packets.map(packet => Buffer.byteLength(JSON.stringify(packet)));
  for (const [index, state] of packets.entries()) {
    const previousBytes = Buffer.byteLength(JSON.stringify({ ...state, history: room.history.slice(-20) }));
    assert.ok(packetBytes[index] < 64 * 1024, `player ${index}: ${packetBytes[index]} live bytes exceeds budget`);
    assert.ok(packetBytes[index] < previousBytes / 4, 'live state removes at least 75% of the repeated history bytes');
    assert.equal(state.history.length, 5);
    assert.equal(state.history[0].handNo, 16);
    assert.equal(state.historyTotal, 20);
    assert.deepEqual(state.history.at(-1).result, room.history.at(-1).result);
    assert.deepEqual(state.history.at(-1).shownHands, room.history.at(-1).shownHands);
    assert.equal(state.history.at(-1).startedAt, room.hand.startedAt);
    assert.equal(state.history.at(-1).fairness.visibleCardCount, 25);
    assert.equal(Object.hasOwn(state.history.at(-1), 'events'), false);
    assert.equal(Object.hasOwn(state.history.at(-1).fairness, 'visibleCardProofs'), false);
    assert.equal(state.fairness.visibleCardProofs.length, 25, 'current-hand verification remains available live');
    for (const proof of state.fairness.visibleCardProofs) assert.equal(verifyCardProof(state.fairness.deckRoot, proof), true);
    assert.equal(JSON.stringify(state).includes(room.hand.fair.seed), false);
  }
  assert.ok(packetBytes.reduce((sum, bytes) => sum + bytes, 0) < 640 * 1024);
  assert.equal(JSON.stringify(room.history), fullHistory, 'summaries never mutate the complete archive');
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(JSON.stringify(restored.history), fullHistory);
  for (const record of restored.history) {
    assert.ok(record.events.length >= 40);
    assert.equal(record.fairness.visibleCardProofs.length, 25);
    for (const proof of record.fairness.visibleCardProofs) assert.equal(verifyCardProof(record.fairness.deckRoot, proof), true);
  }
  assert.equal(players.reduce((sum, player) => sum + player.stack, 0), 1_000_000);
});

test('the history API keeps full events and verifiable proofs after live summaries are introduced',
  { timeout: 10_000 }, async t => {
    const { room, players } = table();
    finishCheckedHand(room, players[0]);
    finishCheckedHand(room, players[0]);
    room.nextHandAt = Date.now() + 60_000;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'poker-snapshot-history-'));
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const dataDir = path.join(directory, 'data');
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(path.join(dataDir, `${room.code}.json`), JSON.stringify(room.toJSON()), { mode: 0o600 });
    const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore',
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir,
        HAND_RECORDS_DIR: path.join(directory, 'records') } });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      rmSync(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail(`history test server exited: ${child.exitCode}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; }
      } catch { /* Server is starting. */ }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.ok(ready);
    const headers = { Authorization: `Bearer ${players[0].token}` };
    const response = await fetch(`${base}/api/rooms/${room.code}/history?offset=0&limit=1`, { headers });
    assert.equal(response.status, 200);
    const archive = await response.json();
    assert.equal(archive.total, 2);
    assert.deepEqual(archive.items, room.historyFor(0, 1));
    for (const proof of archive.items[0].fairness.visibleCardProofs) {
      assert.equal(verifyCardProof(archive.items[0].fairness.deckRoot, proof), true);
    }
    const liveResponse = await fetch(`${base}/api/rooms/${room.code}/state`, { headers });
    const { state } = await liveResponse.json();
    assert.equal(state.historyTotal, 2);
    assert.equal(state.history[0].fairness.visibleCardCount, 25);
    assert.equal(Object.hasOwn(state.history[0].fairness, 'visibleCardProofs'), false);
  });

function deferredHeadsUp() {
  const room = new Room('161803', 4, () => {}, { deferEquity: true });
  const first = room.join('甲'), second = room.join('乙');
  room.command(first.token, { type: 'sit', seat: 0, buyIn: 100 });
  room.command(second.token, { type: 'sit', seat: 1, buyIn: 100 });
  room.command(first.token, { type: 'nextHand' });
  room.command(first.token, { type: 'action', action: 'raise', amount: 100 });
  room.command(second.token, { type: 'action', action: 'call' });
  return { room, first, second };
}

test('deferred equity exposes only public inputs and starts its vote after completion or restoration', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { room, first } = deferredHeadsUp();
  const state = room.stateFor(first.token);
  assert.equal(state.runout.phase, 'calculating');
  assert.deepEqual(state.runout.equity, []);
  assert.equal(state.runout.equityMethod, null);
  assert.equal(state.runout.deadline, null);
  assert.equal(state.runout.nextCardAt, null);
  assert.equal(room.runoutDeadline(), null);
  assert.equal(room.hand.nextCard, 4, 'equity computation must not draw future board cards');
  const input = room.runoutEquityInput();
  assert.deepEqual(Object.keys(input).sort(), ['board', 'players']);
  assert.deepEqual(input.board, []);
  for (const player of input.players) {
    assert.deepEqual(Object.keys(player).sort(), ['hole', 'seat']);
    assert.deepEqual(player.hole.map(cardLabel), state.seats[player.seat].shownCards);
  }
  const snapshot = JSON.parse(JSON.stringify(room.toJSON()));
  assert.equal(Object.hasOwn(snapshot, 'deferEquity'), false);
  const restored = Room.fromJSON(snapshot, () => {}, { deferEquity: true });
  assert.equal(restored.deferEquity, true);
  assert.deepEqual(restored.runoutEquityInput(), input);
  const version = restored.stateVersion;
  now += 100_000;
  assert.equal(restored.advanceRunoutIfDue(), false);
  const result = { equity: [{ seat: 0, winPct: 80, tiePct: 0, equityPct: 80 },
    { seat: 1, winPct: 20, tiePct: 0, equityPct: 20 }],
  scores: [{ seat: 0, share: 16_000 }, { seat: 1, share: 4000 }],
  method: 'monteCarlo', scenarios: 20_000, errorPct: 1 };
  assert.equal(restored.completeRunoutEquity(result), true);
  assert.equal(restored.hand.runout.phase, 'trailingVote');
  assert.equal(restored.hand.runout.deadline, now + RUNOUT_VOTE_MS);
  assert.equal(restored.hand.nextCard, 4);
  assert.equal(restored.stateVersion, version, 'the publishing caller controls the completion revision');
  restored.changed();
  assert.equal(restored.stateVersion, version + 1);
  assert.equal(restored.completeRunoutEquity(result), false, 'a delayed duplicate cannot restart voting');
});

test('an unavailable equity calculation falls back to one committed board and conserves chips', () => {
  const { room, first } = deferredHeadsUp();
  const committedDeck = [...room.hand.fair.deck];
  assert.equal(room.completeRunoutEquity(null), true);
  room.changed();
  assert.equal(room.hand.runout.phase, 'dealing');
  assert.equal(room.hand.runout.reason, 'equityUnavailable');
  assert.equal(room.hand.runout.eligibleForTwice, false);
  assert.equal(room.hand.runout.times, 1);
  assert.equal(room.hand.runout.nextCardAt >= Date.now() + RUNOUT_TURN_MS - 10, true);
  assert.equal(room.stateFor(first.token).runout.equityMethod, null);
  while (room.status === 'playing') {
    room.hand.runout.nextCardAt = Date.now() - 1;
    assert.equal(room.advanceRunoutIfDue(), true);
  }
  assert.deepEqual(room.hand.fair.deck, committedDeck);
  assert.deepEqual(room.hand.board.map(item => item.card), [5, 6, 7, 9, 11].map(position => committedDeck[position]));
  assert.equal(room.hand.result.pot, 200);
  assert.equal(room.hand.result.boards.length, 1);
  assert.equal([...room.members.values()].reduce((sum, member) => sum + member.stack, 0), 200);
  for (const proof of room.publicFairness().visibleCardProofs) assert.equal(verifyCardProof(room.hand.fair.deckRoot, proof), true);
});
