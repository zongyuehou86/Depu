import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeFairDeck, cardProof, verifyCardProof, cardLabel, evaluateBest, compareValues } from './engine.js';
import { Room, ACTION_TIME_MS, NEXT_HAND_DELAY_MS, RUNOUT_VOTE_MS,
  RUNOUT_TURN_MS, RUNOUT_RIVER_MS, calculateShowdownEquity } from './room.js';

function roomWithPlayers(count = 2, stacks = []) {
  const room = new Room('123456', Math.max(4, count));
  const members = [];
  for (let seat = 0; seat < count; seat++) {
    const member = room.join(`玩家${seat + 1}`);
    room.command(member.token, { type: 'sit', seat, buyIn: stacks[seat] ?? 2000 });
    members.push(member);
  }
  return { room, members };
}

function cards(text) {
  return text.split(' ').map(label => {
    const card = Array.from({ length: 52 }, (_, i) => i).find(value => cardLabel(value) === label);
    if (card === undefined) throw new Error(`未知测试牌 ${label}`);
    return card;
  });
}

function finishRunout(room) {
  let steps = 0;
  while (room.status === 'playing' && room.hand.runout) {
    if (++steps > 10) throw new Error('跑马未能结算');
    const runout = room.hand.runout;
    if (runout.phase === 'trailingVote') {
      room.command(room.seatMember(runout.trailingSeat).token, { type: 'runoutChoice', times: 1 });
    } else if (runout.phase === 'leaderVote') {
      room.command(room.seatMember(runout.leadingSeat).token, { type: 'runoutResponse', accept: false });
    } else if (runout.phase === 'dealing' || runout.phase === 'firstBoardPause') {
      runout.nextCardAt = Date.now() - 1;
      assert.equal(room.advanceRunoutIfDue(), true);
    } else throw new Error(`未知跑马阶段 ${runout.phase}`);
  }
}

test('five to seven card evaluator handles wheel straights and hand strength', () => {
  const wheel = evaluateBest(cards('As 2d 3h 4c 5s'));
  const sixHigh = evaluateBest(cards('2s 3d 4h 5c 6s'));
  const straightFlush = evaluateBest(cards('Ts Js Qs Ks As 2d 3c'));
  const fourKind = evaluateBest(cards('Ac Ad Ah As Kc 2d 3h'));
  assert.deepEqual(wheel, [4, 5]);
  assert.deepEqual(sixHigh, [4, 6]);
  assert.equal(compareValues(sixHigh, wheel), 1);
  assert.equal(compareValues(straightFlush, fourKind), 1);
});

test('new independent dealer is deterministic for a fixed UTC time and entropy, with unbiased unique deck and verifiable commitments', () => {
  const utc = '2026-10-02T00:00:00.000Z';
  const entropy = Buffer.alloc(32, 7);
  const first = makeFairDeck(utc, entropy);
  const second = makeFairDeck(utc, entropy);
  assert.deepEqual(first.deck, second.deck);
  assert.equal(new Set(first.deck).size, 52);
  assert.equal(first.seedCommitment, second.seedCommitment);
  assert.notEqual(first.seedCommitment, makeFairDeck(utc, Buffer.alloc(32, 8)).seedCommitment);
  for (let position = 0; position < 52; position++) {
    const proof = cardProof(first, position);
    assert.equal(proof.card, cardLabel(first.deck[position]));
    assert.equal(verifyCardProof(first.deckRoot, proof), true);
    assert.equal(verifyCardProof(first.deckRoot, { ...proof, card: proof.card === 'As' ? 'Ks' : 'As' }), false);
  }
});

