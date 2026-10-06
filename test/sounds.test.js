import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/sounds.js'), 'utf8');

function soundHarness({ stored = {}, storageThrows = false, denyContext = false, audioAvailable = true,
  resumeModes = [], mobileApple = false, sessionType = null, sessionThrows = false,
  sampleMode = null, fetchDelayMs = 0, timerAPI = null, clock = null } = {}) {
  const calls = { started: [], stopped: [], stopTimes: [], disconnected: [], ramps: [], writes: [], events: [], resumeAttempts: 0,
    sessionTypes: [], fetched: [], decoded: [] };
  const listeners = new Map();
  const document = {
    hidden: false,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    dispatchEvent(event) { calls.events.push(event); }
  };
  const localStorage = {
    getItem(key) { if (storageThrows) throw new Error('storage denied'); return stored[key] ?? null; },
    setItem(key, value) { if (storageThrows) throw new Error('storage denied'); calls.writes.push([key, value]); }
  };
  class Param {
    constructor() { this.value = 0; }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.value = value; }
    setTargetAtTime(value) { this.value = value; calls.ramps.push(value); }
  }
  class Node {
    constructor(kind) { this.kind = kind; this.frequency = new Param(); this.gain = new Param(); this.Q = new Param(); }
    connect() { return this; }
    disconnect() { calls.disconnected.push(this); }
    start(at) { calls.started.push({ node: this, at }); }
    stop(at) { calls.stopped.push(this); calls.stopTimes.push({ node: this, at }); }
  }
  class AudioContext {
    static instances = [];
    constructor() {
      if (denyContext) throw new Error('AudioContext denied');
      this.state = 'suspended';
      this.currentTime = 10;
      this.sampleRate = 48_000;
      this.destination = new Node('destination');
      AudioContext.instances.push(this);
    }
    createGain() { return new Node('gain'); }
    createOscillator() { return new Node('oscillator'); }
    createBufferSource() { return new Node('bufferSource'); }
    createBiquadFilter() { return new Node('filter'); }
    createBuffer(_channels, length, sampleRate) {
      return { length, sampleRate, getChannelData() { return new Float32Array(length); } };
    }
    decodeAudioData(bytes) {
      const url = Buffer.from(bytes).toString('utf8');
      calls.decoded.push(url);
      if (sampleMode === 'decode-fail') return Promise.reject(new Error('decode failed'));
      return Promise.resolve({ url, duration: url.includes('winner') ? 2.377 :
        url.includes('card-place') ? 0.810 : 0.6 });
    }
    async resume() {
      calls.resumeAttempts++;
      const mode = resumeModes.shift() ?? 'resolve';
      if (mode === 'hang') await new Promise(() => {});
      if (mode === 'reject') throw new Error('Audio resume denied');
      this.state = 'running';
    }
    async close() { this.state = 'closed'; }
  }
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  const audioSession = sessionType === null ? undefined : {
    currentType: sessionType,
    get type() { return this.currentType; },
    set type(value) {
      if (sessionThrows) throw new Error('AudioSession denied');
      this.currentType = value;
      calls.sessionTypes.push(value);
    }
  };
  const navigator = { userAgent: mobileApple ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)',
    maxTouchPoints: mobileApple ? 5 : 0, ...(audioSession ? { audioSession } : {}) };
  const window = audioAvailable ? { AudioContext } : {};
  const sampleFetch = sampleMode === null ? undefined : async url => {
    calls.fetched.push(url);
    if (sampleMode === 'hang') return new Promise(() => {});
    if (fetchDelayMs) await new Promise(resolve => setTimeout(resolve, fetchDelayMs));
    return { ok: sampleMode !== 'missing',
      arrayBuffer: async () => Uint8Array.from(Buffer.from(url, 'utf8')).buffer };
  };
  vm.runInNewContext(source, { window, document, navigator, localStorage, CustomEvent,
    setTimeout, clearTimeout, ...(timerAPI || {}), ...(clock ? { Date: clock } : {}), ...(sampleFetch ? { fetch: sampleFetch } : {}) },
    { filename: 'public/sounds.js' });
  return { sound: window.PokerSounds, calls, document, listeners, contexts: AudioContext.instances, navigator,
    audioSession };
}

