import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sound-events.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window }, { filename: 'public/sound-events.js' });
const { createPlanner } = window.PokerSoundEvents;
const plain = value => JSON.parse(JSON.stringify(value));
const now = Date.now();
const at = new Date(now).toISOString();
const base = ({ handNo = 1, board = [], boards, events = [], status = 'playing', canAct = false,
  actingSeat = 1, deadline = now + 25_000, pause = null, streetIndex = 0 } = {}) => ({
  roomCode: '8301', handNo, status, streetIndex, actingSeat, actionDeadline: deadline,
  hero: { seat: 0, canAct }, board, ...(boards ? { runout: { boards } } : {}), pause, events,
  seats: [{ nickname: '甲' }, { nickname: '乙' }]
});
const event = (id, text, seat = 0, handNo = 1) => ({ id, seat, handNo, text, at });

test('first entry and recovery ignore old sounds; WS repeats and polling cannot replay the same action', () => {
  const planner = createPlanner();
  const old = base({ handNo: 6, board: ['As', 'Ks', 'Qs'],
    events: [event(20, '甲 过牌', 0, 6)] });
  assert.deepEqual(plain(planner.observe(old, { now })), []);
  assert.deepEqual(plain(planner.observe(old, { now })), []);
  const fresh = { ...old, events: [...old.events, event(21, '甲 跟注 20', 0, 6)] };
  assert.deepEqual(plain(planner.observe(fresh, { now })), [{ kind: 'call' }]);
  assert.deepEqual(plain(planner.observe(fresh, { now })), [], 'a duplicate WS state must be silent');
  assert.deepEqual(plain(planner.observe(fresh, { now, silent: true })), [],
    'language repaint or polling of the same state must be silent');
  planner.reset();
  assert.deepEqual(plain(planner.observe(fresh, { now })), [], 'returning to a room baselines its history');
});

test('server action events drive check, fold, raise and confirmed all-in cues', () => {
  const planner = createPlanner();
  let data = base();
  planner.baseline(data);
  for (const [id, text, expected] of [
    [1, '甲 过牌', 'check'],
    [2, '甲 弃牌', 'fold'],
    [3, '甲 加注至 200', 'raise'],
    [4, '甲 跟注 180，全下', 'allin'],
    [5, '甲 下注至 100，全下', 'allin']
  ]) {
    data = { ...data, events: [...data.events, event(id, text)] };
    assert.deepEqual(plain(planner.observe(data, { now })), [{ kind: expected }], text);
  }
  assert.deepEqual(plain(planner.observe({ ...data, events: [...data.events,
    event(6, '甲 填入全下金额 500')] }, { now })), [],
  'typing or filling all-in is not an accepted poker action');
});

test('flop and each later card sound once, including an independent second runout board', () => {
  const planner = createPlanner();
  let data = base({ boards: [[]] });
  planner.baseline(data);
  const lengths = [[3], [4], [5], [5, 0], [5, 3], [5, 4], [5, 5]];
  const expected = [
    [{ kind: 'flip', count: 3 }], [{ kind: 'flip', count: 1 }], [{ kind: 'flip', count: 1 }],
    [], [{ kind: 'flip', count: 3 }], [{ kind: 'flip', count: 1 }], [{ kind: 'flip', count: 1 }]
  ];
  for (let index = 0; index < lengths.length; index++) {
    data = { ...data, runout: { boards: lengths[index].map(length => Array(length).fill('As')) } };
    assert.deepEqual(plain(planner.observe(data, { now })), expected[index]);
    assert.deepEqual(plain(planner.observe(data, { now })), [], 'same board may arrive by WS and poll');
  }
  data = { ...data, status: 'finished', result: { winners: [] } };
  assert.deepEqual(plain(planner.observe(data, { now })), [{ kind: 'win' }]);
  assert.deepEqual(plain(planner.observe(data, { now })), []);
  const next = base({ handNo: 2, events: [event(9, '第 2 手开始', null, 2)] });
  assert.deepEqual(plain(planner.observe(next, { now })), [{ kind: 'deal' }]);
});

