import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, NEXT_HAND_DELAY_MS, VOLUNTARY_REVEAL_DELAY_MS } from '../room.js';

const snapshot = room => JSON.parse(JSON.stringify(room.toJSON()));

function table(count = 2) {
  const room = new Room('462815', Math.max(4, count));
  const players = Array.from({ length: count }, (_, index) => room.join(`玩家${index + 1}`));
  players.forEach((player, seat) => room.command(player.token, { type: 'sit', seat, buyIn: 2000 }));
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players };
}

function foldToFinish(room) {
  while (room.status === 'playing') {
    room.command(room.seatMember(room.hand.actingSeat).token, { type: 'action', action: 'fold' });
  }
  assert.equal(room.status, 'finished');
}

function finished(count = 2) {
  const result = table(count);
  foldToFinish(result.room);
  return result;
}

function reveal(room, player, handNo = room.handNo) {
  return room.command(player.token, { type: 'reveal', handNo });
}

function fakeClock(t) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return { get now() { return now; }, set now(value) { now = value; } };
}

test('a hand without voluntary reveals retains its existing five-second delay', t => {
  const clock = fakeClock(t);
  const { room } = finished();
  assert.equal(NEXT_HAND_DELAY_MS, 5000);
  assert.equal(VOLUNTARY_REVEAL_DELAY_MS, 5000);
  assert.equal(room.nextHandAt, clock.now + NEXT_HAND_DELAY_MS);
  assert.equal(room.hand.voluntaryRevealHandled, false);
  clock.now = room.nextHandAt;
  assert.equal(room.autoStartIfDue(), true);
});

test('the first whole-hand reveal adds exactly five seconds to the existing deadline', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  const original = room.nextHandAt;
  clock.now += 3000;
  const state = reveal(room, players[0]);
  assert.equal(state.nextHandAt, original + 5000);
  assert.notEqual(state.nextHandAt, clock.now + 5000);
  assert.equal(room.hand.voluntaryRevealHandled, true);
  assert.deepEqual(state.seats[0].shownCards, state.hero.cards);
  assert.equal(state.hero.cards.length, 2, 'preserve the current whole-hand reveal API');
  assert.equal(state.seats[1].shownCards, null);
});

test('duplicate reveals reject without changes, and other players cannot stack the extension', t => {
  fakeClock(t);
  const { room, players } = finished(3);
  const original = room.nextHandAt;
  reveal(room, players[0]);
  const afterFirst = snapshot(room);
  assert.throws(() => reveal(room, players[0]), /尚未公开/);
  assert.deepEqual(snapshot(room), afterFirst);
  for (const player of players.slice(1)) {
    reveal(room, player);
    assert.equal(room.nextHandAt, original + 5000);
  }
  assert.equal(room.history.at(-1).shownHands.length, 3);
});

test('stale hands, spectators, and missing settlement records cannot consume the first reveal', t => {
  fakeClock(t);
  const { room, players } = finished();
  const observer = room.join('观战');
  const before = snapshot(room);
  assert.throws(() => reveal(room, players[0], room.handNo - 1), /当前手结算后/);
  assert.throws(() => reveal(room, observer), /尚未公开/);
  assert.throws(() => room.command('invalid', { type: 'reveal' }), /凭证已失效/);
  assert.deepEqual(snapshot(room), before);
  const history = room.history;
  room.history = [];
  assert.throws(() => reveal(room, players[0]), /找不到该手/);
  assert.equal(room.hand.voluntaryRevealHandled, false);
  assert.equal(players[0].revealable.shown, false);
  assert.equal(room.nextHandAt, before.nextHandAt);
  room.history = history;
  reveal(room, players[0]);
  assert.equal(room.nextHandAt, before.nextHandAt + 5000);
});

test('a reveal during play cannot consume the next hand extension', t => {
  fakeClock(t);
  const { room, players } = table();
  const before = snapshot(room);
  assert.throws(() => reveal(room, players[0]), /当前手结算后/);
  assert.deepEqual(snapshot(room), before);
  foldToFinish(room);
  const original = room.nextHandAt;
  reveal(room, players[0]);
  assert.equal(room.nextHandAt, original + 5000);
});

