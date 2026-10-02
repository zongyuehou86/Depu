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
    '#secondary-presence': { innerHTML: '' }, '#switch-player': { disabled: false, title: '' },
    '#recovery-display': { value: '' }
  };
  const $ = selector => nodes[selector] ?? null;
  const renderSidebar = productionFunction('renderSidebar', {
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

test('all room members can change the blind between hands, with a stable unsubmitted draft', () => {
  const { nodes, renderSidebar, data } = sidebarHarness();
  renderSidebar(data);
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="40"/);
  assert.match(nodes['#room-controls'].innerHTML, /data-command="setBigBlind"/);
  assert.doesNotMatch(nodes['#room-controls'].innerHTML, /data-command="setCapacity"/, 'spectators still have blind permission');

  nodes['#big-blind-change'] = { dataset: { roomCode: 'TABLE', serverBlind: '40' }, value: '125' };
  renderSidebar(data);
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="125"/);
  renderSidebar({ ...data, bigBlind: 50, smallBlind: 25 });
  assert.match(nodes['#room-controls'].innerHTML, /id="big-blind-change"[^>]*value="50"/);

  renderSidebar({ ...data, status: 'playing' });
  assert.doesNotMatch(nodes['#room-controls'].innerHTML, /setBigBlind/);
  renderSidebar({ ...data, status: 'finished' });
  assert.match(nodes['#room-controls'].innerHTML, /setBigBlind/);
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
  const data = { roomCode: 'TABLE', capacity: 4, bigBlind: 5000, status: 'waiting',
    hero: { seat: null }, seats: [null, null, null, null] };
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
  openSeatDialog(0);
  assert.equal(nodes['#seat-buyin-input'].min, '5000');
  assert.equal(nodes['#seat-buyin-input'].value, '5000');
  assert.equal(nodes['#seat-panel'].hidden, false);
});