test('four player hand rotates correctly and does not disclose other private cards', () => {
  const { room, members } = roomWithPlayers(4);
  room.command(members[0].token, { type: 'nextHand' });
  assert.equal(room.hand.dealerSeat, 0);
  assert.equal(room.hand.smallBlindSeat, 1);
  assert.equal(room.hand.bigBlindSeat, 2);
  assert.equal(room.hand.actingSeat, 3);
  const state = room.stateFor(members[0].token);
  assert.equal(state.hero.cards.length, 2);
  assert.equal(state.seats.every(seat => seat.shownCards === null), true);
  assert.equal(state.fairness.visibleCardProofs.length, 0);
  assert.equal(JSON.stringify(state).includes(room.hand.fair.seed), false);
  assert.equal(JSON.stringify(state).includes(JSON.stringify(room.hand.fair.deck)), false);
  assert.throws(() => room.command(members[0].token, { type: 'action', action: 'call' }), /当前未轮到你/);
  for (const seat of [3, 0, 1]) room.command(members[seat].token, { type: 'action', action: 'call' });
  room.command(members[2].token, { type: 'action', action: 'check' });
  const flop = room.stateFor(members[0].token);
  assert.equal(flop.board.length, 3);
  assert.ok(flop.hero.handName);
  for (const proof of flop.fairness.visibleCardProofs) assert.equal(verifyCardProof(flop.fairness.deckRoot, proof), true);
});

test('heads-up all-in showdown conserves chips and reveals only showdown contestants', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'raise', amount: 2000 });
  room.command(members[1].token, { type: 'action', action: 'call' });
  assert.equal(room.status, 'playing');
  assert.equal(room.hand.board.length, 0);
  assert.equal(room.stateFor(members[0].token).fairness.visibleCardProofs.length, 4);
  finishRunout(room);
  assert.equal(room.status, 'finished');
  assert.equal(room.hand.board.length, 5);
  assert.equal(members.reduce((sum, member) => sum + member.stack, 0), 4000);
  assert.equal(room.history.length, 1);
  assert.equal(room.history[0].shownHands.length, 2);
  assert.equal(room.stateFor(members[0].token).fairness.visibleCardProofs.length, 9);
});

test('folded hands remain private until their owner voluntarily reveals after settlement', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.equal(room.stateFor(members[1].token).seats[0].shownCards, null);
  assert.equal(room.history[0].shownHands.length, 0);
  room.command(members[0].token, { type: 'reveal' });
  assert.equal(room.stateFor(members[1].token).seats[0].shownCards.length, 2);
  assert.equal(room.history[0].shownHands.length, 1);
  assert.throws(() => room.command(members[0].token, { type: 'reveal' }), /只能亮出自己当前手/);
});

test('fold winner net profit is pot return minus own blind, before queued gifts and rebuy or unload', () => {
  const { room, members: [smallBlind, bigBlind] } = roomWithPlayers();
  room.command(smallBlind.token, { type: 'nextHand' });
  room.gift(bigBlind, { recipientId: smallBlind.id, quantity: 1, requestId: randomUUID() });
  room.rebuy(bigBlind, 2000, randomUUID());
  room.unload(bigBlind, randomUUID());
  room.command(smallBlind.token, { type: 'action', action: 'fold' });
  const winner = room.hand.result.winners[0];
  assert.deepEqual(winner, { seat: 1, nickname: bigBlind.nickname,
    amount: 30, totalCommit: 20, netProfit: 10 });
  assert.equal(bigBlind.stack, 1960);
  assert.equal(room.history.at(-1).result.winners[0].netProfit, 10);
});

