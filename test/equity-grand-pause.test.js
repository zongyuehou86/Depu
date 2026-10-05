import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { cardLabel, verifyCardProof } from '../engine.js';
import { Room, GRAND_DISPLAY_MS, GRAND_FLIGHT_MS, RUNOUT_TURN_MS,
  RUNOUT_RIVER_MS, RUNOUT_VOTE_MS, RUNOUT_PAUSE_MS } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const snapshot = room => JSON.parse(JSON.stringify(room.toJSON()));

function deferredAllIn(count = 3, { foldLast = false, street = 0 } = {}) {
  const room = new Room('845123', 4, () => {}, { deferEquity: true });
  const players = Array.from({ length: count }, (_, index) => room.join(`玩家${index}`));
  const observer = room.join('观战者');
  players.forEach((player, seat) => room.command(player.token, { type: 'sit', seat, buyIn: 100 }));
  room.command(players[0].token, { type: 'nextHand' });
  while (room.hand.street < street) {
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: room.toCall(actor) ? 'call' : 'check' });
  }
  while (!room.hand.runout) {
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: foldLast && actor === players.at(-1)
      ? 'fold' : room.canRaise(actor) ? 'raise' : 'call', amount: room.maxRaiseTo(actor) });
  }
  assert.equal(room.hand.runout.phase, 'calculating');
  assert.equal(room.hand.board.length, [0, 3, 4][street]);
  return { room, players, observer };
}

function calculation(room, tie = false) {
  const players = room.runoutEquityInput().players;
  const shares = tie ? [10_000, 10_000] : players.length === 2 ? [16_000, 4000] : [12_000, 6000, 2000];
  return { method: 'monteCarlo', scenarios: 20_000, errorPct: 1,
    scores: players.map((player, index) => ({ seat: player.seat, share: shares[index] })),
    equity: players.map((player, index) => ({ seat: player.seat,
      winPct: shares[index] / 200, tiePct: 0, equityPct: shares[index] / 200 })) };
}

function giveGrandGift(room, players) {
  const { effect } = room.gift(players[0], { recipientId: players[1].id,
    quantity: 99, requestId: randomUUID() });
  assert.equal(effect.endAt - effect.startAt, GRAND_DISPLAY_MS + GRAND_FLIGHT_MS);
  return effect;
}

function assertNoBoardDisclosure(room, observer, nextCard) {
  const view = room.stateFor(observer.token);
  assert.deepEqual(view.board, []);
  assert.deepEqual(view.runout.boards, [[]]);
  assert.equal(room.hand.nextCard, nextCard);
  const shownPositions = new Set(room.livePlayers().flatMap(player => player.hand.hole.map(item => item.position)));
  assert.deepEqual(view.fairness.visibleCardProofs.map(proof => proof.position).sort((a, b) => a - b),
    [...shownPositions].sort((a, b) => a - b));
  const publicText = JSON.stringify(view);
  assert.ok(!publicText.includes(room.hand.fair.seed));
  for (let position = 0; position < room.hand.fair.deck.length; position++) {
    if (!shownPositions.has(position)) {
      assert.ok(!publicText.includes(`"${cardLabel(room.hand.fair.deck[position])}"`),
        `unexposed card at position ${position} must remain private`);
    }
  }
  for (const proof of view.fairness.visibleCardProofs) {
    assert.equal(verifyCardProof(view.fairness.deckRoot, proof), true);
  }
}

for (const reason of ['multiway', 'equityTie', 'equityUnavailable']) {
  test(`${reason} equity completed during a grand gift keeps the flop hidden until resume`, t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { room, players, observer } = deferredAllIn(reason === 'multiway' ? 4 : 2,
      { foldLast: reason === 'multiway' });
    const nextCard = room.hand.nextCard;
    const deck = [...room.hand.fair.deck];
    const effect = giveGrandGift(room, players);
    now += 1000;
    const result = reason === 'equityUnavailable' ? null : calculation(room, reason === 'equityTie');
    assert.equal(room.completeRunoutEquity(result), true);
    assert.equal(room.hand.runout.phase, 'dealing');
    assert.equal(room.hand.runout.reason, reason);
    assert.equal(room.hand.runout.times, 1);
    assertNoBoardDisclosure(room, observer, nextCard);
    assert.equal(room.hand.runout.nextCardAt, effect.endAt);
    assert.equal(room.completeRunoutEquity(result), false, 'duplicate worker completion cannot advance cards');
    assert.equal(room.events.filter(event => /第 1 次翻牌/.test(event.text)).length, 0);
    now = effect.endAt - 1;
    assert.equal(room.endPauseIfDue(), false);
    assert.equal(room.advanceRunoutIfDue(), false);
    assertNoBoardDisclosure(room, observer, nextCard);
    now = effect.endAt;
    assert.equal(room.endPauseIfDue(), true);
    assert.equal(room.advanceRunoutIfDue(), true);
    assert.equal(room.hand.board.length, 3);
    assert.deepEqual(room.hand.board.map(item => item.card), deck.slice(nextCard + 1, nextCard + 4));
    assert.equal(room.hand.nextCard, nextCard + 4);
    assert.equal(room.hand.runout.nextCardAt, now + RUNOUT_TURN_MS);
    assert.equal(room.advanceRunoutIfDue(), false, 'resume draws only the flop');
    assert.equal(room.events.filter(event => /第 1 次翻牌/.test(event.text)).length, 1);
    now += RUNOUT_TURN_MS;
    assert.equal(room.advanceRunoutIfDue(), true);
    assert.equal(room.hand.board.length, 4);
    assert.equal(room.hand.runout.nextCardAt, now + RUNOUT_RIVER_MS);
    now += RUNOUT_RIVER_MS;
    assert.equal(room.advanceRunoutIfDue(), true);
    assert.equal(room.status, 'finished');
    assert.equal(room.hand.result.boards.length, 1);
    assert.deepEqual(room.hand.fair.deck, deck);
    assert.equal(room.hand.nextCard, nextCard + 8);
  });
}