test('iPhone configures an audible playback session and refreshes it after returning to the tab',
  { timeout: 1500 }, async () => {
    const { sound, calls, document, listeners, contexts, audioSession } = soundHarness({ mobileApple: true,
      sessionType: 'ambient' });
    assert.equal(audioSession.type, 'ambient');
    assert.equal(await sound.unlock(), true);
    assert.equal(audioSession.type, 'playback',
      'running AudioContext alone can remain inaudible under the iPhone Ring/Silent switch');
    audioSession.currentType = 'ambient';
    assert.equal(sound.play('deal'), true);
    assert.equal(audioSession.type, 'playback',
      'a later cue repairs an externally reset audio session even while AudioContext is running');
    document.hidden = true;
    listeners.get('visibilitychange')();
    document.hidden = false;
    listeners.get('visibilitychange')();
    const beforeReturnCue = calls.started.length;
    assert.equal(sound.play('check'), true);
    assert.equal(calls.started.length, beforeReturnCue,
      'a cue during the session route refresh should wait for playback routing');
    contexts[0].onstatechange();
    assert.equal(sound.getSettings().ready, false,
      'a running context is not yet ready while the audible route is switching');
    assert.equal(calls.started.length, beforeReturnCue,
      'a statechange before the session timer must not fire the cue into ambient routing');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls.sessionTypes.slice(-2), ['ambient', 'playback'],
      'foreground recovery must force a changed session type before playback');
    assert.ok(calls.started.length > beforeReturnCue,
      'the fresh cue should play after the audible route has returned');
    assert.equal(sound.getSettings().ready, true);
    assert.equal(calls.events.at(-1).detail.ready, true,
      'the UI receives a ready update after the session route has recovered');
    sound.setEnabled(false);
    assert.equal(audioSession.type, 'ambient', 'muting releases the playback session');
    sound.dispose();
  });

test('unsupported or denied AudioSession leaves Web Audio usable, and desktop audio is untouched',
  async () => {
    const denied = soundHarness({ mobileApple: true, sessionType: 'ambient', sessionThrows: true });
    assert.equal(await denied.sound.unlock(), true);
    assert.equal(denied.sound.play('deal'), true);
    denied.sound.dispose();
    const desktop = soundHarness({ sessionType: 'ambient' });
    assert.equal(await desktop.sound.unlock(), true);
    assert.equal(desktop.audioSession.type, 'ambient');
    assert.deepEqual(desktop.calls.sessionTypes, []);
    desktop.sound.dispose();
  });

test('iOS waits for a WebKit user-activated touchend or click before creating AudioContext', async () => {
  const { sound, calls, contexts, listeners } = soundHarness({ mobileApple: true, sessionType: 'ambient' });
  listeners.get('pointerdown')({ type: 'pointerdown' });
  assert.equal(contexts.length, 0, 'pointerdown alone is not reliable WebKit activation');
  listeners.get('touchend')({ type: 'touchend' });
  const primes = calls.started.filter(({ node }) => node.buffer?.length === 1);
  assert.equal(primes.length, 1, 'a real iOS gesture starts one silent unlock frame');
  assert.equal(primes[0].node.buffer.sampleRate, 22_050);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].sampleRate, 48_000,
    'the current context and decoded samples are preserved; no 44.1 kHz reset');
  assert.equal(calls.resumeAttempts, 1);
  assert.equal(sound.getSettings().ready, true);
  primes[0].node.onended();
  listeners.get('click')({ type: 'click' });
  assert.equal(calls.started.filter(({ node }) => node.buffer?.length === 1).length, 1,
    'the matching click must not start an endless or repeated unlock sound');
  sound.dispose();
});

test('muting during an iOS route refresh restores the original audio session type', async () => {
  const { sound, document, listeners, audioSession } = soundHarness({ mobileApple: true,
    sessionType: 'auto' });
  await sound.unlock();
  document.hidden = true;
  listeners.get('visibilitychange')();
  document.hidden = false;
  listeners.get('visibilitychange')();
  assert.equal(audioSession.type, 'ambient', 'route refresh has a brief ambient phase');
  sound.setEnabled(false);
  assert.equal(audioSession.type, 'auto');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(audioSession.type, 'auto', 'canceled refresh must not re-enable playback');
  sound.dispose();
});

