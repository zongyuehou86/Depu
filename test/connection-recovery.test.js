import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
const noop = () => {};

function productionFunction(name, dependencies, isAsync = false) {
  const source = app.match(new RegExp(`  ${isAsync ? 'async ' : ''}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `missing production ${name}`);
  return Function(...Object.keys(dependencies), `${source}\nreturn ${name}`)(...Object.values(dependencies));
}

function initialState() {
  return { roomCode: '123456', token: 'test-token', session: 1, pending: false,
    socket: null, socketSeenAt: 0, refreshing: null, lastSyncAt: 0, retry: null,
    clockOffset: 0, soundResumeAt: 0, soundTurnTimer: null,
    tableSettingsRoomCode: '123456', tableSettingsSeenId: 0,
    data: { roomCode: '123456', stateVersion: 3, serverTime: 1000,
      status: 'playing', handNo: 2, streetIndex: 1, actingSeat: 0,
      actionDeadline: 30_000, currentBet: 20, board: [], hero: { canAct: true } } };
}

function commandHarness(state, request, overrides = {}) {
  return productionFunction('command', {
    state, request, preactions: { reset: noop }, renderActions: noop,
    applyState: data => { state.data = data; }, refreshState: async () => {},
    showGiftEffect: noop, queueRoomEffect: noop, showToast: noop,
    t: value => value, money: String, isRoomClosedError: () => false,
    closeExpiredRoom: noop, runPreaction: noop, ...overrides
  }, true);
}

function stateHarness(state) {
  let renders = 0, resets = 0;
  const applyState = productionFunction('applyState', {
    state, soundPlanner: null, sounds: { stop: noop },
    preactions: { observe: noop, reset: () => { resets++; } }, render: () => { renders++; },
    playSoundCues: noop, runPreaction: noop, showToast: noop, t: value => value,
    money: String, tableSettingsNoticeText: () => '', clearTimeout
  });
  return { applyState, renders: () => renders, resets: () => resets };
}

test('timebank and runout commands capture the displayed hand and decision before sending', async () => {
  for (const type of ['timebank', 'runoutChoice', 'runoutResponse']) {
    const state = initialState();
    state.data.runout = { phase: type === 'runoutResponse' ? 'leaderVote' : 'trailingVote', deadline: 40_000 };
    const before = state.data;
    let sent;
    const command = commandHarness(state, async (_url, options) => {
      sent = options.body;
      // The next state cannot change the decision snapshot already sent.
      return { state: { ...before, handNo: before.handNo + 1 } };
    });
    const payload = type === 'timebank' ? { type, enabled: true } :
      type === 'runoutChoice' ? { type, times: 2 } : { type, accept: true };
    assert.equal(await command(payload), true);
    if (type === 'timebank') assert.deepEqual(sent.expectedTimebank, {
      handNo: before.handNo, streetIndex: before.streetIndex, actingSeat: before.actingSeat,
      actionDeadline: before.actionDeadline, currentBet: before.currentBet
    });
    else assert.deepEqual(sent.expectedRunout, {
      handNo: before.handNo, phase: before.runout.phase, deadline: before.runout.deadline
    });
    assert.equal(state.data.handNo, before.handNo + 1);
  }
});

test('request timeouts cover stalled headers and stalled response bodies and abort the network', async () => {
  for (const stallBody of [false, true]) {
    let signal;
    const request = productionFunction('request', {
      state: { token: '' }, t: value => value, AbortController, setTimeout, clearTimeout,
      fetch: async (_path, options) => {
        signal = options.signal;
        if (stallBody) return { ok: true, json: () => new Promise(() => {}) };
        return new Promise(() => {});
      }
    }, true);
    await assert.rejects(request('/stalled', { timeoutMs: 10 }), /网络请求超时/);
    assert.equal(signal.aborted, true, 'timed-out work releases the underlying connection');
  }
});

test('a lost action response releases pending and synchronizes state without retrying the action', async () => {
  const state = initialState();
  const calls = [];
  const fresh = { ...state.data, stateVersion: 4, hero: { canAct: false }, actingSeat: 1 };
  const request = productionFunction('request', {
    state, t: value => value, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      if (options.method === 'POST') return new Promise(() => {});
      return { ok: true, json: async () => ({ state: fresh }) };
    }
  }, true);
  const readState = productionFunction('refreshState', {
    state, request: (url, options) => request(url, { ...options, timeoutMs: 10 }),
    applyState: data => { state.data = data; }, WebSocket: { OPEN: 1 },
    setConnection: noop, isRoomClosedError: () => false, closeExpiredRoom: noop,
    preactions: { reset: noop }, renderActions: noop
  }, true);
  const command = commandHarness(state,
    (url, options) => request(url, { ...options, timeoutMs: 10 }), { refreshState: readState });
  const pending = command({ type: 'action', action: 'check' });
  assert.equal(state.pending, true);
  assert.equal(await pending, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pending, false, 'a missing response cannot disable all subsequent turns');
  assert.equal(state.data.hero.canAct, false, 'the client reads the actual server result');
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.deepEqual(calls[0].body.expectedAction, {
    handNo: 2, streetIndex: 1, actingSeat: 0, actionDeadline: 30_000, currentBet: 20
  }, 'manual actions carry the turn they were chosen for');
});

test('a command releases pending even when initial rendering throws', async () => {
  const state = initialState();
  let syncs = 0;
  const command = commandHarness(state, async () => { throw new Error('must not send'); }, {
    renderActions: () => { if (state.pending) throw new Error('render failed'); },
    refreshState: async () => { syncs++; }
  });
  assert.equal(await command({ type: 'action', action: 'check' }), false);
  assert.equal(state.pending, false);
  assert.equal(syncs, 1);
});

test('state versions reject late equal-time frames and same-version syncs update only the clock', () => {
  const state = initialState();
  const { applyState, renders } = stateHarness(state);
  const newer = { ...state.data, stateVersion: 4, actingSeat: 1, hero: { canAct: false } };
  applyState(newer);
  assert.equal(state.data, newer, 'same millisecond with a greater version is a new state');
  applyState({ ...newer, stateVersion: 3, actingSeat: 0, hero: { canAct: true }, serverTime: 5000 });
  assert.equal(state.data, newer, 'later wall-clock time cannot revive an older turn');
  state.soundResumeAt = 1500;
  applyState({ ...newer, serverTime: 2000, actingSeat: 0, hero: { canAct: true } });
  assert.equal(state.data.actingSeat, 1);
  assert.equal(state.data.serverTime, 2000);
  assert.equal(state.soundResumeAt, 0);
  assert.equal(renders(), 1, 'periodic equal-version responses do not rebuild the table');
  applyState({ ...newer, stateVersion: 5, serverTime: 500, actingSeat: 2 });
  assert.equal(state.data.actingSeat, 2, 'version order survives a server clock adjustment');
  applyState({ ...newer, stateVersion: undefined, serverTime: 10_000, actingSeat: 0 });
  assert.equal(state.data.actingSeat, 2, 'legacy delayed data cannot replace a versioned state');
});

test('a restart epoch accepts a lower version and rejects delayed packets from retired epochs', () => {
  const state = initialState();
  state.data.stateEpoch = 'before-restart';
  const before = { ...state.data, stateVersion: 90 };
  state.data = before;
  const { applyState, renders, resets } = stateHarness(state);
  const restarted = { ...before, stateEpoch: 'after-restart', stateVersion: 2, serverTime: 500,
    actingSeat: 1, hero: { canAct: false } };
  applyState(restarted);
  assert.equal(state.data, restarted, 'new epoch wins even with a lower version and clock');
  assert.equal(resets(), 1, 'preactions cannot reuse the previous version sequence');
  applyState({ ...before, stateVersion: 99, serverTime: 5000 });
  assert.equal(state.data, restarted, 'a late response cannot restore the retired server epoch');
  applyState({ ...before, stateEpoch: undefined, stateVersion: 100, serverTime: 6000 });
  assert.equal(state.data, restarted, 'legacy packets cannot replace an epoch-aware snapshot');
  const next = { ...restarted, stateVersion: 3, actingSeat: 2 };
  applyState(next);
  assert.equal(state.data, next);
  applyState({ ...restarted, serverTime: 9000 });
  assert.equal(state.data, next, 'version ordering still applies within the restarted epoch');
  assert.equal(renders(), 2);
  assert.equal(resets(), 1);
});

test('epoch upgrade from old server snapshots is accepted and retired-epoch tracking stays bounded', () => {
  const state = initialState();
  const { applyState } = stateHarness(state);
  applyState({ ...state.data, stateEpoch: 'epoch-0', stateVersion: 0, serverTime: 1 });
  assert.equal(state.data.stateEpoch, 'epoch-0');
  for (let index = 1; index <= 40; index++) {
    applyState({ ...state.data, stateEpoch: `epoch-${index}`, stateVersion: 0 });
  }
  assert.equal(state.retiredStateEpochs.size, 32);
  assert.equal(state.retiredStateEpochs.has('epoch-39'), true);
  assert.equal(state.data.stateEpoch, 'epoch-40');
  applyState({ ...state.data, stateEpoch: 'epoch-39', stateVersion: 1000 });
  assert.equal(state.data.stateEpoch, 'epoch-40');
  assert.match(app, /function stopNetwork\(\) \{\n    state.session \+= 1;\n    state.retiredStateEpochs = new Set\(\)/);
});

function socketHarness() {
  const state = initialState();
  let now = 100_000;
  const sockets = [], timers = new Map(), labels = [], received = [];
  let nextTimer = 0, syncs = 0, resets = 0;
  class WebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.closed = false; sockets.push(this); }
    close() { this.closed = true; this.readyState = 3; }
  }
  const dependencies = { state, WebSocket, Date: { now: () => now },
    location: { protocol: 'https:', host: 'localhost' },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setConnection: (...args) => labels.push(args),
    applyState: data => received.push(data), preactions: { reset: () => { resets++; } },
    renderActions: noop, sounds: { stop: noop }, closeExpiredRoom: noop,
    queueRoomEffect: noop, showGiftEffect: noop, showToast: noop, t: value => value,
    refreshState: async () => { state.lastSyncAt = now; syncs++; } };
  const connectSocket = productionFunction('connectSocket', dependencies);
  const syncConnection = productionFunction('syncConnection', { ...dependencies, connectSocket });
  return { state, sockets, timers, labels, received, connectSocket, syncConnection,
    advance: milliseconds => { now += milliseconds; }, now: () => now,
    syncs: () => syncs, resets: () => resets };
}

test('heartbeats mark the current socket alive without rendering and obsolete socket events are ignored', () => {
  const h = socketHarness();
  h.connectSocket(h.state.session);
  const old = h.sockets[0];
  old.readyState = 1;
  old.onopen();
  h.advance(15_000);
  old.onmessage({ data: JSON.stringify({ type: 'heartbeat', serverTime: h.now() }) });
  assert.equal(h.state.socketSeenAt, h.now());
  assert.deepEqual(h.received, []);
  const handlers = { open: old.onopen, message: old.onmessage, close: old.onclose, error: old.onerror };
  h.state.socket = null;
  h.connectSocket(h.state.session);
  const current = h.sockets[1], labelCount = h.labels.length;
  handlers.open();
  handlers.message({ data: JSON.stringify({ type: 'state', state: { stale: true } }) });
  handlers.error();
  handlers.close({ code: 1006 });
  assert.equal(h.state.socket, current, 'the old close cannot clear the replacement');
  assert.equal(h.timers.size, 0, 'the old close cannot schedule a duplicate connection');
  assert.equal(h.labels.length, labelCount);
  assert.deepEqual(h.received, []);
});

test('periodic synchronization covers OPEN sockets and a silent socket is replaced', () => {
  const h = socketHarness();
  h.connectSocket(h.state.session);
  const old = h.sockets[0];
  old.readyState = 1;
  old.onopen();
  h.state.lastSyncAt = h.now();
  h.syncConnection();
  assert.equal(h.syncs(), 0);
  h.advance(15_000);
  h.syncConnection();
  assert.equal(h.syncs(), 1, 'an OPEN socket does not suppress periodic state recovery');
  h.advance(21_000);
  h.syncConnection();
  assert.equal(old.closed, true);
  assert.equal(old.onclose, null);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.state.socket, h.sockets[1]);
  assert.equal(h.resets(), 1, 'network recovery discards any stale preselected action');
  assert.equal(h.syncs(), 2);
});

test('state reads coalesce and a previous session cannot clear a new pending read', async () => {
  const state = initialState(), deliveries = [], applied = [];
  const refreshState = productionFunction('refreshState', {
    state, request: () => new Promise(resolve => deliveries.push(resolve)),
    applyState: data => applied.push(data), WebSocket: { OPEN: 1 }, setConnection: noop,
    isRoomClosedError: () => false, closeExpiredRoom: noop,
    preactions: { reset: noop }, renderActions: noop
  }, true);
  const old = refreshState();
  await refreshState();
  assert.equal(deliveries.length, 1);
  state.session++;
  state.refreshing = null; // stopNetwork discards the old session's read owner.
  const current = refreshState(), owner = state.refreshing;
  deliveries[0]({ state: { old: true } });
  await old;
  assert.equal(state.refreshing, owner);
  assert.deepEqual(applied, []);
  deliveries[1]({ state: { current: true } });
  await current;
  assert.equal(state.refreshing, null);
  assert.deepEqual(applied, [{ current: true }]);
});

test('returning to the foreground or regaining connectivity synchronizes immediately', () => {
  const source = app.match(/  document\.addEventListener\('visibilitychange', \(\) => \{[\s\S]*?\n  \}\);\n  window\.addEventListener\('online', \(\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(source);
  const state = initialState(), handlers = {}, syncs = [];
  const document = { hidden: true, addEventListener: (type, handler) => { handlers[type] = handler; } };
  Function('state', 'document', 'window', 'giftNow', 'syncConnection', source)(state, document,
    { addEventListener: (type, handler) => { handlers[type] = handler; } }, () => 2000,
    options => syncs.push(options));
  handlers.visibilitychange();
  assert.deepEqual(syncs, []);
  document.hidden = false;
  handlers.visibilitychange();
  handlers.online();
  assert.deepEqual(syncs, [{ force: true }, { force: true }]);
  assert.equal(state.soundResumeAt, 2000);
});

test('reconnect backoff survives polling and resets only after a real server packet', () => {
  const h = socketHarness();
  h.connectSocket(h.state.session);
  const first = h.sockets[0];
  first.onclose({ code: 1006 });
  const retryAt = h.state.socketRetryAt;
  assert.ok(retryAt > h.now());
  h.syncConnection();
  h.syncConnection();
  assert.equal(h.sockets.length, 1, 'polling must not bypass the socket backoff');
  h.advance(retryAt - h.now() + 1);
  h.syncConnection();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onclose({ code: 1006 });
  assert.equal(h.state.socketFailures, 2);
  assert.ok(h.state.socketRetryAt - h.now() >= 3000);
  h.advance(h.state.socketRetryAt - h.now() + 1);
  h.syncConnection();
  h.sockets[2].onopen();
  assert.equal(h.state.socketFailures, 2, 'handshake alone is not successful delivery');
  h.sockets[2].onmessage({ data: JSON.stringify({type: 'heartbeat'}) });
  assert.equal(h.state.socketFailures, 0);
  assert.equal(h.state.socketRetryAt, 0);
});

test('failed HTTP reads back off independently; foreground retry can recover immediately', async () => {
  const h = socketHarness();
  let reads = 0;
  const readState = productionFunction('refreshState', {
    state: h.state, Date: { now: h.now }, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    request: async () => { reads++; throw new Error('offline'); },
    applyState: noop, WebSocket: {OPEN: 1}, setConnection: noop,
    isRoomClosedError: () => false, closeExpiredRoom: noop,
    preactions: {reset: noop}, renderActions: noop
  }, true);
  await readState();
  assert.equal(reads, 1);
  assert.equal(h.state.nextSyncAt - h.now(), 1500);
  h.syncConnection();
  assert.equal(h.syncs(), 0, 'periodic polling respects failed-read delay');
  h.syncConnection({force:true});
  assert.equal(h.syncs(), 1, 'explicit foreground/online event may retry immediately');
});
