import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Room } from '../room.js';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/preactions.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const makeController = () => window.PokerPreactions.createController();
const { actionFor } = window.PokerPreactions;

function state(overrides = {}) {
  const base = {
    roomCode: 'TABLE', handNo: 1, serverTime: 1000, status: 'playing', streetIndex: 0,
    currentBet: 20, actingSeat: 1, pause: null, runout: null,
    seats: [{ playerId: 'hero', inHand: true, streetCommit: 20 },
      { playerId: 'other', nickname: '乙', inHand: true, streetCommit: 20 }],
    hero: { playerId: 'hero', seat: 0, canAct: false, toCall: 0 },
    events: [{ id: 1, handNo: 1, seat: null, text: '第 1 手开始' }]
  };
  return { ...base, ...overrides, hero: { ...base.hero, ...overrides.hero } };
}

test('fold and check are mutually exclusive; second tap cancels; one turn consumes once', () => {
  const pre = makeController();
  const waiting = state();
  assert.equal(pre.canSelect('check', waiting), true);
  assert.equal(pre.toggle('fold', waiting), 'fold');
  assert.equal(pre.toggle('check', waiting), 'check');
  assert.equal(pre.toggle('check', waiting), null);
  assert.equal(pre.toggle('fold', waiting), 'fold');
  const turn = state({ serverTime: 1100, actingSeat: 0, hero: { canAct: true } });
  assert.equal(pre.observe(turn, { consume: false }), null);
  assert.equal(pre.getSelected(), 'fold');
  assert.equal(pre.observe(turn).action, 'fold');
  assert.equal(pre.getSelected(), null);
  assert.equal(pre.observe(turn), null);
  assert.equal(pre.canSelect('fold', turn), false);
});

test('precheck uses public bet minus own commitment, not offturn hero.toCall', () => {
  const pre = makeController();
  const due = state({ seats: [
    { playerId: 'hero', inHand: true, streetCommit: 10 },
    { playerId: 'other', inHand: true, streetCommit: 20 }
  ] });
  assert.equal(due.hero.toCall, 0, 'server only fills toCall on your turn');
  assert.equal(pre.canSelect('check', due), false);
  assert.equal(pre.canSelect('fold', due), true);
  assert.equal(pre.toggle('check', due), null);
  assert.equal(pre.toggle('fold', due), 'fold');
});

test('new raise cancels precheck even when a later snapshot has reset currentBet', () => {
  const pre = makeController();
  assert.equal(pre.toggle('check', state()), 'check');
  const raise = { id: 2, handNo: 1, seat: 1, text: '乙 加注至 40' };
  const raised = state({ serverTime: 1100, currentBet: 40, events: [state().events[0], raise] });
  assert.equal(pre.observe(raised), null);
  assert.equal(pre.getSelected(), null);

  const across = makeController();
  assert.equal(across.toggle('check', state()), 'check');
  const laterStreet = state({ serverTime: 1200, streetIndex: 1, currentBet: 0,
    seats: [{ playerId: 'hero', inHand: true, streetCommit: 0 }, state().seats[1]],
    events: [state().events[0], raise] });
  assert.equal(across.observe(laterStreet), null);
  assert.equal(across.getSelected(), null);
});

test('street change clears precheck, preserves prefold, and a skipped event gap cancels check', () => {
  const newStreet = state({ serverTime: 1100, streetIndex: 1, currentBet: 0,
    seats: [{ playerId: 'hero', inHand: true, streetCommit: 0 }, state().seats[1]],
    actingSeat: 0, hero: { canAct: true } });
  const check = makeController();
  check.toggle('check', state());
  assert.equal(check.observe(newStreet), null);
  const fold = makeController();
  fold.toggle('fold', state());
  assert.equal(fold.observe(newStreet).action, 'fold');
  const gap = makeController();
  gap.toggle('check', state());
  gap.observe(state({ serverTime: 1200, events: [
    { id: 250, handNo: 1, seat: 1, text: '乙 过牌' }
  ] }));
  assert.equal(gap.getSelected(), null, 'missing public events must not leave a speculative check armed');
});