for (const street of [1, 2]) {
  test(`equity completed during a gift on street ${street} retains the full next-card delay`, t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { room, players } = deferredAllIn(3, { street });
    const originalBoard = structuredClone(room.hand.board);
    const nextCard = room.hand.nextCard;
    const effect = giveGrandGift(room, players);
    now += 1000;
    room.completeRunoutEquity(calculation(room));
    const delay = street === 1 ? RUNOUT_TURN_MS : RUNOUT_RIVER_MS;
    assert.deepEqual(room.hand.board, originalBoard);
    assert.equal(room.hand.nextCard, nextCard);
    assert.equal(room.runoutDeadline(), effect.endAt + delay);
    now = effect.endAt;
    room.endPauseIfDue();
    assert.equal(room.advanceRunoutIfDue(), false);
    now += delay - 1;
    assert.equal(room.advanceRunoutIfDue(), false);
    now++;
    assert.equal(room.advanceRunoutIfDue(), true);
    assert.equal(room.hand.board.length, originalBoard.length + 1);
    assert.equal(room.hand.nextCard, nextCard + 2);
  });
}

test('a persisted pending flop resumes once after restart during or after the gift pause', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { room, players, observer } = deferredAllIn();
  const nextCard = room.hand.nextCard;
  const effect = giveGrandGift(room, players);
  room.completeRunoutEquity(calculation(room));
  const saved = snapshot(room);
  now = effect.endAt - 1000;
  const during = Room.fromJSON(structuredClone(saved), () => {}, { deferEquity: true });
  assert.equal(during.pause.endAt, effect.endAt, 'restart must not extend the gift');
  assert.equal(during.runoutDeadline(), effect.endAt);
  assert.equal(during.runoutEquityInput(), null, 'saved completed equity is not recomputed');
  assertNoBoardDisclosure(during, observer, nextCard);
  assert.equal(during.advanceRunoutIfDue(), false);
  now = effect.endAt + 20_000;
  const after = Room.fromJSON(structuredClone(saved), () => {}, { deferEquity: true });
  assert.equal(after.pause, null);
  assertNoBoardDisclosure(after, observer, nextCard);
  assert.equal(after.advanceRunoutIfDue(), true);
  assert.equal(after.hand.board.length, 3, 'downtime cannot fast-forward to the turn or river');
  assert.equal(after.runoutDeadline(), now + RUNOUT_TURN_MS);
  assert.equal(after.advanceRunoutIfDue(), false);
});

test('heads-up equity completed during a grand gift preserves full votes and both staged boards', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { room, players, observer } = deferredAllIn(2);
  const effect = giveGrandGift(room, players);
  now += 1000;
  room.completeRunoutEquity(calculation(room));
  const saved = snapshot(room);
  assert.equal(room.hand.runout.deadline, effect.endAt + RUNOUT_VOTE_MS);
  assertNoBoardDisclosure(room, observer, 4);
  assert.throws(() => room.command(players[1].token, { type: 'runoutChoice', times: 2 }), /暂停/);
  now = effect.endAt;
  const restored = Room.fromJSON(saved, () => {}, { deferEquity: true });
  assert.equal(restored.hand.runout.deadline, effect.endAt + RUNOUT_VOTE_MS);
  assert.equal(restored.advanceRunoutIfDue(), false);
  now += RUNOUT_VOTE_MS - 1;
  restored.command(players[1].token, { type: 'runoutChoice', times: 2 });
  assert.equal(restored.hand.runout.deadline, now + RUNOUT_VOTE_MS);
  assertNoBoardDisclosure(restored, observer, 4);
  restored.command(players[0].token, { type: 'runoutResponse', accept: true });
  assert.equal(restored.hand.runout.times, 2);
  assert.deepEqual(restored.stateFor(observer.token).runout.boards.map(board => board.length), [3, 0]);
  for (const [delay, lengths, phase] of [
    [RUNOUT_TURN_MS, [4, 0], 'dealing'],
    [RUNOUT_RIVER_MS, [5, 0], 'firstBoardPause'],
    [RUNOUT_PAUSE_MS, [5, 3], 'dealing'],
    [RUNOUT_TURN_MS, [5, 4], 'dealing'],
    [RUNOUT_RIVER_MS, [5, 5], 'finished']
  ]) {
    assert.equal(restored.runoutDeadline(), now + delay);
    now += delay;
    assert.equal(restored.advanceRunoutIfDue(), true);
    assert.deepEqual(restored.stateFor(observer.token).runout.boards.map(board => board.length), lengths);
    assert.equal(restored.hand.runout.phase, phase);
  }
  assert.equal(restored.status, 'finished');
  assert.equal(restored.hand.nextCard, 20);
  assert.equal(restored.hand.result.type, 'runoutTwice');
});

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function waitUntil(read, predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('expected server state did not arrive');
}

