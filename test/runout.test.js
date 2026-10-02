import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cardLabel, verifyCardProof } from '../engine.js';
import { Room, RUNOUT_RIVER_MS, RUNOUT_TURN_MS, RUNOUT_VOTE_MS, calculateShowdownEquity } from '../room.js';

const allCards = Array.from({ length: 52 }, (_, card) => card);
const byLabel = new Map(allCards.map(card => [cardLabel(card), card]));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function installKnownDeck(room, prefixLabels) {
  const prefix = prefixLabels.map(label => {
    assert.ok(byLabel.has(label), `unknown card ${label}`);
    return byLabel.get(label);
  });
  assert.equal(new Set(prefix).size, prefix.length);
  const deck = [...prefix, ...allCards.filter(card => !prefix.includes(card))];
  const draw = room.draw;
  let installed = false;
  room.draw = function () {
    if (!installed) {
      installed = true;
      this.hand.fair.deck = deck;
      let layer = deck.map((card, index) =>
        sha256(`holdem-card-v1:${index}:${cardLabel(card)}:${this.hand.fair.salts[index]}`));
      while (layer.length > 1) {
        const next = [];
        for (let index = 0; index < layer.length; index += 2) {
          next.push(sha256(Buffer.from(layer[index] + (layer[index + 1] ?? layer[index]), 'hex')));
        }
        layer = next;
      }
      this.hand.fair.deckRoot = layer[0];
    }
    return draw.call(this);
  };
}

function headsUpAllIn() {
  const room = new Room('345678');
  const a = room.join('A'), b = room.join('B'), spectator = room.join('旁观者');
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 100 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 100 });
  // Dealing order: B, A, B, A. The first flop stays hidden during the vote.
  installKnownDeck(room, ['Kc', 'As', 'Kd', 'Ah', '2d', '2c', '7d', 'Qc',
    '3c', 'Ks', '4c', '3h', '5c', '4s', '6c', '5d', '6h', '9s', '7c', '9d']);
  room.command(a.token, { type: 'nextHand' });
  room.command(a.token, { type: 'action', action: 'raise', amount: 100 });
  room.command(b.token, { type: 'action', action: 'call' });
  return { room, a, b, spectator };
}

function advanceOne(room) {
  const runout = room.hand.runout;
  if (runout.phase === 'dealing' || runout.phase === 'firstBoardPause') runout.nextCardAt = Date.now() - 1;
  else runout.deadline = Date.now() - 1;
  assert.equal(room.advanceRunoutIfDue(), true);
}

test('exact equity identifies the trailing player from public cards only', () => {
  const input = [
    { seat: 0, hole: ['As', 'Ah'].map(label => byLabel.get(label)) },
    { seat: 1, hole: ['Kc', 'Kd'].map(label => byLabel.get(label)) }
  ];
  const board = ['2c', '7d', 'Qc'].map(label => byLabel.get(label));
  const calculation = calculateShowdownEquity(input, board);
  assert.equal(calculation.scenarios, 990);
  assert.equal(calculation.scores.reduce((sum, item) => sum + item.share, 0), 990);
  assert.ok(calculation.scores[0].share > calculation.scores[1].share);
  assert.ok(calculation.equity[0].equityPct > 50);
  assert.ok(calculation.equity[1].equityPct < 50);
  assert.ok(Math.abs(calculation.equity.reduce((sum, item) => sum + item.equityPct, 0) - 100) <= 0.01);
});

test('preflop equity is stable public-information sampling before any community card is shown', () => {
  const players = [
    { seat: 0, hole: ['As', 'Ah'].map(label => byLabel.get(label)) },
    { seat: 1, hole: ['Kc', 'Kd'].map(label => byLabel.get(label)) }
  ];
  const first = calculateShowdownEquity(players, []);
  const repeated = calculateShowdownEquity(players, []);
  assert.deepEqual(repeated, first);
  assert.equal(first.method, 'monteCarlo');
  assert.equal(first.scenarios, 20_000);
  assert.equal(first.scores.reduce((sum, score) => sum + score.share, 0), 20_000);
  assert.ok(first.equity[0].equityPct > 70);
  assert.ok(first.equity[1].equityPct < 30);
  assert.ok(Math.abs(first.equity.reduce((sum, item) => sum + item.equityPct, 0) - 100) <= 0.02);
  const { room } = headsUpAllIn();
  assert.deepEqual(room.hand.runout.equity, first.equity);
  assert.equal(room.hand.nextCard, 4); // Only four private cards have been drawn.
});

