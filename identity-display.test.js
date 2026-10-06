import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLegacyPlayerIds, displayRecord } from './identity-display.js';

const originalMembers = [
  { id: 'a', nickname: 'Ann' },
  { id: 'b', nickname: 'Ann #2' },
  { id: 'c', nickname: 'A.*[x]$' },
  { id: 'd', nickname: '牌🦊友' }
];
const currentMembers = originalMembers.map((member, index) => ({ ...member, nickname: ['新昵称', '新昵称', 'C+$', '🃏'][index] }));

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test('projects nested winner, runout, shown-hand, action and financial labels without mutation', () => {
  const input = freezeDeep({
    handNo: 42,
    result: {
      pot: 3001,
      winners: [{ playerId: 'a', nickname: 'Ann', amount: 2001, totalCommit: 1234, netProfit: 767 }],
      runouts: [{ boardIndex: 1, pots: [{ amount: 1000, eligibleSeats: [0, 1], winners: [
        { playerId: 'b', nickname: 'Ann #2', amount: 1000, seat: 1 }
      ] }] }]
    },
    shownHands: [{ playerId: 'c', nickname: 'A.*[x]$', cards: ['As', 'Kh'] }],
    fairness: { actions: [{ playerId: 'd', nickname: '牌🦊友', amount: 77, target: 144, at: '2026-10-05T00:00:00Z' }] },
    settlements: [{ gifts: [{ senderId: 'a', sender: 'Ann', recipientId: 'b', recipient: 'Ann #2', amount: 50 }],
      manualRebuys: [{ playerId: 'c', nickname: 'A.*[x]$', amount: 2000 }],
      autoRebuys: [{ playerId: 'd', nickname: '牌🦊友', amount: 4000, count: 2 }] }],
    effects: [{ sender: { playerId: 'a', nickname: 'Ann' }, recipient: { playerId: 'd', nickname: '牌🦊友' }, cost: 100 }]
  });
  const before = JSON.stringify(input), output = displayRecord(input, currentMembers);
  assert.equal(output.result.winners[0].nickname, '新昵称');
  assert.equal(output.result.runouts[0].pots[0].winners[0].nickname, '新昵称');
  assert.equal(output.shownHands[0].nickname, 'C+$');
  assert.equal(output.fairness.actions[0].nickname, '🃏');
  assert.equal(output.settlements[0].gifts[0].sender, '新昵称');
  assert.equal(output.settlements[0].gifts[0].recipient, '新昵称');
  assert.equal(output.effects[0].recipient.nickname, '🃏');
  assert.equal(JSON.stringify(input), before);
  // Restoring just the projected labels must recover the exact original data.
  assert.deepEqual(displayRecord(output, originalMembers), input);
  assert.notEqual(output, input);
  assert.notEqual(output.result.winners, input.result.winners);
});

test('legacy labels bind exact unique names only, independent of seat and name substrings', () => {
  const input = freezeDeep({ winners: [
    { nickname: 'Ann', seat: 8, amount: 100 }, { nickname: 'Ann #2', seat: 8, amount: 101 },
    { nickname: 'A.*[x]$', amount: 102 }, { nickname: '牌🦊友', amount: 103 },
    { nickname: 'ann' }, { nickname: ' Ann' }, { nickname: 'Annette' }
  ], gift: { sender: 'Ann', recipient: 'Ann #2', amount: 12 },
  effect: { sender: { nickname: '牌🦊友' } } });
  const migrated = attachLegacyPlayerIds(input, originalMembers);
  assert.deepEqual(migrated.winners.map(item => item.playerId), ['a', 'b', 'c', 'd', undefined, undefined, undefined]);
  assert.equal(migrated.gift.senderId, 'a');
  assert.equal(migrated.gift.recipientId, 'b');
  assert.equal(migrated.effect.sender.playerId, 'd');
  assert.equal(input.winners[0].playerId, undefined);
  assert.equal(displayRecord(migrated, currentMembers).winners[1].nickname, '新昵称');
  assert.deepEqual(attachLegacyPlayerIds(migrated, originalMembers), migrated);
});

test('ambiguous legacy duplicate names are never assigned or merged, but current duplicate names work by ID', () => {
  const members = [{ id: 'a', nickname: 'Same' }, { id: 'b', nickname: 'Same' }];
  const input = { winners: [{ nickname: 'Same' }], gift: { sender: 'Same', recipient: 'Same' },
    events: [{ text: 'Same 过牌' }] };
  assert.deepEqual(attachLegacyPlayerIds(input, members), input);
  const known = [{ playerId: 'a', nickname: 'Old A' }, { playerId: 'b', nickname: 'Old B' }];
  assert.deepEqual(displayRecord(known, members), [
    { playerId: 'a', nickname: 'Same' }, { playerId: 'b', nickname: 'Same' }
  ]);
});