async function socketState(port, room, observer) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.code}&token=${observer.token}`,
    { headers: { Origin: `http://127.0.0.1:${port}` } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket state timed out')), 3000);
      socket.on('message', raw => {
        const packet = JSON.parse(String(raw));
        if (packet.type === 'state') { clearTimeout(timer); resolve(packet.state); }
      });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed before state')); });
    });
  } finally { socket.terminate(); }
}

test('real async worker completion, HTTP and WebSocket recovery respect the full grand-gift pause',
  { timeout: 20_000 }, async t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'poker-equity-grand-pause-'));
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    let child;
    t.after(async () => {
      await stopServer(child);
      rmSync(directory, { recursive: true, force: true });
    });
    const { room, players, observer } = deferredAllIn();
    const effect = giveGrandGift(room, players);
    const nextCard = room.hand.nextCard;
    const file = path.join(directory, `${room.code}.json`);
    writeFileSync(file, JSON.stringify(room.toJSON()));
    const launch = async () => {
      child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore',
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
          HAND_RECORDS_DIR: path.join(directory, 'records') } });
      await waitUntil(async () => {
        assert.equal(child.exitCode, null, 'server must remain running');
        try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; }
        catch { return false; }
      }, ready => ready);
    };
    const state = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.code}/state`,
        { headers: { Authorization: `Bearer ${observer.token}` } });
      assert.equal(response.status, 200);
      return (await response.json()).state;
    };
    const checkPaused = view => {
      assert.ok(Date.now() < effect.endAt, 'the worker must complete inside the pause for this regression');
      assert.equal(view.pause.endAt, effect.endAt);
      assert.equal(view.runout.phase, 'dealing');
      assert.equal(view.runout.reason, 'multiway');
      assert.equal(view.runout.nextCardAt, effect.endAt);
      assert.deepEqual(view.runout.boards, [[]]);
      assert.deepEqual(view.board, []);
      assert.equal(view.fairness.visibleCardProofs.length, 6);
      assert.ok(view.fairness.visibleCardProofs.every(proof => proof.position < nextCard));
      for (const card of room.hand.fair.deck.slice(nextCard)) {
        assert.ok(!JSON.stringify(view).includes(`"${cardLabel(card)}"`));
      }
    };
    await launch();
    const completed = await waitUntil(state, view => view.runout?.phase !== 'calculating');
    checkPaused(completed);
    assert.equal(completed.runout.equityMethod, 'monteCarlo');
    assert.equal(completed.runout.equitySamples, 20_000);
    checkPaused(await socketState(port, room, observer));
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.hand.nextCard, nextCard);
    assert.deepEqual(persisted.hand.board, []);
    assert.equal(persisted.pause.endAt, effect.endAt);
    await stopServer(child);
    await launch();
    checkPaused(await state());
    checkPaused(await socketState(port, room, observer));
    const resumed = await waitUntil(state, view => view.board.length > 0, 12_000);
    assert.equal(resumed.pause, null);
    assert.equal(resumed.board.length, 3);
    assert.deepEqual(resumed.board, room.hand.fair.deck.slice(nextCard + 1, nextCard + 4).map(cardLabel));
    assert.equal(resumed.fairness.visibleCardProofs.length, 9);
    assert.ok(resumed.runout.nextCardAt >= Date.now() + RUNOUT_TURN_MS - 500);
    assert.ok(resumed.runout.nextCardAt >= effect.endAt + RUNOUT_TURN_MS);
    assert.equal(resumed.events.filter(event => /第 1 次翻牌/.test(event.text)).length, 1);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.hand.nextCard, nextCard + 4);
    assert.equal(after.hand.board.length, 3);
  });
