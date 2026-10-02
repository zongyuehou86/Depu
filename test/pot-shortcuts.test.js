import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js');
const appSource = readFileSync(appPath, 'utf8');
const suggestionSource = appSource.match(/  function raiseSuggestion\(data, fraction\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(suggestionSource, '前端应保留可核对的底池快捷金额函数');
const raiseSuggestion = Function(suggestionSource + '\nreturn raiseSuggestion')();
const defaultSource = appSource.match(/  function defaultRaiseAmount\(data\) \{[\s\S]*?\n  \}/)?.[0];
const stepSource = appSource.match(/  function stepRaiseAmount\(data, value, direction\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(defaultSource && stepSource, 'default and step amounts must use production functions');
const defaultRaiseAmount = Function(defaultSource + '\nreturn defaultRaiseAmount')();
const stepRaiseAmount = Function('defaultRaiseAmount', stepSource + '\nreturn stepRaiseAmount')(defaultRaiseAmount);
const fractions = [1 / 2, 1];
const chipSource = readFileSync(path.join(path.dirname(appPath), 'chip-display.js'), 'utf8');
function loadChips(unit = 'chips') {
  const window = {};
  vm.runInNewContext(chipSource, { window, localStorage: { getItem: () => unit, setItem() {} } });
  return window.PokerChips;
}

// Execute the real delegated click handler with a tiny DOM stand-in. This
// checks the actual input and command boundary, rather than mirroring it.
const clickSource = appSource.match(/  \$\('#action-controls'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?\n  \}\);\n  \$\('#action-controls'\)\.addEventListener\('input'/)?.[0]
  .replace(/\n  \$\('#action-controls'\)\.addEventListener\('input'$/, '');
assert.ok(clickSource, '前端应保留可核对的操作按钮点击处理');

function clickHarness(data, unit = 'chips') {
  const commands = [], toasts = [], sizeButtons = [];
  const chips = loadChips(unit);
  const input = { value: '', dataset: { chipUnit: unit } };
  let click;
  const actionControls = { addEventListener(type, listener) { if (type === 'click') click = listener; } };
  const $ = selector => selector === '#action-controls' ? actionControls :
    selector === '#raise-amount' ? input : null;
  const document = { querySelectorAll: () => sizeButtons };
  const state = { data };
  const command = value => { commands.push(value); };
  const showToast = value => { toasts.push(value); };
  const raisePreviewText = () => '金额不合法';
  const chipAmount = value => chips.format(value, data);
  Function('$', 'state', 'document', 'command', 'showToast', 'raisePreviewText', 'chips', 'chipAmount',
    'stepRaiseAmount', 't', clickSource)(
    $, state, document, command, showToast, raisePreviewText, chips, chipAmount,
    stepRaiseAmount, value => value);
  const press = button => click({ target: { closest: selector => {
    if (selector === 'button[data-fill="allin"]' && button.dataset.fill === 'allin') return button;
    if (selector === 'button[data-step]' && button.dataset.step) return button;
    if (selector === 'button[data-fraction]' && button.dataset.fraction) return button;
    if (selector === 'button[data-action]' && button.dataset.action) return button;
    return null;
  } } });
  const shortcut = fraction => {
    const button = { dataset: { fraction: String(fraction), amount: String(raiseSuggestion(data, fraction)) },
      setAttribute(name, value) { this[name] = value; } };
    sizeButtons.push(button);
    return button;
  };
  return { input, commands, toasts, press, shortcut, chips };
}

test('pot shortcuts fill literal rounded fractions despite current bet and minimum raise', () => {
  const data = { pot: 180, currentBet: 150, minRaiseTo: 300, hero: { maxRaiseTo: 1000 } };
  assert.equal(raiseSuggestion(data, 1 / 3), 60, 'the arithmetic helper still accepts arbitrary fractions');
  assert.deepEqual(fractions.map(fraction => raiseSuggestion(data, fraction)), [90, 180]);
  const ui = clickHarness(data);
  const buttons = fractions.map(ui.shortcut);
  ui.press(buttons[0]);
  assert.equal(ui.input.value, '90');
  assert.deepEqual(ui.commands, []);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  ui.press(buttons[1]);
  assert.equal(ui.input.value, '180');
  assert.equal(buttons[0]['aria-pressed'], 'false');
  assert.deepEqual(ui.commands, []);
});

test('a 500-chip pot fills 250 or 500; actual raise is a separate action', () => {
  const data = { pot: 500, currentBet: 20, minRaiseTo: 40, hero: { maxRaiseTo: 2000 } };
  assert.deepEqual(fractions.map(fraction => raiseSuggestion(data, fraction)), [250, 500]);
  const ui = clickHarness(data);
  ui.press(ui.shortcut(1 / 2));
  assert.equal(ui.input.value, '250');
  assert.deepEqual(ui.commands, []);
  ui.press({ dataset: { action: 'raise' } });
  assert.deepEqual(ui.commands, [{ type: 'action', action: 'raise', amount: 250 }]);
  const limited = clickHarness({ pot: 500, currentBet: 400, minRaiseTo: 600,
    hero: { maxRaiseTo: 450 } });
  limited.press(limited.shortcut(1));
  assert.equal(limited.input.value, '500'); // Filling does not clamp to stack.
  limited.press({ dataset: { action: 'raise' } });
  assert.deepEqual(limited.commands, []); // Existing submit validation still applies.
  assert.deepEqual(limited.toasts, ['金额不合法']);
});

test('shortcut markup contains only the short label and a literal data amount', () => {
  assert.match(appSource, /<button class="size-button" data-fraction=/);
  assert.match(appSource, /data-amount=/);
  assert.doesNotMatch(appSource, /title="填入 |size-literal|suggestion\.adjustment|data-extra/);
});

test('BB shortcut and all-in fill a display value, then submit integer chips only on confirmation', () => {
  const data = { pot: 180, currentBet: 20, minRaiseTo: 40, bigBlind: 20,
    hero: { maxRaiseTo: 2000 } };
  const ui = clickHarness(data, 'bb');
  ui.press(ui.shortcut(1 / 2));
  assert.equal(ui.input.value, '4.5');
  assert.deepEqual(ui.commands, []);
  ui.press({ dataset: { action: 'raise' } });
  assert.deepEqual(ui.commands, [{ type: 'action', action: 'raise', amount: 90 }]);
  ui.press({ dataset: { fill: 'allin' } });
  assert.equal(ui.input.value, '100');
  assert.equal(ui.commands.length, 1, 'all-in fill itself never sends a command');
  ui.press({ dataset: { action: 'raise' } });
  assert.deepEqual(ui.commands.at(-1), { type: 'action', action: 'raise', amount: 2000 });
  ui.input.value = '4.525';
  const count = ui.commands.length;
  ui.press({ dataset: { action: 'raise' } });
  assert.equal(ui.commands.length, count, 'half a chip is rejected before the server command');
  assert.deepEqual(ui.toasts.slice(-1), ['金额不合法']);
});

test('default raise is twice the current bet within legal limits, including short all-in', () => {
  assert.equal(defaultRaiseAmount({ currentBet: 20, minRaiseTo: 40, hero: { maxRaiseTo: 1000 } }), 40);
  assert.equal(defaultRaiseAmount({ currentBet: 150, minRaiseTo: 250, hero: { maxRaiseTo: 1000 } }), 300);
  assert.equal(defaultRaiseAmount({ currentBet: 500, minRaiseTo: 600, hero: { maxRaiseTo: 800 } }), 800);
  assert.equal(defaultRaiseAmount({ currentBet: 0, minRaiseTo: 20, hero: { maxRaiseTo: 1000 } }), 20);
  assert.equal(defaultRaiseAmount({ currentBet: 20, minRaiseTo: 40, hero: { maxRaiseTo: 30 } }), 30);
});

test('real +/- click handler moves 50 chips per tap in BB mode and clamps to legal bounds', () => {
  const data = { pot: 180, currentBet: 20, minRaiseTo: 40, bigBlind: 20,
    hero: { maxRaiseTo: 130 } };
  const ui = clickHarness(data, 'bb');
  ui.input.value = '4.5'; // 90 chips.
  ui.press({ dataset: { step: '1' } });
  assert.equal(ui.input.value, '6.5', '90 + 50 is clamped to 130 chips');
  ui.press({ dataset: { step: '-1' } });
  assert.equal(ui.input.value, '4');
  ui.press({ dataset: { step: '-1' } });
  assert.equal(ui.input.value, '2', 'the legal minimum is 40 chips');
  assert.deepEqual(ui.commands, [], 'step buttons only edit the input');
  ui.press({ dataset: { action: 'raise' } });
  assert.deepEqual(ui.commands, [{ type: 'action', action: 'raise', amount: 40 }]);
  assert.equal(stepRaiseAmount({ currentBet: 20, minRaiseTo: 40,
    hero: { maxRaiseTo: 30 } }, 30, -1), 30, 'a short stack remains at its legal all-in amount');
});