test('existing identities are authoritative and display never guesses from a nickname', () => {
  const input = { records: [
    { playerId: 'b', nickname: 'Ann' }, { playerId: 'missing', nickname: 'Ann' },
    { nickname: 'Ann' }, { playerId: 'a', nickname: null }, { playerId: 'a', amount: 10 }
  ], gift: { senderId: 'missing', sender: 'Ann', recipientId: 'b', recipient: 'Ann' } };
  const migrated = attachLegacyPlayerIds(input, originalMembers);
  assert.equal(migrated.records[0].playerId, 'b');
  assert.equal(migrated.records[1].playerId, 'missing');
  assert.equal(migrated.gift.senderId, 'missing');
  assert.equal(migrated.gift.recipientId, 'b');
  const output = displayRecord(input, currentMembers);
  assert.equal(output.records[0].nickname, '新昵称');
  assert.equal(output.records[1].nickname, 'Ann');
  assert.equal(output.records[2].nickname, 'Ann');
  assert.equal(output.records[3].nickname, null);
  assert.equal(Object.hasOwn(output.records[4], 'nickname'), false);
});

test('legacy generated event shapes support suffixes, regex characters and emoji without replacing unrelated text', () => {
  const events = originalMembers.flatMap(member => [
    { text: `${member.nickname} 跟注 321，全下`, amount: 321 },
    { text: `${member.nickname}接受发两次` },
    { text: `${member.nickname}拒绝发两次` },
    { text: `第 12 手开始；${member.nickname} 持按钮，小盲 10，大盲 20` },
    { text: `等待领先方 ${member.nickname} 接受或拒绝发两次` }
  ]);
  const before = structuredClone(events), migrated = attachLegacyPlayerIds(events, originalMembers);
  for (let i = 0; i < migrated.length; i++) {
    const member = originalMembers[Math.floor(i / 5)], ref = migrated[i].nameRefs[0];
    assert.equal(ref.playerId, member.id);
    assert.equal(migrated[i].text.slice(ref.start, ref.end), member.nickname);
  }
  const rendered = displayRecord(migrated, currentMembers);
  for (let i = 0; i < rendered.length; i++) {
    const member = currentMembers[Math.floor(i / 5)], ref = rendered[i].nameRefs[0];
    assert.equal(rendered[i].text.slice(ref.start, ref.end), member.nickname);
    assert.equal(rendered[i].amount, events[i].amount);
  }
  assert.deepEqual(events, before);
  assert.deepEqual(displayRecord(rendered, currentMembers), rendered);
  assert.deepEqual(displayRecord(rendered, originalMembers), migrated);
});

test('legacy event migration leaves free text, uncertain prefixes and duplicate candidates untouched', () => {
  const members = [...originalMembers, { id: 'e', nickname: 'Ann 设置' }];
  const events = [
    { text: '评论中出现 Ann 和 Ann #2' }, { text: 'Ann 的备注 123' },
    { text: 'Ann 设置 设置牌桌' }, { text: '第 1 手开始；Ann 持按钮后说了一句话' },
    { text: '等待领先方 Ann 接受或拒绝发两次之后' }, { text: 'Annette 过牌' },
    { text: 'A.*[x]$ is arbitrary text' }
  ];
  assert.deepEqual(attachLegacyPlayerIds(events, members), events);
  const duplicates = [...originalMembers, { id: 'duplicate-b', nickname: 'Ann #2' }];
  assert.deepEqual(attachLegacyPlayerIds({ text: 'Ann #2 过牌' }, duplicates), { text: 'Ann #2 过牌' });
});

test('legacy migration never overwrites explicit references, even empty or malformed references', () => {
  for (const nameRefs of [[], null, 'invalid', [{ playerId: 'b', start: 0, end: 3 }]]) {
    const event = { text: 'Ann 过牌', nameRefs };
    assert.deepEqual(attachLegacyPlayerIds(event, originalMembers), event);
  }
});