test('a successful reveal publishes marker and deadline together in one change', t => {
  fakeClock(t);
  const { room, players } = finished();
  const original = room.nextHandAt;
  const version = room.stateVersion;
  const persisted = [];
  room.onChange = current => persisted.push(snapshot(current));
  const state = reveal(room, players[0]);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].nextHandAt, original + 5000);
  assert.equal(persisted[0].hand.voluntaryRevealHandled, true);
  assert.equal(persisted[0].members.find(member => member.token === players[0].token).revealable.shown, true);
  assert.equal(state.stateVersion, version + 1);
  assert.equal(persisted[0].stateVersion, state.stateVersion);
});

test('a held room with eligible players keeps its absent timer in returned and persisted states', t => {
  fakeClock(t);
  const { room, players } = finished();
  room.nextHandAt = null;
  const persisted = [];
  room.onChange = current => persisted.push(snapshot(current));
  const state = reveal(room, players[0]);
  assert.equal(room.eligiblePlayers().length, 2);
  assert.equal(state.nextHandAt, null);
  assert.equal(persisted[0].nextHandAt, null);
  assert.equal(persisted[0].hand.voluntaryRevealHandled, true);
  reveal(room, players[1]);
  assert.equal(room.nextHandAt, null);
});

for (const deadline of [undefined, NaN, Infinity, -Infinity]) {
  test(`a nonfinite deadline (${String(deadline)}) is never manufactured by a reveal`, t => {
    fakeClock(t);
    const { room, players } = finished();
    room.nextHandAt = deadline;
    reveal(room, players[0]);
    assert.ok(Object.is(room.nextHandAt, deadline));
    assert.equal(room.hand.voluntaryRevealHandled, true);
  });
}

test('revealing without enough players consumes the extension before later readiness', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  room.command(players[1].token, { type: 'sitOut' });
  assert.equal(room.nextHandAt, null);
  reveal(room, players[0]);
  assert.equal(room.nextHandAt, null);
  assert.equal(room.hand.voluntaryRevealHandled, true);
  clock.now += 1000;
  room.command(players[1].token, { type: 'return' });
  assert.equal(room.nextHandAt, clock.now + NEXT_HAND_DELAY_MS);
  const readyDeadline = room.nextHandAt;
  reveal(room, players[1]);
  assert.equal(room.nextHandAt, readyDeadline);
});

for (const age of [1000, 9000]) {
  test(`a deadline ${age}ms in the past gains exactly 5000ms rather than a fresh window`, t => {
    const clock = fakeClock(t);
    const { room, players } = finished();
    room.nextHandAt = clock.now - age;
    const original = room.nextHandAt;
    reveal(room, players[0]);
    assert.equal(room.nextHandAt, original + 5000);
    assert.equal(room.autoStartIfDue(), age > 5000);
  });
}

test('manual and automatic starts both respect the extended deadline', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  const original = room.nextHandAt;
  reveal(room, players[0]);
  clock.now = original;
  assert.equal(room.autoStartIfDue(), false);
  assert.throws(() => room.command(players[0].token, { type: 'nextHand' }), /展示结束/);
  clock.now = original + 4999;
  assert.equal(room.autoStartIfDue(), false);
  clock.now++;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.handNo, 2);
});

test('the next hand resets the marker and can receive its own one-time extension', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  reveal(room, players[0]);
  clock.now = room.nextHandAt;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.hand.voluntaryRevealHandled, false);
  assert.equal(room.nextHandAt, null);
  foldToFinish(room);
  const original = room.nextHandAt;
  reveal(room, players[1]);
  assert.equal(room.nextHandAt, original + 5000);
  assert.equal(room.hand.voluntaryRevealHandled, true);
  reveal(room, players[0]);
  assert.equal(room.nextHandAt, original + 5000);
});