test('the real WebAudio cues start only after unlock and obey volume, mute, visibility and stop',
  { timeout: 3000 }, async () => {
    const { sound, calls, document, contexts, listeners } = soundHarness();
    assert.equal(contexts.length, 0, 'loading the page must not create or resume an AudioContext');
    assert.equal(sound.play('deal'), true, 'a fresh pre-unlock cue waits briefly for audio to resume');
    assert.equal(calls.started.length, 0, 'the cue cannot start while AudioContext is suspended');
    assert.equal(await sound.unlock(), true);
    assert.equal(contexts.length, 1);
    assert.equal(sound.getSettings().ready, true);
    assert.ok(calls.started.length > 0, 'the original cue plays after a prompt resume');
    assert.equal(sound.play('deal'), true);
    assert.ok(calls.started.length > 0, 'a supported cue must start audio sources');
    const afterDeal = calls.started.length;
    assert.equal(sound.play('not-a-cue'), false);
    assert.equal(calls.started.length, afterDeal);

    document.hidden = true;
    assert.equal(sound.play('flip'), false);
    assert.equal(sound.play('turn', { allowHidden: true }), true);
    assert.ok(calls.started.length > afterDeal, 'turn cue may sound in a hidden tab');
    assert.equal(sound.play('warning', { allowHidden: true }), true);
    assert.equal(sound.play('gift', { allowHidden: true }), false);
    document.hidden = false;
    const afterTurn = calls.started.length;

    assert.equal(sound.play('win', { delay: 90 }), true);
    sound.stop();
    assert.ok(calls.stopped.length > 0 && calls.disconnected.length > 0,
      'stop must release active sources and nodes');
    await new Promise(resolve => setTimeout(resolve, 130));
    assert.equal(calls.started.length, afterTurn, 'stop must cancel delayed cues');
    sound.setVolume(0);
    assert.equal(sound.play('raise'), false);
    assert.equal(calls.started.length, afterTurn);
    sound.setVolume(0.6);
    assert.equal(sound.play('check'), true);
    assert.ok(calls.started.length > afterTurn);
    assert.ok(calls.ramps.includes(0.6), 'volume changes must reach the master gain');
    sound.setEnabled(false);
    const afterMute = calls.started.length;
    assert.equal(sound.play('allin'), false);
    assert.equal(calls.started.length, afterMute);
    assert.ok(calls.writes.some(([key, value]) => key === 'poker-sound-enabled' && value === 'false'));
    assert.ok(calls.writes.some(([key, value]) => key === 'poker-sound-volume' && value === '0'));
    sound.dispose();
    assert.equal(sound.getSettings().available, false);
    assert.equal(sound.play('deal'), false);
    assert.equal(listeners.has('pointerdown'), false);
    assert.equal(listeners.has('touchend'), false);
    assert.equal(listeners.has('click'), false);
    assert.equal(listeners.has('keydown'), false);
    assert.equal(contexts[0].state, 'closed');
  });

test('hiding the page keeps a current turn and warning cue instead of stopping its audio graph',
  { timeout: 1500 }, async () => {
    const { sound, calls, document, listeners } = soundHarness();
    await sound.unlock();
    const before = calls.started.length;
    assert.equal(sound.play('turn', { delay: 50, allowHidden: true }), true);
    const stoppedBeforeHide = calls.stopped.length;
    document.hidden = true;
    listeners.get('visibilitychange')();
    assert.equal(calls.stopped.length, stoppedBeforeHide,
      'visibility alone must not cancel an already queued own-turn alert');
    await new Promise(resolve => setTimeout(resolve, 85));
    assert.ok(calls.started.length > before, 'the queued turn cue starts while hidden if the browser runs it');
    const afterTurn = calls.started.length;
    assert.equal(sound.play('warning', { allowHidden: true }), true);
    assert.ok(calls.started.length > afterTurn, 'the deadline warning remains eligible while hidden');
    assert.equal(sound.play('deal'), false, 'ordinary table sounds still stay silent while hidden');
    sound.dispose();
  });