test('both consenting players get two staged boards from one deck, with no future card leak', () => {
  assert.equal(RUNOUT_VOTE_MS, 15_000);
  assert.equal(RUNOUT_TURN_MS, 5_000);
  assert.equal(RUNOUT_RIVER_MS, 10_000);
  const { room, a, b, spectator } = headsUpAllIn();
  const vote = room.stateFor(spectator.token);
  assert.equal(vote.status, 'playing');
  assert.equal(vote.runout.phase, 'trailingVote');
  assert.equal(vote.runout.eligibleForTwice, true);
  assert.equal(vote.runout.leadingSeat, 0);
  assert.equal(vote.runout.trailingSeat, 1);
  assert.equal(vote.runout.equityMethod, 'monteCarlo');
  assert.equal(vote.runout.equitySamples, 20_000);
  assert.ok(vote.runout.equity[0].equityPct > vote.runout.equity[1].equityPct);
  assert.deepEqual(vote.board, []);
  assert.deepEqual(vote.runout.boards, [[]]);
  assert.deepEqual(vote.seats[0].shownCards, ['As', 'Ah']);
  assert.deepEqual(vote.seats[1].shownCards, ['Kc', 'Kd']);
  assert.equal(vote.fairness.visibleCardProofs.length, 4);
  for (const proof of vote.fairness.visibleCardProofs) {
    assert.equal(verifyCardProof(vote.fairness.deckRoot, proof), true);
  }
  for (const future of ['2c', '7d', 'Qc', 'Ks', '3h', '4s', '5d', '9s', '9d']) {
    assert.ok(!JSON.stringify(vote).includes(`"${future}"`));
  }
  assert.throws(() => room.command(a.token, { type: 'runoutChoice', times: 2 }), /当前未轮到/);
  assert.throws(() => room.command(spectator.token, { type: 'runoutChoice', times: 2 }), /当前未轮到/);
  room.command(b.token, { type: 'runoutChoice', times: 2 });
  assert.equal(room.stateFor(a.token).runout.phase, 'leaderVote');
  assert.deepEqual(room.stateFor(spectator.token).board, []);
  assert.throws(() => room.command(b.token, { type: 'runoutResponse', accept: true }), /当前未轮到/);
  room.command(a.token, { type: 'runoutResponse', accept: true });
  let view = room.stateFor(spectator.token);
  assert.equal(view.runout.phase, 'dealing');
  assert.equal(view.runout.times, 2);
  assert.deepEqual(view.runout.boards, [['2c', '7d', 'Qc'], []]);
  assert.ok(view.runout.nextCardAt >= Date.now() + 4_500);
  assert.equal(room.hand.nextCard, 8);

  advanceOne(room); // First board turn.
  view = room.stateFor(spectator.token);
  assert.deepEqual(view.runout.boards[0], ['2c', '7d', 'Qc', 'Ks']);
  assert.deepEqual(view.runout.boards[1], []);
  for (const future of ['3h', '4s', '5d', '9s', '9d']) assert.ok(!JSON.stringify(view).includes(`"${future}"`));
  assert.ok(view.runout.nextCardAt >= Date.now() + 9_500);
  advanceOne(room); // First board river.
  assert.equal(room.stateFor(spectator.token).runout.phase, 'firstBoardPause');
  advanceOne(room); // Five-second pause expires; independent second flop appears together.
  assert.deepEqual(room.stateFor(spectator.token).runout.boards[1], ['4s', '6c', '5d']);
  advanceOne(room); // Second board turn.
  advanceOne(room); // Second board river and settlement.
  view = room.stateFor(spectator.token);
  assert.equal(view.status, 'finished');
  assert.equal(view.result.type, 'runoutTwice');
  assert.deepEqual(view.result.boards, [
    ['2c', '7d', 'Qc', 'Ks', '3h'], ['4s', '6c', '5d', '9s', '9d']
  ]);
  assert.equal(room.hand.nextCard, 20);
  assert.deepEqual(view.result.runouts.map(item => item.pots[0].winners[0].seat), [1, 0]);
  assert.deepEqual([a.stack, b.stack], [100, 100]);
  assert.equal(view.result.winners.reduce((sum, item) => sum + item.amount, 0), 200);
  assert.deepEqual(view.result.winners.map(item => [item.seat, item.amount,
    item.totalCommit, item.netProfit]).sort((left, right) => left[0] - right[0]),
  [[0, 100, 100, 0], [1, 100, 100, 0]]);
  assert.equal(view.fairness.visibleCardProofs.length, 14);
  for (const proof of view.fairness.visibleCardProofs) {
    assert.equal(verifyCardProof(view.fairness.deckRoot, proof), true);
  }
});

