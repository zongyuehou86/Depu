import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Room, ACTION_TIME_MS, ACTION_DISPLAY_TIME_MS, ACTION_GRACE_MS } from '../room.js';

function setup(t, count = 2) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const room = new Room('721234', 4);
  const players = Array.from({ length: count }, (_, seat) => {
    const player = room.join(`Grace ${seat}`);
    room.command(player.token, { type: 'sit', seat, buyIn: 2000 });
    return player;
  });
  room.command(players[0].token, { type: 'nextHand' });
  return { room, players, start: now, setTime: value => { now = value; } };
}
const expected = room => ({ handNo: room.handNo, streetIndex: room.hand.street,
  actingSeat: room.hand.actingSeat, actionDeadline: room.hand.actionDeadline, currentBet: room.hand.currentBet });
const snapshot = room => JSON.parse(JSON.stringify(room.toJSON()));

function clockHarness(data, start) {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.match(/  function updateTimers\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(source);
  let now = start;
  const bar = { style: {}, classList: { toggle() {} } };
  const state = { data, soundResumeAt: 1 };
  const update = Function('state', '$', 'document', 'giftNow', 'limit', `${source}; return updateTimers`)(
    state, () => ({ hidden: false }), { querySelectorAll: () => [bar] }, () => now,
    (value, lo, hi) => Math.max(lo, Math.min(hi, value)));
  return { state, width(at) { now = at; update(); return bar.style.width; } };
}

test('authoritative free35 and display30 clocks expire independently; displayed grace stays empty', t => {
  const { room, players, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  const data = room.stateFor(actor.token);
  assert.equal(ACTION_TIME_MS, 35000);
  assert.equal(ACTION_DISPLAY_TIME_MS, 30000);
  assert.equal(ACTION_GRACE_MS, 5000);
  assert.equal(data.actionDeadline, start + 35000);
  assert.equal(data.actionDisplayDeadline, start + 30000);
  assert.equal(data.actionWindowMs, 30000);
  const ui = clockHarness(data, start);
  for (const [elapsed, width] of [[0, '100.0%'], [15000, '50.0%'], [30000, '0.0%'], [34999, '0.0%']]) {
    assert.equal(ui.width(start + elapsed), width);
    setTime(start + elapsed);
    assert.equal(room.timeoutAction(), false);
    assert.equal(actor.hand.timebankCommit, 0);
  }
  setTime(start + 35000);
  assert.equal(room.timeoutAction(), true);
  assert.equal(room.status, 'finished');
  assert.equal(actor.hand.folded, true);
  assert.equal(players.reduce((n, p) => n + p.stack, 0), 4000);
});

test('a guarded manual action remains valid throughout the final five free seconds', t => {
  const { room, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  const guard = expected(room);
  setTime(start + 34999);
  room.command(actor.token, { type: 'action', action: 'call', expectedAction: guard });
  assert.equal(actor.hand.lastAction, 'call');
  assert.equal(actor.hand.timebankCommit, 0);
  assert.equal(room.hand.actionDeadline, start + 69999, 'next actor gets a fresh35seconds');
});

test('timebank charges only after35 seconds and paid blocks display exactly10 seconds', t => {
  const { room, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'timebank', enabled: true });
  for (const elapsed of [30000, 34999]) {
    setTime(start + elapsed);
    assert.equal(room.timeoutAction(), false);
    assert.equal(actor.hand.timebankCommit, 0);
  }
  setTime(start + 35000);
  assert.equal(room.timeoutAction(), true);
  assert.equal(actor.hand.timebankCommit, 10);
  const paid = room.stateFor(actor.token);
  assert.equal(paid.actionDeadline, start + 45000);
  assert.equal(paid.actionDisplayDeadline, paid.actionDeadline);
  assert.equal(paid.actionWindowMs, 10000);
  const ui = clockHarness(paid, start + 35000);
  assert.equal(ui.width(start + 35000), '100.0%');
  assert.equal(ui.width(start + 40000), '50.0%');
  setTime(start + 45000);
  assert.equal(room.timeoutAction(), true);
  assert.equal(actor.hand.timebankCommit, 20);
});

test('turning paid time off during grace does not spend chips or shorten the free deadline', t => {
  const { room, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'timebank', enabled: true });
  setTime(start + 32000);
  room.command(actor.token, { type: 'timebank', enabled: false });
  assert.equal(actor.hand.timebankCommit, 0);
  assert.equal(room.hand.actionDeadline, start + 35000);
  setTime(start + 35000);
  assert.equal(room.timeoutAction(), true);
  assert.equal(actor.hand.timebankCommit, 0);
});

test('pause during grace freezes an empty bar and restores only the remaining free milliseconds', t => {
  const { room, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  setTime(start + 32000);
  room.command(actor.token, { type: 'timebank', enabled: true });
  room.activateGrandPause({ startAt: start + 32000, endAt: start + 42000,
    grandEndAt: start + 40000, flightStartAt: start + 40000, flightEndAt: start + 42000 });
  const paused = room.stateFor(actor.token);
  assert.equal(paused.actionDeadline, start + 45000);
  assert.equal(paused.actionDisplayDeadline, start + 40000);
  const ui = clockHarness(paused, start + 33000);
  assert.equal(ui.width(start + 33000), '0.0%');
  assert.equal(room.timeoutAction(), false);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.hand.actionDeadline, start + 45000);
  setTime(start + 42000);
  restored.endPauseIfDue();
  assert.equal(restored.timeoutAction(), false);
  setTime(start + 44999);
  assert.equal(restored.timeoutAction(), false);
  setTime(start + 45000);
  assert.equal(restored.timeoutAction(), true);
  assert.equal(restored.requireMember(actor.token).hand.timebankCommit, 10);
});

test('v3 free and v2 free migration grants correct grace once; already paid deadlines never change', t => {
  const { room, start } = setup(t);
  for (const [version, previousFree, paid] of [[3, 30000, false], [2, 25000, false], [3, 10000, true], [2, 10000, true]]) {
    const old = snapshot(room);
    old.hand.timerVersion = version;
    old.hand.actionDeadline = start + previousFree;
    old.hand.actionTimebankBlocks = paid ? 1 : 0;
    const restored = Room.fromJSON(old);
    const deadline = start + (paid ? 10000 : 35000);
    assert.equal(restored.hand.actionDeadline, deadline);
    assert.equal(restored.hand.timerVersion, 4);
    assert.equal(Room.fromJSON(snapshot(restored)).hand.actionDeadline, deadline);
  }
});

test('restoring an expired v4 free clock does not resurrect the action or charge multiple late blocks', t => {
  const { room, start, setTime } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  room.command(actor.token, { type: 'timebank', enabled: true });
  setTime(start + 120000);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.hand.actionDeadline, start + 35000);
  assert.equal(restored.timeoutAction(), true);
  assert.equal(restored.hand.actionDeadline, start + 130000);
  assert.equal(restored.requireMember(actor.token).hand.timebankCommit, 10);
  assert.equal(restored.timeoutAction(), false);
});

