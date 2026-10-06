import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, ACTION_TIME_MS, TIMEBANK_BLOCK_MS, TIMEBANK_BLOCK_COST } from '../room.js';

function readyRoom(count = 2) {
  const room = new Room('581234', Math.max(4, count));
  const players = [];
  for (let seat = 0; seat < count; seat++) {
    const player = room.join(`计时玩家${seat}`);
    room.command(player.token, { type: 'sit', seat, buyIn: 2000 });
    players.push(player);
  }
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players };
}

test('35-second free clock buys a 10-second block without altering betting or blind commitments', () => {
  assert.equal(ACTION_TIME_MS, 35_000);
  assert.equal(TIMEBANK_BLOCK_MS, 10_000);
  assert.equal(TIMEBANK_BLOCK_COST, 10);
  const { room, players: [smallBlind, bigBlind] } = readyRoom();
  const before = room.hand.actionDeadline;
  const state = room.command(smallBlind.token, { type: 'timebank', enabled: true });
  assert.equal(state.hero.timebankEnabled, true);
  assert.equal(state.hero.canUseTimebank, true);
  assert.equal(room.hand.actionDeadline, before);
  room.command(smallBlind.token, { type: 'timebank', enabled: true });
  assert.equal(smallBlind.hand.timebankCommit, 0);

  const expectedAction = { handNo: room.handNo, streetIndex: room.hand.street,
    actingSeat: room.hand.actingSeat, actionDeadline: room.hand.actionDeadline,
    currentBet: room.hand.currentBet };
  room.hand.actionDeadline = Date.now() - 1;
  assert.throws(() => room.command(smallBlind.token, { type: 'action', action: 'fold',
    expectedAction }), /行动已更新/);
  assert.equal(smallBlind.hand.timebankCommit, 10);
  assert.equal(smallBlind.hand.folded, false);
  assert.equal(room.timeoutAction(), false);
  assert.equal(room.hand.actingSeat, smallBlind.seat);
  assert.ok(room.hand.actionDeadline > Date.now() + 9_000);
  assert.equal(room.stateFor(smallBlind.token).actionWindowMs, 10_000);
  assert.equal(room.stateFor(smallBlind.token).actionTimebankBlocks, 1);
  assert.equal(smallBlind.stack, 1980);
  assert.equal(smallBlind.hand.streetCommit, 10);
  assert.equal(smallBlind.hand.totalCommit, 10);
  assert.equal(smallBlind.hand.timebankCommit, 10);
  assert.equal(room.pot(), 40);
  assert.equal(room.ledger().find(item => item.playerId === smallBlind.id).profitLoss, 0);
  assert.equal(room.hand.actions.at(-1).action, 'timebank');

  room.command(smallBlind.token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.equal(smallBlind.hand.timebankEnabled, false);
  assert.deepEqual(room.hand.result.winners[0], { seat: bigBlind.seat, playerId: bigBlind.id,
    nickname: bigBlind.nickname, amount: 40, totalCommit: 20, netProfit: 20 });
  assert.equal(smallBlind.stack + bigBlind.stack, 4000);
});

test('a player who pays timebank and wins by fold has net profit after the fee', () => {
  const { room, players: [smallBlind, bigBlind] } = readyRoom();
  room.command(smallBlind.token, { type: 'timebank', enabled: true });
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  room.command(smallBlind.token, { type: 'action', action: 'raise', amount: 40 });
  room.command(bigBlind.token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.hand.result.winners[0], { seat: smallBlind.seat, playerId: smallBlind.id,
    nickname: smallBlind.nickname, amount: 70, totalCommit: 40, netProfit: 20 });
  assert.equal(smallBlind.stack + bigBlind.stack, 4000);
});

test('late callback or restart charges only one block, never for inaccessible elapsed time', () => {
  const { room, players: [actor] } = readyRoom();
  room.command(actor.token, { type: 'timebank', enabled: true });
  room.hand.actionDeadline = Date.now() - 20_001;
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  const recoveredActor = restored.requireMember(actor.token);
  assert.equal(restored.timeoutAction(), true);
  assert.equal(recoveredActor.hand.timebankCommit, 10);
  assert.equal(restored.hand.actionTimebankBlocks, 1);
  assert.equal(restored.hand.actions.at(-1).target, 1);
  assert.ok(restored.hand.actionDeadline > Date.now() + 9_000);
  assert.equal(restored.timeoutAction(), false);
  assert.equal(recoveredActor.hand.timebankCommit, 10);
  const chargedSnapshot = JSON.parse(JSON.stringify(restored.toJSON()));
  const reloaded = Room.fromJSON(chargedSnapshot);
  assert.equal(reloaded.timeoutAction(), false);
  assert.equal(reloaded.requireMember(actor.token).hand.timebankCommit, 10);
  restored.command(actor.token, { type: 'timebank', enabled: false });
  assert.equal(recoveredActor.hand.timebankEnabled, false);
  assert.equal(recoveredActor.hand.timebankCommit, 10);
  assert.ok(restored.hand.actionDeadline > Date.now());
  restored.hand.actionDeadline = Date.now() - 1;
  assert.equal(restored.timeoutAction(), true);
  assert.equal(recoveredActor.hand.timebankCommit, 10);
  assert.equal(recoveredActor.sittingOut, true);
});

test('fees are main-pot dead money with unchanged side-pot caps and conserved showdown chips', () => {
  const { room, players } = readyRoom(3);
  for (const [index, player] of players.entries()) {
    player.hand.totalCommit = [50, 100, 100][index];
    player.stack = 2000 - player.hand.totalCommit;
  }
  players[0].stack -= 10;
  players[0].hand.timebankCommit = 10;
  room.hand.board = Array.from({ length: 5 }, () => room.draw());
  room.hand.street = 3;
  assert.equal(room.pot(), 260);
  assert.deepEqual(room.buildPots().map(pot => pot.amount), [160, 100]);
  room.showdown();
  assert.equal(room.hand.result.pots[0].amount, 160);
  assert.equal(room.hand.result.pots[1].amount, 100);
  assert.equal(room.hand.result.winners.reduce((sum, item) => sum + item.amount, 0), 260);
  assert.equal(players.reduce((sum, player) => sum + player.stack, 0), 6000);
  for (const winner of room.hand.result.winners) {
    const player = players[winner.seat];
    assert.equal(winner.netProfit, winner.amount - player.hand.totalCommit - player.hand.timebankCommit);
  }
});

test('grand gift pause shifts a paid action deadline without charging during the pause', () => {
  const { room, players: [actor] } = readyRoom();
  room.command(actor.token, { type: 'timebank', enabled: true });
  const startAt = Date.now();
  const deadline = room.hand.actionDeadline;
  room.activateGrandPause({ startAt, grandEndAt: startAt + 8000,
    flightStartAt: startAt + 8000, flightEndAt: startAt + 10000, endAt: startAt + 10000 });
  assert.equal(room.hand.actionDeadline, deadline + 10000);
  assert.equal(room.timeoutAction(), false);
  assert.equal(actor.hand.timebankCommit, 0);
});

test('the final ten chips buy the full block but never become a zero-chip call', () => {
  const { room, players: [actor] } = readyRoom();
  actor.stack = 10;
  room.command(actor.token, { type: 'timebank', enabled: true });
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(actor.stack, 0);
  assert.equal(actor.hand.allIn, false);
  assert.equal(actor.hand.needsAction, true);
  assert.equal(room.hand.actingSeat, actor.seat);
  assert.ok(room.hand.actionDeadline > Date.now() + 9_000);
  assert.throws(() => room.command(actor.token, { type: 'action', action: 'call' }), /可用筹码不足/);
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(actor.hand.folded, true);
  assert.equal(room.status, 'finished');
  assert.equal(actor.hand.timebankCommit, 10);
});

test('the final paid block can still be checked, then zero-stack player keeps showdown claim', () => {
  const { room, players: [smallBlind, bigBlind] } = readyRoom();
  room.command(smallBlind.token, { type: 'action', action: 'call' });
  assert.equal(room.hand.actingSeat, bigBlind.seat);
  assert.equal(room.toCall(bigBlind), 0);
  bigBlind.stack = 10;
  room.command(bigBlind.token, { type: 'timebank', enabled: true });
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(bigBlind.stack, 0);
  assert.equal(bigBlind.hand.allIn, false);
  room.command(bigBlind.token, { type: 'action', action: 'check' });
  assert.equal(bigBlind.hand.folded, false);
  assert.equal(bigBlind.hand.allIn, true);
  assert.equal(bigBlind.hand.timebankEnabled, false);
  assert.equal(room.hand.actingSeat, null);
  assert.equal(room.hand.runout?.phase !== undefined, true);
});

test('a new seat waiting for next hand cannot be timed out before receiving cards', () => {
  const { room, players: [first] } = readyRoom();
  const newcomer = room.join('新入座');
  room.command(newcomer.token, { type: 'sit', seat: 2, buyIn: 2000 });
  assert.equal(room.stateFor(newcomer.token).hero.waitingNextHand, true);
  assert.equal(newcomer.hand, null);
  const originalActor = room.hand.actingSeat;
  room.hand.actingSeat = newcomer.seat; // Stale actor from malformed legacy state.
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(newcomer.pendingSitOut, false);
  assert.equal(newcomer.sittingOut, false);
  assert.equal(newcomer.hand, null);
  assert.notEqual(room.hand.actingSeat, newcomer.seat);
  assert.ok(room.hand.actingSeat === originalActor || room.hand.actingSeat === first.seat);
});
