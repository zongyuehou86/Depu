import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';

function readyRoom() {
  const room = new Room('724196', 4, () => {}, { deferEquity: true });
  const players = ['A', 'B'].map((name, seat) => {
    const player = room.join(name);
    room.command(player.token, { type: 'sit', seat, buyIn: 100 });
    return player;
  });
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players };
}

const actionContext = room => ({ handNo: room.handNo, streetIndex: room.hand.street,
  actingSeat: room.hand.actingSeat, actionDeadline: room.hand.actionDeadline,
  currentBet: room.hand.currentBet });
const runoutContext = room => ({ handNo: room.handNo, phase: room.hand.runout.phase,
  deadline: room.hand.runout.deadline });

function votingRoom() {
  const setup = readyRoom();
  const { room, players: [a, b] } = setup;
  room.command(a.token, { type: 'action', action: 'raise', amount: 100 });
  room.command(b.token, { type: 'action', action: 'call' });
  // The equity worker only decides voting order. No dealt cards are replaced.
  room.completeRunoutEquity({ scores: [{ seat: a.seat, share: 60 }, { seat: b.seat, share: 40 }],
    equity: [], method: 'monteCarlo', scenarios: 100, errorPct: 1 });
  assert.equal(room.hand.runout.phase, 'trailingVote');
  return setup;
}

test('a delayed timebank switch cannot enable or disable a later hand', () => {
  const { room, players: [a] } = readyRoom();
  const expectedTimebank = actionContext(room);
  room.command(a.token, { type: 'action', action: 'fold' });
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.canUseTimebank(a), true);
  assert.throws(() => room.command(a.token,
    { type: 'timebank', enabled: true, expectedTimebank }), /行动已更新/);
  assert.equal(a.hand.timebankEnabled, false);

  room.command(a.token, { type: 'timebank', enabled: true,
    expectedTimebank: actionContext(room) });
  assert.throws(() => room.command(a.token,
    { type: 'timebank', enabled: false, expectedTimebank }), /行动已更新/);
  assert.equal(a.hand.timebankEnabled, true);
  room.command(a.token, { type: 'timebank', enabled: false,
    expectedTimebank: actionContext(room) });
  assert.equal(a.hand.timebankEnabled, false);
});

test('a delayed timebank switch cannot change a newly purchased action block', () => {
  const { room, players: [a] } = readyRoom();
  room.command(a.token, { type: 'timebank', enabled: true });
  const expectedTimebank = actionContext(room);
  room.hand.actionDeadline = Date.now() - 1;
  assert.throws(() => room.command(a.token,
    { type: 'timebank', enabled: false, expectedTimebank }), /行动已更新/);
  assert.equal(a.hand.timebankEnabled, true);
  assert.equal(a.hand.timebankCommit, 10);
  assert.equal(room.hand.actionTimebankBlocks, 1);
});

test('fresh runout contexts allow both votes and preserve two-board consent', () => {
  const { room, players: [a, b] } = votingRoom();
  room.command(b.token, { type: 'runoutChoice', times: 2,
    expectedRunout: runoutContext(room) });
  assert.equal(room.hand.runout.phase, 'leaderVote');
  room.command(a.token, { type: 'runoutResponse', accept: true,
    expectedRunout: runoutContext(room) });
  assert.equal(room.hand.runout.times, 2);
  assert.equal(room.hand.runout.phase, 'dealing');
});

for (const stage of ['trailingVote', 'leaderVote']) {
  test(`an expired ${stage} defaults to one board before a late vote is accepted`, t => {
    const { room, players: [a, b] } = votingRoom();
    if (stage === 'leaderVote') room.command(b.token, { type: 'runoutChoice', times: 2 });
    const expectedRunout = runoutContext(room);
    t.mock.method(Date, 'now', () => expectedRunout.deadline);
    const command = stage === 'trailingVote'
      ? { type: 'runoutChoice', times: 2 } : { type: 'runoutResponse', accept: true };
    const voter = stage === 'trailingVote' ? b : a;
    assert.throws(() => room.command(voter.token, { ...command, expectedRunout }), /行动已更新/);
    assert.equal(room.hand.runout.phase, 'dealing');
    assert.equal(room.hand.runout.times, 1);
    assert.equal(room.hand.board.length, 3);
    const lastVote = room.hand.actions.filter(action => action.type === 'runout').at(-1);
    assert.equal(lastVote.source, 'timeout');
    assert.equal(lastVote.target, 1);
  });
}

test('malformed optional action contexts are rejected instead of silently ignored', () => {
  const { room, players: [a] } = readyRoom();
  for (const expectedTimebank of [null, [], 1, {}]) {
    assert.throws(() => room.command(a.token,
      { type: 'timebank', enabled: true, expectedTimebank }), /行动已更新/);
  }
  assert.equal(a.hand.timebankEnabled, false);
  const { room: voting, players: [, b] } = votingRoom();
  for (const expectedRunout of [null, [], 1, {}]) {
    assert.throws(() => voting.command(b.token,
      { type: 'runoutChoice', times: 2, expectedRunout }), /行动已更新/);
  }
  assert.equal(voting.hand.runout.phase, 'trailingVote');
});
