import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadI18n, sourceFile } from './i18n-harness.js';

function translatedKeys() {
  const app = sourceFile('app.js');
  const html = sourceFile('index.html');
  const dynamic = [...app.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1]);
  const staticKeys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)].map(match => match[1]);
  return [...new Set([...dynamic, ...staticKeys])];
}

test('production UI keys have English and Traditional Chinese text', () => {
  const { i18n } = loadI18n();
  // These values are passed through t(variable) in the production app and
  // therefore cannot be discovered from literal t('...') calls alone.
  const runtimeKeys = ['准备连接', '连接中', '实时在线', '正在重连', '连接中断',
    '待翻牌', '1/3池', '1/2池', '1倍池', '补码', '卸码', '送礼', '收礼',
    '已弃牌', '已过牌', '已跟注', '已加注', '全下'];
  const serverErrors = ['../room.js', '../server.js'].flatMap(file =>
    [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/new GameError\('((?:[^'\\]|\\.)*)'/g)]
      .map(match => match[1]));
  const keys = [...new Set([...translatedKeys(), ...runtimeKeys, ...serverErrors, '命令失败'])];
  assert.ok(keys.length > 200, 'must inspect the live app and HTML rather than a short sample list');
  for (const language of ['en', 'zh-TW']) {
    const missing = keys.filter(key => !i18n.has(key, language));
    assert.deepEqual(missing, [], `${language} is missing visible production strings`);
  }
});

test('locale switching translates static text and interpolation without changing a nickname', () => {
  const attributes = new Map([
    ['data-i18n', '开设房间'],
    ['data-i18n-aria-label', '送礼物']
  ]);
  const node = {
    textContent: '',
    hasAttribute(name) { return attributes.has(name); },
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); }
  };
  const { i18n, document, events } = loadI18n({ nodes: [node] });
  i18n.setLanguage('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(node.textContent, 'Create room');
  assert.equal(attributes.get('aria-label'), 'Send gift');
  assert.equal(i18n.t('{name} · {seat} 号位', { name: 'Check & Rose', seat: 2 }), 'Check & Rose · Seat 2');
  assert.equal(events.at(-1).type, 'poker-language-change');
  i18n.setLanguage('zh-TW');
  assert.equal(node.textContent, '開設房間');
  assert.equal(i18n.t('{name} · {seat} 号位', { name: 'Check & Rose', seat: 2 }), 'Check & Rose · 2 號位');
});

test('unknown language and unavailable localStorage fall back without crashing', () => {
  const unknown = loadI18n({ stored: 'fr' });
  assert.equal(unknown.i18n.getLanguage(), 'zh-CN');
  assert.equal(unknown.i18n.setLanguage('fr'), 'zh-CN');
  assert.deepEqual(unknown.writes.at(-1), ['poker-language', 'zh-CN']);
  const unavailable = loadI18n({ storageThrows: true });
  assert.equal(unavailable.i18n.getLanguage(), 'zh-CN');
  assert.equal(unavailable.i18n.setLanguage('en'), 'en');
  assert.equal(unavailable.i18n.t('开设房间'), 'Create room');
});

test('server hand shorthand, errors and financial notices translate while unknown history stays literal', () => {
  const { i18n } = loadI18n();
  i18n.setLanguage('en');
  assert.equal(i18n.hand('两对A,Q'), 'Two pair A,Q');
  assert.equal(i18n.hand('炸弹Q'), 'Quads Q');
  assert.equal(i18n.hand('10-A顺子'), 'Straight 10–A');
  assert.equal(i18n.hand('同花顺'), 'Straight flush');
  assert.equal(i18n.message('Check & Rose 跟注 40'), 'Check & Rose calls 40');
  assert.equal(i18n.message('加注总额须至少 200，或全下至 500'),
    'Raise to at least 200, or go all-in to 500.');
  assert.equal(i18n.message('礼物差额自动补码 2000'), 'Gift shortfall covered by an auto rebuy of 2000.');
  assert.equal(i18n.message('一条旧记录：Check & Rose'), '一条旧记录：Check & Rose');
  i18n.setLanguage('zh-TW');
  assert.equal(i18n.hand('两对A,Q'), '兩對A,Q');
  assert.equal(i18n.hand('炸弹Q'), '四條Q');
  assert.equal(i18n.hand('10-A顺子'), '10-A順子');
  assert.equal(i18n.message('加注总额须至少 200，或全下至 500'),
    '加注總額須至少 200，或全下至 500');
});