test('an interrupted hidden context may resume one fresh warning without replaying old table sounds',
  { timeout: 1500 }, async () => {
    const { sound, calls, contexts, document, listeners } = soundHarness();
    await sound.unlock();
    const before = calls.started.length;
    document.hidden = true;
    listeners.get('visibilitychange')();
    contexts[0].state = 'interrupted';
    assert.equal(sound.play('warning', { allowHidden: true }), true);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.ok(calls.started.length > before,
      'a browser that permits background resume can play the current warning');
    const afterWarning = calls.started.length;
    assert.equal(sound.play('raise'), false);
    assert.equal(calls.started.length, afterWarning);
    sound.dispose();
  });

test('denied storage and AudioContext cannot crash the page or retain a queued sound', async () => {
  const denied = soundHarness({ storageThrows: true, denyContext: true });
  assert.equal(await denied.sound.unlock(), false);
  assert.equal(denied.sound.play('deal'), false);
  assert.equal(denied.calls.started.length, 0);
  denied.sound.setEnabled(false);
  denied.sound.setVolume(0);
  denied.sound.reset();
  denied.sound.dispose();

  const unavailable = soundHarness({ audioAvailable: false });
  assert.equal(unavailable.sound.getSettings().available, false);
  assert.equal(await unavailable.sound.unlock(), false);
  assert.equal(unavailable.sound.play('deal'), false);
  const muted = soundHarness({ stored: { 'poker-sound-enabled': 'false', 'poker-sound-volume': '0.25' } });
  assert.equal(muted.sound.getSettings().enabled, false);
  assert.equal(muted.sound.getSettings().volume, 0.25);
  assert.equal(muted.contexts.length, 0);
  assert.equal(muted.sound.play('gift'), false);
});

test('a three-card flop actually produces three separated flip sounds',
  { timeout: 2000 }, async () => {
    const { sound, calls } = soundHarness();
    await sound.unlock();
    sound.play('flip');
    const sourcesPerCard = calls.started.length;
    assert.ok(sourcesPerCard > 0);
    sound.stop();
    const beforeFlop = calls.started.length;
    assert.equal(sound.play('flip', { count: 3 }), true);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(calls.started.length - beforeFlop, sourcesPerCard * 3);
  sound.stop();
});

test('a current cue survives suspended and interrupted contexts, and a visible tab retries resume',
  { timeout: 3000 }, async () => {
    const { sound, calls, contexts, document, listeners } = soundHarness();
    await sound.unlock();
    const audio = contexts[0];
    sound.play('check');
    const sourcesPerCheck = calls.started.length;
    assert.ok(sourcesPerCheck > 0);
    sound.stop();
    for (const state of ['suspended', 'interrupted']) {
      const before = calls.started.length;
      audio.state = state;
      assert.equal(sound.play('check'), true);
      assert.equal(calls.started.length, before, `${state} cannot start a source yet`);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls.started.length - before, sourcesPerCheck,
        `${state} should play the fresh cue exactly once after resuming`);
      sound.stop();
    }
    audio.state = 'suspended';
    document.hidden = true;
    listeners.get('visibilitychange')();
    const beforeResume = calls.resumeAttempts;
    document.hidden = false;
    listeners.get('visibilitychange')();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(calls.resumeAttempts > beforeResume, 'becoming visible retries a suspended context');
    assert.equal(sound.getSettings().ready, true);
    sound.dispose();
  });

test('a hung resume times out so the next gesture can retry without replaying stale audio',
  { timeout: 3500 }, async () => {
    const { sound, calls, listeners } = soundHarness({ resumeModes: ['hang', 'resolve'] });
    const first = sound.unlock();
    assert.equal(calls.resumeAttempts, 1);
    assert.equal(await first, false, 'one hung browser Promise must not block forever');
    assert.equal(sound.getSettings().ready, false);
    listeners.get('touchend')();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.resumeAttempts, 2, 'a later mobile gesture gets a fresh resume attempt');
    assert.equal(sound.getSettings().ready, true);
    assert.equal(calls.started.length, 0, 'a timed-out unlock cannot replay an old table sound');
    sound.dispose();
  });

