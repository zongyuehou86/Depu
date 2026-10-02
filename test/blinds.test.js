import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, BIG_BLIND, SMALL_BLIND, MAX_BIG_BLIND } from '../room.js';

function table() {
  const room = new Room('713642');
  const first = room.join('甲');
  const second = room.join('乙');
  const spectator = room.join('观战');
  room.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
  return { room, first, second, spectator };
}

test('any room member, including a spectator, can set a bounded integer blind between hands', () => {
  const { room, first, spectator } = table();
  for (const invalid of [1, 1.5, '50', null, MAX_BIG_BLIND + 1]) {
    assert.throws(() => room.command(spectator.token,
      { type: 'setBigBlind', amount: invalid }), /大盲须为/);
  }
  const changed = room.command(spectator.token, { type: 'setBigBlind', amount: 51 });
  assert.equal(changed.bigBlind, 51);
  assert.equal(changed.smallBlind, 25);
  assert.equal(changed.handBigBlind, null);
  assert.throws(() => room.command(spectator.token,
    { type: 'sit', seat: 2, buyIn: 50 }), /带入筹码须为 51/);
  const newcomer = room.join('新玩家');
  room.command(newcomer.token, { type: 'sit', seat: 2, buyIn: 51 });
  room.command(newcomer.token, { type: 'stand' });
  room.command(first.token, { type: 'setBigBlind', amount: 2 });
  assert.equal(room.stateFor(first.token).smallBlind, 1);
});

test('a hand freezes its blinds for posting, heads-up action, street minimums, and saved history', () => {
  const { room, first, second, spectator } = table();
  room.command(spectator.token, { type: 'setBigBlind', amount: 51 });
  room.command(first.token, { type: 'nextHand' });
  assert.equal(room.hand.smallBlindSeat, first.seat);
  assert.equal(room.hand.bigBlindSeat, second.seat);
  assert.equal(room.hand.smallBlind, 25);
  assert.equal(room.hand.bigBlind, 51);
  assert.equal(room.hand.currentBet, 51);
  assert.equal(room.hand.lastFullRaise, 51);
  assert.equal(room.hand.actingSeat, first.seat);
  assert.equal(room.stateFor(first.token).minRaiseTo, 102);
  assert.deepEqual(room.hand.actions.slice(0, 2).map(item => [item.action, item.amount]),
    [['smallBlind', 25], ['bigBlind', 51]]);
  assert.throws(() => room.command(spectator.token,
    { type: 'setBigBlind', amount: 40 }), /当前手结束后才能调整大盲/);

  room.command(first.token, { type: 'action', action: 'call' });
  room.command(second.token, { type: 'action', action: 'check' });
  assert.equal(room.hand.street, 1);
  assert.equal(room.hand.lastFullRaise, 51);
  assert.equal(room.stateFor(first.token).minRaiseTo, 51);
  room.command(second.token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  const saved = JSON.stringify(room.history[0]);
  assert.equal(room.history[0].smallBlind, 25);
  assert.equal(room.history[0].bigBlind, 51);
  room.command(spectator.token, { type: 'setBigBlind', amount: 37 });
  const finished = room.stateFor(first.token);
  assert.equal(finished.bigBlind, 37);
  assert.equal(finished.smallBlind, 18);
  assert.equal(finished.handBigBlind, 51);
  assert.equal(finished.handSmallBlind, 25);
  assert.equal(JSON.stringify(room.history[0]), saved);

  room.nextHandAt = Date.now() - 1;
  room.command(first.token, { type: 'nextHand' });
  assert.equal(room.hand.bigBlind, 37);
  assert.equal(room.hand.smallBlind, 18);
  assert.deepEqual(room.hand.actions.slice(0, 2).map(item => item.amount), [18, 37]);
});

test('room and hand blinds survive restart; old snapshots migrate to the original 10/20', () => {
  const { room, first, spectator } = table();
  room.command(spectator.token, { type: 'setBigBlind', amount: 73 });
  room.command(first.token, { type: 'nextHand' });
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(restored.bigBlind, 73);
  assert.equal(restored.smallBlind, 36);
  assert.equal(restored.hand.bigBlind, 73);
  assert.equal(restored.hand.smallBlind, 36);
  assert.equal(restored.stateFor(first.token).bigBlind, 73);

  const legacy = JSON.parse(JSON.stringify(room.toJSON()));
  delete legacy.bigBlind;
  delete legacy.smallBlind;
  delete legacy.hand.bigBlind;
  delete legacy.hand.smallBlind;
  const migrated = Room.fromJSON(legacy);
  assert.equal(migrated.bigBlind, BIG_BLIND);
  assert.equal(migrated.smallBlind, SMALL_BLIND);
  assert.equal(migrated.hand.bigBlind, BIG_BLIND);
  assert.equal(migrated.hand.smallBlind, SMALL_BLIND);
  migrated.command(first.token, { type: 'action', action: 'fold' });
  const earlier = JSON.parse(JSON.stringify(migrated.toJSON()));
  delete earlier.history[0].smallBlind;
  delete earlier.history[0].bigBlind;
  const migratedHistory = Room.fromJSON(earlier);
  assert.equal(migratedHistory.history[0].smallBlind, SMALL_BLIND);
  assert.equal(migratedHistory.history[0].bigBlind, BIG_BLIND);
});