test('warning sound follows visual final five and does not replay on resume inside grace', t => {
  const { room, start } = setup(t);
  const actor = room.seatMember(room.hand.actingSeat);
  const data = room.stateFor(actor.token), window = {};
  vm.runInNewContext(readFileSync(new URL('../public/sound-events.js', import.meta.url), 'utf8'), { window });
  const planner = window.PokerSoundEvents.createPlanner();
  planner.baseline(data, start);
  assert.equal(planner.warning(data, start + 24999), null);
  assert.equal(planner.warning(data, start + 25000)?.kind, 'warning');
  assert.equal(planner.warning(data, start + 26000), null);
  const resumed = window.PokerSoundEvents.createPlanner();
  resumed.baseline(data, start + 31000);
  assert.equal(resumed.warning(data, start + 31000), null);
});

test('legacy paused runouts without an action clock stay byte-for-byte unchanged', t => {
  const { room } = setup(t);
  room.hand.timerVersion = 3;
  room.hand.actingSeat = null;
  room.hand.actionDeadline = null;
  room.hand.runout = { phase: 'paused', initialStreet: 0, boardResults: [], sharedBoard: [],
    times: null, deadline: null, nextCardAt: null };
  const old = snapshot(room);
  const restored = Room.fromJSON(JSON.parse(JSON.stringify(old)));
  assert.deepEqual(restored.hand, old.hand);
});
