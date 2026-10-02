import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const app = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const translations = readFileSync(path.join(publicDir, 'i18n.js'), 'utf8');
const plannerSource = readFileSync(path.join(publicDir, 'sound-events.js'), 'utf8');
const chipSource = readFileSync(path.join(publicDir, 'chip-display.js'), 'utf8');
const window = {};
vm.runInNewContext(plannerSource, { window });
vm.runInNewContext(chipSource, { window, localStorage: { getItem: () => null, setItem() {} } });

function productionFunction(name, dependencies) {
  const source = app.match(new RegExp(`  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `missing real ${name} implementation`);
  return Function(...Object.keys(dependencies), `${source}\nreturn ${name}`)(...Object.values(dependencies));
}

test('sound settings controls and translations exist before app startup', () => {
  assert.match(html, /<script src="\/i18n\.js" defer><\/script>[\s\S]*<script src="\/sounds\.js" defer><\/script>[\s\S]*<script src="\/sound-events\.js" defer><\/script>[\s\S]*<script src="\/app\.js" defer><\/script>/);
  for (const id of ['sound-open', 'sound-panel', 'sound-close', 'sound-enabled',
    'sound-volume', 'sound-volume-value', 'sound-preview']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const key of ['音效设置', '牌桌音效', '关闭音效设置', '开启音效', '音量', '试听']) {
    assert.ok(translations.includes(`['${key}'`), `missing translated settings key: ${key}`);
  }
  const elements = new Map();
  for (const id of ['sound-open', 'sound-enabled', 'sound-volume', 'sound-volume-value', 'sound-preview']) {
    elements.set(`#${id}`, { value: '', checked: false, disabled: false, textContent: '',
      classList: { toggle(name, active) { this[name] = active; } } });
  }
  const sounds = { getSettings: () => ({ enabled: true, volume: 0.45, available: true }) };
  const sync = productionFunction('syncSoundControls', { sounds, $: selector => elements.get(selector) });
  assert.doesNotThrow(sync);
  assert.equal(elements.get('#sound-enabled').checked, true);
  assert.equal(elements.get('#sound-volume').value, '45');
  assert.equal(elements.get('#sound-volume-value').textContent, '45%');
  assert.equal(elements.get('#sound-preview').disabled, false);
});