test('a second touch can recover one fresh cue while the first resume Promise still hangs',
  { timeout: 3000 }, async () => {
    const { sound, calls, listeners } = soundHarness({ resumeModes: ['hang', 'resolve'] });
    assert.equal(sound.play('deal'), true);
    assert.equal(calls.resumeAttempts, 1);
    assert.equal(calls.started.length, 0);
    await new Promise(resolve => setTimeout(resolve, 85));
    listeners.get('touchend')();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.resumeAttempts, 2, 'touch retries before the first resume timeout');
    assert.equal(sound.getSettings().ready, true);
    assert.ok(calls.started.length > 0, 'the fresh cue should sound after the second gesture');
    const playedOnce = calls.started.length;
    listeners.get('click')();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.started.length, playedOnce, 'touchend plus click cannot duplicate a cue');
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(calls.started.length, playedOnce, 'the first hung attempt timing out cannot replay it');
    sound.dispose();
  });

test('a delayed cue interrupted at fire time survives a later gesture exactly once',
  { timeout: 3000 }, async () => {
    const { sound, calls, contexts, listeners } = soundHarness();
    await sound.unlock();
    sound.play('raise');
    const sourcesPerRaise = calls.started.length;
    assert.ok(sourcesPerRaise > 0);
    sound.stop();
    const audio = contexts[0];
    let resumeAttempts = 0;
    audio.resume = () => {
      resumeAttempts++;
      if (resumeAttempts === 1) return new Promise(() => {});
      audio.state = 'running';
      return Promise.resolve();
    };
    assert.equal(sound.play('raise', { delay: 40 }), true);
    audio.state = 'interrupted';
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(calls.started.length, sourcesPerRaise, 'the delayed cue cannot fire into interruption');
    assert.equal(resumeAttempts, 1, 'the delayed fire tries to restore audio');
    listeners.get('touchend')();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(resumeAttempts, 2);
    assert.equal(calls.started.length - sourcesPerRaise, sourcesPerRaise,
      'the current delayed cue fires once after audio resumes');
    listeners.get('click')();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(calls.started.length - sourcesPerRaise, sourcesPerRaise);
    sound.dispose();
  });

test('stop, mute, zero volume and dispose cancel cues waiting for a suspended context',
  { timeout: 3500 }, async () => {
    for (const cancel of ['stop', 'mute', 'zeroVolume', 'dispose']) {
      const { sound, calls, contexts } = soundHarness();
      await sound.unlock();
      const audio = contexts[0];
      audio.state = 'suspended';
      let release;
      audio.resume = () => new Promise(resolve => {
        release = () => { audio.state = 'running'; resolve(); };
      });
      const before = calls.started.length;
      assert.equal(sound.play('deal'), true);
      if (cancel === 'stop') sound.stop();
      if (cancel === 'mute') sound.setEnabled(false);
      if (cancel === 'zeroVolume') sound.setVolume(0);
      if (cancel === 'dispose') sound.dispose();
      release();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(calls.started.length, before, `${cancel} must cancel the pending sound`);
      sound.dispose();
    }
  });

test('same-origin MP3 samples preload once and play the mapped full-length buffers',
  { timeout: 1500 }, async () => {
    const { sound, calls } = soundHarness({ sampleMode: 'ok' });
    await sound.unlock();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.fetched.length, 8, 'shared cues use eight cached sample files');
    assert.equal(new Set(calls.fetched).size, 8);
    const expected = [
      ['deal', 'card-place.mp3', 1], ['flip', 'card-place.mp3', 1],
      ['show', 'card-place.mp3', 1], ['check', 'two-taps.mp3', 1],
      ['fold', 'fold.mp3', 1], ['call', 'chips.mp3', 1],
      ['raise', 'chips.mp3', 1], ['allin', 'chips.mp3', 1],
      ['turn', 'beep.mp3', 1], ['warning', 'warning-beep.mp3', 1],
      ['win', 'winner.mp3', 1], ['gift', 'chat-beep.mp3', 1]
    ];
    for (const [kind, filename, count] of expected) {
      const before = calls.started.length;
      assert.equal(sound.play(kind), true);
      const started = calls.started.slice(before);
      assert.equal(started.length, count, `${kind} should use only its decoded sample`);
      assert.ok(started.every(item => item.node.buffer?.url.endsWith(filename)), kind);
    }
    const winnerStart = calls.started.find(item => item.node.buffer?.url.endsWith('winner.mp3'));
    const winnerStop = calls.stopTimes.find(item => item.node === winnerStart.node);
    assert.ok(winnerStop.at - winnerStart.at >= 2.37,
      'the 2.377-second winner clip is not cut by the old 0.7-second cap');
    assert.equal(calls.fetched.length, 8, 'playback reuses decoded buffers without another request');
    sound.dispose();
  });

