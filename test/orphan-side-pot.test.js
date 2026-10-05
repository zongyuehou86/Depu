import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';

function setup(stacks = [2000, 100, 50]) {
  const room = new Room('512345', Math.max(4, stacks.length));
  const players = stacks.map((buyIn, seat) => {
    const player = room.join(`QA${seat}`);
    room.command(player.token, { type: 'sit', seat, buyIn });
    return player;
  });
  const observer = room.join('QA observer');
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players, observer };
}

function foldedBettorRunout() {
  const fixture = setup();
  const { room, players: [a, b, c] } = fixture;
  room.command(a.token, { type: 'action', action: 'raise', amount: 200 });
  room.command(a.token, { type: 'sitOut' });
  room.command(b.token, { type: 'action', action: 'call' });
  room.command(c.token, { type: 'action', action: 'call' });
  return fixture;
}

function finishRunout(room, times = 1) {
  room.decideRunout(times);
  for (let step = 0; step < 10 && room.status === 'playing'; step++) {
    room.hand.runout.nextCardAt = Date.now() - 1;
    assert.equal(room.advanceRunoutIfDue(), true);
  }
  assert.equal(room.status, 'finished');
}

for (const times of [1, 2]) test(`out-of-turn folded bettor receives only unmatched excess; ${times} run(s) settle`, () => {
  const { room, players: [a, b, c], observer } = foldedBettorRunout();
  assert.equal(a.stack, 1900, 'exactly 100 unmatched chips return to their owner');
  assert.equal(a.hand.totalCommit, 100);
  assert.deepEqual(room.buildPots(), [
    { amount: 150, eligibleSeats: [1, 2] }, { amount: 100, eligibleSeats: [1] }
  ]);
  const returned = room.hand.actions.filter(action => action.action === 'uncalledReturn');
  assert.equal(returned.length, 1);
  assert.equal(returned[0].amount, 100);
  finishRunout(room, times);
  assert.equal(room.hand.result.pot, 250);
  assert.equal(room.hand.result.winners.reduce((sum, winner) => sum + winner.amount, 0), 250);
  assert.equal(a.stack + b.stack + c.stack, 2150);
  assert.equal(a.stack, 1900, 'folded hand cannot win matched chips');
  assert.ok(room.hand.result.winners.every(winner => winner.seat !== a.seat));
  assert.equal(room.ledger().find(row => row.playerId === a.id).pokerProfitLoss, -100);
  const view = room.stateFor(observer.token);
  assert.equal(view.seats[a.seat].shownCards, null, 'refund must not reveal folded cards');
  const positions = new Set(a.hand.hole.map(card => card.position));
  assert.ok(view.fairness.visibleCardProofs.every(proof => !positions.has(proof.position)));
  assert.ok(view.history.every(hand => hand.shownHands.every(player => player.seat !== a.seat)));
  assert.equal(room.hand.actions.filter(action => action.action === 'uncalledReturn').length, 1);
});

test('restoration preserves the refund and completing the hand never refunds it twice', () => {
  const { room: before, players: [a] } = foldedBettorRunout();
  const room = Room.fromJSON(JSON.parse(JSON.stringify(before.toJSON())));
  const restored = room.requireMember(a.token);
  assert.equal(restored.stack, 1900);
  assert.equal(room.returnUncalledFoldedBet(), 0);
  finishRunout(room);
  assert.equal(restored.stack, 1900);
  assert.equal(room.hand.actions.filter(action => action.action === 'uncalledReturn').length, 1);
  assert.equal([...room.members.values()].reduce((sum, player) => sum + player.stack, 0), 2150);
});

test('a pre-fix in-flight twice-run snapshot refunds before its first-board preview', () => {
  const { room: before, players: [a] } = foldedBettorRunout();
  before.decideRunout(2);
  const snapshot = JSON.parse(JSON.stringify(before.toJSON()));
  // Reconstruct the previous release's reachable state, before it knew how to
  // return this unmatched 100: the committed deck and runout timing stay intact.
  const bettor = snapshot.members.find(player => player.token === a.token);
  bettor.stack -= 100;
  bettor.hand.totalCommit += 100;
  snapshot.hand.actions = snapshot.hand.actions.filter(action => action.action !== 'uncalledReturn');
  snapshot.events = snapshot.events.filter(event => !event.text.includes('退回无人跟注的'));
  const room = Room.fromJSON(snapshot);
  assert.equal(room.requireMember(a.token).stack, 1800);
  for (let step = 0; step < 2; step++) {
    room.hand.runout.nextCardAt = Date.now() - 1;
    assert.equal(room.advanceRunoutIfDue(), true);
  }
  assert.equal(room.hand.runout.phase, 'firstBoardPause');
  assert.equal(room.requireMember(a.token).stack, 1900);
  const preview = room.hand.runout.boardResults[0];
  assert.equal(preview.pots.reduce((sum, pot) => sum + pot.amount, 0), 125);
  for (let step = 0; step < 8 && room.status === 'playing'; step++) {
    room.hand.runout.nextCardAt = Date.now() - 1;
    room.advanceRunoutIfDue();
  }
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.hand.result.runouts[0], preview);
  assert.equal(room.hand.actions.filter(action => action.action === 'uncalledReturn').length, 1);
  assert.equal([...room.members.values()].reduce((sum, player) => sum + player.stack, 0), 2150);
});

test('already matched, abandoned side-pot chips remain forfeited and flow to the lower eligible pot', () => {
  const { room, players: [a, b, c, d] } = setup([2000, 2000, 100, 50]);
  room.command(d.token, { type: 'action', action: 'call' });
  room.command(a.token, { type: 'action', action: 'raise', amount: 200 });
  room.command(b.token, { type: 'action', action: 'call' });
  room.command(a.token, { type: 'sitOut' });
  room.command(b.token, { type: 'sitOut' });
  room.command(c.token, { type: 'action', action: 'call' });
  room.command(d.token, { type: 'action', action: 'call' });
  assert.deepEqual(room.buildPots(), [
    { amount: 200, eligibleSeats: [2, 3] }, { amount: 350, eligibleSeats: [2] }
  ]);
  assert.equal(a.stack, 1800);
  assert.equal(b.stack, 1800);
  finishRunout(room);
  assert.equal(room.hand.result.pot, 550);
  assert.equal(a.stack + b.stack + c.stack + d.stack, 4150);
  assert.equal(a.stack, 1800);
  assert.equal(b.stack, 1800);
  assert.ok(room.hand.result.winners.every(winner => winner.seat === 2 || winner.seat === 3));
});

test('a final opponent fold also refunds only the folded bettor’s unmatched excess', () => {
  const { room, players: [a, b, c] } = setup();
  room.command(a.token, { type: 'action', action: 'raise', amount: 200 });
  room.command(a.token, { type: 'sitOut' });
  room.command(b.token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.equal(a.stack, 1980);
  assert.equal(room.hand.result.pot, 50);
  assert.equal(a.stack + b.stack + c.stack, 2150);
  assert.equal(room.hand.result.winners[0].seat, c.seat);
});
