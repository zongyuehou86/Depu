import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, BIG_BLIND, SMALL_BLIND, MAX_BIG_BLIND } from '../room.js';

function table(capacity = 4) {
  const room = new Room('713642', capacity);
  const first = room.join('甲'), second = room.join('乙'), spectator = room.join('观战');
  room.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
  return { room, first, second, spectator };
}

test('only spectators may reserve blind and capacity changes; repeated targets are stable', () => {
  const { room, first, spectator } = table();
  for (const invalid of [1, 1.5, '50', null, MAX_BIG_BLIND + 1]) {
    assert.throws(() => room.command(spectator.token,
      { type: 'setBigBlind', amount: invalid }), /大盲须为/);
  }
  assert.throws(() => room.command(first.token,
    { type: 'setBigBlind', amount: 51 }), /只有观战者可以调整大盲/);
  assert.throws(() => room.command(first.token,
    { type: 'setCapacity', capacity: 6 }), /只有观战者可以调整人数/);
  room.command(first.token, { type: 'sitOut' });
  assert.throws(() => room.command(first.token,
    { type: 'setCapacity', capacity: 6 }), /只有观战者可以调整人数/);
  const requested = room.command(spectator.token, { type: 'setBigBlind', amount: 51 });
  assert.equal(requested.bigBlind, 20);
  assert.equal(requested.pendingBigBlind, 51);
  assert.equal(requested.handBigBlind, null);
  assert.equal(requested.tableSettingsNotice.kind, 'bigBlind');
  assert.equal(requested.tableSettingsNotice.message, '下一局大盲筹码数为51筹码');
  const firstNoticeId = requested.tableSettingsNotice.id;
  assert.equal(room.command(spectator.token,
    { type: 'setBigBlind', amount: 51 }).tableSettingsNotice.id, firstNoticeId);
  const overwritten = room.command(spectator.token, { type: 'setBigBlind', amount: 73 });
  assert.equal(overwritten.pendingBigBlind, 73);
  assert.ok(overwritten.tableSettingsNotice.id > firstNoticeId);
  const cancelled = room.command(spectator.token, { type: 'setBigBlind', amount: 20 });
  assert.equal(cancelled.pendingBigBlind, null);
  assert.equal(cancelled.tableSettingsNotice.message, '下一局大盲筹码数为20筹码');
  assert.equal(cancelled.bigBlind, 20);
  const expanded = room.command(spectator.token, { type: 'setCapacity', capacity: 6 });
  assert.equal(expanded.capacity, 4);
  assert.equal(expanded.pendingCapacity, 6);
  assert.equal(expanded.seatingCapacity, 6);
  assert.equal(expanded.tableSettingsNotice.kind, 'capacity');
  const restored = room.command(spectator.token, { type: 'setCapacity', capacity: 4 });
  assert.equal(restored.pendingCapacity, null);
  assert.equal(restored.seatingCapacity, 4);
  const extra = room.join('额外玩家');
  assert.throws(() => room.command(extra.token,
    { type: 'sit', seat: 5, buyIn: 2000 }), /无效座位/);
});

test('pending blind takes effect exactly at next hand, including heads-up and later street minimums', () => {
  const { room, first, second, spectator } = table();
  room.command(spectator.token, { type: 'setBigBlind', amount: 51 });
  assert.throws(() => room.command(spectator.token,
    { type: 'sit', seat: 2, buyIn: 19 }), /带入筹码须为 20/);
  room.command(first.token, { type: 'nextHand' });
  assert.equal(room.bigBlind, 51);
  assert.equal(room.smallBlind, 25);
  assert.equal(room.pendingBigBlind, null);
  assert.equal(room.hand.smallBlindSeat, first.seat);
  assert.equal(room.hand.bigBlindSeat, second.seat);
  assert.equal(room.hand.currentBet, 51);
  assert.equal(room.hand.lastFullRaise, 51);
  assert.equal(room.stateFor(first.token).minRaiseTo, 102);
  assert.deepEqual(room.hand.actions.slice(0, 2).map(item => [item.action, item.amount]),
    [['smallBlind', 25], ['bigBlind', 51]]);

  room.command(spectator.token, { type: 'setBigBlind', amount: 37 });
  assert.equal(room.bigBlind, 51);
  assert.equal(room.hand.bigBlind, 51);
  assert.equal(room.stateFor(first.token).pendingBigBlind, 37);
  room.command(first.token, { type: 'action', action: 'call' });
  room.command(second.token, { type: 'action', action: 'check' });
  assert.equal(room.hand.street, 1);
  assert.equal(room.stateFor(first.token).minRaiseTo, 51);
  room.command(second.token, { type: 'action', action: 'fold' });
  const saved = JSON.stringify(room.history[0]);
  assert.equal(room.history[0].smallBlind, 25);
  assert.equal(room.history[0].bigBlind, 51);
  assert.equal(room.stateFor(first.token).bigBlind, 51);
  room.nextHandAt = Date.now() - 1;
  room.command(first.token, { type: 'nextHand' });
  assert.equal(room.hand.bigBlind, 37);
  assert.equal(room.hand.smallBlind, 18);
  assert.deepEqual(room.hand.actions.slice(0, 2).map(item => item.amount), [18, 37]);
  assert.equal(room.pendingBigBlind, null);
  assert.equal(JSON.stringify(room.history[0]), saved);
});