test('first board result stays visible for a full five-second pause before the second board starts', () => {
  const { room, a, b, spectator } = headsUpAllIn();
  room.command(b.token, { type: 'runoutChoice', times: 2 });
  room.command(a.token, { type: 'runoutResponse', accept: true });

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    room.hand.runout.nextCardAt = now;
    assert.equal(room.advanceRunoutIfDue(), true); // First turn.
    assert.equal(room.hand.runout.nextCardAt, now + RUNOUT_RIVER_MS);
    now += RUNOUT_RIVER_MS;
    assert.equal(room.advanceRunoutIfDue(), true); // First river.
    const pauseStart = now;
    let view = room.stateFor(spectator.token);
    assert.equal(view.status, 'playing');
    assert.equal(view.result, null);
    assert.equal(view.runout.phase, 'firstBoardPause');
    assert.equal(view.runout.boardIndex, 0);
    assert.equal(view.runout.nextCardAt, pauseStart + 5_000);
    assert.deepEqual(view.runout.boards.map(board => board.length), [5, 0]);
    assert.equal(view.runout.boardResults.length, 1);
    assert.equal(view.runout.boardResults[0].pots[0].amount, 100);
    assert.deepEqual(view.runout.boardResults[0].pots[0].winners.map(winner => winner.nickname), ['B']);
    assert.equal(view.runout.boardResults[0].pots[0].winners[0].handCategory, 3);
    assert.ok(view.runout.boardResults[0].pots[0].winners[0].handDisplay);
    assert.equal(room.hand.nextCard, 12);
    assert.deepEqual([a.stack, b.stack], [0, 0]); // Preview does not settle early.

    now = pauseStart + 4_999;
    assert.equal(room.advanceRunoutIfDue(), false);
    view = room.stateFor(spectator.token);
    assert.equal(view.runout.boardIndex, 0);
    for (const future of ['4s', '5d', '9s', '9d']) assert.ok(!JSON.stringify(view).includes(`\"${future}\"`));
    assert.equal(room.hand.nextCard, 12);

    now = pauseStart + 5_000;
    assert.equal(room.advanceRunoutIfDue(), true);
    view = room.stateFor(spectator.token);
    assert.equal(view.runout.phase, 'dealing');
    assert.equal(view.runout.boardIndex, 1);
    assert.equal(view.runout.nextCardAt, now + RUNOUT_TURN_MS);
    assert.deepEqual(view.runout.boards[1], ['4s', '6c', '5d']);
    assert.deepEqual(view.runout.boards.map(board => board.length), [5, 3]);
    assert.equal(room.hand.nextCard, 16);
    now += RUNOUT_TURN_MS;
    assert.equal(room.advanceRunoutIfDue(), true);
    view = room.stateFor(spectator.token);
    assert.deepEqual(view.runout.boards[1], ['4s', '6c', '5d', '9s']);
    assert.equal(room.hand.nextCard, 18);
    assert.ok(!JSON.stringify(view).includes('"9d"'));
  } finally {
    Date.now = realNow;
  }
});