test('the production toast writes a translated nickname as raw text, not HTML entities', () => {
  const source = sourceFile('app.js');
  const toastSource = source.match(/  function showToast\(message\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(toastSource, 'use the production toast handler');
  const { i18n } = loadI18n();
  i18n.setLanguage('en');
  const toast = { textContent: '', hidden: true };
  const showToast = Function('$', 'i18n', 'clearTimeout', 'setTimeout',
    `let toastTimer;\n${toastSource}\nreturn showToast;`)(
    () => toast, i18n, () => {}, () => 1);
  showToast('Check & Rose 跟注 40');
  assert.equal(toast.textContent, 'Check & Rose calls 40');
  assert.equal(toast.hidden, false);
});

test('the production language change retains exact bet text and focus without network actions', () => {
  const source = sourceFile('app.js');
  const handlerSource = source.match(/  document\.addEventListener\('poker-language-change', \(\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handlerSource, 'use the production language change handler');
  const { i18n } = loadI18n();
  let handler, fetches = 0, commands = 0, focused = false;
  const oldRaise = { value: '0070' };
  let newRaise = oldRaise;
  const fields = new Map([
    ['#gift-count', { value: '99' }],
    ['#gift-recipient', { value: 'recipient-1', dataset: {}, options: [{ value: 'recipient-1' }] }],
    ['#seat-buyin-input', { value: '2000' }],
    ['#nickname-input', { value: 'Check & Rose' }],
    ['#room-code-input', { value: '123456' }],
    ['#enter-button', { textContent: '' }],
    ['#spectate-button', { textContent: '' }],
    ['#connection', { textContent: '', dataset: { labelKey: '准备连接' } }],
    ['#lobby-error', { dataset: {}, textContent: '' }],
    ['#board-cards', { dataset: {} }],
    ['#toast', { hidden: false }]
  ]);
  const $ = selector => selector === '#raise-amount' ? newRaise : fields.get(selector);
  const document = { activeElement: oldRaise, addEventListener(type, listener) { if (type === 'poker-language-change') handler = listener; } };
  const state = { mode: 'create', data: { status: 'playing' }, newRunoutCards: new Set(['0:1']) };
  const giftPicker = { recipientId: '' };
  const render = () => { newRaise = { value: '70', focus() { focused = true; } }; };
  Function('document', '$', 'state', 'i18n', 't', 'message', 'giftPicker', 'render',
    'refreshSavedIdentity', 'refreshLiveEffectsLanguage', 'fetch', 'command', handlerSource)(
    document, $, state, i18n, i18n.t, i18n.message, giftPicker, render, () => {}, () => {},
    () => { fetches++; }, () => { commands++; });
  assert.equal(typeof handler, 'function');
  handler();
  assert.equal(newRaise.value, '0070');
  assert.equal(focused, true);
  assert.equal(fields.get('#nickname-input').value, 'Check & Rose');
  assert.equal(fields.get('#gift-count').value, '99');
  assert.equal(fields.get('#gift-recipient').value, 'recipient-1');
  assert.equal(state.newRunoutCards.size, 0);
  assert.equal(fetches, 0);
  assert.equal(commands, 0);
  newRaise.value = '4.5';
  newRaise.dataset = { chipUnit: 'bb' };
  document.activeElement = newRaise;
  handler();
  assert.equal(newRaise.value, '4.5', 'language repaint must preserve the BB wager string');
  assert.equal(fetches, 0);
  assert.equal(commands, 0);
});
