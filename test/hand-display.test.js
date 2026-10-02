import test from 'node:test';
import assert from 'node:assert/strict';
import { cardLabel, describeHandValue, evaluateBest } from '../engine.js';

const cardByLabel = new Map(Array.from({ length: 52 }, (_, card) => [cardLabel(card), card]));

function display(labels) {
  const cards = labels.map(label => {
    assert.ok(cardByLabel.has(label), `unknown card ${label}`);
    return cardByLabel.get(label);
  });
  return describeHandValue(evaluateBest(cards));
}

test('seven-card hand display names the made ranks, not just the category', () => {
  assert.deepEqual(display(['As', 'Ah', 'Qc', 'Qd', '2h', '3s', '9c']),
    { label: '两对A,Q', category: 2 });
  assert.deepEqual(display(['Qs', 'Qh', 'Qd', 'Qc', '2h', '3s', '9c']),
    { label: '炸弹Q', category: 7 });
  assert.deepEqual(display(['Tc', 'Jd', 'Qh', 'Ks', 'Ac', '2s', '3d']),
    { label: '10-A顺子', category: 4 });
  assert.deepEqual(display(['Th', 'Jh', 'Qh', 'Kh', 'Ah', '2c', '3d']),
    { label: '同花顺', category: 8 });
  assert.deepEqual(display(['As', '2d', '3c', '4h', '5s', 'Qc', 'Kd']),
    { label: 'A-5顺子', category: 4 });
  assert.deepEqual(display(['As', 'Qs', '9s', '6s', '3s', '2d', 'Kh']),
    { label: '同花', category: 5 });
  assert.deepEqual(display(['Qs', 'Qh', 'Qd', 'As', 'Ah', '2c', '3d']),
    { label: '葫芦', category: 6 });
});