test('vote timeout defaults to one board and never silently runs twice', () => {
  const { room, spectator } = headsUpAllIn();
  advanceOne(room); // Trailing player did not choose within 15 seconds.
  let view = room.stateFor(spectator.token);
  assert.equal(view.runout.phase, 'dealing');
  assert.equal(view.runout.times, 1);
  assert.equal(view.runout.proposal, 1);
  advanceOne(room);
  advanceOne(room);
  view = room.stateFor(spectator.token);
  assert.equal(view.status, 'finished');
  assert.equal(view.result.type, 'showdown');
  assert.equal(view.result.boards.length, 1);
  assert.equal(room.hand.nextCard, 12);
});

test('flop and turn all-ins keep only the already dealt board cards shared', () => {
  for (const lockStreet of [1, 2]) {
    let setup;
    for (let attempt = 0; attempt < 20; attempt++) {
      const room = new Room('345680');
      const a = room.join('A'), b = room.join('B'), spectator = room.join('观战者');
      room.command(a.token, { type: 'sit', seat: 0, buyIn: 100 });
      room.command(b.token, { type: 'sit', seat: 1, buyIn: 100 });
      room.command(a.token, { type: 'nextHand' });
      room.command(a.token, { type: 'action', action: 'call' });
      room.command(b.token, { type: 'action', action: 'check' });
      assert.equal(room.hand.board.length, 3);
      if (lockStreet === 2) {
        room.command(b.token, { type: 'action', action: 'check' });
        room.command(a.token, { type: 'action', action: 'check' });
        assert.equal(room.hand.board.length, 4);
      }
      room.command(b.token, { type: 'action', action: 'raise', amount: 80 });
      room.command(a.token, { type: 'action', action: 'call' });
      if (room.hand.runout?.eligibleForTwice) { setup = { room, a, b, spectator }; break; }
    }
    assert.ok(setup, `non-tied equity fixture for street ${lockStreet}`);
    const { room, spectator } = setup;
    const shared = room.hand.board.map(item => cardLabel(item.card));
    assert.equal(room.stateFor(spectator.token).runout.sharedBoardCount, shared.length);
    const trailing = room.seatMember(room.hand.runout.trailingSeat);
    const leading = room.seatMember(room.hand.runout.leadingSeat);
    room.command(trailing.token, { type: 'runoutChoice', times: 2 });
    room.command(leading.token, { type: 'runoutResponse', accept: true });
    assert.deepEqual(room.stateFor(spectator.token).runout.boards[1], shared);
    while (room.hand.runout.phase === 'dealing' && room.hand.runout.boardIndex === 0) advanceOne(room);
    assert.equal(room.hand.runout.phase, 'firstBoardPause');
    const cursorBeforeSecond = room.hand.nextCard;
    const future = cardLabel(room.hand.fair.deck[cursorBeforeSecond + 1]);
    assert.ok(!JSON.stringify(room.stateFor(spectator.token)).includes(`"${future}"`));
    advanceOne(room);
    const switched = room.stateFor(spectator.token);
    assert.equal(switched.runout.boardIndex, 1);
    assert.deepEqual(switched.runout.boards[1], shared);
    assert.equal(room.hand.nextCard, cursorBeforeSecond);
    while (room.status === 'playing') advanceOne(room);
    const result = room.hand.result;
    assert.equal(result.type, 'runoutTwice');
    for (const board of result.boards) assert.deepEqual(board.slice(0, shared.length), shared);
    assert.equal(new Set([...result.boards[0], ...result.boards[1]]).size,
      shared.length + 2 * (5 - shared.length));
  }
});