test('legacy current hand backfills net profit by dealt participant, never a replacement seat', () => {
  const { room, members: [smallBlind, bigBlind] } = roomWithPlayers();
  room.command(smallBlind.token, { type: 'nextHand' });
  room.command(smallBlind.token, { type: 'action', action: 'fold' });
  room.command(bigBlind.token, { type: 'stand' });
  const replacement = room.join('新玩家');
  room.command(replacement.token, { type: 'sit', seat: 1, buyIn: 4000 });
  const snapshot = JSON.parse(JSON.stringify(room.toJSON()));
  for (const result of [snapshot.hand.result, snapshot.history.at(-1).result]) {
    delete result.winners[0].totalCommit;
    delete result.winners[0].netProfit;
  }
  const incomplete = JSON.parse(JSON.stringify(snapshot));
  incomplete.members.find(member => member.id === bigBlind.id).hand.totalCommit = null;
  const restored = Room.fromJSON(snapshot);
  assert.equal(restored.hand.result.winners[0].totalCommit, 20);
  assert.equal(restored.hand.result.winners[0].netProfit, 10);
  assert.equal(restored.history.at(-1).result.winners[0].netProfit, 10);
  const unverified = Room.fromJSON(incomplete);
  assert.equal(unverified.hand.result.winners[0].netProfit, undefined);
  assert.equal(unverified.history.at(-1).result.winners[0].netProfit, undefined);
});

test('rebuy requested during play settles immediately after this hand and survives serialization', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'rebuy', amount: 2000 });
  assert.equal(members[0].pendingRebuy, 2000);
  assert.equal(members[0].rebuyCount, 0);
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  const player0 = restored.requireMember(members[0].token);
  assert.equal(player0.pendingRebuy, 2000);
  assert.equal(restored.hand.fair.seedCommitment, room.hand.fair.seedCommitment);
  restored.command(members[0].token, { type: 'action', action: 'fold' });
  assert.equal(player0.pendingRebuy, 0);
  assert.equal(player0.rebuyCount, 1);
  assert.equal(player0.rebuyTotal, 2000);
  assert.equal(player0.stack, 3990);
  restored.nextHandAt = Date.now() - 1;
  restored.autoStartIfDue();
  assert.equal(player0.pendingRebuy, 0);
  assert.equal(player0.rebuyCount, 1);
  assert.equal(player0.rebuyTotal, 2000);
  assert.equal(player0.stack, 3970);
});

test('side pots conserve total chips across three unequal stacks', () => {
  const { room, members } = roomWithPlayers(3, [200, 500, 1000]);
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'raise', amount: 200 });
  room.command(members[1].token, { type: 'action', action: 'raise', amount: 500 });
  room.command(members[2].token, { type: 'action', action: 'call' });
  assert.equal(room.hand.runout.reason, 'multiway');
  assert.equal(room.hand.runout.times, 1);
  assert.equal(room.hand.runout.equity.length, 3);
  finishRunout(room);
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.hand.result.pots.map(pot => pot.amount), [600, 600]);
  assert.equal(members.reduce((sum, member) => sum + member.stack, 0), 1700);
  assert.deepEqual(room.hand.actions.slice(0, 5).map(item => [item.action, item.amount, item.target]), [
    ['smallBlind', 10, null], ['bigBlind', 20, null],
    ['raise', 200, 200], ['raise', 490, 500], ['call', 480, null]
  ]);
});

test('a short all-in does not reopen raising for a player who already acted', () => {
  const { room, members } = roomWithPlayers(3, [2000, 110, 2000]);
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'raise', amount: 100 });
  room.command(members[1].token, { type: 'action', action: 'raise', amount: 110 });
  room.command(members[2].token, { type: 'action', action: 'call' });
  assert.equal(room.hand.actingSeat, 0);
  assert.equal(room.canRaise(members[0]), false);
  assert.throws(() => room.command(members[0].token, { type: 'action', action: 'raise', amount: 200 }), /当前不能加注/);
  room.command(members[0].token, { type: 'action', action: 'call' });
  assert.equal(room.hand.street, 1);
});

test('expired action deadline automatically folds when facing a bet', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(room.status, 'finished');
  assert.equal(room.hand.result.type, 'fold');
  assert.equal(room.events.some(event => /行动超时/.test(event.text)), true);
});

