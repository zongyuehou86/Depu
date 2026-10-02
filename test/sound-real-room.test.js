import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Room } from '../room.js';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sound-events.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window });
const { createPlanner, actionCue } = window.PokerSoundEvents;
const kinds = cues => Array.from(cues, cue => cue.kind);

function liveRoom() {
  const room = new Room('839172', 4);
  const alice = room.join('Check & Rose');
  const bob = room.join('Bob');
  const spectator = room.join('Observer');
  room.command(alice.token, { type: 'sit', seat: 0, buyIn: 2000 });
  room.command(bob.token, { type: 'sit', seat: 1, buyIn: 2000 });
  room.command(alice.token, { type: 'nextHand' });
  return { room, alice, bob, spectator };
}

test('real Room public event text produces raise, call, flop, check, fold and win sounds', () => {
  const { room, alice, bob, spectator } = liveRoom();
  const planner = createPlanner();
  const observe = () => {
    const state = room.stateFor(spectator.token);
    return kinds(planner.observe(state, { now: state.serverTime }));
  };
  assert.deepEqual(observe(), [], 'joining a live table does not replay prior blind and deal events');
  room.command(alice.token, { type: 'action', action: 'raise', amount: 200 });
  assert.deepEqual(observe(), ['raise']);
  room.command(bob.token, { type: 'action', action: 'call' });
  assert.deepEqual(observe(), ['call', 'flip'], 'real public flop and call arrive in one update');
  assert.deepEqual(observe(), [], 'a second WS or polling state cannot replay either sound');
  room.command(bob.token, { type: 'action', action: 'check' });
  assert.deepEqual(observe(), ['check']);
  room.command(alice.token, { type: 'action', action: 'raise', amount: 100 });
  assert.deepEqual(observe(), ['raise']);
  room.command(bob.token, { type: 'action', action: 'fold' });
  assert.deepEqual(observe(), ['fold', 'win']);
});

test('real Room all-in and multiword nickname match production action parser', () => {
  const { room, alice, spectator } = liveRoom();
  const planner = createPlanner();
  let state = room.stateFor(spectator.token);
  planner.baseline(state);
  room.command(alice.token, { type: 'action', action: 'raise', amount: 2000 });
  state = room.stateFor(spectator.token);
  const accepted = state.events.at(-1);
  assert.equal(accepted.text, 'Check & Rose 加注至 2000，全下');
  assert.equal(actionCue(accepted, state), 'allin');
  assert.deepEqual(kinds(planner.observe(state, { now: state.serverTime })), ['allin']);
});
