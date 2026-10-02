import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_TIME_MS, NEXT_HAND_DELAY_MS, Room } from '../room.js';

function seatedRoom(count = 2) {
  const room = new Room('765432', 4);
  const players = [];
  for (let seat = 0; seat < count; seat++) {
    const player = room.join(`玩家${seat + 1}`);
    room.command(player.token, { type: 'sit', seat, buyIn: 2000 });
    players.push(player);
  }
  return { room, players };
}

test('five-second auto-start pauses while a reserved seat sits out, then resumes on return', () => {
  assert.equal(NEXT_HAND_DELAY_MS, 5_000);
  const { room, players: [first, second] } = seatedRoom();
  assert.ok(room.nextHandAt >= Date.now() + 4_500);
  const originalStack = first.stack;
  room.command(first.token, { type: 'sitOut' });
  assert.equal(room.nextHandAt, null);
  assert.equal(room.seats[0], first.token);
  assert.equal(first.stack, originalStack);
  assert.equal(room.stateFor(second.token).seats[0].sittingOut, true);
  room.command(first.token, { type: 'return' });
  assert.ok(room.nextHandAt >= Date.now() + 4_500);
  assert.equal(room.stateFor(first.token).hero.sittingOut, false);
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.handNo, 1);
});

test('sitting-out player keeps seat and chips but receives no cards or blinds', () => {
  const { room, players: [first, second, third] } = seatedRoom(3);
  room.command(first.token, { type: 'sitOut' });
  const stack = first.stack;
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(first.seat, 0);
  assert.equal(first.stack, stack);
  assert.equal(first.hand, null);
  assert.equal(room.hand.smallBlindSeat !== 0 && room.hand.bigBlindSeat !== 0, true);
  assert.deepEqual(room.stateFor(first.token).hero.cards, []);
  assert.equal(room.stateFor(first.token).seats[0].sittingOut, true);
  assert.equal(second.hand.hole.length, 2);
  assert.equal(third.hand.hole.length, 2);
});

test('sitting out mid-hand folds current cards, and returning takes effect next hand', () => {
  const { room, players: [first, second] } = seatedRoom();
  room.command(first.token, { type: 'nextHand' });
  const handNo = room.handNo;
  room.command(first.token, { type: 'sitOut' });
  assert.equal(first.seat, 0);
  assert.equal(first.sittingOut, true);
  assert.equal(first.hand.folded, true);
  assert.equal(room.status, 'finished');
  assert.equal(room.nextHandAt, null);
  room.command(first.token, { type: 'return' });
  assert.equal(first.hand.folded, true);
  assert.ok(room.nextHandAt >= Date.now() + 4_500);
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  assert.equal(room.handNo, handNo + 1);
  assert.equal(first.hand.hole.length, 2);
  assert.equal(second.hand.hole.length, 2);
});

test('thirty-second action clock checks when free and folds when facing a bet', () => {
  assert.equal(ACTION_TIME_MS, 30_000);
  const { room, players: [first, second] } = seatedRoom();
  room.command(first.token, { type: 'nextHand' });
  assert.ok(room.hand.actionDeadline >= Date.now() + 29_500);
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(room.status, 'finished');
  assert.equal(first.hand.folded, true);
  assert.ok(room.events.some(event => /行动超时，自动弃牌/.test(event.text)));

  assert.equal(first.sittingOut, true);
  room.command(first.token, { type: 'return' });
  room.nextHandAt = Date.now() - 1;
  assert.equal(room.autoStartIfDue(), true);
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'action', action: 'call' });
  const freeActor = room.seatMember(room.hand.actingSeat);
  assert.equal(room.toCall(freeActor), 0);
  room.hand.actionDeadline = Date.now() - 1;
  assert.equal(room.timeoutAction(), true);
  assert.equal(freeActor.hand.folded, false);
  assert.ok(room.events.some(event => /行动超时，自动过牌/.test(event.text)));
});

test('old snapshots migrate deadlines, waiting timers, and duplicate identities safely', () => {
  const { room, players: [first] } = seatedRoom();
  const resumed = room.join('ignored', first.token);
  assert.equal(resumed, first);
  const duplicate = room.join(first.nickname);
  assert.notEqual(duplicate.token, first.token);
  assert.equal(duplicate.seat, null);
  assert.match(duplicate.nickname, /#2$/);

  room.command(first.token, { type: 'nextHand' });
  const old = JSON.parse(JSON.stringify(room.toJSON()));
  delete old.nextHandAt;
  delete old.hand.timerVersion;
  old.hand.actionDeadline = Date.now() + 90_000;
  for (const member of old.members) { delete member.sittingOut; delete member.revealable; }
  const recovered = Room.fromJSON(old);
  assert.equal(recovered.hand.timerVersion, 3);
  assert.ok(recovered.hand.actionDeadline <= Date.now() + ACTION_TIME_MS);
  assert.ok(recovered.hand.actionDeadline > Date.now() + ACTION_TIME_MS - 1000);
  assert.equal(recovered.requireMember(first.token).sittingOut, false);

  const actor = recovered.seatMember(recovered.hand.actingSeat);
  recovered.command(actor.token, { type: 'action', action: 'fold' });
  const finishedOld = JSON.parse(JSON.stringify(recovered.toJSON()));
  delete finishedOld.nextHandAt;
  for (const member of finishedOld.members) delete member.revealable;
  const finishedRecovered = Room.fromJSON(finishedOld);
  assert.ok(finishedRecovered.nextHandAt >= Date.now() + NEXT_HAND_DELAY_MS - 1000);
  assert.ok(finishedRecovered.requireMember(actor.token).revealable);
});
