import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/chip-display.js'), 'utf8');
const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');

function loadChips({ stored = null, storageThrows = false } = {}) {
  const writes = [];
  const localStorage = {
    getItem(key) { if (storageThrows) throw new Error('storage denied'); return key === 'poker-chip-unit' ? stored : null; },
    setItem(key, value) { if (storageThrows) throw new Error('storage denied'); writes.push([key, value]); }
  };
  const window = {};
  vm.runInNewContext(source, { window, localStorage }, { filename: 'public/chip-display.js' });
  return { chips: window.PokerChips, writes };
}

test('20 chips are 1 BB and integer chip commands survive display round trips', () => {
  const { chips, writes } = loadChips();
  assert.equal(chips.getUnit(), 'chips');
  assert.equal(chips.format(2000), '2,000');
  assert.equal(chips.getBlind(), 20);
  assert.equal(chips.setUnit('bb'), 'bb');
  assert.deepEqual(writes, [['poker-chip-unit', 'bb']]);
  assert.equal(chips.format(20), '1 BB');
  assert.equal(chips.format(90), '4.5 BB');
  assert.equal(chips.format(2000), '100 BB');
  assert.equal(chips.inputStep(), '0.05');
  for (const rawChips of [1, 20, 90, 2000, 999_999]) {
    assert.equal(chips.toChips(chips.inputValue(rawChips)), rawChips);
  }
  assert.equal(chips.toChips('4.5'), 90);
  assert.ok(Number.isNaN(chips.toChips('4.525')), 'a partial chip must not be silently rounded');
  assert.ok(Number.isNaN(chips.toChips('')));
  assert.ok(Number.isNaN(chips.toChips('Infinity')));
  assert.equal(chips.setUnit('chips'), 'chips');
  assert.equal(chips.inputValue(90), '90');
  assert.equal(chips.inputStep(), '1');
});

test('saved unit, changing blind size and unavailable storage remain safe', () => {
  const saved = loadChips({ stored: 'bb' });
  assert.equal(saved.chips.getUnit(), 'bb');
  assert.equal(saved.chips.getBlind({ bigBlind: 50 }), 50);
  assert.equal(saved.chips.format(2000, { bigBlind: 50 }), '40 BB');
  assert.equal(saved.chips.inputValue(90, { bigBlind: 50 }), '1.8');
  assert.equal(saved.chips.toChips('1.8', { bigBlind: 50 }), 90);
  assert.equal(saved.chips.getBlind({ bigBlind: 0 }), 20);
  const denied = loadChips({ storageThrows: true });
  assert.equal(denied.chips.getUnit(), 'chips');
  assert.doesNotThrow(() => denied.chips.setUnit('bb'));
  assert.equal(denied.chips.getUnit(), 'bb');
  assert.equal(denied.chips.setUnit('unknown'), 'chips');
});

test('production unit switch preserves the same 90-chip wager and does not submit it', () => {
  const handlerSource = appSource.match(/  \$\('#chip-unit-select'\)\.addEventListener\('change', \(event\) => \{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handlerSource, 'use the production unit change handler');
  const { chips } = loadChips();
  let listener, renderCount = 0, focusCount = 0, commands = 0;
  let input = { value: '90', dataset: { chipUnit: 'chips' }, focus() { focusCount++; } };
  const document = { activeElement: input };
  const state = { data: { bigBlind: 20 }, newRunoutCards: new Set(['old-card']) };
  const $ = selector => selector === '#chip-unit-select'
    ? { addEventListener(_event, callback) { listener = callback; } }
    : selector === '#raise-amount' ? input : null;
  const render = () => {
    renderCount++;
    input = { value: input.value, dataset: { chipUnit: chips.getUnit() }, focus() { focusCount++; } };
  };
  Function('$', 'chips', 'document', 'state', 'render', 'command', handlerSource)(
    $, chips, document, state, render, () => { commands++; });
  listener({ target: { value: 'bb' } });
  assert.equal(chips.getUnit(), 'bb');
  assert.equal(input.value, '4.5');
  assert.equal(chips.toChips(input.value, state.data, input.dataset.chipUnit), 90);
  assert.equal(renderCount, 1);
  assert.equal(focusCount, 1);
  assert.equal(state.newRunoutCards.size, 0);
  document.activeElement = input;
  listener({ target: { value: 'chips' } });
  assert.equal(input.value, '90');
  assert.equal(chips.toChips(input.value, state.data, input.dataset.chipUnit), 90);
  assert.equal(renderCount, 2);
  assert.equal(commands, 0);
});