test('snapshot restoration preserves the extended deadline and consumed marker', t => {
  fakeClock(t);
  const { room, players } = finished();
  const original = room.nextHandAt;
  reveal(room, players[0]);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.nextHandAt, original + 5000);
  assert.equal(restored.hand.voluntaryRevealHandled, true);
  reveal(restored, restored.requireMember(players[1].token));
  assert.equal(restored.nextHandAt, original + 5000);
  assert.equal(snapshot(restored).hand.voluntaryRevealHandled, true);
});

test('snapshot restoration preserves a consumed marker when readiness later creates a timer', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  room.command(players[1].token, { type: 'sitOut' });
  reveal(room, players[0]);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.nextHandAt, null);
  assert.equal(restored.hand.voluntaryRevealHandled, true);
  restored.command(players[1].token, { type: 'return' });
  assert.equal(restored.nextHandAt, clock.now + NEXT_HAND_DELAY_MS);
  reveal(restored, restored.requireMember(players[1].token));
  assert.equal(restored.nextHandAt, clock.now + NEXT_HAND_DELAY_MS);
});

test('legacy snapshots without the marker remain eligible for their first voluntary reveal', t => {
  fakeClock(t);
  const { room, players } = finished();
  const saved = snapshot(room);
  delete saved.hand.voluntaryRevealHandled;
  const restored = Room.fromJSON(saved);
  assert.equal(restored.hand.voluntaryRevealHandled, false);
  reveal(restored, restored.requireMember(players[0].token));
  assert.equal(restored.nextHandAt, saved.nextHandAt + 5000);
});

test('automatic showdown disclosure does not consume or extend the voluntary reveal window', t => {
  const clock = fakeClock(t);
  const { room, players } = table(3);
  const folded = room.seatMember(room.hand.actingSeat);
  room.command(folded.token, { type: 'action', action: 'fold' });
  while (room.status === 'playing') {
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: room.toCall(actor) ? 'call' : 'check' });
  }
  assert.equal(room.hand.result.type, 'showdown');
  assert.equal(room.hand.voluntaryRevealHandled, false);
  assert.equal(room.nextHandAt, clock.now + NEXT_HAND_DELAY_MS);
  for (const player of players.filter(player => player !== folded)) {
    assert.equal(player.hand.shown, true);
    assert.throws(() => reveal(room, player), /尚未公开/);
  }
  assert.equal(room.hand.voluntaryRevealHandled, false);
  reveal(room, folded);
  assert.equal(room.nextHandAt, clock.now + NEXT_HAND_DELAY_MS + 5000);
});

test('a grand pause blocks revealing and preserves the shifted deadline through resume', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  const original = room.nextHandAt;
  const startAt = clock.now;
  const endAt = startAt + 10_000;
  room.activateGrandPause({ startAt, endAt, grandEndAt: endAt - 2000,
    flightStartAt: endAt - 2000, flightEndAt: endAt });
  const shifted = original + 10_000;
  assert.equal(room.nextHandAt, shifted);
  const before = snapshot(room);
  assert.throws(() => reveal(room, players[0]), /暂停/);
  assert.deepEqual(snapshot(room), before);
  assert.equal(room.hand.voluntaryRevealHandled, false);
  clock.now = endAt;
  assert.equal(room.endPauseIfDue(), true);
  reveal(room, players[0]);
  assert.equal(room.nextHandAt, shifted + 5000);
  assert.equal(room.isPaused(), false);
});

test('a grand pause after revealing shifts the full extended delay without adding another extension', t => {
  const clock = fakeClock(t);
  const { room, players } = finished();
  reveal(room, players[0]);
  const extended = room.nextHandAt;
  clock.now += 1000;
  const endAt = clock.now + 10_000;
  room.activateGrandPause({ startAt: clock.now, endAt, grandEndAt: endAt - 2000,
    flightStartAt: endAt - 2000, flightEndAt: endAt });
  assert.equal(room.nextHandAt, extended + 10_000);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.hand.voluntaryRevealHandled, true);
  assert.equal(restored.nextHandAt, extended + 10_000);
  clock.now = endAt;
  restored.endPauseIfDue();
  reveal(restored, restored.requireMember(players[1].token));
  assert.equal(restored.nextHandAt, extended + 10_000);
});
