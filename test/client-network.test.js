import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['request', 'joinIdentity', 'enterRoom', 'stopNetwork', 'openRoom', 'connectSocket', 'refreshState',
  'recoverCommandState', 'recoverNetwork', 'switchPlayer', 'command', 'runPreaction', 'applyState'];
const sources = names.map(name => {
  const source = app.match(new RegExp(`  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `use real production ${name}`);
  return source;
}).join('\n');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function snapshot(extra = {}) {
  return { roomCode: '1234', hero: { playerId: 'me', canAct: true }, handNo: 1, streetIndex: 0,
    actingSeat: 0, actionDeadline: 10000, currentBet: 20, serverTime: 1000000, board: [], events: [], ...extra };
}
function response(data, status = 200) { return { ok: status < 400, status, json: async () => data }; }

function harness() {
  let now = 1000000, nextTimer = 0;
  const timers = new Map(), calls = [], sockets = [], toasts = [], connections = [], rendered = [];
  const state = { roomCode: '1234', token: 'secret', session: 1, data: snapshot(), pending: false,
    recovering: false, clockOffset: 0, socket: null, soundResumeAt: 0, newRunoutCards: new Set() };
  const schedule = (fn, delay, interval = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const clear = id => timers.delete(id);
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, value: '', hidden: false, disabled: false, focus() {}, classList: { remove() {}, toggle() {} } });
    return nodes.get(selector);
  };
  const preactions = { resets: 0, queued: null, reset() { this.resets++; this.queued = null; }, observe(_data, options) { if (options) return null; const queued = this.queued; this.queued = null; return queued; } };
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    packet(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    fail() { this.onclose?.({ code: 1006 }); }
  }
  const h = { state, calls, sockets, timers, toasts, connections, preactions, rendered, $, fetchImpl: async () => response({ state: snapshot() }) };
  const context = vm.createContext({ state, $, AbortController, console, navigator: {}, document: { hidden: false },
    location: { protocol: 'https:', host: 'example.test', pathname: '/' }, history: { replaceState() {} },
    Date: class extends Date { static now() { return now; } }, WebSocket: FakeWebSocket,
    fetch: (path, options) => { calls.push({ path, ...options }); return h.fetchImpl(path, options); },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: clear,
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: clear,
    t: value => value, message: value => value, money: String, preactions,
    soundPlanner: { baseline() {}, reset() {}, observe() { return []; } }, sounds: { stop() {} },
    clearRoomEffects() {}, clearGiftEffects() {}, closeGiftPicker() {}, closeSeatDialog() {},
    giftPicker: { retries: new Map() }, giftEffects: { preload: [] },
    render() { rendered.push(state.data); }, renderActions() {}, playSoundCues() {},
    tableSettingsNoticeText: () => '', showToast: value => toasts.push(value),
    setConnection: (...args) => connections.push(args),
    isRoomClosedError: cause => cause.status === 410, closeExpiredRoom() {},
    showGiftEffect() {}, queueRoomEffect() {}, updateTimers() {},
    remember() {}, stored: () => '', forget() {}, nickKey: code => `nick:${code}`, tokenKey: code => `token:${code}`,
    validateNickname: () => 'Player', cannotLeaveSeatDuringHand: () => false,
    leaveRoom() { throw new Error('unexpected leave'); },
  });
  vm.runInContext(sources, context);
  Object.assign(h, Object.fromEntries(names.map(name => [name, context[name]])));
  h.tick = async milliseconds => {
    const end = now + milliseconds;
    while (true) {
      let first;
      for (const [id, timer] of timers) if (timer.at <= end && (!first || timer.at < first[1].at)) first = [id, timer];
      if (!first) break;
      const [id, timer] = first;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  h.now = () => now;
  return h;
}

test('request deadline covers both headers and JSON, aborts transport, and composes caller cancellation', async () => {
  for (const stalledBody of [false, true]) {
    const h = harness();
    const stalled = deferred();
    h.fetchImpl = () => stalledBody ? Promise.resolve({ ok: true, json: () => stalled.promise }) : stalled.promise;
    const result = h.request('/api/rooms/1234/state').catch(error => error);
    await h.tick(9999);
    assert.equal(h.calls[0].signal.aborted, false);
    await h.tick(1);
    const error = await result;
    assert.equal(error.errorCode, 'REQUEST_TIMEOUT');
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.state.requests.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls[0].path, '/api/rooms/1234/state?compact=1');
    stalled.resolve(response({ state: snapshot() }));
    await flush();
  }
  const h = harness(), signal = new AbortController();
  h.fetchImpl = () => new Promise(() => {});
  const pending = h.request('/api/rooms/1234/history?limit=20', { signal: signal.signal }).catch(error => error);
  signal.abort(new Error('details closed'));
  assert.match((await pending).message, /details closed/);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('one still-pending mutation blocks repeat clicks; timeout resyncs once and never replays the action', async () => {
  const h = harness(), mutation = deferred(), read = deferred();
  h.fetchImpl = (_path, options) => options.method === 'POST' ? mutation.promise : read.promise;
  h.preactions.queued = { action: 'check' };
  const pending = h.command({ type: 'action', action: 'call' });
  assert.equal(h.state.pending, true);
  assert.equal(await h.command({ type: 'action', action: 'call' }), false);
  h.applyState(snapshot({ serverTime: h.now() + 1, currentBet: 40 }));
  assert.equal(h.state.pending, true, 'authoritative WS frames must not prematurely unlock an in-flight POST');
  await h.tick(9999);
  assert.equal(h.calls.length, 1);
  await h.tick(1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].method, 'GET');
  assert.equal(h.state.recovering, true);
  assert.equal(h.state.pending, true);
  assert.equal(await h.command({ type: 'rebuy' }), false);
  const body = JSON.parse(h.calls[0].body);
  assert.deepEqual(body.expectedAction, { handNo: 1, streetIndex: 0, actingSeat: 0, actionDeadline: 10000, currentBet: 20 });
  read.resolve(response({ state: snapshot({ serverTime: h.now(), currentBet: 100 }) }));
  assert.equal(await pending, false, 'uncertain outcome must not claim that the original action succeeded');
  assert.equal(h.state.pending, false);
  assert.equal(h.state.recovering, false);
  assert.equal(h.preactions.queued, null);
  mutation.resolve(response({ state: snapshot({ currentBet: 5 }) }));
  await flush();
  assert.equal(h.state.data.currentBet, 100, 'late completion cannot overwrite resync');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
});

test('failed bounded resync releases pending but blocks actions until fallback read succeeds, even with OPEN socket', async () => {
  const h = harness();
  h.openRoom('1234', 'secret', snapshot());
  const socket = h.sockets[0]; socket.open(); socket.packet({ type: 'state', state: snapshot() });
  socket.packet({ type: 'pong', nonce: socket.sent[0].nonce });
  h.fetchImpl = () => new Promise(() => {});
  const pending = h.command({ type: 'rebuy', amount: 2000 });
  await h.tick(10000);
  const heartbeat = socket.sent.at(-1); socket.packet({ type: 'pong', nonce: heartbeat.nonce });
  assert.equal(h.state.recovering, true);
  await h.tick(9000);
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 1, 'fallback must join the in-flight recovery GET');
  await h.tick(1000);
  assert.equal(await pending, false);
  assert.equal(h.state.pending, false);
  assert.equal(h.state.recovering, true);
  assert.equal(await h.command({ type: 'rebuy' }), false);
  h.fetchImpl = async () => response({ state: snapshot({ serverTime: h.now() }) });
  socket.packet({ type: 'pong', nonce: socket.sent.at(-1).nonce });
  await h.tick(1000);
  assert.equal(h.state.recovering, false);
  assert.equal(h.state.socket, socket, 'recovery fallback works even when the socket is OPEN and answers heartbeat');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  h.stopNetwork();
});

test('resync cancels an older read then starts exactly one post-failure read; normal polls are deduplicated', async () => {
  const h = harness(), oldRead = deferred(), mutation = deferred(), newRead = deferred();
  let reads = 0;
  h.fetchImpl = (_path, options) => options.method === 'POST' ? mutation.promise : (++reads === 1 ? oldRead.promise : newRead.promise);
  const command = h.command({ type: 'stand' });
  await h.tick(3000);
  const first = h.refreshState(), duplicate = h.refreshState();
  assert.equal(reads, 1);
  await h.tick(7000);
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(reads, 2);
  await first; await duplicate;
  oldRead.resolve(response({ state: snapshot({ currentBet: 1 }) }));
  await flush();
  assert.equal(h.state.recovering, true, 'read predating failure cannot release the barrier');
  newRead.resolve(response({ state: snapshot({ serverTime: h.now(), currentBet: 77 }) }));
  await command;
  assert.equal(h.state.data.currentBet, 77);
  assert.equal(h.state.recovering, false);
});

test('handshake and unanswered heartbeat retire dead sockets; stale events cannot replace a new connection', async () => {
  const h = harness();
  h.connectSocket(h.state.session);
  const first = h.sockets[0], staleClose = first.onclose, staleMessage = first.onmessage, staleOpen = first.onopen;
  await h.tick(8000);
  assert.equal(first.readyState, 3);
  assert.equal(h.state.socket, null);
  await h.tick(2500);
  const second = h.sockets[1];
  assert.match(second.url, /compact=1/);
  second.open(); second.packet({ type: 'state', state: snapshot() });
  staleOpen(); staleClose({ code: 1006 }); staleMessage({ data: JSON.stringify({ type: 'state', state: snapshot({ currentBet: 999 }) }) });
  assert.equal(h.state.socket, second);
  assert.equal(h.state.data.currentBet, 20);
  assert.equal(h.sockets.length, 2);
  second.packet({ type: 'pong', nonce: 'incorrect' });
  await h.tick(8000);
  assert.equal(second.readyState, 3, 'wrong nonce cannot keep a half-open socket alive');
  assert.equal(h.state.socket, null);
  h.stopNetwork();
  await h.tick(60000);
  assert.equal(h.sockets.length, 2, 'cleanup cancels reconnect timers');
  assert.equal(h.timers.size, 0);
});

test('heartbeat pong alone cannot finish initial-state handshake, and valid pong keeps idle room alive', async () => {
  const h = harness(); h.connectSocket(h.state.session);
  h.sockets[0].open(); h.sockets[0].packet({ type: 'pong', nonce: h.sockets[0].sent[0].nonce });
  await h.tick(8000);
  assert.equal(h.state.socket, null, 'initial authenticated state is required');
  await h.tick(2500);
  const socket = h.sockets[1]; socket.open(); socket.packet({ type: 'state', state: snapshot() });
  for (let i = 0; i < 4; i++) {
    socket.packet({ type: 'pong', nonce: socket.sent.at(-1).nonce });
    await h.tick(10000);
    assert.equal(h.state.socket, socket);
  }
  h.stopNetwork();
});

test('visibility/online recovery is read-only, coalesces wake events, and retires stale OPEN sockets', async () => {
  const h = harness(), read = deferred();
  h.connectSocket(h.state.session);
  const socket = h.sockets[0]; socket.open(); socket.packet({ type: 'state', state: snapshot() });
  h.fetchImpl = () => read.promise;
  h.state.socketLastSeen = h.now() - 18001;
  h.recoverNetwork(); h.recoverNetwork(); h.recoverNetwork();
  assert.equal(socket.readyState, 3);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'GET');
  read.resolve(response({ state: snapshot() }));
  await flush(); h.stopNetwork();
});

test('stop aborts all requests and timers; old completions cannot unlock or paint a new room', async () => {
  const h = harness(), oldPost = deferred(), oldRead = deferred();
  h.openRoom('1234', 'secret', snapshot());
  h.fetchImpl = (_path, options) => options.method === 'POST' ? oldPost.promise : oldRead.promise;
  const pending = h.command({ type: 'action', action: 'call' }), reading = h.refreshState();
  h.stopNetwork();
  assert.ok(h.calls.every(call => call.signal.aborted));
  h.state.roomCode = '5678'; h.state.token = 'next'; h.state.data = snapshot({ roomCode: '5678' }); h.state.pending = true;
  await pending; await reading;
  assert.equal(h.state.pending, true, 'old finally must not release a different session lock');
  oldPost.resolve(response({ state: snapshot({ currentBet: 99 }) }));
  oldRead.resolve(response({ state: snapshot({ currentBet: 88 }) }));
  await h.tick(60000);
  assert.equal(h.state.data.roomCode, '5678');
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0);
});

test('epoch + sequence rejects older same-ms frames and retired-server responses, retaining legacy ordering', async () => {
  const h = harness();
  h.applyState(snapshot({ stateEpoch: 'a', stateSequence: 10, currentBet: 100 }));
  h.applyState(snapshot({ stateEpoch: 'a', stateSequence: 9, currentBet: 9 }));
  assert.equal(h.state.data.currentBet, 100);
  h.applyState(snapshot({ stateEpoch: 'a', stateSequence: 11, serverTime: 999999, currentBet: 110 }));
  assert.equal(h.state.data.currentBet, 110, 'sequence survives a backward wall-clock correction');
  h.applyState(snapshot({ stateEpoch: 'b', stateSequence: 1, serverTime: 900000, currentBet: 200 }));
  assert.equal(h.state.data.currentBet, 200, 'server restart can reset clock and sequence');
  h.applyState(snapshot({ stateEpoch: 'a', stateSequence: 999, serverTime: 2000000, currentBet: 999 }));
  assert.equal(h.state.data.currentBet, 200);
  h.state.recovering = true;
  h.fetchImpl = async () => response({ state: snapshot({ stateEpoch: 'a', stateSequence: 1000 }) });
  assert.equal(await h.refreshState(), false);
  assert.equal(h.state.recovering, true, 'retired epoch cannot satisfy a recovery read');
  const legacy = harness();
  legacy.applyState(snapshot({ serverTime: 1000001, currentBet: 11 }));
  legacy.applyState(snapshot({ serverTime: 1000000, currentBet: 1 }));
  assert.equal(legacy.state.data.currentBet, 11);
});


test('switch-player timeout preserves identity, resyncs without replay, and ignores a late old-session stand', async () => {
  const h = harness(), mutation = deferred();
  h.state.data.hero.seat = 0;
  h.fetchImpl = (_path, options) => options.method === 'POST' ? mutation.promise : Promise.resolve(response({ state: snapshot() }));
  const switching = h.switchPlayer();
  await h.tick(10000);
  await switching;
  assert.equal(h.state.roomCode, '1234');
  assert.equal(h.state.token, 'secret');
  assert.equal(h.state.pending, false);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 1);
  const old = harness(); old.state.data.hero.seat = 0;
  old.fetchImpl = () => new Promise(() => {});
  const lateSwitch = old.switchPlayer();
  old.stopNetwork(); old.state.roomCode = '5678'; old.state.token = 'new'; old.state.pending = true;
  await lateSwitch;
  assert.equal(old.state.roomCode, '5678');
  assert.equal(old.state.token, 'new');
  assert.equal(old.state.pending, true);
});

test('entry and queued joins do not resume old-room mutations after a session change', async () => {
  const h = harness(), create = deferred();
  h.state.roomCode = ''; h.state.token = ''; h.state.mode = 'create';
  h.fetchImpl = () => create.promise;
  const entry = h.enterRoom();
  h.stopNetwork(); h.state.roomCode = '5678'; h.state.token = 'new'; h.state.pending = true;
  create.resolve(response({ roomCode: '1234' }));
  await entry;
  assert.equal(h.calls.length, 1, 'a late create must not start a new join');
  assert.equal(h.state.roomCode, '5678');
  assert.equal(h.state.pending, true);
  const queued = harness();
  let release;
  // Exercise the production queued Web Locks callback after the old session ends.
  const source = app.match(/  async function joinIdentity\([^\n]*\) \{[\s\S]*?\n  \}/)[0];
  const join = Function('state', 'navigator', 't', 'request', `${source}\nreturn joinIdentity`)(queued.state,
    { locks: { request(_key, callback) { release = callback; return new Promise(() => {}); } } }, x => x,
    () => { throw new Error('stale join dispatched'); });
  void join('1234', 'Player', '');
  queued.state.session++;
  await assert.rejects(release(), /连接已切换/);
});
