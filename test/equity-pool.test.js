import test from 'node:test';
import assert from 'node:assert/strict';
import { EquityPool } from '../equity-pool.js';
import { calculateShowdownEquity } from '../room.js';

const players = Array.from({ length: 10 }, (_, seat) => ({ seat, hole: [seat * 2, seat * 2 + 1] }));

test('ten-player equity runs off the event loop and matches the synchronous public-card calculation', async t => {
  const pool = new EquityPool();
  t.after(() => pool.close());
  const expected = calculateShowdownEquity(players, []);
  const result = pool.calculate({ players, board: [] });
  let settled = false;
  result.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(settled, false, 'main-loop timer runs before the worker finishes');
  assert.deepEqual(await result, expected);
});

test('an uncloneable input rejects immediately without blocking the next room', async t => {
  const pool = new EquityPool();
  t.after(() => pool.close());
  await assert.rejects(pool.calculate({ players, board: [], invalid: () => {} }), /clone/);
  assert.equal((await pool.calculate({ players, board: [20, 21, 22, 23, 24] })).scenarios, 1);
});

test('worker errors do not prevent the next room from obtaining its equity', async t => {
  const pool = new EquityPool();
  t.after(() => pool.close());
  const invalid = pool.calculate({ players, board: [0] });
  const valid = pool.calculate({ players, board: [20, 21, 22, 23, 24] });
  await assert.rejects(invalid, /合法公共牌/);
  assert.equal((await valid).scenarios, 1);
});

test('a timed-out worker rejects its job and a new worker processes subsequent jobs', async t => {
  const pool = new EquityPool({ timeoutMs: 1 });
  t.after(() => pool.close());
  await assert.rejects(pool.calculate({ players, board: [] }), /timed out/);
  pool.timeoutMs = 30_000;
  assert.equal((await pool.calculate({ players, board: [20, 21, 22, 23, 24] })).scenarios, 1);
});
