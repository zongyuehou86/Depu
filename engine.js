import { createHash, createHmac, randomBytes } from 'node:crypto';

export const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
export const STREET_NAMES = ['翻牌前', '翻牌', '转牌', '河牌'];
const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

export function cardLabel(card) {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

function rank(card) { return card % 13 + 2; }
function suit(card) { return Math.floor(card / 13); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function straightHigh(values) {
  const present = new Set(values);
  if (present.has(14)) present.add(1);
  for (let high = 14; high >= 5; high--) {
    if ([0, 1, 2, 3, 4].every(offset => present.has(high - offset))) return high;
  }
  return 0;
}

export function evaluateFive(cards) {
  if (cards.length !== 5) throw new Error('必须使用五张牌评估牌型');
  const ranks = cards.map(rank);
  const flush = cards.every(card => suit(card) === suit(cards[0]));
  const straight = straightHigh(ranks);
  const counts = new Map();
  for (const value of ranks) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts].map(([value, count]) => [count, value])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  if (flush && straight) return [8, straight];
  if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
  if (groups[0][0] === 3 && groups[1][0] === 2) return [6, groups[0][1], groups[1][1]];
  if (flush) return [5, ...ranks.sort((a, b) => b - a)];
  if (straight) return [4, straight];
  if (groups[0][0] === 3) return [3, groups[0][1], ...groups.slice(1).map(x => x[1]).sort((a, b) => b - a)];
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    return [2, Math.max(groups[0][1], groups[1][1]), Math.min(groups[0][1], groups[1][1]), groups[2][1]];
  }
  if (groups[0][0] === 2) return [1, groups[0][1], ...groups.slice(1).map(x => x[1]).sort((a, b) => b - a)];
  return [0, ...ranks.sort((a, b) => b - a)];
}

export function compareValues(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

export function evaluateBest(cards) {
  if (cards.length < 5 || cards.length > 7) return null;
  let best = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const value = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareValues(value, best) > 0) best = value;
          }
  return best;
}

// Compact public wording for a completed five-card-or-better hand.
// The category is the evaluator's strength category (0–8), not a style guess.
export function describeHandValue(value) {
  if (!value) return null;
  const rank = number => number === 10 ? '10' : number === 14 ? 'A' :
    number === 13 ? 'K' : number === 12 ? 'Q' : number === 11 ? 'J' : String(number);
  const straight = high => `${high === 5 ? 'A' : rank(high - 4)}-${rank(high)}`;
  let label;
  switch (value[0]) {
    case 0: label = `${rank(value[1])}高牌`; break;
    case 1: label = `一对${rank(value[1])}`; break;
    case 2: label = `两对${rank(value[1])},${rank(value[2])}`; break;
    case 3: label = `三条${rank(value[1])}`; break;
    case 4: label = `${straight(value[1])}顺子`; break;
    case 5: label = '同花'; break;
    case 6: label = '葫芦'; break;
    case 7: label = `炸弹${rank(value[1])}`; break;
    case 8: label = '同花顺'; break;
    default: throw new Error('未知牌型类别');
  }
  return { label, category: value[0] };
}

// Every hand uses a fresh UTC timestamp plus 256 bits from the operating system.
// HMAC expands the seed; rejection sampling removes modulo bias at each swap.
export function makeFairDeck(utc = new Date().toISOString(), entropy = randomBytes(32)) {
  const seed = createHash('sha256').update('holdem-v1\0').update(utc).update(entropy).digest();
  let counter = 0;
  const randomInt = max => {
    const ceiling = 0x100000000 - (0x100000000 % max);
    for (;;) {
      const input = Buffer.alloc(8);
      input.writeBigUInt64BE(BigInt(counter++));
      const value = createHmac('sha256', seed).update(input).digest().readUInt32BE(0);
      if (value < ceiling) return value % max;
    }
  };
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const salts = deck.map(() => randomBytes(16).toString('hex'));
  const leaves = deck.map((card, index) => sha256(`holdem-card-v1:${index}:${cardLabel(card)}:${salts[index]}`));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const layer = levels.at(-1), next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(sha256(Buffer.from(layer[i] + (layer[i + 1] ?? layer[i]), 'hex')));
    }
    levels.push(next);
  }
  return {
    utc, seed: seed.toString('hex'), seedCommitment: sha256(seed),
    deck, salts, deckRoot: levels.at(-1)[0]
  };
}

export function cardProof(fair, position) {
  const card = fair.deck[position], salt = fair.salts[position];
  if (!Number.isInteger(card) || !salt) throw new Error('无效的牌序位置');
  let index = position;
  let layer = fair.deck.map((value, i) => sha256(`holdem-card-v1:${i}:${cardLabel(value)}:${fair.salts[i]}`));
  const proof = [];
  while (layer.length > 1) {
    const sibling = index ^ 1;
    proof.push({ side: index % 2 === 0 ? 'right' : 'left', hash: layer[sibling] ?? layer[index] });
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256(Buffer.from(layer[i] + (layer[i + 1] ?? layer[i]), 'hex')));
    index = Math.floor(index / 2);
    layer = next;
  }
  return { position, card: cardLabel(card), salt, proof };
}

export function verifyCardProof(root, item) {
  let hash = sha256(`holdem-card-v1:${item.position}:${item.card}:${item.salt}`);
  for (const step of item.proof) {
    hash = sha256(Buffer.from(step.side === 'left' ? step.hash + hash : hash + step.hash, 'hex'));
  }
  return hash === root;
}