test('temporary leave folds an active hand, skips its turn and pauses automatic start until two return', () => {
  const { room, members } = roomWithPlayers(3);
  assert.equal(ACTION_TIME_MS, 30_000);
  assert.equal(NEXT_HAND_DELAY_MS, 5_000);
  room.command(members[0].token, { type: 'nextHand' });
  assert.equal(room.hand.actingSeat, 0);
  room.command(members[0].token, { type: 'sitOut' });
  assert.equal(room.hand.actingSeat, 1);
  assert.equal(members[0].hand.folded, true);
  room.command(members[2].token, { type: 'sitOut' });
  assert.equal(room.status, 'finished');
  assert.equal(room.nextHandAt, null);
  assert.equal(members[2].stack, 1980);
  room.command(members[0].token, { type: 'return' });
  assert.ok(room.nextHandAt > Date.now());
  assert.throws(() => room.command(members[1].token, { type: 'nextHand' }), /请等待本手展示结束/);
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.handNo, 2);
  assert.equal(room.status, 'playing');
  assert.equal(members[2].hand, null);
  assert.equal(room.stateFor(members[2].token).seats[2].sittingOut, true);
});

test('a player cannot reveal a previous folded hand after the next hand begins', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  const previousCards = room.stateFor(members[0].token).hero.cards;
  room.command(members[0].token, { type: 'action', action: 'fold' });
  assert.ok(room.nextHandAt > Date.now());
  assert.equal(room.stateFor(members[1].token).seats[0].shownCards, null);
  room.nextHandAt = Date.now() - 1;
  room.autoStartIfDue();
  assert.throws(() => room.command(members[0].token, { type: 'reveal', handNo: 1 }), /只能在当前手结算后/);
  const watching = room.stateFor(members[1].token);
  assert.equal(previousCards.length, 2);
  assert.equal(room.history[0].shownHands.length, 0);
  assert.equal(watching.seats[0].shownCards, null);
  assert.equal(watching.history[0].fairness.visibleCardProofs.length, 0);
  assert.deepEqual(room.stateFor(members[0].token).hero.revealableHands, []);
});

test('sitting out after going all-in keeps the current showdown claim but skips later hands', () => {
  const { room, members } = roomWithPlayers();
  assert.ok(room.nextHandAt > Date.now());
  room.command(members[0].token, { type: 'nextHand' });
  assert.ok(room.hand.actionDeadline <= Date.now() + ACTION_TIME_MS);
  room.command(members[0].token, { type: 'action', action: 'raise', amount: 2000 });
  room.command(members[0].token, { type: 'sitOut' });
  assert.equal(members[0].hand.folded, false);
  assert.equal(room.hand.actingSeat, 1);
  room.command(members[1].token, { type: 'action', action: 'call' });
  finishRunout(room);
  assert.equal(room.status, 'finished');
  assert.equal(room.hand.result.type, 'showdown');
  assert.equal(room.nextHandAt, null);
  assert.equal(room.history[0].shownHands.length, 2);
});

test('timed-out check preserves the current hand and may be cancelled before settlement', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'call' });
  room.hand.actionDeadline = Date.now() - 1;
  room.timeoutAction();
  assert.equal(room.hand.street, 1);
  assert.equal(members[1].hand.folded, false);
  assert.equal(members[1].pendingSitOut, true);
  assert.equal(members[1].sittingOut, false);
  assert.equal(room.stateFor(members[1].token).hero.pendingSitOut, true);
  assert.deepEqual(room.hand.actions.slice(-2).map(item => [item.type, item.action, item.source]),
    [['timeout', 'timeout', 'system'], ['action', 'check', 'timeout']]);
  room.command(members[1].token, { type: 'return' });
  assert.equal(members[1].pendingSitOut, false);
  assert.equal(members[1].awayHands, 0);
  room.command(members[1].token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'finished');
  assert.equal(members[1].sittingOut, false);
});