test('a folded odd contribution is split per pot across two boards without losing a chip', () => {
  const room = new Room('345679');
  const a = room.join('A'), b = room.join('B'), c = room.join('C');
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 100 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 100 });
  room.command(c.token, { type: 'sit', seat: 2, buyIn: 1000 });
  // Three-player deal order: B, C, A, B, C, A; then shared flop.
  installKnownDeck(room, ['Kc', '4h', 'As', 'Kd', '5h', 'Ah', '2d', '2c', '7d', 'Qc',
    '3c', 'Ks', '4c', '3h', '5c', '4s', '6c', '5d', '6h', '9s', '7c', '9d']);
  room.command(a.token, { type: 'nextHand' });
  room.command(a.token, { type: 'action', action: 'raise', amount: 41 });
  room.command(b.token, { type: 'action', action: 'call' });
  room.command(c.token, { type: 'action', action: 'raise', amount: 81 });
  room.command(a.token, { type: 'action', action: 'raise', amount: 100 });
  room.command(b.token, { type: 'action', action: 'call' });
  room.command(c.token, { type: 'action', action: 'fold' });
  assert.equal(room.pot(), 281);
  assert.deepEqual(room.buildPots().map(pot => pot.amount), [243, 38]);
  assert.equal(room.stateFor(c.token).runout.eligibleForTwice, true);
  const exposedOnly = calculateShowdownEquity([
    { seat: 0, hole: ['As', 'Ah'].map(label => byLabel.get(label)) },
    { seat: 1, hole: ['Kc', 'Kd'].map(label => byLabel.get(label)) }
  ], []);
  assert.deepEqual(room.hand.runout.equity, exposedOnly.equity);
  assert.equal(room.stateFor(a.token).seats[2].shownCards, null); // Folded player's cards stay private.
  room.command(b.token, { type: 'runoutChoice', times: 2 });
  room.command(a.token, { type: 'runoutResponse', accept: true });
  for (let step = 0; step < 5; step++) advanceOne(room);
  const result = room.hand.result;
  assert.equal(result.type, 'runoutTwice');
  assert.deepEqual(result.runouts.map(item => item.pots.map(pot => pot.amount)), [[122, 19], [121, 19]]);
  assert.deepEqual([a.stack, b.stack, c.stack], [140, 141, 919]);
  assert.equal(a.stack + b.stack + c.stack, 1200);
  assert.equal(result.winners.reduce((sum, item) => sum + item.amount, 0), 281);
  assert.deepEqual(result.winners.map(item => [item.seat, item.amount,
    item.totalCommit, item.netProfit]).sort((left, right) => left[0] - right[0]),
  [[0, 140, 100, 40], [1, 141, 100, 41]]);
});

test('a side-pot recipient can have a negative hand net despite a positive payout', () => {
  const room = new Room('345680');
  const a = room.join('A'), b = room.join('B');
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 1000 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 1000 });
  // Heads-up order: B, A, B, A. B wins the contested 200; A alone
  // receives the remaining 200 from the layer only A funded.
  installKnownDeck(room, ['As', '2c', 'Ah', '3d', '5c', '4h', '7s', '9c',
    '6d', 'Jd', '8c', 'Qh']);
  room.command(a.token, { type: 'nextHand' });
  a.stack = 700;
  b.stack = 900;
  a.hand.totalCommit = 300;
  b.hand.totalCommit = 100;
  a.hand.streetCommit = 300;
  b.hand.streetCommit = 100;
  room.draw(); // flop burn
  room.hand.board = [room.draw(), room.draw(), room.draw()];
  room.draw(); // turn burn
  room.hand.board.push(room.draw());
  room.draw(); // river burn
  room.hand.board.push(room.draw());
  room.hand.street = 3;
  room.showdown();
  assert.deepEqual(room.hand.result.winners.map(item => [item.seat, item.amount,
    item.totalCommit, item.netProfit]).sort((left, right) => left[0] - right[0]),
  [[0, 200, 300, -100], [1, 200, 100, 100]]);
  assert.deepEqual([a.stack, b.stack], [900, 1100]);
});
