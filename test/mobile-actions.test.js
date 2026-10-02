import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const app = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const css = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const window = {};
vm.runInNewContext(readFileSync(path.join(publicDir, 'preactions.js'), 'utf8'), { window });
vm.runInNewContext(readFileSync(path.join(publicDir, 'chip-display.js'), 'utf8'),
  { window, localStorage: { getItem: () => null, setItem() {} } });

function productionFunction(name, dependencies) {
  const source = app.match(new RegExp(`  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `missing production ${name}`);
  return Function(...Object.keys(dependencies), `${source}\nreturn ${name}`)(...Object.values(dependencies));
}

const defaultRaiseAmount = productionFunction('defaultRaiseAmount', {});
const raiseSuggestion = productionFunction('raiseSuggestion', {});
const stepRaiseAmount = productionFunction('stepRaiseAmount', { defaultRaiseAmount });

function table({ actor = 1, currentBet = 20, streetCommit = 20, unit = 'chips',
  maxRaiseTo = 2000, minRaiseTo = 40, canUseTimebank = false, timebankEnabled = false } = {}) {
  return { roomCode: 'TABLE', status: 'playing', handNo: 1, streetIndex: 0, serverTime: Date.now(),
    currentBet, minRaiseTo, maxRaiseTo, bigBlind: 20, pot: 180, actingSeat: actor,
    events: [{ id: 1, handNo: 1, seat: null, text: '第 1 手开始' }],
    seats: [{ playerId: 'hero', inHand: true, streetCommit, stack: 2000 },
      { playerId: 'other', inHand: true, streetCommit: currentBet, stack: 2000 }],
    hero: { playerId: 'hero', seat: 0, canAct: actor === 0,
      toCall: actor === 0 ? Math.max(0, currentBet - streetCommit) : 0,
      canRaise: actor === 0, maxRaiseTo, canUseTimebank, timebankEnabled }, unit };
}

function renderedControls(data, unit = 'chips') {
  const chips = window.PokerChips;
  chips.setUnit(unit);
  const state = { data, pending: false, clockOffset: 0 };
  const $ = () => null;
  const safe = value => String(value);
  const t = (key, params = {}) => String(key).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
  const chipAmount = value => chips.format(value, data);
  return productionFunction('bettingControlsHtml', { state, preactions: window.PokerPreactions.createController(),
    chips, chipAmount, raiseSuggestion, defaultRaiseAmount, $, t, safe, Date })(data);
}

function clickHarness(data, unit = 'chips') {
  const chips = window.PokerChips;
  chips.setUnit(unit);
  const preactions = window.PokerPreactions.createController();
  const input = { value: chips.inputValue(defaultRaiseAmount(data), data), dataset: { chipUnit: unit } };
  const commands = [];
  let click;
  const controls = { addEventListener(kind, listener) { if (kind === 'click') click = listener; } };
  const $ = selector => selector === '#action-controls' ? controls : selector === '#raise-amount' ? input : null;
  const clickSource = app.match(/  \$\('#action-controls'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?\n  \}\);\n  \$\('#action-controls'\)\.addEventListener\('input'/)?.[0]
    .replace(/\n  \$\('#action-controls'\)\.addEventListener\('input'$/, '');
  assert.ok(clickSource, 'use the production action click handler');
  Function('$', 'state', 'document', 'command', 'showToast', 'raisePreviewText', 't',
    'chips', 'chipAmount', 'preactions', 'renderActions', 'window', 'stepRaiseAmount', clickSource)(
    $, { data, pending: false }, { querySelectorAll: () => [] }, payload => { commands.push(payload); },
    () => {}, () => '', value => value, chips, value => chips.format(value, data),
    preactions, () => {}, window, stepRaiseAmount);
  const press = dataset => {
    const button = { dataset, disabled: false };
    const selectorMap = {
      'button[data-preaction]': 'preaction', 'button[data-timebank]': 'timebank',
      'button[data-check-fold]': 'checkFold', 'button[data-step]': 'step',
      'button[data-runout-choice]': 'runoutChoice', 'button[data-runout-response]': 'runoutResponse',
      'button[data-fill="allin"]': 'fill', 'button[data-fraction]': 'fraction',
      'button[data-action]': 'action', 'button[data-command]': 'command'
    };
    click({ target: { closest(selector) {
      if (selector === 'button') return button;
      const field = selectorMap[selector];
      return field && dataset[field] !== undefined ? button : null;
    } } });
  };
  return { press, commands, input, preactions };
}

test('production action markup uses three decisions, raise step controls, then four shortcuts', () => {
  const output = renderedControls(table({ actor: 0, canUseTimebank: true }));
  assert.match(output, /^<button class="[^"]*action-fold[^"]*"/);
  const positions = ['action-fold', 'action-check', 'action-checkfold', 'raise-control',
    'data-step="-1"', 'data-step="1"', 'action-raise', 'raise-sizes',
    'action-timebank', 'data-fraction="0.5"', 'data-fraction="1"', 'action-allin']
    .map(marker => output.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), 'every requested control is rendered');
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]),
    'controls remain in mobile reading order');
  assert.doesNotMatch(output, /1\/3池|data-fraction="0\.333/);
  assert.match(output, /id="raise-amount"[^>]*value="40"/);
  assert.match(renderedControls(table({ actor: 0, currentBet: 150, minRaiseTo: 250 })),
    /id="raise-amount"[^>]*value="300"/);
  assert.match(renderedControls(table({ actor: 0, maxRaiseTo: 30 })),
    /id="raise-amount"[^>]*value="30"/);
});

test('check/fold can be queued offturn but is disabled on the current turn', () => {
  const waiting = clickHarness(table());
  waiting.press({ preaction: 'checkFold' });
  assert.equal(waiting.preactions.getSelected(), 'checkFold');
  assert.deepEqual(waiting.commands, []);
  const ownTurn = renderedControls(table({ actor: 0 }));
  assert.match(ownTurn, /class="button action-checkfold" aria-pressed="false" disabled/);
  assert.doesNotMatch(ownTurn, /data-check-fold/);
  assert.match(css, /\.action-panel \.action-controls>\.action-checkfold\{[^}]*min-height:40px/);
  assert.match(css, /@media \(min-width:641px\) and \(max-width:850px\)\{[\s\S]*?\.action-panel \.action-controls>\.raise-sizes\{[^}]*width:100%[^}]*grid-template-columns:minmax\(0,\.5fr\) repeat\(3,minmax\(0,1fr\)\)/);
});

test('decision-row grid gives Fold and Check equal wider tracks without shrinking Check/Fold height', () => {
  const three = 'minmax(0,1fr) minmax(0,1fr) minmax(0,.6667fr)';
  assert.ok(css.includes(`.action-panel:not(.is-special) .action-controls{grid-template-columns:${three}}`));
  assert.ok(css.includes(`.action-panel:not(.is-special) .action-controls{grid-template-columns:${three} minmax(0,1fr) minmax(0,1fr)}`));
  assert.match(css, /\.action-panel \.action-controls>\.action-checkfold\{width:100%;min-width:0;justify-self:stretch\}/);
  assert.match(css, /\.action-controls>\.action-fold,\.action-panel \.action-controls>\.action-check,[\s\S]*?\.action-controls>\.action-checkfold\{min-height:40px\}/);
  assert.match(css, /\.action-panel \.action-controls>\.action-checkfold\{min-height:44px\}/);
});

test('real timebank click sends only its explicit boolean command', () => {
  const enable = clickHarness(table({ actor: 0, canUseTimebank: true }));
  enable.press({ timebank: 'true' });
  assert.deepEqual(enable.commands, [{ type: 'timebank', enabled: true }]);
  const disable = clickHarness(table({ actor: 0, timebankEnabled: true }));
  disable.press({ timebank: 'false' });
  assert.deepEqual(disable.commands, [{ type: 'timebank', enabled: false }]);
});

test('phone CSS keeps text inputs at 16px and viewport guard blocks only pinch gestures', () => {
  assert.match(html, /name="viewport"[^>]*initial-scale=1[^>]*minimum-scale=1[^>]*maximum-scale=1[^>]*user-scalable=no/);
  assert.match(html, /<script src="\/viewport-guard\.js" defer><\/script>[\s\S]*<script src="\/app\.js" defer><\/script>/);
  assert.match(css, /@media \(max-width:850px\)\{[\s\S]*?input:not\(\[type="range"\]\):not\(\[type="checkbox"\]\),select,textarea,\.action-panel \.raise-control input\{font-size:16px!important\}/);
  const listeners = new Map();
  vm.runInNewContext(readFileSync(path.join(publicDir, 'viewport-guard.js'), 'utf8'), {
    document: { addEventListener(kind, listener) { listeners.set(kind, listener); } }
  });
  let prevented = 0;
  const event = touches => ({ touches, cancelable: true, preventDefault() { prevented++; } });
  listeners.get('touchmove')(event([{}]));
  assert.equal(prevented, 0, 'single-finger scrolling stays available');
  listeners.get('touchmove')(event([{}, {}]));
  listeners.get('gesturestart')(event([]));
  listeners.get('gesturechange')(event([]));
  assert.equal(prevented, 3, 'two-finger pinch and Safari gestures are blocked');
});
