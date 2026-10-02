import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadI18n } from './i18n-harness.js';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js'), 'utf8');
const chipSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/chip-display.js'), 'utf8');
const chipWindow = {};
vm.runInNewContext(chipSource, { window: chipWindow, localStorage: { getItem: () => null, setItem() {} } });
const chips = chipWindow.PokerChips;
const chipAmount = (value, data) => chips.format(value, data);
const formatterSource = source.match(/  function runoutWinners\(data, boardIndex\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(formatterSource, '前端应保留逐板赢家显示函数');
const { i18n } = loadI18n();
const runoutWinners = Function('safe', 'chipAmount', 't', 'hand', `${formatterSource}\nreturn runoutWinners`)(
  value => String(value), chipAmount, i18n.t, i18n.hand
);
const streetSource = source.match(/  function streetLabel\(data, board, boardIndex\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(streetSource, '前端应按当前跑马牌面显示街道');
const streetLabel = Function('names', 't', 'money', `${streetSource}\nreturn streetLabel`)(
  {}, i18n.t, value => String(value));

test('runout panels show each board winner, made hand and combined side-pot payout', () => {
  const first = { boardIndex: 0, pots: [
    { winners: [{ seat: 1, nickname: '乙', amount: 80, handDisplay: '炸弹Q', handCategory: 7 }] },
    { winners: [{ seat: 1, nickname: '乙', amount: 20, handDisplay: '炸弹Q', handCategory: 7 }] }
  ] };
  const second = { boardIndex: 1, pots: [
    { winners: [{ seat: 0, nickname: '甲', amount: 100, handDisplay: '同花顺', handCategory: 8 }] }
  ] };
  const pending = { result: null, runout: { boardResults: [first] } };
  const preview = runoutWinners(pending, 0);
  assert.match(preview, /本板赢家/);
  assert.match(preview, /乙/);
  assert.match(preview, /炸弹Q/);
  assert.match(preview, /\+100/);
  assert.equal(runoutWinners(pending, 1), ''); // Future board has no winner yet.

  const settled = { result: { runouts: [first, second] }, runout: { boardResults: [first] } };
  const firstHtml = runoutWinners(settled, 0);
  const secondHtml = runoutWinners(settled, 1);
  assert.match(firstHtml, /乙/);
  assert.match(firstHtml, /炸弹Q/);
  assert.ok(!firstHtml.includes('本板赢家'));
  assert.match(secondHtml, /甲/);
  assert.match(secondHtml, /同花顺/);
  assert.match(secondHtml, /👑/);
  assert.match(secondHtml, /\+100/);
});

test('top street label follows the visible second board rather than the first board river', () => {
  const data = { street: '河牌', runout: { times: 2 } };
  assert.equal(streetLabel(data, ['As', 'Ks', 'Qs', 'Js', 'Ts'], 0), '第 1 次河牌');
  assert.equal(streetLabel(data, [], 1), '第 2 次待翻牌');
  assert.equal(streetLabel(data, ['2c', '7d', 'Qc'], 1), '第 2 次翻牌');
  assert.equal(streetLabel(data, ['2c', '7d', 'Qc', '4s'], 1), '第 2 次转牌');
  assert.equal(streetLabel(data, ['2c', '7d', 'Qc', '4s', '9h'], 1), '第 2 次河牌');
  assert.equal(streetLabel({ street: '翻牌' }, ['2c', '7d', 'Qc'], 0), '翻牌');
  assert.equal(streetLabel({ smallBlind: 25, bigBlind: 50 }, [], 0), '盲注 25 / 50');
});

test('English runout panels translate the server hand label and current visible street', () => {
  i18n.setLanguage('en');
  const data = { result: { runouts: [{ boardIndex: 1, pots: [
    { winners: [{ seat: 0, nickname: 'Check & Rose', amount: 120, handDisplay: '同花顺', handCategory: 8 }] }
  ] }] } };
  const html = runoutWinners(data, 1);
  assert.match(html, /Straight flush/);
  assert.doesNotMatch(html, /同花顺/);
  assert.match(html, /Check & Rose/);
  assert.equal(streetLabel({ runout: { times: 2 } }, ['2c', '7d', 'Qc'], 1), 'Board 2 · Flop');
  i18n.setLanguage('zh-CN');
});

test('runout winner payout uses selected BB unit while source chips stay intact', () => {
  chips.setUnit('bb');
  const winner = { seat: 0, nickname: '甲', amount: 100, handDisplay: '同花', handCategory: 5 };
  const data = { bigBlind: 20, result: { runouts: [{ boardIndex: 0, pots: [{ winners: [winner] }] }] } };
  assert.match(runoutWinners(data, 0), /\+5 BB/);
  assert.equal(winner.amount, 100);
  chips.setUnit('chips');
});
