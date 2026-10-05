import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Room } from '../room.js';

const window = {};
vm.runInNewContext(readFileSync(new URL('../public/preactions.js', import.meta.url), 'utf8'), { window });
const make = () => window.PokerPreactions.createController();
const plain = value => JSON.parse(JSON.stringify(value));
function waiting(overrides = {}) {
  const state = { roomCode: '712345', status: 'playing', handNo: 1, streetIndex: 0,
    serverTime: 1000, currentBet: 100, actingSeat: 1, actionDeadline: 36000,
    hero: { playerId: 'hero', seat: 0, canAct: false, toCall: 0, spendableStack: 2000 },
    seats: [{ playerId: 'hero', inHand: true, streetCommit: 20, stack: 2000 },
      { playerId: 'villain', inHand: true, streetCommit: 100, stack: 1900 }],
    events: [{ id: 1, handNo: 1, seat: 1, text: 'Villain 加注至 100' }] };
  return { ...state, ...overrides, hero: { ...state.hero, ...overrides.hero } };
}
const turn = overrides => waiting({ serverTime: 2000, actingSeat: 0, ...overrides,
  hero: { canAct: true, toCall: 80, ...overrides?.hero } });
const raised = amount => ({ id: 2, handNo: 1, seat: 1,
  text: `Villain 加注至 ${amount}${amount < 180 ? '，全下（不足额加注）' : ''}` });
const guard = data => ({ handNo: data.handNo, streetIndex: data.streetIndex, actingSeat: data.actingSeat,
  actionDeadline: data.actionDeadline, currentBet: data.currentBet });

test('offturn precall uses public gap, mutually excludes other choices and sends exactly once', () => {
  const pre = make(), data = waiting();
  assert.equal(data.hero.toCall, 0);
  assert.equal(pre.canSelect('check', data), false);
  assert.equal(pre.canSelect('call', data), true);
  assert.equal(pre.toggle('fold', data), 'fold');
  assert.equal(pre.toggle('call', data), 'call');
  assert.equal(pre.toggle('call', data), null);
  assert.equal(pre.toggle('call', data), 'call');
  assert.equal(pre.observe(data), null);
  assert.equal(pre.observe(turn(), { consume: false }), null);
  assert.equal(pre.getSelected(), 'call');
  assert.deepEqual(plain(pre.observe(turn())), { action: 'call', maxCallAmount: 80 });
  assert.equal(pre.observe(turn()), null);
  assert.equal(pre.canSelect('call', turn()), false);
});

test('a later full raise or short all-in cancels precall even for a capped short-stack call', () => {
  for (const amount of [110, 180]) for (const stack of [30, 2000]) {
    const pre = make(), data = waiting({ hero: { spendableStack: stack } });
    assert.equal(pre.toggle('call', data), 'call');
    assert.equal(pre.observe(turn({ currentBet: amount, hero: { spendableStack: stack, toCall: amount - 20 },
      events: [...data.events, raised(amount)] })), null);
    assert.equal(pre.getSelected(), null);
  }
});

test('raise event cancels precall even if bet is reset; unannounced target increase is also safe', () => {
  for (const changes of [{ events: [...waiting().events, raised(110)] }, { currentBet: 110 }]) {
    const pre = make();
    pre.toggle('call', waiting());
    assert.equal(pre.observe(turn(changes)), null);
    assert.equal(pre.getSelected(), null);
  }
});

test('short-stack call costs use unlocked chips and never grow beyond selected amount', () => {
  const pre = make();
  assert.equal(pre.toggle('call', waiting({ hero: { spendableStack: 30 } })), 'call');
  assert.deepEqual(plain(pre.observe(turn({ hero: { spendableStack: 30 } }))),
    { action: 'call', maxCallAmount: 30 });
  const growing = make();
  growing.toggle('call', waiting({ hero: { spendableStack: 30 } }));
  assert.equal(growing.observe(turn({ hero: { spendableStack: 80 } })), null);
  assert.equal(growing.getSelected(), null);
  const shrinking = make();
  shrinking.toggle('call', waiting({ hero: { spendableStack: 80 } }));
  assert.deepEqual(plain(shrinking.observe(turn({ hero: { spendableStack: 30 } }))),
    { action: 'call', maxCallAmount: 80 });
  for (const spendableStack of [0, -1, NaN]) {
    assert.equal(make().canSelect('call', waiting({ hero: { spendableStack } })), false);
  }
  assert.equal(make().canSelect('call', waiting({ currentBet: 20 })), false);
});