test('a turn and its five-second warning happen once; a gift pause does not invent another turn', () => {
  const planner = createPlanner();
  let data = base({ canAct: false });
  planner.baseline(data);
  data = { ...data, hero: { canAct: true }, actingSeat: 0 };
  assert.deepEqual(plain(planner.observe(data, { now })), [{ kind: 'turn', delay: 100 }]);
  assert.equal(planner.warning(data, now + 19_000), null);
  assert.deepEqual(plain(planner.warning(data, now + 21_000)), { kind: 'warning' });
  assert.equal(planner.warning(data, now + 21_100), null);

  const paused = { ...data, pause: { startAt: now + 22_000, endAt: now + 32_000 },
    actionDeadline: now + 35_000 };
  assert.deepEqual(plain(planner.observe(paused, { now: now + 22_000 })), []);
  assert.equal(planner.warning(paused, now + 31_000), null);
  const resumed = { ...paused, pause: null };
  assert.deepEqual(plain(planner.observe(resumed, { now: now + 32_000 })), [],
    'gift presentation does not start a new betting turn');
  assert.equal(planner.warning(resumed, now + 32_000), null,
    'the same turn must not warn a second time after gift presentation');
});

test('a polling gap that misses an opponent turn can still identify the hero next turn', () => {
  const planner = createPlanner();
  let data = base({ actingSeat: 0, canAct: true, deadline: now + 10_000 });
  planner.baseline(data);
  data = { ...data, actionDeadline: now + 25_000,
    events: [event(1, '甲 跟注 20', 0), event(2, '乙 加注至 200', 1)] };
  assert.deepEqual(plain(planner.observe(data, { now })),
    [{ kind: 'call' }, { kind: 'raise' }, { kind: 'turn', delay: 100 }]);
});

test('another player sitting out mid-turn cannot replay the hero turn or its warning', () => {
  const planner = createPlanner();
  let data = base({ canAct: false, actingSeat: 1 });
  planner.baseline(data);
  data = { ...data, hero: { seat: 0, canAct: true }, actingSeat: 0 };
  assert.deepEqual(plain(planner.observe(data, { now })), [{ kind: 'turn', delay: 100 }]);
  assert.deepEqual(plain(planner.warning(data, now + 21_000)), { kind: 'warning' });
  const sitOut = { ...data, events: [event(1, '乙 暂时离席，本手弃牌', 1)] };
  assert.deepEqual(plain(planner.observe(sitOut, { now: now + 21_100 })), []);
  assert.equal(planner.warning(sitOut, now + 21_200), null);
});

test('a shared flop appears only once across two runout boards', () => {
  const planner = createPlanner();
  const shared = ['As', 'Ks', 'Qs'];
  const first = base({ board: shared, boards: [shared] });
  first.runout.sharedBoardCount = 3;
  planner.baseline(first);
  const second = { ...first, runout: { sharedBoardCount: 3, boards: [shared, shared] } };
  assert.deepEqual(plain(planner.observe(second, { now })), []);
  assert.deepEqual(plain(planner.observe({ ...second, runout: {
    ...second.runout, boards: [shared, [...shared, '2c']]
  } }, { now })), [{ kind: 'flip', count: 1 }]);
  assert.deepEqual(plain(planner.observe({ ...second, runout: {
    ...second.runout, boards: [shared, [...shared, '2c', '3d']]
  } }, { now })), [{ kind: 'flip', count: 1 }]);
});

test('a recovered live turn may warn later, but never plays its historical turn cue', () => {
  const planner = createPlanner();
  const data = base({ actingSeat: 0, canAct: true, deadline: now + 25_000 });
  assert.deepEqual(plain(planner.observe(data, { now })), []);
  assert.equal(planner.warning(data, now + 18_000), null);
  assert.deepEqual(plain(planner.warning(data, now + 21_000)), { kind: 'warning' });
  assert.equal(planner.warning(data, now + 21_100), null);
  planner.reset();
  const urgent = { ...data, actionDeadline: now + 3000 };
  assert.deepEqual(plain(planner.observe(urgent, { now })), []);
  assert.equal(planner.warning(urgent, now), null, 'entry inside the final five seconds must not replay a warning');
});

