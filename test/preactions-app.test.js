import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const app = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const window = {};
vm.runInNewContext(readFileSync(path.join(publicDir, 'preactions.js'), 'utf8'), { window });
vm.runInNewContext(readFileSync(path.join(publicDir, 'chip-display.js'), 'utf8'),
  { window, localStorage: { getItem: () => null, setItem() {} } });
const { createController } = window.PokerPreactions;
const chips = window.PokerChips;
const plain = value => JSON.parse(JSON.stringify(value));

function productionFunction(name, dependencies, isAsync = false) {
  const source = app.match(new RegExp(`  ${isAsync ? 'async ' : ''}function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `missing production ${name}`);
  return Function(...Object.keys(dependencies), `${source}\nreturn ${name}`)(...Object.values(dependencies));
}

function table({ actor = 1, currentBet = 20, streetIndex = 0, status = 'playing',
  runout = null, handNo = 1, serverTime = Date.now() } = {}) {
  return { roomCode: '839172', handNo, status, runout, streetIndex, currentBet,
    actingSeat: actor, actionDeadline: serverTime + 25_000, serverTime,
    pot: 30, bigBlind: 20, minRaiseTo: 40, seats: [
      { seat: 0, playerId: 'me', nickname: 'Hero', inHand: true, folded: false,
        allIn: false, streetCommit: streetIndex ? 0 : 20, stack: 1980 },
      { seat: 1, playerId: 'other', nickname: 'Other', inHand: true, folded: false,
        allIn: false, streetCommit: streetIndex ? 0 : 20, stack: 1980 }
    ], hero: { seat: 0, playerId: 'me', cards: ['As', 'Kd'], canAct: actor === 0,
      toCall: actor === 0 ? Math.max(0, currentBet - (streetIndex ? 0 : 20)) : 0,
      canRaise: actor === 0, maxRaiseTo: 2000 }, events: [] };
}

function renderHarness(data, preactions = createController()) {
  const classes = new Set();
  const nodes = {
    '#action-title': { textContent: '' },
    '#action-panel': { hidden: false, classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); }
    } },
    '#action-controls': { innerHTML: '' },
    '#to-call-label': { textContent: '' }
  };
  const $ = selector => nodes[selector] ?? null;
  const state = { roomCode: data.roomCode, data, pending: false, clockOffset: 0 };
  const t = (key, values = {}) => String(key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  const safe = value => String(value);
  const chipAmount = (value, current = data) => chips.format(value, current);
  const raiseSuggestion = productionFunction('raiseSuggestion', {});
  const defaultRaiseAmount = productionFunction('defaultRaiseAmount', {});
  const bettingControlsHtml = productionFunction('bettingControlsHtml', {
    state, preactions, chips, chipAmount, raiseSuggestion, defaultRaiseAmount, $, t, safe, Date
  });
  const renderActions = productionFunction('renderActions', {
    state, preactions, bettingControlsHtml, $, t, safe, chipAmount, Date,
    isFinished: value => value.status === 'finished', currentRevealable: () => null,
    canStart: () => false
  });
  return { state, nodes, $, t, safe, chipAmount, preactions, renderActions };
}

test('another player turn keeps every betting control visible; local fold/check selection sends nothing', () => {
  assert.match(html, /<script src="\/preactions\.js" defer><\/script>[\s\S]*<script src="\/app\.js" defer><\/script>/);
  const waiting = table();
  const ui = renderHarness(waiting);
  ui.renderActions(waiting);
  const controls = ui.nodes['#action-controls'];
  assert.equal(ui.nodes['#action-panel'].hidden, false);
  assert.match(controls.innerHTML, /data-preaction="fold" aria-pressed="false"/);
  assert.match(controls.innerHTML, /data-preaction="check" aria-pressed="false"/);
  assert.match(controls.innerHTML, /data-preaction="checkFold" aria-pressed="false"/);
  for (const klass of ['action-raise', 'action-allin', 'size-button']) {
    assert.match(controls.innerHTML, new RegExp(`class="[^"]*${klass}[^"]*"[^>]*disabled`));
  }
  assert.match(css, /\.action-controls \.action-fold\[aria-pressed="true"\]/);
  assert.match(css, /\.action-controls \.action-check\[aria-pressed="true"\]/);
  assert.match(css, /\.action-controls \.action-checkfold\[aria-pressed="true"\]/);

  let click, requests = 0;
  const actionControls = { addEventListener(type, handler) { if (type === 'click') click = handler; } };
  const $ = selector => selector === '#action-controls' ? actionControls : ui.$(selector);
  const clickSource = app.match(/  \$\('#action-controls'\)\.addEventListener\('click', \(event\) => \{[\s\S]*?\n  \}\);\n  \$\('#action-controls'\)\.addEventListener\('input'/)?.[0]
    .replace(/\n  \$\('#action-controls'\)\.addEventListener\('input'$/, '');
  assert.ok(clickSource);
  Function('$', 'state', 'document', 'command', 'showToast', 'raisePreviewText', 't',
    'chips', 'chipAmount', 'preactions', 'renderActions', 'window', clickSource)(
    $, ui.state, { querySelectorAll: () => [] }, () => { requests++; }, () => {}, () => '',
    ui.t, chips, ui.chipAmount, ui.preactions, ui.renderActions, window);
  const button = { disabled: false, dataset: { preaction: 'fold' } };
  click({ target: { closest(selector) {
    return selector === 'button' || selector === 'button[data-preaction]' ? button : null;
  } } });
  assert.equal(ui.preactions.getSelected(), 'fold');
  assert.equal(requests, 0, 'selecting fold is strictly local until the actual turn');
  assert.match(controls.innerHTML, /data-preaction="fold" aria-pressed="true"/);
  button.dataset.preaction = 'checkFold';
  click({ target: { closest(selector) {
    return selector === 'button' || selector === 'button[data-preaction]' ? button : null;
  } } });
  assert.equal(ui.preactions.getSelected(), 'checkFold');
  assert.equal(requests, 0, 'selecting check/fold is also strictly local');
  assert.match(controls.innerHTML, /data-preaction="checkFold" aria-pressed="true"/);
});

test('a stored fold dispatches once with an exact server guard; check cancels on raise or street change', () => {
  const waiting = table();
  const ui = renderHarness(waiting);
  const sent = [];
  const runPreaction = productionFunction('runPreaction', {
    state: ui.state, preactions: ui.preactions, renderActions: ui.renderActions,
    command: payload => { sent.push(payload); return Promise.resolve(true); }
  });
  ui.preactions.toggle('fold', waiting);
  runPreaction();
  assert.deepEqual(sent, []);
  const turn = table({ actor: 0, serverTime: waiting.serverTime + 100 });
  ui.state.data = turn;
  runPreaction();
  runPreaction();
  assert.deepEqual(plain(sent), [{ type: 'action', action: 'fold', expectedAction: {
    handNo: turn.handNo, streetIndex: turn.streetIndex, actingSeat: turn.actingSeat,
    actionDeadline: turn.actionDeadline, currentBet: turn.currentBet
  } }]);

  const check = createController();
  assert.equal(check.toggle('check', waiting), 'check');
  const raised = table({ actor: 0, currentBet: 100, serverTime: waiting.serverTime + 200 });
  assert.equal(check.observe(raised), null);
  assert.equal(check.getSelected(), null, 'a new bet cancels check before dispatch');
  assert.equal(check.toggle('check', waiting), null, 'a stale earlier frame cannot rearm check');
  const next = createController();
  assert.equal(next.toggle('check', waiting), 'check');
  const flop = table({ actor: 1, currentBet: 0, streetIndex: 1,
    serverTime: waiting.serverTime + 300 });
  assert.equal(next.observe(flop), null);
  assert.equal(next.getSelected(), null, 'a later street clears check even if its current bet is zero');
});

test('while another command is pending, a new turn waits until finally and sends one guarded check',
  async () => {
    const waiting = table();
    const ui = renderHarness(waiting);
    ui.state.roomCode = waiting.roomCode;
    ui.state.token = 'test-token';
    ui.state.session = 1;
    ui.preactions.toggle('check', waiting);
    const sent = [];
    let finishRebuy;
    let command;
    const runPreaction = productionFunction('runPreaction', {
      state: ui.state, preactions: ui.preactions, renderActions: ui.renderActions,
      command: payload => command(payload)
    });
    const applyState = fresh => {
      ui.state.data = fresh;
      ui.preactions.observe(fresh, { consume: false });
      runPreaction();
    };
    const request = (_url, options) => {
      sent.push(options.body);
      if (options.body.type === 'rebuy') return new Promise(resolve => { finishRebuy = resolve; });
      return Promise.resolve({ state: { ...ui.state.data,
        hero: { ...ui.state.data.hero, canAct: false }, serverTime: ui.state.data.serverTime + 1 } });
    };
    command = productionFunction('command', {
      state: ui.state, preactions: ui.preactions, renderActions: ui.renderActions,
      request, applyState, refreshState: async () => {},
      showGiftEffect() {}, queueRoomEffect() {}, showToast() {},
      t: value => value, money: value => String(value), isRoomClosedError: () => false,
      closeExpiredRoom() {}, runPreaction
    }, true);
    const rebuy = command({ type: 'rebuy', amount: 2000 });
    assert.equal(ui.state.pending, true);
    const turn = table({ actor: 0, serverTime: waiting.serverTime + 100 });
    applyState(turn);
    assert.deepEqual(sent.map(item => item.type), ['rebuy'], 'no action request while rebuy is in flight');
    finishRebuy({ state: turn });
    await rebuy;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent.map(item => item.type), ['rebuy', 'action']);
    assert.deepEqual(plain(sent[1]), { type: 'action', action: 'check', expectedAction: {
      handNo: turn.handNo, streetIndex: turn.streetIndex, actingSeat: turn.actingSeat,
      actionDeadline: turn.actionDeadline, currentBet: turn.currentBet
    } });
    assert.equal(ui.preactions.getSelected(), null);
  });

test('runout choices and hand reveal replace ordinary betting controls below the table', () => {
  const choice = table({ runout: { phase: 'trailingVote', trailingSeat: 0 } });
  const ui = renderHarness(choice);
  ui.renderActions(choice);
  const controls = ui.nodes['#action-controls'];
  const panel = ui.nodes['#action-panel'];
  assert.equal(panel.hidden, false);
  assert.equal(panel.classList.contains('is-special'), true);
  assert.match(controls.innerHTML, /data-runout-choice="1"/);
  assert.match(controls.innerHTML, /data-runout-choice="2"/);
  assert.doesNotMatch(controls.innerHTML, /data-action=|data-preaction=|raise-amount/);

  const calculating = table({ runout: { phase: 'calculating', equity: [], deadline: null } });
  ui.renderActions(calculating);
  assert.equal(panel.hidden, false);
  assert.equal(ui.nodes['#action-title'].textContent, '正在计算胜率…');
  assert.match(controls.innerHTML, /正在计算胜率…/);
  assert.doesNotMatch(controls.innerHTML, /<button|data-action=|data-runout-choice=/,
    'equity calculation offers no betting or premature vote');

  const response = table({ runout: { phase: 'leaderVote', leadingSeat: 0 } });
  ui.renderActions(response);
  assert.match(controls.innerHTML, /data-runout-response="true"/);
  assert.match(controls.innerHTML, /data-runout-response="false"/);
  assert.doesNotMatch(controls.innerHTML, /data-action=|data-preaction=|raise-amount/);

  const finished = table({ status: 'finished' });
  ui.renderActions(finished);
  assert.equal(panel.hidden, false);
  assert.match(controls.innerHTML, /data-command="reveal"/);
  assert.doesNotMatch(controls.innerHTML, /data-action=|data-preaction=|raise-amount/);

  finished.seats[0].shownCards = ['As', 'Kd'];
  ui.renderActions(finished);
  assert.equal(panel.hidden, true, 'no empty action panel after automatic showdown or reveal');
  assert.equal(controls.innerHTML, '');

  const normal = table();
  ui.renderActions(normal);
  assert.equal(panel.classList.contains('is-special'), false);
  assert.match(controls.innerHTML, /data-preaction="fold"/);
  assert.match(css, /\.action-panel\.is-special \.action-controls\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('a local choice is discarded on hand end, leaving the seat or changing rooms', () => {
  const waiting = table();
  const scenarios = [
    { ...waiting, status: 'finished' },
    { ...waiting, hero: { ...waiting.hero, seat: null } },
    { ...waiting, roomCode: '839173' },
    { ...waiting, handNo: waiting.handNo + 1 }
  ];
  for (const next of scenarios) {
    const controller = createController();
    assert.equal(controller.toggle('fold', waiting), 'fold');
    assert.equal(controller.observe(next), null);
    assert.equal(controller.getSelected(), null);
  }
  const stopSource = app.match(/  function stopNetwork\(\) \{[\s\S]*?\n  \}/)?.[0];
  const closeSource = app.match(/    socket\.onclose = \(event\) => \{[\s\S]*?\n    \};/)?.[0];
  assert.match(stopSource || '', /preactions\.reset\(\)/, 'leaving a room clears the local choice');
  assert.match(closeSource || '', /preactions\.reset\(\)/, 'socket disconnect clears the local choice');
});