test('precall clears on street, hand, room, seat, own action, event gap, leave and terminal states', () => {
  const data = waiting();
  const changes = [{ streetIndex: 1 }, { handNo: 2 }, { roomCode: '712346' },
    { hero: { seat: null } }, { hero: { sittingOut: true } }, { hero: { pendingSitOut: true } },
    { runout: { phase: 'calculating' } }, { status: 'finished' },
    { seats: [{ ...data.seats[0], allIn: true }, data.seats[1]] },
    { seats: [{ ...data.seats[0], folded: true }, data.seats[1]] },
    { events: [...data.events, { id: 2, handNo: 1, seat: 0, text: 'Hero 跟注 80' }] },
    { events: [{ id: 250, handNo: 1, seat: 1, text: 'Villain 过牌' }] }];
  for (const change of changes) {
    const pre = make(); pre.toggle('call', data);
    assert.equal(pre.observe(waiting({ ...change, serverTime: 2000 })), null);
    assert.equal(pre.getSelected(), null, JSON.stringify(change));
  }
});

test('pause preserves fixed precall but cannot execute; reset/reconnect cannot replay it', () => {
  const pre = make(), paused = turn({ pause: { endAt: 5000 } });
  pre.toggle('call', waiting());
  assert.equal(pre.observe(paused), null);
  assert.equal(pre.getSelected(), 'call');
  assert.equal(pre.canSelect('call', paused), false);
  assert.equal(pre.observe(turn({ serverTime: 5000 }))?.action, 'call');
  const reconnect = make(); reconnect.toggle('call', waiting()); reconnect.reset();
  assert.equal(reconnect.observe(turn()), null);
});

test('stale frames cannot change precall but newer server versions cancel even after clock rollback', () => {
  const pre = make(); pre.toggle('call', waiting({ serverTime: 3000, stateVersion: 5 }));
  assert.equal(pre.observe(turn({ serverTime: 4000, currentBet: 180, stateVersion: 4 })), null);
  assert.equal(pre.getSelected(), 'call');
  assert.equal(pre.observe(turn({ serverTime: 2000, currentBet: 110, stateVersion: 6 })), null);
  assert.equal(pre.getSelected(), null);
  assert.equal(pre.toggle('call', waiting({ serverTime: 4000, stateVersion: 5 })), null);
});

function roomWithPlayers(stacks = [2000, 2000, 2000, 2000]) {
  const room = new Room('734567', 4);
  const players = stacks.map((stack, seat) => {
    const p = room.join(`Caller ${seat}`);
    room.command(p.token, { type: 'sit', seat, buyIn: stack }); return p;
  });
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players };
}

test('actual four-player Room executes an unchanged precall after earlier players call/fold', () => {
  const { room, players } = roomWithPlayers();
  room.command(players[3].token, { type: 'action', action: 'raise', amount: 100 });
  const pre = make();
  assert.equal(pre.toggle('call', room.stateFor(players[2].token)), 'call');
  room.command(players[0].token, { type: 'action', action: 'call' });
  assert.equal(pre.observe(room.stateFor(players[2].token)), null);
  room.command(players[1].token, { type: 'action', action: 'fold' });
  const fresh = room.stateFor(players[2].token), choice = pre.observe(fresh);
  assert.deepEqual(plain(choice), { action: 'call', maxCallAmount: 80 });
  room.command(players[2].token, { type: 'action', ...choice, expectedAction: guard(fresh) });
  assert.equal(players[2].hand.totalCommit, 100);
  assert.equal(players[2].hand.lastAction, 'call');
  assert.throws(() => room.command(players[2].token, { type: 'action', ...choice,
    expectedAction: guard(fresh) }), /行动已更新/);
});

test('actual insufficient all-in raise cancels queued call and server rejects the stale target', () => {
  const { room, players } = roomWithPlayers([110, 2000, 2000, 2000]);
  room.command(players[3].token, { type: 'action', action: 'raise', amount: 100 });
  const pre = make(), old = room.stateFor(players[2].token);
  assert.equal(pre.toggle('call', old), 'call');
  room.command(players[0].token, { type: 'action', action: 'raise', amount: 110 });
  assert.equal(pre.observe(room.stateFor(players[2].token)), null);
  assert.equal(pre.getSelected(), null);
  room.command(players[1].token, { type: 'action', action: 'call' });
  const stale = { ...guard(room.stateFor(players[2].token)), currentBet: 100 };
  assert.throws(() => room.command(players[2].token, { type: 'action', action: 'call',
    maxCallAmount: 80, expectedAction: stale }), /行动已更新/);
  assert.equal(players[2].hand.totalCommit, 20);
  assert.equal(room.hand.actingSeat, 2);
});

test('server call cap rejects increased cost and malformed limits without moving chips or actor', () => {
  const { room, players } = roomWithPlayers();
  room.command(players[3].token, { type: 'action', action: 'raise', amount: 100 });
  const actor = players[0], fresh = room.stateFor(actor.token), initial = actor.stack;
  for (const maxCallAmount of [30, 0, -1, '100', Infinity]) {
    assert.throws(() => room.command(actor.token, { type: 'action', action: 'call',
      maxCallAmount, expectedAction: guard(fresh) }), /行动已更新/);
    assert.equal(actor.stack, initial);
    assert.equal(room.hand.actingSeat, actor.seat);
  }
  room.command(actor.token, { type: 'action', action: 'call', maxCallAmount: 100,
    expectedAction: guard(fresh) });
  assert.equal(actor.stack, initial - 100);
});