test('timeout that ends a hand seats the player out from the next hand', () => {
  const { room, members } = roomWithPlayers();
  room.command(members[0].token, { type: 'nextHand' });
  room.hand.actionDeadline = Date.now() - 1;
  room.timeoutAction();
  assert.equal(room.status, 'finished');
  assert.equal(members[0].sittingOut, true);
  assert.equal(members[0].pendingSitOut, false);
  assert.equal(members[0].awayHands, 0);
  assert.equal(room.nextHandAt, null);
  assert.equal(room.stateFor(members[0].token).hero.lastPresenceEvent.type, 'timeoutSitOut');
  assert.deepEqual(room.hand.actions.slice(-2).map(item => [item.type, item.action, item.source]),
    [['timeout', 'timeout', 'system'], ['action', 'fold', 'timeout']]);
});

test('five complete skipped hands automatically free the seat and keep the bankroll', () => {
  const { room, members } = roomWithPlayers(3);
  room.command(members[2].token, { type: 'sitOut' });
  for (let number = 1; number <= 5; number++) {
    if (number === 1) room.command(members[0].token, { type: 'nextHand' });
    else { room.nextHandAt = Date.now() - 1; room.autoStartIfDue(); }
    assert.equal(members[2].skippedHandNo, number);
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: 'fold' });
    assert.equal(members[2].awayHands, number);
    assert.equal(members[2].seat, number === 5 ? null : 2);
  }
  assert.equal(members[2].cashOutTotal, 2000);
  assert.equal(members[2].stack, 0);
  assert.equal(members[2].lastPresenceEvent.type, 'autoStand');
  assert.equal(room.seats[2], null);
  assert.equal(room.stateFor(members[2].token).hero.awayHands, 5);
});

test('returning resets the consecutive absence count and new hands record real paid amounts', () => {
  const { room, members } = roomWithPlayers(3);
  room.command(members[2].token, { type: 'sitOut' });
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'fold' });
  assert.equal(members[2].awayHands, 1);
  room.command(members[2].token, { type: 'return' });
  assert.equal(members[2].awayHands, 0);
  room.nextHandAt = Date.now() - 1;
  room.autoStartIfDue();
  assert.equal(room.hand.recordVersion, 1);
  assert.match(room.hand.startedAt, /Z$/);
  assert.deepEqual(room.hand.actions.slice(0, 2).map(item => [item.type, item.amount]),
    [['blind', 10], ['blind', 20]]);
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'action', action: 'raise', amount: 60 });
  const raise = room.hand.actions.at(-1);
  assert.equal(raise.action, 'raise');
  assert.equal(raise.amount, 60);
  assert.equal(raise.target, 60);
  assert.equal(raise.streetIndex, 0);
  assert.equal(raise.source, 'player');
  assert.match(raise.at, /Z$/);
});

test('new arrivals may take and change an empty seat during play without joining the current hand', () => {
  const { room, members } = roomWithPlayers(3);
  room.command(members[0].token, { type: 'setCapacity', capacity: 5 });
  room.command(members[0].token, { type: 'nextHand' });
  const before = {
    actor: room.hand.actingSeat, dealer: room.hand.dealerSeat,
    pot: room.pot(), dealt: room.hand.nextCard,
    holes: members.map(member => [...member.hand.hole])
  };
  const newcomer = room.join('新玩家');
  room.command(newcomer.token, { type: 'sit', seat: 3, buyIn: 2000 });
  let state = room.stateFor(newcomer.token);
  assert.equal(state.hero.waitingNextHand, true);
  assert.equal(state.seats[3].waitingNextHand, true);
  assert.equal(state.seats[3].inHand, false);
  assert.deepEqual(state.hero.cards, []);
  assert.equal(room.hand.actingSeat, before.actor);
  assert.equal(room.hand.dealerSeat, before.dealer);
  assert.equal(room.pot(), before.pot);
  assert.equal(room.hand.nextCard, before.dealt);
  assert.deepEqual(members.map(member => member.hand.hole), before.holes);
  assert.equal(room.handPlayers().length, 3);
  assert.throws(() => room.command(newcomer.token, { type: 'action', action: 'fold' }), /当前未轮到你/);

  room.command(newcomer.token, { type: 'stand' });
  assert.equal(room.seats[3], null);
  room.command(newcomer.token, { type: 'sit', seat: 4, buyIn: 2000 });
  assert.equal(room.stateFor(newcomer.token).hero.waitingNextHand, true);
  assert.equal(room.ledger().find(person => person.playerId === newcomer.id).profitLoss, 0);
  assert.equal(room.pot(), before.pot);
  while (room.status === 'playing') {
    const actor = room.seatMember(room.hand.actingSeat);
    room.command(actor.token, { type: 'action', action: 'fold' });
  }
  assert.equal(room.history[0].result.pot, before.pot);
  room.nextHandAt = Date.now() - 1;
  room.autoStartIfDue();
  state = room.stateFor(newcomer.token);
  assert.equal(state.hero.waitingNextHand, false);
  assert.equal(state.seats[4].inHand, true);
  assert.equal(state.hero.cards.length, 2);
});