test('a loading sample plays only the latest fresh cue; stop and reset cancel any later decode replay',
  { timeout: 1500 }, async () => {
    const { sound, calls } = soundHarness({ sampleMode: 'ok', fetchDelayMs: 80 });
    await sound.unlock();
    assert.equal(sound.play('deal'), true);
    sound.stop();
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(calls.started.length, 0, 'stopped cue stays silent after its sample finishes loading');
    assert.equal(sound.play('deal'), true);
    assert.equal(calls.started.at(-1)?.node.buffer?.url.endsWith('card-place.mp3'), true);
    const before = calls.started.length;
    sound.reset();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.started.length, before);
    sound.dispose();
  });

test('missing or stalled MP3 files fall back to synthesis before a fresh cue expires',
  { timeout: 1800 }, async () => {
    const missing = soundHarness({ sampleMode: 'missing' });
    await missing.sound.unlock();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(missing.sound.play('deal'), true);
    assert.ok(missing.calls.started.length > 0);
    assert.ok(missing.calls.started.every(item => !item.node.buffer?.url));
    missing.sound.dispose();

    const stalled = soundHarness({ sampleMode: 'hang' });
    await stalled.sound.unlock();
    assert.equal(stalled.sound.play('deal'), true);
    await new Promise(resolve => setTimeout(resolve, 860));
    assert.ok(stalled.calls.started.length > 0,
      'a hung sample request must not leave an otherwise fresh cue silent');
    assert.ok(stalled.calls.started.every(item => !item.node.buffer?.url));
    stalled.sound.dispose();
  });

test('a slow first sample falls back once, then later cues use the completed MP3 cache',
  { timeout: 1800 }, async () => {
    const { sound, calls } = soundHarness({ sampleMode: 'ok', fetchDelayMs: 1000 });
    await sound.unlock();
    assert.equal(sound.play('deal'), true);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.ok(calls.started.length > 0);
    assert.ok(calls.started.every(item => !item.node.buffer?.url),
      'the first cue uses synthesis when its sample misses the freshness window');
    await new Promise(resolve => setTimeout(resolve, 190));
    const before = calls.started.length;
    assert.equal(sound.play('deal'), true);
    assert.equal(calls.started.slice(before).length, 1);
    assert.equal(calls.started.at(-1).node.buffer.url.endsWith('card-place.mp3'), true,
      'a later event uses the sample rather than remaining in fallback for the session');
    sound.dispose();
  });


test('an early fallback timer reschedules the remaining millisecond for a hung sample', async () => {
  let now = 1000, id = 0;
  const timers = new Map();
  const h = soundHarness({ sampleMode: 'hang', clock: { now: () => now }, timerAPI: {
    setTimeout(fn, delay) { timers.set(++id, {fn,delay}); return id; },
    clearTimeout(id) { timers.delete(id); }
  } });
  await h.sound.unlock();
  assert.equal(h.sound.play('deal'), true);
  const [fallbackId, fallback] = [...timers].find(([,timer]) => timer.delay === 800);
  timers.delete(fallbackId);
  now = 1799; fallback.fn();
  assert.equal(h.calls.started.length, 0, 'do not synthesize before the fallback deadline');
  const [nextId, next] = [...timers].find(([,timer]) => timer.delay === 1);
  assert.ok(next, 'early callback must retain a future fallback');
  timers.delete(nextId); now = 1800; next.fn();
  assert.ok(h.calls.started.length > 0, 'deadline callback synthesizes the fresh cue');
  h.sound.dispose();
  assert.equal(timers.size, 0, 'dispose clears the rescheduled timer and cue cleanup');
});