test('stale and duplicate snapshots cannot consume or cancel a newer choice', () => {
  const pre = makeController();
  pre.toggle('check', state({ serverTime: 2000 }));
  pre.observe(state({ serverTime: 2200 }));
  const stale = state({ serverTime: 2100, currentBet: 40, actingSeat: 0,
    hero: { canAct: true, toCall: 20 }, events: [state().events[0],
      { id: 2, handNo: 1, seat: 1, text: '乙 加注至 40' }] });
  assert.equal(pre.observe(stale), null);
  assert.equal(pre.getSelected(), 'check');
  const current = state({ serverTime: 2300, actingSeat: 0, hero: { canAct: true } });
  assert.equal(pre.observe(current).action, 'check');
  assert.equal(pre.observe(current), null);
});

test('pause keeps an existing choice, disables new choices, and resumes only once', () => {
  const pre = makeController();
  pre.toggle('fold', state());
  const paused = state({ serverTime: 1100, actingSeat: 0, hero: { canAct: true },
    pause: { kind: 'grandGift', endAt: 9999 } });
  assert.equal(pre.canSelect('check', paused), false);
  assert.equal(pre.observe(paused), null);
  assert.equal(pre.getSelected(), 'fold');
  assert.equal(pre.observe(state({ serverTime: 1200, actingSeat: 0, hero: { canAct: true } })).action, 'fold');
});

test('new hand, leaving, folding, all-in, sitting out, runout and finished clear selection', () => {
  const invalid = [
    { handNo: 2 }, { hero: { seat: null } }, { seats: [{ playerId: 'hero', inHand: true, streetCommit: 20, folded: true }, state().seats[1]] },
    { seats: [{ playerId: 'hero', inHand: true, streetCommit: 20, allIn: true }, state().seats[1]] },
    { hero: { sittingOut: true } }, { hero: { pendingSitOut: true } },
    { runout: { phase: 'dealing' } }, { status: 'finished' }
  ];
  for (const changes of invalid) {
    const pre = makeController();
    pre.toggle('fold', state());
    assert.equal(pre.observe(state({ ...changes, serverTime: 1100 })), null);
    assert.equal(pre.getSelected(), null, JSON.stringify(changes));
  }
});

