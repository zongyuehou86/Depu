import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';

test('seat streetCommit is this betting round total, then resets on each new street', () => {
  const room = new Room('654321');
  const a = room.join('A');
  const b = room.join('B');
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(a.token, { type: 'nextHand' });
  assert.equal(room.hand.smallBlindSeat, 0);
  assert.equal(room.hand.bigBlindSeat, 1);

  const beforeStreetChange = [];
  const advance = room.advanceStreet;
  room.advanceStreet = function () {
    beforeStreetChange.push(this.stateFor(a.token));
    return advance.call(this);
  };
  const view = () => room.stateFor(a.token);
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [10, 20]);

  room.command(a.token, { type: 'action', action: 'raise', amount: 200 });
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [200, 20]);
  assert.equal(view().pot, 220);
  room.command(b.token, { type: 'action', action: 'raise', amount: 400 });
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [200, 400]);
  assert.equal(view().hero.toCall, 200);
  assert.equal(view().pot, 600);
  room.command(a.token, { type: 'action', action: 'call' });
  assert.deepEqual(beforeStreetChange[0].seats.map(seat => seat?.streetCommit).slice(0, 2), [400, 400]);
  assert.equal(beforeStreetChange[0].streetIndex, 0);
  assert.equal(beforeStreetChange[0].pot, 800);
  assert.deepEqual(room.hand.actions.slice(-3).map(action => [action.action, action.amount, action.target]), [
    ['raise', 190, 200], ['raise', 380, 400], ['call', 200, null]
  ]);
  assert.equal(view().streetIndex, 1);
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [0, 0]);
  assert.equal(view().pot, 800);

  room.command(b.token, { type: 'action', action: 'check' });
  room.command(a.token, { type: 'action', action: 'raise', amount: 100 });
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [100, 0]);
  room.command(b.token, { type: 'action', action: 'call' });
  assert.deepEqual(beforeStreetChange[1].seats.map(seat => seat?.streetCommit).slice(0, 2), [100, 100]);
  assert.equal(beforeStreetChange[1].streetIndex, 1);
  assert.equal(beforeStreetChange[1].pot, 1000);
  assert.equal(view().streetIndex, 2);
  assert.deepEqual(view().seats.map(seat => seat?.streetCommit).slice(0, 2), [0, 0]);
  assert.equal(view().pot, 1000);
});