test('first reconnect frame sounds only actions newer than the disconnect server timestamp', () => {
  const planner = createPlanner();
  const initial = { ...base({ events: [event(20, '甲 过牌', 0)] }), serverTime: now };
  planner.baseline(initial, now);
  const disconnectedAt = now + 1000;
  const catchup = { ...initial, serverTime: now + 3000, events: [
    ...initial.events,
    { ...event(21, '甲 弃牌', 0), at: new Date(now + 500).toISOString() },
    { ...event(22, '乙 加注至 120', 1), at: new Date(now + 2000).toISOString() }
  ] };
  assert.deepEqual(plain(planner.observe(catchup, { now: catchup.serverTime, since: disconnectedAt })),
    [{ kind: 'raise' }], 'one restored state may contain both old and genuinely new events');
  assert.deepEqual(plain(planner.observe(catchup, { now: catchup.serverTime })), [],
    'the same frame over WS and HTTP cannot replay the new action');
});

test('late old HTTP state cannot replay a turn or old board after a newer reconnect frame', () => {
  const planner = createPlanner();
  const initial = { ...base({ board: [], events: [], canAct: false, actingSeat: 1 }), serverTime: now };
  planner.baseline(initial, now);
  const disconnectedAt = now + 1000;
  const current = { ...initial, serverTime: now + 3000, board: ['As', 'Ks', 'Qs'],
    actingSeat: 0, hero: { seat: 0, canAct: true },
    events: [
      { ...event(1, '翻牌：As Ks Qs', null), at: new Date(now + 500).toISOString() },
      { ...event(2, '乙 过牌', 1), at: new Date(now + 2000).toISOString() }
    ] };
  assert.deepEqual(plain(planner.observe(current, { now: current.serverTime, since: disconnectedAt })),
    [{ kind: 'check' }, { kind: 'turn', delay: 100 }],
    'the old flop stays quiet while a new check and the live hero turn are audible');
  const lateHttp = { ...initial, serverTime: now + 2000, board: ['As', 'Ks', 'Qs'],
    events: current.events.slice(0, 1) };
  assert.deepEqual(plain(planner.observe(lateHttp, { now: lateHttp.serverTime })), [],
    'a stale HTTP response must not rewind the sound planner');
  assert.deepEqual(plain(planner.observe(current, { now: current.serverTime })), [],
    'after the stale response, the current WS state must not repeat the turn');
});

test('reconnect snapshots need a post-disconnect event before sounding deal or win', () => {
  const disconnectedAt = now + 1000;
  const oldStart = { ...event(8, '第 2 手开始；甲持按钮', null, 2),
    at: new Date(now + 500).toISOString() };
  const recentStart = { ...oldStart, at: new Date(now + 1500).toISOString() };
  for (const [start, expected] of [[oldStart, []], [recentStart, [{ kind: 'deal' }]]]) {
    const planner = createPlanner();
    planner.baseline({ ...base({ handNo: 1, status: 'finished' }), serverTime: now }, now);
    const next = { ...base({ handNo: 2, events: [start] }), serverTime: now + 2000 };
    assert.deepEqual(plain(planner.observe(next, { now: next.serverTime, since: disconnectedAt })), expected);
  }
  const oldWin = { ...event(9, '甲 赢得底池 40（其他玩家弃牌）', 0),
    at: new Date(now + 500).toISOString() };
  const recentWin = { ...oldWin, at: new Date(now + 1500).toISOString() };
  for (const [winner, expected] of [[oldWin, []], [recentWin, [{ kind: 'win' }]]]) {
    const planner = createPlanner();
    planner.baseline({ ...base(), serverTime: now }, now);
    const settled = { ...base({ status: 'finished', events: [winner] }),
      serverTime: now + 2000, result: { winners: [] } };
    assert.deepEqual(plain(planner.observe(settled, { now: settled.serverTime, since: disconnectedAt })), expected);
  }
});
