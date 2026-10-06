import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadI18n, sourceFile } from './i18n-harness.js';

const app = sourceFile('app.js');
const noop = () => {};

// Run the shipping functions together so the tests exercise their shared state,
// actual translated labels, and chip formatter rather than a duplicate model.
function productionFunctions(names, dependencies) {
  const sources = names.map(name => {
    const source = app.match(new RegExp(`  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(source, `missing production ${name}`);
    return source;
  });
  return Function(...Object.keys(dependencies), `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(
    ...Object.values(dependencies));
}

function actionHarness({ stack = 80, spendable = stack, toCall = 180, unit = 'chips',
  language = 'en', bigBlind = 20, canAct = true, pending = false, pause = null } = {}) {
  const { i18n } = loadI18n({ stored: language });
  const window = {};
  vm.runInNewContext(sourceFile('chip-display.js'), { window, localStorage: { getItem: () => unit, setItem: noop } });
  vm.runInNewContext(sourceFile('preactions.js'), { window });
  const chips = window.PokerChips;
  const data = { roomCode: '123456', status: 'playing', pause, handNo: 1, streetIndex: 0,
    currentBet: 200, minRaiseTo: 380, bigBlind, pot: 240, actingSeat: canAct ? 0 : 1,
    seats: [{ playerId: 'hero', inHand: true, stack, spendableStack: spendable, streetCommit: 20 }],
    hero: { playerId: 'hero', seat: 0, canAct, toCall, canRaise: false, spendableStack: spendable,
      maxRaiseTo: spendable + 20 } };
  const nodes = {
    '#action-title': { textContent: '' },
    '#action-panel': { hidden: false, classList: { toggle: noop, remove: noop } },
    '#action-controls': { innerHTML: '' },
    '#to-call-label': { textContent: '' }
  };
  const state = { data, pending, clockOffset: 0 };
  const functions = productionFunctions(['defaultRaiseAmount', 'raiseSuggestion', 'bettingControlsHtml', 'renderActions'], {
    state, chips, preactions: window.PokerPreactions.createController(),
    $: selector => nodes[selector] ?? null, t: i18n.t, safe: String,
    chipAmount: (value, current) => chips.format(value, current),
    isFinished: () => false, currentRevealable: () => null, canStart: () => false
  });
  return { data, nodes, state, render() { functions.renderActions(data); },
    button() { return nodes['#action-controls'].innerHTML.match(/<button[^>]*class="[^"]*action-call[^>]*>[^<]*<\/button>/)?.[0]; },
    hint() { return nodes['#to-call-label'].textContent; } };
}

test('short-stack calls display the affordable amount in both button and hint', () => {
  for (const stack of [80, 30, 180, 500]) {
    const ui = actionHarness({ stack });
    ui.render();
    const expected = Math.min(180, stack);
    assert.match(ui.button(), new RegExp(`>Call ${expected}</button>$`));
    assert.doesNotMatch(ui.button(), /disabled/);
    assert.equal(ui.hint(), `To call ${expected}`);
    assert.equal(ui.data.hero.toCall, 180, 'rendering never mutates the server betting gap');
  }
});

test('call labels use spendable chips, preserve BB/localization, and support older seat snapshots', () => {
  for (const [language, call, hint] of [['zh-CN', '跟注', '需跟注'], ['zh-TW', '跟注', '需跟注'], ['en', 'Call', 'To call']]) {
    const ui = actionHarness({ stack: 500, spendable: 30, unit: 'bb', language });
    ui.render();
    assert.match(ui.button(), new RegExp(`>${call} 1.5 BB</button>$`));
    assert.equal(ui.hint(), `${hint} 1.5 BB`);
    delete ui.data.hero.spendableStack;
    ui.render();
    assert.equal(ui.hint(), `${hint} 1.5 BB`, 'seat spendable balance takes precedence over locked chips');
    delete ui.data.seats[0].spendableStack;
    ui.data.seats[0].stack = 80;
    ui.data.bigBlind = 40;
    ui.render();
    assert.equal(ui.hint(), `${hint} 2 BB`, 'legacy seat balance and current BB remain supported');
  }
});

test('zero spendable chips cannot call; free checks, off-turn, pending and paused controls remain safe', () => {
  for (const spendable of [0, -10]) {
    const ui = actionHarness({ stack: 500, spendable });
    ui.render();
    assert.match(ui.button(), /disabled[^>]*>Call 0<\/button>$/);
    assert.equal(ui.hint(), 'To call 0');
  }
  const check = actionHarness({ toCall: 0 });
  check.render();
  assert.equal(check.button(), undefined);
  assert.match(check.nodes['#action-controls'].innerHTML, /action-check"[^>]*>Check<\/button>/);
  const waiting = actionHarness({ canAct: false });
  waiting.render();
  assert.match(waiting.button(), /data-preaction="call" aria-pressed="false"[^>]*>Call 80<\/button>$/);
  assert.doesNotMatch(waiting.button(), /disabled/);
  assert.equal(waiting.hint(), '');
  for (const options of [{ pending: true }, { pause: { endAt: Date.now() + 60_000 } }]) {
    const ui = actionHarness(options);
    ui.render();
    assert.match(ui.button(), /disabled[^>]*>Call 80<\/button>$/);
  }
});

function connectionHarness() {
  const { i18n } = loadI18n({ stored: 'en' });
  const badge = { dataset: {}, textContent: '', className: '' };
  const state = { roomCode: '123456', token: 'test-token', session: 1, data: { stateVersion: 1 },
    socket: null, socketSeenAt: 0, refreshing: null, lastSyncAt: 0, retry: null, clockOffset: 0 };
  let now = 100_000, request = async () => ({ state: state.data }), resets = 0;
  const sockets = [], applied = [], timers = new Map();
  let nextTimer = 0;
  class WebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; }
  }
  const functions = productionFunctions(['setConnection', 'connectSocket', 'refreshState', 'syncConnection'], {
    state, WebSocket, Date: { now: () => now }, location: { protocol: 'https:', host: 'localhost' },
    $: () => badge, t: i18n.t, request: (...args) => request(...args),
    applyState: data => applied.push(data), preactions: { reset: () => { resets++; } },
    renderActions: noop, sounds: { stop: noop }, queueRoomEffect: noop, showGiftEffect: noop, showToast: noop,
    closeExpiredRoom: noop, isRoomClosedError: () => false,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  });
  return { ...functions, state, badge, sockets, applied, timers, resets: () => resets,
    advance(milliseconds) { now += milliseconds; }, now: () => now,
    setRequest(next) { request = next; },
    open() { functions.connectSocket(state.session); const socket = state.socket; socket.readyState = 1; socket.onopen(); return socket; },
    message(packet, socket = state.socket) { socket.onmessage({ data: JSON.stringify(packet) }); },
    async failRead() { request = async () => { throw new Error('transient GET failure'); }; await functions.refreshState(); },
    async recoverRead() { request = async () => ({ state: state.data }); await functions.refreshState(); }
  };
}

test('a transient state-read failure recovers the badge after a successful HTTP read with fresh realtime traffic', async () => {
  const h = connectionHarness(), socket = h.open();
  h.message({ type: 'state', state: h.state.data });
  await h.failRead();
  assert.equal(h.badge.className, 'connection offline');
  await h.recoverRead();
  assert.equal(h.badge.textContent, 'Online');
  assert.equal(h.badge.className, 'connection online');
  assert.equal(h.state.socket, socket, 'recovery does not require reopening the live socket');
});

test('current heartbeats and state frames independently restore online after a transient HTTP failure', async () => {
  for (const type of ['heartbeat', 'state']) {
    const h = connectionHarness();
    h.open();
    await h.failRead();
    h.advance(1000);
    h.message({ type, state: h.state.data });
    assert.equal(h.badge.textContent, 'Online');
    assert.equal(h.badge.dataset.labelKey, '实时在线');
    assert.equal(h.badge.className, 'connection online');
    assert.equal(h.state.socketSeenAt, h.now());
    assert.equal(h.applied.length, type === 'state' ? 1 : 0, 'heartbeat recovery does not render the table');
  }
});

test('OPEN alone or stale socket traffic cannot claim realtime online after a successful HTTP read', async () => {
  const h = connectionHarness(), socket = h.open();
  assert.notEqual(h.badge.className, 'connection online', 'opening still awaits authenticated room traffic');
  await h.recoverRead();
  assert.equal(h.badge.className, 'connection offline');
  h.message({ type: 'heartbeat' });
  assert.equal(h.badge.className, 'connection online');
  h.advance(35_001);
  await h.recoverRead();
  assert.equal(socket.readyState, 1);
  assert.equal(h.badge.className, 'connection offline', 'HTTP is not proof a silent WebSocket is alive');
  h.syncConnection();
  assert.equal(socket.readyState, 3);
  assert.equal(h.sockets.length, 2, 'existing silent-socket recovery remains intact');
  assert.notEqual(h.badge.className, 'connection online');
});

test('missing, connecting, closing and closed sockets stay offline despite a successful state read', async () => {
  for (const readyState of [null, 0, 2, 3]) {
    const h = connectionHarness();
    if (readyState !== null) { h.open(); h.message({ type: 'heartbeat' }); h.state.socket.readyState = readyState; }
    await h.recoverRead();
    assert.equal(h.badge.className, 'connection offline');
    assert.equal(h.badge.dataset.labelKey, '已同步，实时连接恢复中');
  }
});

test('malformed or unrecognized packets cannot clear an offline badge or extend socket liveness', async () => {
  const h = connectionHarness(), socket = h.open();
  await h.failRead();
  const seen = h.state.socketSeenAt;
  h.advance(5000);
  for (const data of ['not JSON', 'null', '[]', '{}', '{"type":"unrecognized"}']) {
    assert.doesNotThrow(() => socket.onmessage({ data }));
    assert.equal(h.badge.className, 'connection offline');
    assert.equal(h.state.socketSeenAt, seen);
  }
});

test('a socket error requires fresh server traffic before HTTP can claim realtime online again', async () => {
  const h = connectionHarness(), socket = h.open();
  h.message({ type: 'heartbeat' });
  socket.onerror();
  await h.recoverRead();
  assert.equal(h.badge.className, 'connection offline');
  h.message({ type: 'heartbeat' });
  assert.equal(h.badge.className, 'connection online');
});

test('obsolete socket handlers and previous-session HTTP results cannot change the current badge', async () => {
  const h = connectionHarness(), old = h.open();
  const handlers = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  h.state.socket = null;
  const current = h.open();
  await h.failRead();
  const before = { ...h.badge }, seen = h.state.socketSeenAt;
  h.advance(1000);
  handlers.open();
  handlers.message({ data: JSON.stringify({ type: 'heartbeat' }) });
  handlers.message({ data: JSON.stringify({ type: 'state', state: { stale: true } }) });
  handlers.close({ code: 1006 });
  handlers.error();
  assert.deepEqual(h.badge, before);
  assert.equal(h.state.socket, current);
  assert.equal(h.state.socketSeenAt, seen);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.applied, []);

  for (const field of ['session', 'roomCode', 'token']) {
    for (const outcome of ['success', 'failure']) {
      let resolve, reject;
      h.setRequest(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
      const pending = h.refreshState();
      h.state[field] = field === 'session' ? h.state.session + 1 : `${h.state[field]}-new`;
      h.state.refreshing = null;
      h.setConnection('准备连接');
      if (outcome === 'success') resolve({ state: { stale: true } });
      else reject(new Error('stale failure'));
      await pending;
      assert.equal(h.badge.dataset.labelKey, '准备连接', `${outcome} from obsolete ${field} is ignored`);
      assert.deepEqual(h.applied, []);
    }
  }
});
