import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const translations = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const noop = () => {};
const t = value => value;
function production(name, dependencies = {}, async = false) {
  const source = app.match(new RegExp(`  ${async ? 'async ' : ''}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, name);
  return Function(...Object.keys(dependencies), `${source}; return ${name};`)(...Object.values(dependencies));
}

function joinHarness({ saved = 'saved-token', request, locks = true, storageDisabled = false } = {}) {
  const storage = new Map(saved ? [['token:123456', saved]] : []);
  const calls = [], writes = [];
  const deps = { t, tokenKey: code => `token:${code}`, nickKey: code => `nick:${code}`,
    stored: key => storageDisabled ? '' : storage.get(key) || '',
    forget: key => storage.delete(key),
    remember: (key, value) => { writes.push([key, value]); if (!storageDisabled) storage.set(key, value); },
    request: async (...args) => {
      calls.push(args);
      return request ? request(...args) : { token: 'phone-token', state: { hero: { nickname: '最新昵称' } } };
    },
    navigator: locks ? { locks: { request: async (key, callback) => callback() } } : {},
    setTimeout: callback => queueMicrotask(callback), Date, Math
  };
  deps.rememberIdentity = production('rememberIdentity', deps);
  return { storage, calls, writes, join: production('joinIdentity', deps, true) };
}

test('entry has one required phone field for create/join and no recovery or password UI', () => {
  assert.match(html, /<span data-i18n="手机号">手机号<\/span><input id="phone-input"[^>]*type="tel"[^>]*autocomplete="off"[^>]*required>/);
  assert.equal([...html.matchAll(/id="phone-input"/g)].length, 1);
  assert.doesNotMatch(html + app + css + translations, /恢复码|恢復碼|recovery-code|recovery-control|recovery-input|recovery-display|copy-recovery|manualToken|saved-identity/i);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(app, /copyText\(state\.token/);
  const inviteHandler = app.split('\n').find(line => line.includes("$('#copy-link').addEventListener"));
  assert.ok(inviteHandler);
  assert.doesNotMatch(inviteHandler, /token|phone/);
});

test('phone input is trimmed in memory, rejects empty input, and leaves canonical checks to the server', () => {
  const input = { value: '  +86 138-0013-8000  ' };
  const validate = production('validatePhone', { $: () => input, t });
  assert.equal(validate(), '+86 138-0013-8000');
  input.value = '  ';
  assert.throws(validate, /请输入手机号/);
});

test('live HTTP and WebSocket views request compact payloads without changing explicit history reads', async () => {
  const calls = [];
  const request = production('request', { state: { token: 'saved-token' }, t,
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: {} }) }; }
  }, true);
  for (const path of ['/api/rooms', '/api/rooms/123456/join', '/api/rooms/123456/state', '/api/rooms/123456/command']) {
    await request(path);
    assert.equal(calls.at(-1).url, `${path}?compact=1`);
    assert.equal(calls.at(-1).options.cache, 'no-store');
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer saved-token');
  }
  await request('/api/rooms/123456/state?other=1');
  assert.equal(calls.at(-1).url, '/api/rooms/123456/state?other=1&compact=1');
  await request('/api/rooms/123456/state?compact=1');
  assert.equal(calls.at(-1).url, '/api/rooms/123456/state?compact=1');
  await request('/api/rooms/123456/history?limit=20');
  assert.equal(calls.at(-1).url, '/api/rooms/123456/history?limit=20');
  assert.match(app, /const url = `[^`]*\/ws\?[^`]*&compact=1`/);
});

test('request retains only a validated pending-save room code for safe create retry', async () => {
  for (const roomCode of ['123456', '12', '123456789', '../123456', '123456?phone=secret', 123456, null]) {
    const request = production('request', { state: { token: '' }, t,
      AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: false, status: 503,
        json: async () => ({ errorCode: 'IDENTITY_SAVE_PENDING', roomCode, message: '房间身份正在保存，请稍后重试' }) })
    }, true);
    await assert.rejects(request('/api/rooms', { method: 'POST', body: { nickname: 'Test', phone: '+12025550101' } }), cause => {
      assert.equal(cause.status, 503);
      assert.equal(cause.errorCode, 'IDENTITY_SAVE_PENDING');
      assert.equal(cause.roomCode, roomCode === '123456' ? '123456' : undefined);
      assert.equal(cause.message, '房间身份正在保存，请稍后重试');
      assert.doesNotMatch(JSON.stringify(cause), /12025550101/);
      return true;
    });
  }
});

test('phone is always submitted even with a saved token and only returned token/nickname persist', async () => {
  const h = joinHarness();
  const joined = await h.join('123456', '最新昵称', '13800138000');
  assert.deepEqual(h.calls, [['/api/rooms/123456/join', { method: 'POST',
    body: { nickname: '最新昵称', phone: '13800138000', enter: true, token: 'saved-token' }, token: '' }]]);
  assert.equal(joined.token, 'phone-token');
  assert.deepEqual([...h.storage], [
    ['token:123456', 'phone-token'], ['poker-last-nickname', '最新昵称'],
    ['poker-last-room', '123456'], ['nick:123456', '最新昵称']
  ]);
  assert.doesNotMatch(JSON.stringify(h.writes), /13800138000/);
});

test('joining without local storage still sends the phone and never stores it in a fallback lease', async () => {
  const h = joinHarness({ saved: '', locks: false, storageDisabled: true });
  await h.join('123456', '新人', '+447700900123');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].body.phone, '+447700900123');
  assert.equal(h.calls[0][1].body.token, undefined);
  assert.doesNotMatch(JSON.stringify(h.writes), /447700900123/);
});

test('an invalid cached token retries the same phone without silently changing identity', async () => {
  let attempts = 0;
  const h = joinHarness({ request: async () => {
    if (++attempts === 1) throw Object.assign(new Error('invalid token'), { status: 401 });
    return { token: 'valid-token', state: { hero: { nickname: '昵称' } } };
  } });
  await h.join('123456', '昵称', '13800138000');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1][1].body, { nickname: '昵称', phone: '13800138000', enter: true });
  assert.equal(h.storage.get('token:123456'), 'valid-token');
});

test('validation or legacy claim conflicts keep the saved token and do not retry without it', async () => {
  for (const status of [400, 409]) {
    const h = joinHarness({ request: async () => { throw Object.assign(new Error('invalid phone'), { status }); } });
    await assert.rejects(h.join('123456', '昵称', '13800138000'), /invalid phone/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.storage.get('token:123456'), 'saved-token');
    assert.deepEqual(h.writes, []);
  }
});

function switchHarness({ seated = false, inHand = false, standError = false } = {}) {
  const state = { roomCode: '123456', token: 'private-token', session: 1, pending: false,
    data: { status: inHand ? 'playing' : 'waiting', hero: { seat: seated ? 0 : null },
      seats: seated ? [{ inHand }] : [] } };
  const nodes = Object.fromEntries(['nickname-input', 'phone-input', 'room-code-input', 'room-screen', 'lobby-screen', 'leave-button'].map(id => [`#${id}`, { value: id === 'phone-input' ? '13800138000' : '旧昵称', focus() { this.focused = true; } }]));
  const storage = new Map([['token:123456', state.token], ['nick:123456', '旧昵称'], ['poker-last-room', '123456'], ['poker-last-nickname', '旧昵称']]);
  const calls = [], toasts = [], history = [];
  const deps = { state, $: selector => nodes[selector], t,
    tokenKey: code => `token:${code}`, nickKey: code => `nick:${code}`,
    stored: key => storage.get(key), forget: key => storage.delete(key),
    showToast: text => toasts.push(text), preactions: { reset: noop }, renderActions: noop,
    request: async (...args) => { calls.push(args); if (standError) throw new Error('stand failed'); },
    isRoomClosedError: () => false, closeExpiredRoom: noop,
    hideEntryLoading: noop, stopNetwork: () => { state.session++; },
    setMode: mode => { state.mode = mode; }, setConnection: noop,
    history: { replaceState: (...args) => history.push(args) }, location: { pathname: '/' }
  };
  deps.cannotLeaveSeatDuringHand = production('cannotLeaveSeatDuringHand', deps);
  deps.leaveRoom = production('leaveRoom', deps);
  return { state, nodes, storage, calls, toasts, history, switchPlayer: production('switchPlayer', deps, true) };
}

test('switch player clears token and both inputs, leaves seat first, and returns to a clean lobby', async () => {
  for (const seated of [false, true]) {
    const h = switchHarness({ seated });
    await h.switchPlayer();
    assert.equal(h.calls.length, seated ? 1 : 0);
    if (seated) assert.deepEqual(h.calls[0], ['/api/rooms/123456/command', { method: 'POST', body: { type: 'stand' } }]);
    assert.equal(h.state.token, '');
    assert.equal(h.state.roomCode, '');
    assert.equal(h.state.pending, false);
    assert.equal(h.nodes['#nickname-input'].value, '');
    assert.equal(h.nodes['#phone-input'].value, '');
    assert.equal(h.nodes['#room-code-input'].value, '123456');
    assert.equal(h.nodes['#lobby-screen'].hidden, false);
    assert.equal(h.nodes['#room-screen'].hidden, true);
    assert.equal(h.storage.size, 0);
    assert.deepEqual(h.history, [[null, '', '/']]);
    assert.match(h.toasts[0], /输入昵称和手机号/);
  }
});

test('active hands and queued settlements still guard switching identities', async () => {
  const h = switchHarness({ seated: true, inHand: true });
  await h.switchPlayer();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.token, 'private-token');
  assert.match(h.toasts[0], /结算后切换/);
  const guard = production('cannotLeaveSeatDuringHand');
  for (const key of ['pendingRebuy', 'pendingUnload', 'pendingGiftSent', 'pendingGiftReceived']) {
    assert.equal(guard({ status: 'playing', hero: { seat: 0, [key]: 10 }, seats: [{ inHand: false }] }), true);
  }
});

test('failed stand preserves identity and input so switching can be retried safely', async () => {
  const h = switchHarness({ seated: true, standError: true });
  await h.switchPlayer();
  assert.equal(h.state.token, 'private-token');
  assert.equal(h.storage.get('token:123456'), 'private-token');
  assert.equal(h.nodes['#phone-input'].value, '13800138000');
  assert.equal(h.state.pending, false);
  assert.deepEqual(h.history, []);
  assert.deepEqual(h.toasts, ['stand failed']);
});
