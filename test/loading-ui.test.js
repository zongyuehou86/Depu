import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function production(name, dependencies, async = false) {
  const source = app.match(new RegExp(`  ${async ? 'async ' : ''}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, name);
  return Function(...Object.keys(dependencies), `${source}; return ${name};`)(...Object.values(dependencies));
}
const noop = () => {};
function entryHarness(overrides = {}) {
  const state = { pending: false, roomCode: '', mode: 'join', resumeCancelled: false };
  const nodes = Object.fromEntries(['room-loading', 'room-load-label', 'room-load-progress', 'room-load-note', 'room-load-retry', 'enter-button', 'spectate-button', 'lobby-error', 'capacity-input', 'room-code-input', 'nickname-input', 'phone-input'].map(id => [`#${id}`, { value: id === 'room-code-input' ? '123456' : '4', hidden: true, disabled: false, dataset: {}, textContent: '', removeAttribute: noop, focus() { this.focused = true; } }]));
  const stages = [], timers = [], calls = [], opened = [], forgotten = [];
  const dependencies = { state, $: selector => nodes[selector], t: value => value, message: value => value,
    request: async (...args) => { calls.push(args); return { state: { stateVersion: 1, hero: { canAct: true } } }; },
    showEntryLoading: (stage, options) => stages.push({stage, options}), hideEntryLoading: () => stages.push({stage: 'hidden'}),
    setTimeout: (callback, delay) => { timers.push(delay); queueMicrotask(callback); },
    setConnection: noop, Math: { random: () => 0 }, stored: () => '123456', tokenKey: code => `token:${code}`, nickKey: code => `nick:${code}`,
    forget: key => forgotten.push(key), closeExpiredRoom: noop,
    isRoomClosedError: cause => cause.status === 410,
    openRoom: (...args) => { assert.equal(state.pending, false, 'first render must enable the current action'); state.roomCode = args[0]; opened.push(args); },
    validateNickname: () => 'Test', validatePhone: () => '13800138000', setMode: mode => { state.mode = mode; },
    rememberIdentity: production('rememberIdentity', { remember: noop, tokenKey: code => `token:${code}`, nickKey: code => `nick:${code}`, t: value => value }),
    joinIdentity: async () => ({ token: 'test-token', state: { hero: {} } }), queueRoomEffect: noop,
    ...overrides };
  const resumeRoom = production('resumeRoom', dependencies, true);
  const enterRoom = production('enterRoom', dependencies, true);
  return { state, nodes, stages, timers, calls, opened, forgotten, resumeRoom, enterRoom };
}

test('page resource progress exists before external JS, counts completed files, and leaves server stages indeterminate', () => {
  assert.ok(html.indexOf('Lives in HTML') < html.indexOf('<script src='));
  assert.match(html, /media="print" onload="this.media='all'"/);
  assert.match(html, /const ready = initialized && complete.size === total/);
  assert.match(html, /document.addEventListener\('click'/);
  assert.match(html, /page-load-retry'\)\.hidden = !failed && !slow/);
  assert.match(app, /room-load-progress'\)\.removeAttribute\('value'\)/);
  assert.doesNotMatch(app, /new Image\(/, 'room entry must not prefetch four large gifts');
  assert.equal([...html.matchAll(/<img[^>]+src="\/assets/g)].length, 2, 'data-src is retained for both gift choices');
  assert.doesNotMatch(html, /<img src="\/assets/);
});

test('entry progress reports slow waiting and a manual retry without inventing percent', () => {
  const nodes = {}, timers = new Map(); let id = 0;
  const $ = key => nodes[key] ||= { removeAttribute(key) { this.removed = key; } };
  const entryLoading = {};
  const deps = { $, entryLoading, t: value => value, clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++id, fn); return id; } };
  const show = production('showEntryLoading', deps);
  const hide = production('hideEntryLoading', deps);
  show('正在恢复房间状态');
  assert.equal(nodes['#room-load-progress'].removed, 'value');
  [...timers.values()][0]();
  assert.match(nodes['#room-load-note'].textContent, /比平时慢/);
  show('暂时无法进入房间', { retry: noop });
  assert.equal(nodes['#room-load-retry'].hidden, false);
  assert.equal(nodes['#room-load-progress'].hidden, true);
  hide();
  assert.equal(nodes['#room-loading'].hidden, true);
  assert.equal(entryLoading.retry, null);
});

test('saved room resume locks duplicate clicks, performs only GET, and renders enabled current-turn controls', async () => {
  let resolve;
  const h = entryHarness({ request: () => new Promise(done => { resolve = done; }) });
  const first = h.resumeRoom('123456', 'test-token');
  assert.equal(h.state.pending, true);
  await h.resumeRoom('123456', 'test-token');
  await h.enterRoom();
  resolve({ state: { stateVersion: 1, hero: { canAct: true } } });
  await first;
  assert.equal(h.opened.length, 1);
  assert.equal(h.state.pending, false);
  assert.equal(h.nodes['#enter-button'].disabled, false);
});

test('resume retries only read-only state failures twice with exponential delays, then offers in-page retry', async () => {
  const calls = [];
  const h = entryHarness({ request: async (url, options) => { calls.push({url, options}); throw new Error('offline'); } });
  await h.resumeRoom('123456', 'test-token');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url.endsWith('/state') && !call.options.method));
  assert.deepEqual(h.timers, [1500, 3000]);
  assert.equal(typeof h.stages.at(-1).options.retry, 'function');
  assert.equal(h.state.pending, false);
});

test('invalid saved identity and missing/closed room never auto-retry or create a new player', async () => {
  for (const status of [401, 404, 410]) {
    let calls = 0, closed = 0;
    const h = entryHarness({ request: async () => { calls++; throw Object.assign(new Error('invalid'), {status}); }, closeExpiredRoom: () => { closed++; } });
    await h.resumeRoom('123456', 'test-token');
    assert.equal(calls, 1);
    assert.equal(h.opened.length, 0);
    assert.equal(h.stages.at(-1).stage, 'hidden');
    assert.equal(closed, status === 410 ? 1 : 0);
    if (status === 401) assert.ok(h.forgotten.includes('token:123456'));
  }
});

test('incomplete create response retries the known room by phone without creating another room', async () => {
  let creates = 0, joins = 0;
  const h = entryHarness({ request: async () => { creates++; return { roomCode: '654321' }; }, joinIdentity: async () => { joins++; throw new Error('offline'); } });
  h.state.mode = 'create';
  await h.enterRoom();
  assert.equal(h.nodes['#room-code-input'].value, '654321');
  assert.equal(h.state.mode, 'join');
  await h.stages.at(-1).options.retry();
  assert.equal(creates, 1);
  assert.equal(joins, 1);
});

test('a partially persisted atomic create retries its returned room without creating another room', async () => {
  let creates = 0;
  const joins = [];
  const h = entryHarness({ request: async () => {
    creates++;
    throw Object.assign(new Error('房间身份正在保存，请稍后重试'), {
      status: 503, errorCode: 'IDENTITY_SAVE_PENDING', roomCode: '654321'
    });
  }, joinIdentity: async (...args) => {
    joins.push(args);
    return { token: 'owner-token', state: { hero: { nickname: 'Test', isOwner: true } } };
  } });
  h.state.mode = 'create';
  h.nodes['#nickname-input'].value = 'Test';
  h.nodes['#phone-input'].value = '13800138000';
  await h.enterRoom();
  assert.equal(creates, 1);
  assert.equal(h.state.mode, 'join');
  assert.equal(h.nodes['#room-code-input'].value, '654321');
  assert.equal(h.nodes['#nickname-input'].value, 'Test');
  assert.equal(h.nodes['#phone-input'].value, '13800138000');
  assert.equal(h.nodes['#lobby-error'].textContent, '房间身份正在保存，请稍后重试');
  assert.equal(h.state.pending, false);
  await h.stages.at(-1).options.retry();
  assert.equal(creates, 1);
  assert.deepEqual(joins, [['654321', 'Test', '13800138000']]);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0][0], '654321');
  assert.equal(h.opened[0][1], 'owner-token');
});

test('create sends nickname and phone once and opens the returned owner without a second join', async () => {
  const created = { roomCode: '654321', token: 'owner-token', state: { hero: { nickname: 'Test', isOwner: true } } };
  const requests = [], remembered = [];
  const h = entryHarness({ request: async (...args) => { requests.push(args); return created; },
    rememberIdentity: (...args) => { remembered.push(args); return args[2]; },
    joinIdentity: async () => { assert.fail('create must not separately join its owner'); } });
  h.state.mode = 'create';
  await h.enterRoom();
  assert.deepEqual(requests, [['/api/rooms', { method: 'POST', body: { capacity: 4, nickname: 'Test', phone: '13800138000', enter: true }, token: '' }]]);
  assert.deepEqual(remembered, [['654321', 'Test', created]]);
  assert.deepEqual(h.opened, [['654321', 'owner-token', created.state]]);
});

test('empty phone stops create and join locally without creating any room or player', async () => {
  for (const mode of ['create', 'join']) {
    const h = entryHarness({ validatePhone: () => { throw new Error('请输入手机号。'); },
      joinIdentity: async () => { assert.fail('must not join without a phone'); } });
    h.state.mode = mode;
    await h.enterRoom();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.opened, []);
    assert.equal(h.nodes['#lobby-error'].textContent, '请输入手机号。');
    assert.equal(h.state.pending, false);
    assert.equal(h.nodes['#enter-button'].disabled, false);
  }
});

test('a create in flight locks repeat submits until the atomic owner response arrives', async () => {
  let resolve, creates = 0;
  const h = entryHarness({ request: () => { creates++; return new Promise(done => { resolve = done; }); } });
  h.state.mode = 'create';
  const first = h.enterRoom();
  await h.enterRoom();
  assert.equal(creates, 1);
  assert.equal(h.state.pending, true);
  resolve({ roomCode: '654321', token: 'owner-token', state: { hero: { isOwner: true } } });
  await first;
  assert.equal(h.opened.length, 1);
  assert.equal(h.state.pending, false);
});

test('legacy saved identity stays in the lobby for phone binding and retains its token', async () => {
  const h = entryHarness({ request: async () => ({ state: { hero: { nickname: '原玩家', needsPhone: true } } }) });
  await h.resumeRoom('123456', 'legacy-token');
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.forgotten, []);
  assert.equal(h.state.mode, 'join');
  assert.equal(h.state.pending, false);
  assert.equal(h.nodes['#nickname-input'].value, '原玩家');
  assert.equal(h.nodes['#phone-input'].value, '');
  assert.equal(h.nodes['#phone-input'].focused, true);
  assert.equal(h.nodes['#enter-button'].disabled, false);
  assert.equal(h.stages.at(-1).stage, 'hidden');
});

test('manual closed-room failure stops the entry spinner', async () => {
  const h = entryHarness({ joinIdentity: async () => { throw Object.assign(new Error('closed'), {status: 410}); } });
  await h.enterRoom();
  assert.equal(h.stages.at(-1).stage, 'hidden');
});

test('content-version mapping applies only to public media and missing mapping falls back', () => {
  const resolve = production('publicAsset', { document: { getElementById: () => ({ textContent: JSON.stringify({'/assets/a.png':'/assets/a.png?v=abc'}) }) } });
  assert.equal(resolve('/assets/a.png'), '/assets/a.png?v=abc');
  assert.equal(resolve('/assets/b.png'), '/assets/b.png');
});

test('inline boot monitor counts load events and handles late CSS failure before DOMContentLoaded', () => {
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const handlers = {}, timers = new Map(), classes = new Set();
  const nodes = Object.fromEntries(['page-loading','page-load-progress','page-load-label','page-load-note','page-load-retry'].map(id => [id,{hidden:false,disabled:false,textContent:''}]));
  let reloaded = 0, timer = 0;
  const document = {getElementById: id=>nodes[id],querySelectorAll:()=>Array(8),
    documentElement: {classList:{toggle(k,on){on?classes.add(k):classes.delete(k);},contains:k=>classes.has(k)}},
    addEventListener: (type, fn)=>{handlers[type]=fn;}};
  const window = {addEventListener:(type,fn)=>{handlers[`window:${type}`]=fn;}};
  vm.runInNewContext(source,{document,window,location:{reload:()=>reloaded++},
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),Set});
  for(let index=0;index<7;index++)handlers.load({target:{matches:()=>true}});
  window.PokerPageLoad.ready();
  assert.equal(nodes['page-loading'].hidden,false);
  assert.equal(nodes['page-load-progress'].value,7);
  assert.equal(timers.size,1,'late CSS remains covered by slow waiting timer');
  handlers['window:error']({target:{matches:()=>true}});
  assert.equal(nodes['page-load-retry'].hidden,false);
  const target={id:'page-load-retry',disabled:false};
  handlers.click({target});handlers.click({target});
  assert.equal(reloaded,1,'a failed resource exposes one retry even before DOMContentLoaded');
  handlers.load({target:{matches:()=>true}});
  assert.equal(nodes['page-loading'].hidden,true);
  assert.equal(timers.size,0);
});

test('changing mode or room after a failed resume clears the stale retry', () => {
  assert.match(app, /if \(state.pending\) return;\n    hideEntryLoading\(\);\n    setMode\(button.dataset.mode\)/);
  assert.match(app, /room-code-input'\)\.addEventListener\('input', \(\) => \{\n    if \(!state.pending\) hideEntryLoading\(\)/);
});

test('fallback join lease cannot time out into a duplicate concurrent POST', async () => {
  let requests=0;
  const join=production('joinIdentity',{state:{},request:()=>{requests++;},stored:()=>JSON.stringify({owner:'another-tab',until:100000}),
    remember:noop,forget:noop,tokenKey:()=>'',nickKey:()=>'',navigator:{},Date:{now:()=>1000},Math:{random:()=>0},
    setTimeout:callback=>queueMicrotask(callback),t:value=>value},true);
  await assert.rejects(join('123456','Test',''),/另一个页面/);
  assert.equal(requests,0);
});