test('event references replace only explicit spans and preserve literal occurrences of names', () => {
  const text = '牌🦊友 → Ann / 牌🦊友；Ann 金额 2000';
  const firstEnd = '牌🦊友'.length, secondStart = text.indexOf('Ann');
  const event = freezeDeep({ id: 17, text, amount: 2000, at: '2026-10-05',
    nameRefs: [{ playerId: 'a', start: secondStart, end: secondStart + 3, role: 'recipient' },
      { playerId: 'd', start: 0, end: firstEnd }] });
  const output = displayRecord(event, currentMembers);
  assert.equal(output.text, '🃏 → 新昵称 / 牌🦊友；Ann 金额 2000');
  assert.equal(output.nameRefs[0].role, 'recipient');
  assert.equal(output.text.slice(output.nameRefs[0].start, output.nameRefs[0].end), '新昵称');
  assert.equal(output.text.slice(output.nameRefs[1].start, output.nameRefs[1].end), '🃏');
  assert.equal(output.amount, event.amount);
  assert.equal(output.id, event.id);
  assert.equal(output.at, event.at);
  assert.equal(event.text, text);
  assert.deepEqual(displayRecord(output, currentMembers), output);
});

test('multiple references to one ID and unresolved IDs remain positionally correct after length changes', () => {
  const event = { text: 'Ann/未知/Ann', nameRefs: [
    { playerId: 'a', start: 0, end: 3 }, { playerId: 'missing', start: 4, end: 6 },
    { playerId: 'a', start: 7, end: 10 }
  ] };
  const output = displayRecord(event, [{ id: 'a', nickname: '🦊long' }]);
  assert.equal(output.text, '🦊long/未知/🦊long');
  assert.deepEqual(output.nameRefs.map(ref => output.text.slice(ref.start, ref.end)), ['🦊long', '未知', '🦊long']);
});

test('invalid, overlapping or surrogate-splitting spans preserve the entire event', () => {
  const text = 'Ann 牌🦊友';
  const good = { playerId: 'a', start: 0, end: 3 };
  const invalid = [null, {}, { ...good, start: -1 }, { ...good, start: 0.5 },
    { ...good, end: text.length + 1 }, { ...good, end: 0 }, { ...good, end: Infinity },
    { ...good, playerId: null }, { playerId: 'd', start: 6, end: 8 }];
  for (const ref of invalid) {
    const event = { text, nameRefs: [good, ref] };
    assert.deepEqual(displayRecord(event, currentMembers), event);
  }
  for (const nameRefs of [[good, { ...good }], [good, { playerId: 'b', start: 2, end: 4 }], {}, null, []]) {
    const event = { text, nameRefs };
    assert.deepEqual(displayRecord(event, currentMembers), event);
  }
});

test('array, member Map, token-keyed Map and id-keyed object inputs resolve the same players', () => {
  const record = { playerId: 'a', nickname: 'Old', text: 'Ann 过牌' };
  const collections = [originalMembers, new Map(originalMembers.map(member => [member.id, member])),
    new Map(originalMembers.map(member => [`token-${member.id}`, member])),
    Object.fromEntries(originalMembers.map(member => [member.id, { nickname: member.nickname }]))];
  for (const members of collections) {
    assert.equal(displayRecord(record, members).nickname, 'Ann');
    assert.equal(attachLegacyPlayerIds({ nickname: 'Ann' }, members).playerId, 'a');
    assert.equal(attachLegacyPlayerIds(record, members).nameRefs[0].playerId, 'a');
  }
});

test('missing or inconsistent member data never manufactures a name or ID', () => {
  const record = { playerId: 'a', nickname: 'Ann', text: 'Ann 过牌' };
  for (const members of [undefined, null, [], {}, [{ id: 'a' }], [{ nickname: 'Ann' }],
    [{ id: 'a', nickname: 'Ann' }, { id: 'a', nickname: 'Different' }]]) {
    assert.deepEqual(displayRecord(record, members), record);
    assert.deepEqual(attachLegacyPlayerIds({ nickname: 'Ann' }, members), { nickname: 'Ann' });
  }
});

test('cloning preserves primitive values and shared record structure', () => {
  for (const value of [null, undefined, 1, 'Ann', false]) {
    assert.equal(displayRecord(value, currentMembers), value);
    assert.equal(attachLegacyPlayerIds(value, originalMembers), value);
  }
  const event = { text: 'Ann 过牌', nameRefs: [{ playerId: 'a', start: 0, end: 3 }] };
  const output = displayRecord({ event, events: [event] }, [{ id: 'a', nickname: 'Longer Ann' }]);
  assert.equal(output.event, output.events[0]);
  assert.equal(output.event.text, 'Longer Ann 过牌');
  assert.notEqual(output.event, event);
});
