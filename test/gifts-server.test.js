import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Room, GRAND_DISPLAY_MS, GRAND_FLIGHT_MS } from '../room.js';

function seatedRoom(stacks = [2000, 2000]) {
  const room = new Room('741852', 4);
  const players = stacks.map((buyIn, seat) => {
    const player = room.join(`玩家${seat}`);
    room.command(player.token, { type: 'sit', seat, buyIn });
    return player;
  });
  return { room, players };
}

const give = (room, sender, recipient, quantity, roseType = 'whiteRose') =>
  room.gift(sender, { recipientId: recipient.id, quantity, roseType, requestId: randomUUID() });

test('waiting gifts settle immediately in both rose colors and auto rebuy when short', () => {
  const { room, players: [a, b] } = seatedRoom();
  const white = give(room, a, b, 3);
  assert.equal(white.effect.roseType, 'whiteRose');
  assert.equal(white.effect.settlementPending, false);
  assert.deepEqual([a.stack, b.stack], [1850, 2150]);
  const id = randomUUID();
  const red = room.gift(a, { recipientId: b.id, quantity: 40, roseType: 'redRose', requestId: id });
  assert.equal(red.effect.roseType, 'redRose');
  assert.deepEqual([a.stack, b.stack], [1850, 4150]);
  assert.equal(a.rebuyTotal, 2000);
  assert.equal(a.rebuyCount, 1);
  assert.equal(room.gift(a, { recipientId: b.id, quantity: 40, requestId: id }).duplicate, true);
  assert.equal(room.ledger()[0].pokerProfitLoss, 0);
  assert.equal(room.ledger()[1].pokerProfitLoss, 0);
  assert.throws(() => give(room, a, a, 1), /自己/);
  assert.throws(() => give(room, a, b, 20_001), /数量/);
});

test('playing gifts, rebuy and unload leave poker balances unchanged until the hand settles', () => {
  const { room, players: [a, b] } = seatedRoom();
  room.command(a.token, { type: 'nextHand' });
  const initialStacks = [a.stack, b.stack], initialPot = room.pot(), maxRaise = room.maxRaiseTo(a);
  const white = give(room, a, b, 2);
  const red = give(room, b, a, 1, 'redRose');
  room.rebuy(a, 2000, randomUUID());
  room.unload(a, randomUUID());
  assert.equal(white.effect.settlementPending, true);
  assert.equal(red.effect.settlementPending, true);
  assert.deepEqual([a.stack, b.stack], initialStacks);
  assert.equal(room.pot(), initialPot);
  assert.equal(room.maxRaiseTo(a), maxRaise);
  const state = room.stateFor(a.token);
  assert.equal(state.hero.pendingRebuy, 2000);
  assert.equal(state.hero.pendingUnload, 2000);
  assert.equal(state.hero.pendingGiftSent, 100);
  assert.equal(state.hero.pendingGiftReceived, 50);
  assert.equal(state.hero.pendingGifts.length, 2);
  const spectator = room.join('观众');
  assert.ok(!JSON.stringify(room.stateFor(spectator.token)).includes('whiteRose'));
  room.command(a.token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.deepEqual([a.stack, b.stack], [1940, 2060]);
  assert.equal(a.cashOutTotal, 2000);
  assert.equal(a.pendingRebuy, 0);
  assert.equal(room.hand.financialSettlement.gifts.length, 2);
  assert.equal(room.hand.financialSettlement.unloads[0].accepted, true);
  assert.equal(room.history.at(-1).result.financialSettlement, undefined);
  assert.equal(room.ledger().reduce((sum, item) => sum + item.stack + item.cashOutTotal, 0), 6000);
});

test('reciprocal gifts each use gross spend for auto topup, regardless of receipt order', () => {
  const { room, players: [a, b] } = seatedRoom();
  room.command(a.token, { type: 'nextHand' });
  give(room, a, b, 98);
  give(room, b, a, 98, 'redRose');
  room.command(a.token, { type: 'action', action: 'fold' });
  assert.deepEqual(room.hand.financialSettlement.autoRebuys.map(item => item.amount).sort(), [4000, 4000]);
  assert.equal(a.rebuyTotal, 4000);
  assert.equal(b.rebuyTotal, 4000);
  assert.equal(room.ledger().reduce((sum, item) => sum + item.stack + item.cashOutTotal, 0), 12_000);
});

test('queued unload may be requested while active, then cancels without automatic rebuy', () => {
  const { room, players: [a] } = seatedRoom([20, 2000]);
  room.command(a.token, { type: 'nextHand' });
  room.unload(a, randomUUID());
  room.command(a.token, { type: 'action', action: 'fold' });
  assert.equal(room.hand.financialSettlement.unloads[0].accepted, false);
  assert.equal(a.lastFinancialNotice.type, 'unloadCanceled');
  assert.equal(a.rebuyTotal, 0);
  assert.equal(a.cashOutTotal, 0);
});

test('grand gift pauses only its room and does not transfer chips before the hand finishes', () => {
  const { room, players: [a, b] } = seatedRoom([10_000, 10_000]);
  const other = seatedRoom().room;
  room.command(a.token, { type: 'nextHand' });
  const deadline = room.hand.actionDeadline, otherDeadline = other.nextHandAt, stack = a.stack;
  const { effect } = give(room, a, b, 99, 'redRose');
  assert.equal(effect.scope, 'grand');
  assert.equal(effect.settlementPending, true);
  assert.equal(effect.grandEndAt - effect.startAt, GRAND_DISPLAY_MS);
  assert.equal(effect.flightEndAt - effect.grandEndAt, GRAND_FLIGHT_MS);
  assert.equal(a.stack, stack);
  assert.ok(Math.abs((room.hand.actionDeadline - deadline) - 10_000) < 100);
  assert.equal(other.nextHandAt, otherDeadline);
  assert.throws(() => room.rebuy(a, 2000, randomUUID()), /暂停/);
  room.pause.endAt = Date.now() - 1;
  room.endPauseIfDue();
  assert.throws(() => give(room, a, b, 99), /冷却/);
  const spectator = room.join('观众');
  const sneak = room.sneak(spectator, { requestId: randomUUID() });
  assert.equal(sneak.effect.cost, 0);
});

test('settlement validates the full ledger before any balance changes', () => {
  const { room, players: [a, b] } = seatedRoom();
  a.stack = 0;
  a.rebuyTotal = Number.MAX_SAFE_INTEGER - 1000;
  const before = [a.stack, b.stack, a.giftSentTotal, b.giftReceivedTotal];
  assert.throws(() => give(room, a, b, 1), /礼物累计金额过大/);
  assert.deepEqual([a.stack, b.stack, a.giftSentTotal, b.giftReceivedTotal], before);
  assert.equal(room.transactionSeq, 0);
});
