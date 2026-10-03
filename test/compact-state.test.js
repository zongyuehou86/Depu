import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { verifyCardProof } from '../engine.js';

function setup(count = 2) {
  const room = new Room('765432', Math.max(4, count));
  const players = Array.from({ length: count }, (_, seat) => {
    const member = room.join(`玩家${seat + 1}`);
    room.command(member.token, { type: 'sit', seat, buyIn: 2000 });
    return member;
  });
  const observer = room.join('旁观者');
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players, observer };
}

test('compact live state preserves gameplay and private-card visibility, omitting only bulk details', () => {
  const { room, players, observer } = setup();
  const full = room.stateFor(players[0].token);
  const live = room.stateFor(players[0].token, { compact: true });
  for (const field of ['hero', 'seats', 'board', 'result', 'ledger', 'events', 'actionDeadline', 'actingSeat']) {
    assert.deepEqual(live[field], full[field], field);
  }
  assert.equal(live.compact, true);
  assert.equal(live.historyTotal, 0);
  assert.equal(Object.hasOwn(live, 'history'), false);
  assert.equal(Object.hasOwn(live.fairness, 'visibleCardProofs'), false);
  assert.equal(live.fairness.visibleCardCount, 0);
  assert.equal(live.fairness.deckRoot, full.fairness.deckRoot);
  assert.equal(live.fairness.seedCommitment, full.fairness.seedCommitment);
  assert.ok(live.stateSequence > full.stateSequence);
  assert.equal(live.stateEpoch, full.stateEpoch);
  assert.equal(room.stateFor(observer.token, { compact: true }).hero.cards.length, 0);
  assert.ok(live.seats.every(seat => !seat?.shownCards));
  const text = JSON.stringify(live);
  assert.ok(!text.includes(room.hand.fair.seed));
  assert.ok(!text.includes(JSON.stringify(room.hand.fair.deck)));
  for (const member of room.members.values()) assert.ok(!text.includes(member.token));
  assert.throws(() => room.stateFor('invalid', { compact: true }), /凭证/);
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.notEqual(restored.stateFor(players[0].token).stateEpoch, live.stateEpoch);
});

test('same-hand voluntary reveal changes historyVersion without leaking folded cards', () => {
  const { room, players, observer } = setup();
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'action', action: 'fold' }, { compact: true });
  const before = room.stateFor(observer.token, { compact: true });
  assert.equal(before.historyTotal, 1);
  assert.equal(before.fairness.visibleCardCount, 0);
  assert.equal(room.history[0].fairness.visibleCardProofs.length, 0);
  const live = room.command(actor.token, { type: 'reveal' }, { compact: true });
  assert.equal(Object.hasOwn(live, 'history'), false);
  assert.notEqual(live.historyVersion, before.historyVersion);
  assert.equal(live.fairness.visibleCardCount, 2);
  const proofs = room.publicFairness();
  for (const proof of proofs.visibleCardProofs) assert.ok(verifyCardProof(proofs.deckRoot, proof));
  const other = players.find(member => member !== actor);
  assert.equal(live.seats[other.seat].shownCards, null);
  assert.ok(!proofs.visibleCardProofs.some(proof => other.hand.hole.some(card => card.position === proof.position)));
});

test('compact payload stays small as full public history and proofs grow', t => {
  const { room, players, observer } = setup(10);
  for (let actions = 0; room.status === 'playing'; actions++) {
    assert.ok(actions < 60);
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: room.toCall(actor) ? 'call' : 'check' }, { compact: true });
  }
  assert.equal(room.publicFairness().visibleCardProofs.length, 25);
  const record = room.history[0];
  // Repeat a real public record to isolate history growth from game logic.
  room.history = Array.from({ length: 20 }, () => structuredClone(record));
  const fullBytes = Buffer.byteLength(JSON.stringify(room.stateFor(observer.token)));
  const liveBytes = Buffer.byteLength(JSON.stringify(room.stateFor(observer.token, { compact: true })));
  assert.ok(liveBytes < fullBytes / 5, `${liveBytes} versus ${fullBytes}`);
  room.history.push(...Array.from({ length: 200 }, () => structuredClone(record)));
  const grownBytes = Buffer.byteLength(JSON.stringify(room.stateFor(observer.token, { compact: true })));
  assert.ok(grownBytes - liveBytes < 50);
  assert.equal(room.stateFor(players[0].token, { compact: true }).hero.cards.length, 2);
  t.diagnostic(`10-seat public showdown, 20-history fixture: full=${fullBytes} bytes, live=${liveBytes} bytes; 220-history live=${grownBytes} bytes`);
});
