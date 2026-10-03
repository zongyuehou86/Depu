import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadI18n } from './i18n-harness.js';

const source = readFileSync(new URL('../public/details.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const nodes = Object.fromEntries(['history-details', 'history-content', 'fairness-details', 'fairness-proof-content'].map(id => {
    const listeners = {};
    return [`#${id}`, { open: false, textContent: '', innerHTML: '', listeners,
      addEventListener(kind, callback) { listeners[kind] = callback; } }];
  }));
  const calls = [], copies = [];
  const context = { session: 1, roomCode: '123456', token: 'test-token' };
  const window = {};
  vm.runInNewContext(source, { window, AbortController });
  const ui = window.PokerDetails.createController({
    document: { querySelector: selector => nodes[selector] }, getContext: () => context,
    request(url, options) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })); },
    t: (key, params = {}) => key.replace(/\{(\w+)\}/g, (_, field) => params[field] ?? ''),
    message: value => value, safe: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    copyText: (...args) => copies.push(args)
  });
  const data = { roomCode: context.roomCode, handNo: 21, historyTotal: 20, historyVersion: '20:500:25', stateEpoch: 'epoch-1',
    fairness: { deckRoot: 'committed-root', visibleCardCount: 3, detailsAvailable: true } };
  const toggle = (id, open) => { nodes[`#${id}`].open = open; nodes[`#${id}`].listeners.toggle(); };
  const click = (id, selector, dataset = {}) => nodes[`#${id}`].listeners.click({ target: {
    closest: value => value === selector ? { dataset, disabled: false } : null } });
  ui.update(data);
  return { ui, nodes, context, data, calls, copies, toggle, click };
}

test('closed detail panels cause no requests; opening history fetches one bounded authenticated page', async () => {
  const h = harness();
  h.ui.update(h.data);
  assert.equal(h.calls.length, 0);
  h.toggle('history-details', true);
  h.ui.update(h.data);
  h.toggle('history-details', true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/rooms/123456/history?offset=0&limit=20');
  assert.equal(h.calls[0].options.token, 'test-token');
  assert.ok(h.calls[0].options.signal);
  h.calls[0].resolve({ total: 20, items: [{ handNo: 1, board: ['As'], events: [{ text: '<bad-name> checked' }] }] });
  await settle();
  assert.match(h.nodes['#history-content'].innerHTML, /&lt;bad-name>/);
  assert.doesNotMatch(h.nodes['#history-content'].innerHTML, /<bad-name>/);
  h.ui.update(h.data);
  assert.equal(h.calls.length, 1, 'ordinary live state updates do not refetch history');
});

test('closing an in-flight panel aborts it; reopening and a late old response cannot overwrite new content', async () => {
  const h = harness();
  h.toggle('history-details', true);
  h.toggle('history-details', false);
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.toggle('history-details', true);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ total: 20, items: [{ handNo: 20, board: [] }] });
  await settle();
  const expected = h.nodes['#history-content'].innerHTML;
  h.calls[0].resolve({ total: 20, items: [{ handNo: 1, board: [] }] });
  await settle();
  assert.equal(h.nodes['#history-content'].innerHTML, expected);
});

test('a room or identity switch discards and aborts detail responses from the prior session', async () => {
  const h = harness();
  h.toggle('history-details', true);
  h.context.session++;
  h.context.roomCode = '654321';
  h.context.token = 'other-token';
  h.ui.update({ ...h.data, roomCode: '654321' });
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.match(h.calls[1].url, /rooms\/654321\/history/);
  h.calls[0].resolve({ total: 20, items: [{ handNo: 1, events: [{ text: 'OLD ROOM DATA' }] }] });
  await settle();
  assert.doesNotMatch(h.nodes['#history-content'].innerHTML, /OLD ROOM DATA/);
  h.ui.reset();
  assert.equal(h.calls[1].options.signal.aborted, true);
});

