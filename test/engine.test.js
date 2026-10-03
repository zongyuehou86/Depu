import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBest, evaluateFive } from '../engine.js';

const ranks = '23456789TJQKA', suits = 'cdhs';
const cards = labels => labels.split(' ').map(label =>
  suits.indexOf(label[1]) * 13 + ranks.indexOf(label[0]));

function exhaustiveBest(hand) {
  let best = null;
  for (let a = 0; a < hand.length - 4; a++)
    for (let b = a + 1; b < hand.length - 3; b++)
      for (let c = b + 1; c < hand.length - 2; c++)
        for (let d = c + 1; d < hand.length - 1; d++)
          for (let e = d + 1; e < hand.length; e++) {
            const value = evaluateFive([hand[a], hand[b], hand[c], hand[d], hand[e]]);
            let stronger = !best;
            if (best) {
              for (let index = 0; index < value.length; index++) {
                if (value[index] === best[index]) continue;
                stronger = value[index] > best[index];
                break;
              }
            }
            if (stronger) best = value;
          }
  return best;
}

test('direct evaluator chooses the best ranks and kickers for five to seven cards', () => {
  const cases = [
    ['Ac Kd Jh 9s 7c', [0, 14, 13, 11, 9, 7]],
    ['Ac Ad Kh Qs Jc 9d 2h', [1, 14, 13, 12, 11]],
    ['Ac Ad Kh Ks Qc Qd Jh', [2, 14, 13, 12]], // Three pairs: third pair supplies the kicker.
    ['Ac Ad Ah Ks Qc Jd 9h', [3, 14, 13, 12]],
    ['As 2d 3h 4c 5s', [4, 5]],
    ['As 2d 3h 4c 5s 6d 7h', [4, 7]],
    ['As Ad 2h 3c 4s 5d 9h', [4, 5]],
    ['Ac Kd Qh Js Tc 9d 8h', [4, 14]],
    ['Ac Qc Tc 8c 6c 4c 2c', [5, 14, 12, 10, 8, 6]], // Seven-card flush.
    ['Ac Kc Qc 9c 7c 2d 2h', [5, 14, 13, 12, 9, 7]],
    ['Ac Ad Ah Kc Kd Kh Qs', [6, 14, 13]], // Higher triple wins; lower triple supplies pair.
    ['Kc Kd Kh Ac Ad Qc Qd', [6, 13, 14]], // Highest pair, even above the triple.
    ['Ac Ad Ah Qc Qd Js Jd', [6, 14, 12]],
    ['2c 2d 2h 2s Ac Kd Kh', [7, 2, 14]],
    ['Ac Ad Ah As Kc Kd Qh', [7, 14, 13]],
    ['Ac 2c 3c 4c 5c Kd Qh', [8, 5]],
    ['Ac Kc Qc Jc Tc 9c 8c', [8, 14]],
    ['Ac 2c 3c 4c 9c 5d 6h', [5, 14, 9, 4, 3, 2]] // Off-suit wheel is weaker than flush.
  ];
  for (const [labels, expected] of cases) {
    const hand = cards(labels);
    assert.deepEqual(evaluateBest(hand), expected, labels);
    assert.deepEqual(evaluateBest(hand.toReversed()), expected, `reversed ${labels}`);
    assert.deepEqual(exhaustiveBest(hand), expected, `oracle ${labels}`);
  }
  assert.equal(evaluateBest(cards('Ac Ad Ah As')), null);
  assert.equal(evaluateBest(cards('Ac Ad Ah As Kc Kd Qh Qs')), null);
});

test('direct evaluator agrees with independent five-card enumeration for 60,000 seeded hands', () => {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (const length of [5, 6, 7]) {
    for (let sample = 0; sample < 20_000; sample++) {
      const deck = Array.from({ length: 52 }, (_, card) => card);
      for (let index = 0; index < length; index++) {
        const swap = index + random() % (52 - index);
        [deck[index], deck[swap]] = [deck[swap], deck[index]];
      }
      const hand = deck.slice(0, length);
      assert.deepEqual(evaluateBest(hand), exhaustiveBest(hand),
        `${length}-card sample ${sample}: ${hand.join(',')}`);
    }
  }
});
