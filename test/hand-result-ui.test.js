import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadI18n } from './i18n-harness.js';

const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/app.js');
const source = readFileSync(appPath, 'utf8');
const chipSource = readFileSync(path.join(path.dirname(appPath), 'chip-display.js'), 'utf8');
const chipWindow = {};
vm.runInNewContext(chipSource, { window: chipWindow, localStorage: { getItem: () => null, setItem() {} } });
const chips = chipWindow.PokerChips;
const chipAmount = (value, data) => chips.format(value, data);
const safeSource = source.match(/  const safe = [^\n]+;/)?.[0];
const finishedSource = source.match(/  function isFinished\(data\) \{[^\n]+\}/)?.[0];
const resultSource = source.match(/  function handResultHtml\(data\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(safeSource && finishedSource && resultSource, '应从生产前端源码提取手末结果渲染函数');
const { i18n } = loadI18n();
const handResultHtml = Function('t', 'chipAmount', `${safeSource}\n${finishedSource}\n${resultSource}\nreturn handResultHtml;`)(i18n.t, chipAmount);

test('normal playing state has no hand result; finished state shows signed net amounts', () => {
  assert.equal(handResultHtml({ status: 'playing', result: null }), '');
  const html = handResultHtml({ status: 'finished', result: { winners: [
    { nickname: '赢家', amount: 350, totalCommit: 100, netProfit: 250 },
    { nickname: '平分者', amount: 200, totalCommit: 200, netProfit: 0 },
    { nickname: '边池亏损者', amount: 200, totalCommit: 300, netProfit: -100 }
  ] } });
  assert.match(html, /赢家<\/span><strong>净赢 \+250<\/strong>/);
  assert.match(html, /平分者<\/span><strong>净赢 0<\/strong>/);
  assert.match(html, /边池亏损者<\/span><strong>净亏 −100<\/strong>/);
  assert.equal((html.match(/role="listitem"/g) || []).length, 3);
});

test('legacy result reports gross share without inventing net profit, and escapes nicknames', () => {
  const html = handResultHtml({ status: 'finished', result: { winners: [
    { nickname: '<玩家&甲>', amount: 777 }
  ] } });
  assert.match(html, /&lt;玩家&amp;甲&gt;/);
  assert.match(html, /分得 777/);
  assert.doesNotMatch(html, /净赢|净亏/);
  assert.doesNotMatch(html, /<玩家&甲>/);
});

test('English result keeps a nickname literal while escaping it exactly once', () => {
  i18n.setLanguage('en');
  const html = handResultHtml({ status: 'finished', result: { winners: [
    { nickname: 'Check & Rose', amount: 130, netProfit: 30 }
  ] } });
  assert.match(html, /Check &amp; Rose/);
  assert.doesNotMatch(html, /&amp;amp;/);
  assert.match(html, /Net \+30/);
  i18n.setLanguage('zh-CN');
});

test('result orders net winners before negative and legacy gross shares without changing source data', () => {
  const winners = [
    { nickname: '净亏者', amount: 200, netProfit: -100 },
    { nickname: '旧结果', amount: 900 },
    { nickname: '净赢家', amount: 350, netProfit: 250 },
    { nickname: '持平者', amount: 200, netProfit: 0 }
  ];
  const html = handResultHtml({ status: 'finished', result: { winners } });
  assert.deepEqual([...html.matchAll(/class="hand-result-name"[^>]*>([^<]*)/g)].map((match) => match[1]),
    ['净赢家', '持平者', '净亏者', '旧结果']);
  assert.equal(winners[0].nickname, '净亏者');
});

test('finished net winnings display in BB without changing their chip accounting', () => {
  chips.setUnit('bb');
  const result = { status: 'finished', bigBlind: 20, result: { winners: [
    { nickname: '甲', amount: 350, totalCommit: 100, netProfit: 250 }
  ] } };
  const html = handResultHtml(result);
  assert.match(html, /净赢 \+12\.5 BB/);
  assert.equal(result.result.winners[0].netProfit, 250);
  chips.setUnit('chips');
});
