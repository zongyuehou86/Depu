import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';

function table() {
  const room = new Room('827361', 4);
  const first = room.join('First');
  const second = room.join('Second');
  room.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(first.token, { type: 'nextHand' });
  return { room, first, second };
}

function expectedAction(room) {
  return { handNo: room.handNo, streetIndex: room.hand.street,
    actingSeat: room.hand.actingSeat, actionDeadline: room.hand.actionDeadline,
    currentBet: room.hand.currentBet };
}

function rejectWithoutMutation(room, token, action, expected) {
  const before = JSON.stringify(room.toJSON());
  assert.throws(() => room.command(token, { type: 'action', action, expectedAction: expected }),
    /行动已更新，请重新选择。/);
  assert.equal(JSON.stringify(room.toJSON()), before, 'a stale pre-action must not alter the hand or event log');
}

test('an exact current-turn guard permits check and fold, including folding when no call is due', () => {
  const { room, first, second } = table();
  room.command(first.token, { type: 'action', action: 'call' });
  room.command(second.token, { type: 'action', action: 'check' });
  assert.equal(room.hand.street, 1);
  room.command(second.token, { type: 'action', action: 'check', expectedAction: expectedAction(room) });
  const state = room.stateFor(first.token);
  assert.equal(state.hero.canAct, true);
  assert.equal(state.hero.toCall, 0);
  room.command(first.token, { type: 'action', action: 'fold', expectedAction: expectedAction(room) });
  assert.equal(room.status, 'finished');
  assert.equal(room.hand.result.winners[0].seat, 1);
});

test('a preselected action from the prior hand cannot fold the next hand', () => {
  const { room, first, second } = table();
  const oldTurn = expectedAction(room);
  room.command(first.token, { type: 'action', action: 'fold' });
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.handNo, oldTurn.handNo + 1);
  room.command(second.token, { type: 'action', action: 'call' });
  assert.equal(room.hand.actingSeat, 0);
  rejectWithoutMutation(room, first.token, 'fold', oldTurn);
  room.command(first.token, { type: 'action', action: 'fold', expectedAction: expectedAction(room) });
  assert.equal(room.status, 'finished');
});

test('a preselected check from the prior street cannot check a later street', () => {
  const { room, first, second } = table();
  const oldTurn = expectedAction(room);
  room.command(first.token, { type: 'action', action: 'call' });
  room.command(second.token, { type: 'action', action: 'check' });
  assert.equal(room.hand.street, 1);
  room.command(second.token, { type: 'action', action: 'check' });
  assert.equal(room.hand.actingSeat, 0);
  rejectWithoutMutation(room, first.token, 'check', oldTurn);
  room.command(first.token, { type: 'action', action: 'check', expectedAction: expectedAction(room) });
  assert.equal(room.hand.street, 2);
});

test('a same-street actor cycle invalidates its previous deadline, while old manual action API works',
  async () => {
    const { room, first, second } = table();
    const oldTurn = expectedAction(room);
    room.command(first.token, { type: 'action', action: 'call' });
    await new Promise(resolve => setTimeout(resolve, 3));
    room.command(second.token, { type: 'action', action: 'raise', amount: 100 });
    assert.equal(room.hand.street, oldTurn.streetIndex);
    assert.equal(room.hand.actingSeat, oldTurn.actingSeat);
    assert.notEqual(room.hand.actionDeadline, oldTurn.actionDeadline);
    rejectWithoutMutation(room, first.token, 'fold', oldTurn);
    room.command(first.token, { type: 'action', action: 'fold' });
    assert.equal(room.status, 'finished', 'older clients without expectedAction retain manual commands');
  });

test('malformed or mismatched optional expectations are rejected before action changes', () => {
  const { room, first } = table();
  const current = expectedAction(room);
  for (const expected of [null, {}, { ...current, actionDeadline: current.actionDeadline + 1 },
    { ...current, currentBet: current.currentBet + 1 },
    { ...current, handNo: String(current.handNo) }]) {
    rejectWithoutMutation(room, first.token, 'fold', expected);
  }
});

test('a same-millisecond return to the same seat cannot reuse an old preselected fold after a raise', () => {
  const { room, first, second } = table();
  const oldTurn = expectedAction(room);
  room.command(first.token, { type: 'action', action: 'call' });
  room.command(second.token, { type: 'action', action: 'raise', amount: 100 });
  assert.equal(room.hand.street, oldTurn.streetIndex);
  assert.equal(room.hand.actingSeat, oldTurn.actingSeat);
  assert.notEqual(room.hand.currentBet, oldTurn.currentBet);
  room.hand.actionDeadline = oldTurn.actionDeadline; // Worst case: the clock produced the same millisecond.
  rejectWithoutMutation(room, first.token, 'fold', oldTurn);
  room.command(first.token, { type: 'action', action: 'fold', expectedAction: expectedAction(room) });
  assert.equal(room.status, 'finished');
});