test('filling all-in sends no command or sound; confirmed raise sounds from the accepted server event only', () => {
  const calls = [], commands = [], timers = new Map();
  let timerId = 0;
  const setTimeoutFake = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  const clearTimeoutFake = id => timers.delete(id);
  const sounds = { play(kind, options) { calls.push({ kind, options }); } };
  const soundPlanner = window.PokerSoundEvents.createPlanner();
  const now = Date.now();
  const initial = { roomCode: '8301', handNo: 1, status: 'playing', streetIndex: 0,
    currentBet: 20, minRaiseTo: 40, actingSeat: 0, actionDeadline: now + 25_000,
    hero: { seat: 0, canAct: true, maxRaiseTo: 500 }, board: [], events: [],
    seats: [{ nickname: '甲' }, { nickname: '乙' }], serverTime: now };
  const state = { roomCode: '8301', token: 'test', session: 1, data: initial,
    clockOffset: 0, soundResumeAt: 0, soundTurnTimer: null, newRunoutCards: new Set() };
  soundPlanner.baseline(initial, now);
  const playSoundCues = productionFunction('playSoundCues', {
    sounds, state, document: { hidden: false }, clearTimeout: clearTimeoutFake, setTimeout: setTimeoutFake
  });
  const applyState = productionFunction('applyState', {
    state, soundPlanner, render() {}, playSoundCues, showToast() {}, t: value => value,
    Date, preactions: { observe() {} }, runPreaction() {}
  });
  const chips = window.PokerChips;
  const input = { value: '', dataset: { chipUnit: 'chips' } };
  const actionControls = { addEventListener(_name, listener) { this.click = listener; } };
  const $ = selector => selector === '#action-controls' ? actionControls :
    selector === '#raise-amount' ? input : null;
  const clickSource = app.match(/  \$\('#action-controls'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?\n  \}\);\n  \$\('#action-controls'\)\.addEventListener\('input'/)?.[0]
    .replace(/\n  \$\('#action-controls'\)\.addEventListener\('input'$/, '');
  assert.ok(clickSource);
  Function('$', 'state', 'document', 'command', 'showToast', 'raisePreviewText', 't', 'chips', 'chipAmount', clickSource)(
    $, state, { querySelectorAll: () => [] }, value => commands.push(value), () => {}, () => '',
    value => value, chips, value => chips.format(value, state.data));
  const press = dataset => actionControls.click({ target: { closest: selector => {
    if (selector === 'button[data-fill="allin"]' && dataset.fill === 'allin') return { dataset };
    if (selector === 'button[data-action]' && dataset.action) return { dataset };
    return null;
  } } });
  press({ fill: 'allin' });
  assert.equal(input.value, '500');
  assert.deepEqual(commands, []);
  assert.deepEqual(calls, []);
  press({ action: 'raise' });
  assert.deepEqual(commands, [{ type: 'action', action: 'raise', amount: 500 }]);
  assert.deepEqual(calls, [], 'a click alone cannot sound before server acceptance');

  const accepted = { ...initial, serverTime: now + 100,
    events: [{ id: 1, handNo: 1, seat: 0, text: '甲 加注至 500，全下', at: new Date(now).toISOString() }],
    hero: { ...initial.hero, canAct: false } };
  applyState(accepted);
  assert.deepEqual(calls.map(item => item.kind), ['allin']);
  applyState(accepted);
  assert.deepEqual(calls.map(item => item.kind), ['allin'], 'duplicate WS or HTTP state stays silent');
  const afterReconnect = { ...accepted, events: [...accepted.events,
    { id: 2, handNo: 1, seat: 1, text: '乙 过牌', at: new Date(now).toISOString() }] };
  applyState(afterReconnect, { soundSilent: true });
  applyState(afterReconnect);
  assert.deepEqual(calls.map(item => item.kind), ['allin'], 'reconnect baselines the missed event');
});

test('a pending HTTP refresh uses the disconnect timestamp when its response arrives', async () => {
  const now = Date.now();
  const initial = { roomCode: '8301', handNo: 1, status: 'playing', streetIndex: 0,
    actingSeat: 1, serverTime: now, hero: { seat: 0, canAct: false }, board: [],
    events: [], seats: [{ nickname: '甲' }, { nickname: '乙' }] };
  const state = { roomCode: '8301', token: 'test', session: 1, data: initial,
    soundResumeAt: 0, clockOffset: 0, newRunoutCards: new Set(), soundTurnTimer: null, socket: null };
  const soundPlanner = window.PokerSoundEvents.createPlanner();
  soundPlanner.baseline(initial, now);
  const heard = [];
  const applyState = productionFunction('applyState', {
    state, soundPlanner, render() {}, playSoundCues: cues => heard.push(...cues.map(cue => cue.kind)),
    showToast() {}, t: value => value, Date, preactions: { observe() {} }, runPreaction() {}
  });
  let deliver;
  const request = () => new Promise(resolve => { deliver = resolve; });
  const refreshSource = app.match(/  async function refreshState\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(refreshSource, 'use the production HTTP refresh handler');
  const refreshState = Function('state', 'request', 'applyState', 'WebSocket', 'setConnection',
    'isRoomClosedError', 'closeExpiredRoom', 'preactions', 'renderActions', `${refreshSource}\nreturn refreshState`)(
    state, request, applyState, { OPEN: 1 }, () => {}, () => false, () => {},
    { reset() {} }, () => {});
  const pending = refreshState();
  const disconnectedAt = now + 1000;
  state.soundResumeAt = disconnectedAt; // The socket closed while the HTTP request was awaiting.
  const catchup = { ...initial, serverTime: now + 3000, events: [
    { id: 1, handNo: 1, seat: 0, text: '甲 弃牌', at: new Date(now + 500).toISOString() },
    { id: 2, handNo: 1, seat: 1, text: '乙 加注至 120', at: new Date(now + 2000).toISOString() }
  ] };
  deliver({ state: catchup });
  await pending;
  assert.deepEqual(heard, ['raise'], 'the awaited response keeps only post-disconnect action audio');
  assert.equal(state.soundResumeAt, 0);
  applyState({ ...catchup, serverTime: now + 2000, events: catchup.events.slice(0, 1) });
  applyState(catchup);
  assert.deepEqual(heard, ['raise'], 'late old HTTP and repeated current state cannot replay sounds');
});

test('late HTTP and direct stale snapshots cannot cancel a newer WS turn sound',
  { timeout: 2500 }, async () => {
    const now = Date.now();
    const initial = { roomCode: '8301', handNo: 4, status: 'playing', streetIndex: 1,
      actingSeat: 1, serverTime: now, hero: { seat: 0, canAct: false }, board: ['As', 'Ks', 'Qs'],
      events: [], seats: [{ nickname: '甲' }, { nickname: '乙' }] };
    const state = { roomCode: '8301', token: 'test', session: 1, data: initial,
      soundResumeAt: 0, clockOffset: 0, newRunoutCards: new Set(), soundTurnTimer: null, socket: null };
    const soundPlanner = window.PokerSoundEvents.createPlanner();
    soundPlanner.baseline(initial, now);
    const heard = [];
    let renders = 0;
    const sounds = { play: kind => heard.push(kind) };
    const playSoundCues = productionFunction('playSoundCues', {
      sounds, state, document: { hidden: false }, clearTimeout, setTimeout
    });
    const applyState = productionFunction('applyState', {
      state, soundPlanner, render() { renders++; }, playSoundCues, showToast() {}, t: value => value,
      Date, clearTimeout, preactions: { observe() {} }, runPreaction() {}
    });
    let deliver;
    const request = () => new Promise(resolve => { deliver = resolve; });
    const refreshSource = app.match(/  async function refreshState\(\) \{[\s\S]*?\n  \}/)?.[0];
    assert.ok(refreshSource);
    const refreshState = Function('state', 'request', 'applyState', 'WebSocket', 'setConnection',
      'isRoomClosedError', 'closeExpiredRoom', 'preactions', 'renderActions', `${refreshSource}\nreturn refreshState`)(
      state, request, applyState, { OPEN: 1 }, () => {}, () => false, () => {},
      { reset() {} }, () => {});
    const pendingHttp = refreshState();
    const freshWs = { ...initial, serverTime: now + 200, actingSeat: 0,
      hero: { seat: 0, canAct: true }, actionDeadline: now + 25_000 };
    applyState(freshWs);
    assert.equal(state.data, freshWs);
    assert.ok(state.soundTurnTimer, 'the WS turn is scheduled');
    const turnTimer = state.soundTurnTimer;
    const offset = state.clockOffset;
    const stale = { ...initial, serverTime: now + 100 };
    applyState(stale);
    assert.equal(state.data, freshWs, 'a directly applied stale state cannot roll back the table');
    assert.equal(state.soundTurnTimer, turnTimer, 'direct stale apply cannot cancel the turn timer');
    assert.equal(state.clockOffset, offset);
    deliver({ state: stale });
    await pendingHttp;
    assert.equal(state.data, freshWs, 'a late HTTP response cannot roll back the newer WS state');
    assert.equal(state.soundTurnTimer, turnTimer, 'late HTTP cannot cancel the queued turn sound');
    assert.equal(state.clockOffset, offset);
    assert.equal(renders, 1, 'stale snapshots must not repaint the table');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(heard, ['turn'], 'the still-current turn sounds after its 100 ms delay');
    const sameMillisecond = { ...freshWs, pot: 120 };
    applyState(sameMillisecond);
    assert.equal(state.data, sameMillisecond, 'same-server-time updates remain valid');
    assert.equal(renders, 2);
  });

test('a newly observed own turn alerts immediately in the background without replaying ordinary sounds', () => {
  const heard = [], timers = [];
  const state = { roomCode: '8301', session: 1, soundTurnTimer: null,
    data: { handNo: 2, status: 'playing', pause: null, hero: { canAct: true } } };
  const playSoundCues = productionFunction('playSoundCues', {
    sounds: { play(kind, options) { heard.push({ kind, options }); } }, state,
    document: { hidden: true }, clearTimeout() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
  });
  playSoundCues([{ kind: 'turn', delay: 420 }]);
  assert.deepEqual(heard, [{ kind: 'turn', options: { allowHidden: true } }]);
  assert.deepEqual(timers, [], 'a hidden tab must not wait for a throttled timeout');
  state.data.hero.canAct = false;
  playSoundCues([{ kind: 'turn', delay: 100 }]);
  assert.equal(heard.length, 1, 'the alert checks the latest turn before playing');
});