test('a player dealt into the current hand cannot stand even after folding', () => {
  const { room, members } = roomWithPlayers(3);
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'fold' });
  assert.equal(room.status, 'playing');
  assert.throws(() => room.command(members[0].token, { type: 'stand' }), /已参与当前手/);
  assert.equal(room.seats[0], members[0].token);
});

test('exposed-card equity is exact and excludes unseen burn or folded cards', () => {
  const result = calculateShowdownEquity([
    { seat: 0, hole: cards('Jh Th') },
    { seat: 1, hole: cards('2c 3d') }
  ], cards('Ah Kh Qh'));
  assert.equal(result.scenarios, 990);
  assert.equal(result.equity[0].equityPct, 100);
  assert.equal(result.equity[1].equityPct, 0);
  assert.equal(RUNOUT_VOTE_MS, 15_000);
  assert.equal(RUNOUT_TURN_MS, 5_000);
  assert.equal(RUNOUT_RIVER_MS, 10_000);
});

test('two runouts reveal only due cards and preserve spectators, proofs and total chips', () => {
  let setup;
  for (let attempt = 0; attempt < 12; attempt++) {
    setup = roomWithPlayers();
    setup.room.command(setup.members[0].token, { type: 'nextHand' });
    setup.room.command(setup.members[0].token, { type: 'action', action: 'raise', amount: 2000 });
    setup.room.command(setup.members[1].token, { type: 'action', action: 'call' });
    if (setup.room.hand.runout.eligibleForTwice) break;
  }
  const { room, members } = setup;
  const runout = room.hand.runout;
  assert.equal(runout.eligibleForTwice, true);
  const spectator = room.join('观众');
  const watching = room.stateFor(spectator.token);
  assert.equal(watching.hero.canAct, false);
  assert.deepEqual(watching.hero.cards, []);
  assert.equal(watching.runout.phase, 'trailingVote');
  assert.equal(watching.runout.boards[0].length, 0);
  assert.equal(watching.fairness.visibleCardProofs.length, 4);
  assert.equal(watching.runout.equityMethod, 'monteCarlo');
  assert.equal(watching.runout.equitySamples, 20_000);
  assert.ok(watching.seats.every(seat => !seat || seat.shownCards?.length === 2));
  assert.throws(() => room.command(spectator.token, { type: 'runoutChoice', times: 2 }), /当前未轮到/);

  room.command(room.seatMember(runout.trailingSeat).token, { type: 'runoutChoice', times: 2 });
  assert.equal(runout.phase, 'leaderVote');
  assert.deepEqual(room.stateFor(spectator.token).board, []);
  room.command(room.seatMember(runout.leadingSeat).token, { type: 'runoutResponse', accept: true });
  assert.equal(runout.phase, 'dealing');
  assert.equal(runout.times, 2);
  assert.deepEqual(room.stateFor(spectator.token).runout.boards.map(board => board.length), [3, 0]);
  const expectedLengths = [[4, 0], [5, 0], [5, 3], [5, 4], [5, 5]];
  for (const lengths of expectedLengths) {
    runout.nextCardAt = Date.now() - 1;
    assert.equal(room.advanceRunoutIfDue(), true);
    assert.deepEqual(room.stateFor(spectator.token).runout.boards.map(board => board.length), lengths);
  }
  assert.equal(room.status, 'finished');
  assert.equal(room.hand.result.type, 'runoutTwice');
  assert.notDeepEqual(room.hand.result.boards[0].slice(0, 3), room.hand.result.boards[1].slice(0, 3));
  assert.equal(new Set([...room.hand.result.boards[0], ...room.hand.result.boards[1]]).size, 10);
  assert.equal(members.reduce((sum, member) => sum + member.stack, 0), 4000);
  assert.deepEqual(room.hand.result.runouts.map(item => item.pots[0].amount), [2000, 2000]);
  assert.equal(room.stateFor(spectator.token).fairness.visibleCardProofs.length, 14);
  for (const proof of room.stateFor(spectator.token).fairness.visibleCardProofs) {
    assert.equal(verifyCardProof(room.hand.fair.deckRoot, proof), true);
  }
});