test('pending expansion opens reservation seats without changing the current hand; shrink protects occupied tails', () => {
  const { room, first, spectator } = table();
  room.command(first.token, { type: 'nextHand' });
  const before = { capacity: room.capacity, pot: room.pot(), actingSeat: room.hand.actingSeat,
    dealerSeat: room.hand.dealerSeat, dealt: room.hand.nextCard };
  room.command(spectator.token, { type: 'setCapacity', capacity: 6 });
  const newcomer = room.join('下手玩家');
  room.command(newcomer.token, { type: 'sit', seat: 5, buyIn: 2000 });
  assert.equal(room.capacity, before.capacity);
  assert.equal(room.seats.length, 6);
  assert.equal(room.pot(), before.pot);
  assert.equal(room.hand.actingSeat, before.actingSeat);
  assert.equal(room.hand.dealerSeat, before.dealerSeat);
  assert.equal(room.hand.nextCard, before.dealt);
  assert.equal(room.stateFor(newcomer.token).hero.waitingNextHand, true);
  assert.deepEqual(room.stateFor(newcomer.token).hero.cards, []);
  assert.throws(() => room.command(spectator.token,
    { type: 'setCapacity', capacity: 4 }), /缩小人数前请先清空末尾座位/);
  room.command(newcomer.token, { type: 'stand' });
  room.command(spectator.token, { type: 'setCapacity', capacity: 4 });
  assert.equal(room.pendingCapacity, null);
  assert.equal(room.seats.length, 4);
});

test('reserved expansion seats can form the next hand when all current seats are sitting out', () => {
  const { room, first, second, spectator } = table();
  const third = room.join('丙'), fourth = room.join('丁');
  room.command(third.token, { type: 'sit', seat: 2, buyIn: 2000 });
  room.command(fourth.token, { type: 'sit', seat: 3, buyIn: 2000 });
  for (const member of [first, second, third, fourth]) {
    room.command(member.token, { type: 'sitOut' });
  }
  assert.equal(room.eligiblePlayers().length, 0);
  room.command(spectator.token, { type: 'setCapacity', capacity: 6 });
  const fifth = room.join('戊'), sixth = room.join('己');
  room.command(fifth.token, { type: 'sit', seat: 4, buyIn: 2000 });
  room.command(sixth.token, { type: 'sit', seat: 5, buyIn: 2000 });
  assert.equal(room.capacity, 4);
  assert.equal(room.eligiblePlayers().length, 2);
  room.command(fifth.token, { type: 'nextHand' });
  assert.equal(room.capacity, 6);
  assert.equal(room.handPlayers().length, 2);
  assert.equal(room.hand.actingSeat, 4);
  assert.equal(fifth.hand.hole.length, 2);
  assert.equal(sixth.hand.hole.length, 2);
});

test('queued shrink keeps old dealer and result untouched, then wraps next button to retained seat zero', () => {
  const { room, first, second, spectator } = table(6);
  room.command(first.token, { type: 'nextHand' });
  room.command(first.token, { type: 'action', action: 'fold' });
  room.hand.dealerSeat = 5; // Old button in an empty tail seat being removed.
  const savedResult = JSON.stringify(room.hand.result), oldHand = room.hand;
  room.command(spectator.token, { type: 'setCapacity', capacity: 4 });
  assert.equal(room.capacity, 6);
  assert.equal(room.hand.dealerSeat, 5);
  assert.equal(JSON.stringify(room.hand.result), savedResult);
  const late = room.join('末尾候选');
  assert.throws(() => room.command(late.token,
    { type: 'sit', seat: 5, buyIn: 2000 }), /该座位将在下一手移除/);
  room.nextHandAt = Date.now() - 1;
  room.command(second.token, { type: 'nextHand' });
  assert.equal(room.capacity, 4);
  assert.equal(room.hand.dealerSeat, 0);
  assert.equal(oldHand.dealerSeat, 5);
  assert.equal(JSON.stringify(oldHand.result), savedResult);
});

test('pending settings persist across restart and old snapshots migrate to 10/20 with no queue', () => {
  const { room, first, spectator } = table();
  room.command(spectator.token, { type: 'setBigBlind', amount: 73 });
  room.command(spectator.token, { type: 'setCapacity', capacity: 6 });
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(restored.bigBlind, 20);
  assert.equal(restored.pendingBigBlind, 73);
  assert.equal(restored.pendingCapacity, 6);
  assert.equal(restored.seats.length, 6);
  assert.equal(restored.tableSettingsNotice.kind, 'capacity');
  restored.command(first.token, { type: 'nextHand' });
  assert.equal(restored.bigBlind, 73);
  assert.equal(restored.smallBlind, 36);
  assert.equal(restored.capacity, 6);
  assert.equal(restored.hand.bigBlind, 73);

  const legacy = JSON.parse(JSON.stringify(room.toJSON()));
  delete legacy.bigBlind;
  delete legacy.smallBlind;
  delete legacy.pendingBigBlind;
  delete legacy.pendingCapacity;
  delete legacy.tableSettingsNotice;
  legacy.seats.length = legacy.capacity;
  const migrated = Room.fromJSON(legacy);
  assert.equal(migrated.bigBlind, BIG_BLIND);
  assert.equal(migrated.smallBlind, SMALL_BLIND);
  assert.equal(migrated.pendingBigBlind, null);
  assert.equal(migrated.pendingCapacity, null);
  assert.equal(migrated.tableSettingsNotice, null);
});
