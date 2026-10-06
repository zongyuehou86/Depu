import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');
const t = (key, params = {}) => key.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
const safe = value => String(value);

function productionFunction(name, dependencies) {
  const source = app.match(new RegExp(`  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `missing production ${name}`);
  return Function(...Object.keys(dependencies), `${source}\nreturn ${name}`)(...Object.values(dependencies));
}

function sidebarHarness() {
  const nodes = {
    '#room-summary': { innerHTML: '' }, '#room-controls': { innerHTML: '' },
    '#secondary-presence': { innerHTML: '' }, '#switch-player': { disabled: false, title: '' }
  };
  const $ = selector => nodes[selector] ?? null;
  const renderSidebar = productionFunction('renderSidebar', {
    updateControlsHtml: (element, html) => { element.innerHTML = html; },
    $, t, safe, money: value => String(value), chipAmount: value => String(value),
    chips: { getBlind: data => data.bigBlind }, state: { token: 'secret' },
    canStart: () => true, cannotLeaveSeatDuringHand: () => false,
    message: value => value
  });
  const data = { roomCode: 'TABLE', status: 'waiting', capacity: 4,
    bigBlind: 40, smallBlind: 20, seats: [null, null, null, null],
    hero: { seat: null, isOwner: false }, spectatorCount: 1 };
  return { nodes, renderSidebar, data };
}

test('only spectators can edit next-hand settings, including during play, with stable drafts', () => {
  const { nodes, renderSidebar, data } = sidebarHarness();
  renderSidebar(data);
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="40"/);
  assert.match(nodes['#room-controls'].innerHTML, /data-command="setBigBlind"/);
  assert.match(nodes['#room-controls'].innerHTML, /data-command="setCapacity"/, 'spectators can also change capacity');

  nodes['#big-blind-change'] = { dataset: { roomCode: 'TABLE', serverBlind: '40' }, value: '125' };
  renderSidebar(data);
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="125"/);
  renderSidebar({ ...data, pendingBigBlind: 50 });
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="50"/);

  renderSidebar({ ...data, status: 'playing', seatingCapacity: 6, pendingCapacity: 6,
    seats: [null, null, null, null, null, null] });
  assert.match(nodes['#room-controls'].innerHTML, /setBigBlind/);
  assert.match(nodes['#room-controls'].innerHTML, /<option value="6" selected>/);
  assert.match(nodes['#room-summary'].innerHTML, /0 \/ 6/);
  assert.match(nodes['#room-controls'].innerHTML, /下手设置：人数 6/);

  renderSidebar({ ...data, hero: { seat: 0, isOwner: true },
    seats: [{ seat: 0, stack: 2000 }, null, null, null] });
  assert.doesNotMatch(nodes['#room-controls'].innerHTML, /setBigBlind|setCapacity/,
    'being the owner does not permit changes while seated');
});

test('blind button sends a validated integer amount through the production room command handler', () => {
  const { nodes, data } = sidebarHarness();
  const calls = [], errors = [];
  let click;
  nodes['#room-controls'] = { addEventListener(type, handler) { if (type === 'click') click = handler; } };
  nodes['#big-blind-change'] = { value: '125' };
  const $ = selector => nodes[selector] ?? null;
  const source = app.match(/  \$\('#room-controls'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(source);
  Function('$', 'command', 'idempotentCommand', 'showToast', 't', source)(
    $, payload => calls.push(payload), () => {}, value => errors.push(value), t);
  const button = { disabled: false, dataset: { command: 'setBigBlind' } };
  const press = () => click({ target: { closest: () => button } });
  press();
  assert.deepEqual(calls, [{ type: 'setBigBlind', amount: 125 }]);
  for (const invalid of ['', '1', '1e3', '1000001']) {
    nodes['#big-blind-change'].value = invalid;
    press();
  }
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 4);
});

test('seat buy-in minimum follows the current room blind', () => {
  const data = { roomCode: 'TABLE', capacity: 4, seatingCapacity: 6, pendingCapacity: 6,
    bigBlind: 5000, pendingBigBlind: 8000, status: 'playing',
    hero: { seat: null }, seats: [null, null, null, null, null, null] };
  const nodes = {
    '#seat-buyin-input': { min: '20', value: '2000', focus() {} },
    '#seat-panel': { hidden: true }, '#seat-backdrop': { hidden: true },
    '#seat-title': { textContent: '' }, '#seat-count': { textContent: '' },
    '#seat-note': { textContent: '' }, '#seat-picker': { innerHTML: '' }
  };
  const $ = selector => nodes[selector] ?? null;
  const state = { data, seatDialogSeat: null };
  const renderSeatPanel = productionFunction('renderSeatPanel', { $, state, t, safe });
  const openSeatDialog = productionFunction('openSeatDialog', { $, state, renderSeatPanel });
  openSeatDialog(5);
  assert.equal(nodes['#seat-buyin-input'].min, '5000');
  assert.equal(nodes['#seat-buyin-input'].value, '5000');
  assert.equal(nodes['#seat-panel'].hidden, false);
  assert.equal(state.seatDialogSeat, 5, 'an added seat can be reserved during the current hand');
  renderSeatPanel({ ...data, pendingCapacity: 4 });
  assert.equal(nodes['#seat-panel'].hidden, true, 'shrinking the next hand invalidates a tail-seat draft');
});

test('a new setting notice appears once while pending, never on baseline or after its hand starts', () => {
  const noticeText = productionFunction('tableSettingsNoticeText', {
    t, money: value => String(value)
  });
  const old = { roomCode: 'TABLE', handNo: 4, tableSettingsNotice: { id: 10 } };
  const bigBlind = { roomCode: 'TABLE', handNo: 4, tableSettingsNotice: {
    id: 11, kind: 'bigBlind', bigBlind: 51, nextHandNo: 5
  } };
  assert.equal(noticeText(bigBlind, null), '');
  assert.equal(noticeText(bigBlind, old), '下一局大盲筹码数为51筹码');
  assert.equal(noticeText(bigBlind, old, 11), '', 'a newer setting already seen cannot replay');
  assert.equal(noticeText(bigBlind, bigBlind), '');
  assert.equal(noticeText({ ...bigBlind, handNo: 5 }, old), '');
  assert.equal(noticeText(bigBlind, { ...old, roomCode: 'OTHER' }), '');
  assert.equal(noticeText({ ...bigBlind, tableSettingsNotice: {
    id: 12, kind: 'capacity', capacity: 8, nextHandNo: 5
  } }, old), '下一局牌桌人数为8人');
});