test('two live players may run side pots twice, with each odd chip assigned to first board', () => {
  const { room, members } = roomWithPlayers(3, [101, 201, 2000]);
  room.command(members[0].token, { type: 'nextHand' });
  room.command(members[0].token, { type: 'action', action: 'raise', amount: 101 });
  room.command(members[1].token, { type: 'action', action: 'call' });
  room.command(members[2].token, { type: 'action', action: 'call' });
  assert.equal(room.hand.actingSeat, 1);
  room.command(members[1].token, { type: 'action', action: 'raise', amount: 100 });
  room.command(members[2].token, { type: 'action', action: 'fold' });
  assert.equal(room.hand.runout !== null, true);
  assert.deepEqual(room.buildPots().map(pot => pot.amount), [303, 100]);
  room.decideRunout(2);
  finishRunout(room);
  assert.equal(room.hand.result.type, 'runoutTwice');
  assert.deepEqual(room.hand.result.runouts.map(item => item.pots.map(pot => pot.amount)),
    [[152, 50], [151, 50]]);
  assert.equal(room.hand.result.winners.reduce((sum, item) => sum + item.amount, 0), 403);
  assert.equal(members.reduce((sum, member) => sum + member.stack, 0), 2302);
});

test('runout votes default to once, survive restart and do not let the covering player fold', () => {
  let setup;
  for (let attempt = 0; attempt < 12; attempt++) {
    setup = roomWithPlayers(2, [100, 2000]);
    setup.room.command(setup.members[0].token, { type: 'nextHand' });
    setup.room.command(setup.members[0].token, { type: 'action', action: 'raise', amount: 100 });
    setup.room.command(setup.members[1].token, { type: 'action', action: 'call' });
    if (setup.room.hand.runout.eligibleForTwice) break;
  }
  const { room, members } = setup;
  assert.equal(room.hand.runout.phase, 'trailingVote');
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(restored.hand.runout.deadline, room.hand.runout.deadline);
  const covering = restored.requireMember(members[1].token);
  restored.command(covering.token, { type: 'sitOut' });
  assert.equal(covering.hand.folded, false);
  assert.equal(covering.pendingSitOut, true);
  assert.equal(restored.livePlayers().length, 2);
  restored.hand.runout.deadline = Date.now() - 1;
  assert.equal(restored.advanceRunoutIfDue(), true);
  assert.equal(restored.hand.runout.times, 1);
  assert.equal(restored.hand.board.length, 3);
  finishRunout(restored);
  assert.equal(covering.sittingOut, true);
  assert.equal(covering.hand.folded, false);
  assert.equal(covering.lastPresenceEvent.type, 'runoutSitOut');
  assert.ok(restored.events.some(event => /按主动选择，从下一手起暂时离席/.test(event.text)));
});