test('actual Room offturn big blind can precheck; an accepted raise cancels it', () => {
  const room = new Room('834271', 4);
  const players = [room.join('甲'), room.join('乙')];
  room.command(players[0].token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(players[1].token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(players[0].token, { type: 'nextHand' });
  const first = room.stateFor(players[0].token);
  const actor = first.actingSeat;
  const other = 1 - actor;
  const viewer = players[other];
  const waiting = room.stateFor(viewer.token);
  assert.equal(waiting.hero.toCall, 0);
  assert.equal(waiting.currentBet - waiting.seats[other].streetCommit, 0);
  const pre = makeController();
  assert.equal(pre.toggle('check', waiting), 'check');
  room.command(players[actor].token, { type: 'action', action: 'raise', amount: 40 });
  assert.equal(pre.observe(room.stateFor(viewer.token)), null);
  assert.equal(pre.getSelected(), null);
});

test('check/fold is mutually exclusive, a second tap cancels, and an unraised turn checks once', () => {
  const pre = makeController();
  const waiting = state();
  assert.equal(pre.canSelect('checkFold', waiting), true);
  assert.equal(pre.toggle('fold', waiting), 'fold');
  assert.equal(pre.toggle('checkFold', waiting), 'checkFold');
  assert.equal(pre.toggle('checkFold', waiting), null);
  assert.equal(pre.toggle('checkFold', waiting), 'checkFold');
  const turn = state({ serverTime: 1100, actingSeat: 0, hero: { canAct: true } });
  assert.equal(pre.observe(turn, { consume: false }), null);
  assert.equal(pre.getSelected(), 'checkFold');
  assert.equal(pre.observe(turn).action, 'check');
  assert.equal(pre.observe(turn), null);
});

test('check/fold may be selected while owing chips and then folds; direct current-turn helper never calls', () => {
  const due = state({ seats: [
    { playerId: 'hero', inHand: true, streetCommit: 10 },
    state().seats[1]
  ] });
  const pre = makeController();
  assert.equal(pre.canSelect('check', due), false);
  assert.equal(pre.canSelect('checkFold', due), true);
  assert.equal(pre.toggle('checkFold', due), 'checkFold');
  const turn = state({ serverTime: 1100, actingSeat: 0, hero: { canAct: true, toCall: 10 }, seats: due.seats });
  assert.equal(pre.observe(turn).action, 'fold');
  assert.equal(actionFor('checkFold', turn), 'fold');
  assert.equal(actionFor('check', turn), null);
  assert.equal(actionFor('fold', turn), 'fold');
  assert.equal(actionFor('checkFold', state()), null, 'helper acts only on the current turn');
  assert.equal(actionFor('checkFold', state({ actingSeat: 0, hero: { canAct: true } })), 'check');
});

test('a raise makes check/fold sticky fold, even if the same street later shows zero to call', () => {
  const pre = makeController();
  pre.toggle('checkFold', state());
  const raised = state({ serverTime: 1100, currentBet: 40,
    events: [state().events[0], { id: 2, handNo: 1, seat: 1, text: '乙 加注至 40' }] });
  assert.equal(pre.observe(raised, { consume: false }), null);
  assert.equal(pre.getSelected(), 'checkFold');
  const turn = state({ serverTime: 1200, actingSeat: 0, hero: { canAct: true, toCall: 0 },
    events: raised.events });
  assert.equal(pre.observe(turn).action, 'fold', 'a later zero due must not undo the earlier raise');
  assert.equal(pre.observe(turn), null);
});

test('check/fold clears at the next street; prefold remains for the same hand', () => {
  const nextStreet = state({ serverTime: 1100, streetIndex: 1, currentBet: 0,
    seats: [{ playerId: 'hero', inHand: true, streetCommit: 0 }, state().seats[1]],
    actingSeat: 0, hero: { canAct: true } });
  const checkFold = makeController();
  checkFold.toggle('checkFold', state());
  assert.equal(checkFold.observe(nextStreet), null);
  assert.equal(checkFold.getSelected(), null);
  const fold = makeController();
  fold.toggle('fold', state());
  assert.equal(fold.observe(nextStreet).action, 'fold');
});

test('paused check/fold stays selected but cannot be picked or consumed; stale raises cannot flip it', () => {
  const pre = makeController();
  pre.toggle('checkFold', state({ serverTime: 2000 }));
  const paused = state({ serverTime: 2200, actingSeat: 0, hero: { canAct: true },
    pause: { kind: 'grandGift', endAt: 9999 } });
  assert.equal(pre.canSelect('checkFold', paused), false);
  assert.equal(pre.observe(paused), null);
  assert.equal(pre.getSelected(), 'checkFold');
  const stale = state({ serverTime: 2100, currentBet: 40,
    events: [state().events[0], { id: 2, handNo: 1, seat: 1, text: '乙 加注至 40' }] });
  assert.equal(pre.observe(stale), null);
  assert.equal(pre.observe(state({ serverTime: 2300, actingSeat: 0, hero: { canAct: true } })).action, 'check');
});

test('a skipped public event gap cancels check/fold rather than guessing whether anyone raised', () => {
  const pre = makeController();
  pre.toggle('checkFold', state());
  pre.observe(state({ serverTime: 1100, events: [
    { id: 250, handNo: 1, seat: 1, text: '乙 过牌' }
  ] }));
  assert.equal(pre.getSelected(), null);
});

test('actual Room offturn check/fold folds after a raise, but checks after a call', () => {
  for (const action of ['raise', 'call']) {
    const room = new Room(action === 'raise' ? '834272' : '834273', 4);
    const players = [room.join('甲'), room.join('乙')];
    room.command(players[0].token, { type: 'sit', seat: 0, buyIn: 2000 });
    room.command(players[1].token, { type: 'sit', seat: 1, buyIn: 2000 });
    room.command(players[0].token, { type: 'nextHand' });
    const actor = room.stateFor(players[0].token).actingSeat;
    const viewer = players[1 - actor];
    const pre = makeController();
    assert.equal(pre.toggle('checkFold', room.stateFor(viewer.token)), 'checkFold');
    room.command(players[actor].token, { type: 'action', action,
      ...(action === 'raise' ? { amount: 40 } : {}) });
    assert.equal(pre.observe(room.stateFor(viewer.token)).action,
      action === 'raise' ? 'fold' : 'check');
  }
});