test('public proof fetch is on demand and replaces an out-of-date in-flight proof after a new reveal', async () => {
  const h = harness();
  h.toggle('fairness-details', true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/rooms/123456/fairness?handNo=21');
  h.ui.update({ ...h.data, fairness: { ...h.data.fairness, visibleCardCount: 5 } });
  assert.equal(h.calls.length, 1, 'one proof request in flight');
  h.calls[0].resolve({ handNo: 21, fairness: { visibleCardProofs: ['old-proof'] } });
  await settle();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ handNo: 21, fairness: { visibleCardProofs: ['new-proof'] } });
  await settle();
  h.click('fairness-proof-content', 'button[data-proof-copy]');
  assert.match(h.copies[0][0], /new-proof/);
  assert.doesNotMatch(h.copies[0][0], /old-proof/);
});

test('failed detail reads wait for a deliberate retry instead of refetching on every state update', async () => {
  const h = harness();
  h.toggle('fairness-details', true);
  h.calls[0].reject(new Error('test offline'));
  await settle();
  h.ui.update(h.data);
  assert.equal(h.calls.length, 1);
  assert.match(h.nodes['#fairness-proof-content'].innerHTML, /test offline/);
  h.click('fairness-proof-content', 'button[data-proof-retry]');
  assert.equal(h.calls.length, 2);
});

test('history pages do not overlap at the oldest boundary; latest reveal invalidates only the latest view', async () => {
  const h = harness();
  h.ui.update({ ...h.data, historyTotal: 45, historyVersion: '45:1000:25' });
  h.toggle('history-details', true);
  assert.match(h.calls[0].url, /offset=40&limit=20/);
  h.calls[0].resolve({ total: 45, items: Array.from({ length: 5 }, (_, index) => ({ handNo: index + 41 })) });
  await settle();
  h.click('history-content', 'button[data-history-page]', { historyPage: 'older' });
  assert.match(h.calls[1].url, /offset=20&limit=20/);
  h.calls[1].resolve({ total: 45, items: Array.from({ length: 20 }, (_, index) => ({ handNo: index + 21 })) });
  await settle();
  h.click('history-content', 'button[data-history-page]', { historyPage: 'older' });
  assert.match(h.calls[2].url, /offset=0&limit=20/);
  h.calls[2].resolve({ total: 45, items: Array.from({ length: 20 }, (_, index) => ({ handNo: index + 1 })) });
  await settle();
  h.ui.update({ ...h.data, historyTotal: 45, historyVersion: '45:1001:27' });
  assert.equal(h.calls.length, 3, 'older hand page is immutable while a later hand reveals cards');
  h.click('history-content', 'button[data-history-page]', { historyPage: 'latest' });
  assert.match(h.calls[3].url, /offset=40&limit=20/);
});

test('late public proof from a previous hand never gets copied as the current hand', async () => {
  const h = harness();
  h.toggle('fairness-details', true);
  h.ui.update({ ...h.data, handNo: 22, fairness: { ...h.data.fairness, deckRoot: 'next-root' } });
  h.calls[0].resolve({ handNo: 21, fairness: { visibleCardProofs: ['old-hand'] } });
  await settle();
  h.click('fairness-proof-content', 'button[data-proof-copy]');
  assert.equal(h.copies.length, 0);
  assert.match(h.calls[1].url, /handNo=22/);
});

test('a server restart invalidates cached and in-flight detail data even when the room identity stays the same', async () => {
  const h = harness();
  h.toggle('history-details', true);
  h.toggle('fairness-details', true);
  h.ui.update({ ...h.data, stateEpoch: 'epoch-2' });
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.calls[1].options.signal.aborted, true);
  assert.equal(h.calls.length, 4);
  h.calls[0].resolve({ total: 20, items: [{ handNo: 1, events: [{ text: 'OLD EPOCH' }] }] });
  h.calls[1].resolve({ handNo: 21, fairness: { visibleCardProofs: ['OLD EPOCH'] } });
  await settle();
  assert.doesNotMatch(h.nodes['#history-content'].innerHTML, /OLD EPOCH/);
  h.click('fairness-proof-content', 'button[data-proof-copy]');
  assert.equal(h.copies.length, 0);
});

test('all on-demand details UI strings have English and Traditional Chinese translations', () => {
  const { i18n } = loadI18n();
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const language of ['en', 'zh-TW']) {
    assert.deepEqual(keys.filter(key => !i18n.has(key, language)), []);
  }
});
