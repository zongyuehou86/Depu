import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../room.js';
import { canonicalPhone } from '../phone-identity.js';

const phoneA = '+12025550101', phoneB = '+12025550102';
const snapshot = room => JSON.parse(JSON.stringify(room.toJSON()));

test('phone canonicalization normalizes explicit international and mainland aliases, rejects ambiguous input', () => {
  for (const value of ['+1 (202) 555-0101', '0012025550101', '＋１２０２５５５０１０１', phoneA]) assert.equal(canonicalPhone(value), phoneA);
  for (const value of ['13800000000', '+86 138-0000-0000', '008613800000000']) assert.equal(canonicalPhone(value), '+8613800000000');
  for (const value of [null, 12025550101, '', '2025550101', '+00012345678', '1e2025550101', '+1+2025550101', '+8612800000000', '+1234567', '+1234567890123456', 'sms:13800000000']) assert.throws(() => canonicalPhone(value));
});

test('same room phone preserves member, owner, stack and latest nickname; unchanged join is side-effect-free', () => {
  let writes = 0;
  const room = new Room('810101', 4, () => { writes++; });
  const a = room.joinPhone('Original', phoneA);
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 2000 });
  const version = room.stateVersion, count = writes, before = snapshot(room);
  for (let i = 0; i < 200; i++) assert.equal(room.joinPhone(' Ｏｒｉｇｉｎａｌ ', '0012025550101'), a);
  assert.equal(writes, count);
  assert.equal(room.stateVersion, version);
  assert.deepEqual(snapshot(room), before);
  const renamed = room.joinPhone('Newest', phoneA);
  assert.equal(renamed, a);
  assert.equal(room.members.size, 1);
  assert.equal(room.ownerToken, a.token);
  assert.equal(a.stack, 2000);
  assert.equal(a.seat, 0);
  assert.equal(room.stateFor(a.token).seats[0].nickname, 'Newest');
  assert.equal(writes, count + 1);
  assert.equal(room.stateFor(a.token).hero.needsPhone, false);
});

test('phones are room-scoped hashed lookups and never enter public/private records or bearer tokens', () => {
  const room = new Room('810102'), other = new Room('810103');
  const a = room.joinPhone('Alice', phoneA), b = room.joinPhone('Bob', phoneB);
  const otherA = other.joinPhone('Alice', phoneA);
  assert.notEqual(a.id, otherA.id);
  assert.notEqual(a.token, otherA.token);
  assert.notEqual(a.phoneKey, otherA.phoneKey);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(a.token, { type: 'nextHand' });
  room.command(room.seatMember(room.hand.actingSeat).token, { type: 'action', action: 'fold' });
  const publicText = JSON.stringify([room.stateFor(a.token), room.stateFor(b.token), room.historyFor(), room.ledger()]);
  for (const value of [phoneA, phoneB, a.phoneKey, b.phoneKey, room.phoneIdentity.key, a.token, b.token]) assert.equal(publicText.includes(value), false);
  const persisted = JSON.stringify(snapshot(room));
  for (const value of [phoneA, phoneB, '2025550101', '2025550102']) assert.equal(persisted.includes(value), false);
  const restored = Room.fromJSON(snapshot(room));
  assert.equal(restored.joinPhone('Alice again', phoneA).id, a.id);
  assert.equal(restored.joinPhone('Alice again', phoneA).token, a.token);
});

test('all public hand names resolve latest player ID without changing archived events or financial amounts', () => {
  const room = new Room('810104');
  const a = room.joinPhone('Old A', phoneA), b = room.joinPhone('Old B', phoneB);
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(a.token, { type: 'nextHand' });
  room.command(room.seatMember(room.hand.actingSeat).token, { type: 'action', action: 'fold' });
  const before = JSON.stringify([room.events, room.history, room.hand.actions]);
  const stack = a.stack, winner = room.history[0].result.winners[0];
  room.joinPhone('Current A', phoneA);
  room.joinPhone('Current B', phoneB);
  assert.equal(JSON.stringify([room.events, room.history, room.hand.actions]), before);
  const history = room.historyFor();
  assert.equal(history[0].result.winners[0].amount, winner.amount);
  assert.match(history[0].result.winners[0].nickname, /^Current /);
  assert.equal(JSON.stringify(history).includes('Old A'), false);
  assert.equal(JSON.stringify(history).includes('Old B'), false);
  assert.equal(a.stack, stack);
  const state = room.stateFor(a.token, { compact: true });
  assert.equal(Object.hasOwn(state, 'history'), false);
  assert.equal(state.historyTotal, 1);
  assert.equal(JSON.stringify(state.events).includes('Old A'), false);
});

test('legacy token claim preserves exact old identity; same nickname without possession never claims it', () => {
  const original = new Room('810105');
  const old = original.join('Legacy');
  original.command(old.token, { type: 'sit', seat: 2, buyIn: 2000 });
  const data = snapshot(original);
  delete data.phoneIdentity;
  delete data.displayIdentityVersion;
  const room = Room.fromJSON(data);
  assert.equal(room.stateFor(old.token).hero.needsPhone, true);
  const newcomer = room.joinPhone('Legacy', phoneB);
  assert.notEqual(newcomer.id, old.id);
  assert.equal(newcomer.stack, 0);
  const claimed = room.joinPhone('Newest', phoneA, old.token);
  assert.equal(claimed.id, old.id);
  assert.equal(claimed.seat, 2);
  assert.equal(claimed.stack, 2000);
  assert.equal(room.ownerToken, old.token);
  assert.equal(room.stateFor(old.token).events[0].text.startsWith('Newest '), true);
  assert.equal(room.joinPhone('Other browser', phoneA).id, old.id);
});

test('legacy phone collisions, invalid tokens and malformed indexes fail without merging or moving chips', () => {
  const room = new Room('810106');
  const legacy = room.join('Legacy'), bound = room.joinPhone('Bound', phoneA);
  const before = snapshot(room);
  assert.throws(() => room.joinPhone('Hijack', phoneA, legacy.token), error => error.errorCode === 'PHONE_IDENTITY_CONFLICT');
  assert.deepEqual(snapshot(room), before);
  assert.throws(() => room.joinPhone('Invalid', phoneA, 'bad-token'), error => error.status === 401);
  assert.equal(room.joinPhone('Bound renamed', phoneA, bound.token).id, bound.id);
  assert.notEqual(room.joinPhone('Different phone', phoneB, bound.token).id, bound.id);
  const duplicate = snapshot(room);
  duplicate.members[0].phoneKey = bound.phoneKey;
  assert.throws(() => Room.fromJSON(duplicate), /身份索引/);
  const lostKey = snapshot(room);
  delete lostKey.phoneIdentity;
  assert.throws(() => Room.fromJSON(lostKey), /身份索引/);
});

test('numeric or prefix-like nicknames do not rewrite hand numbers or narrative text', () => {
  const room = new Room('810107');
  const a = room.joinPhone('1', phoneA), b = room.joinPhone('等待领先方', phoneB);
  room.command(a.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(b.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(a.token, { type: 'nextHand' });
  const dealer = room.seatMember(room.hand.dealerSeat);
  const newName = 'New name';
  room.joinPhone(newName, dealer === a ? phoneA : phoneB);
  const event = room.stateFor(a.token).events.find(item => item.text.includes('持按钮'));
  assert.equal(event.text, `第 1 手开始；${newName} 持按钮，小盲 10，大盲 20`);
});
