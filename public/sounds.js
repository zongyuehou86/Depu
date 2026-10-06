/* Short table cues from same-origin samples, with local synthesis as a fallback. */
(() => {
  'use strict';

  const Context = window.AudioContext || window.webkitAudioContext;
  const AVAILABLE = typeof Context === 'function';
  const ENABLED_KEY = 'poker-sound-enabled';
  const VOLUME_KEY = 'poker-sound-volume';
  const KINDS = new Set(['deal', 'flip', 'check', 'fold', 'call', 'raise', 'allin',
    'turn', 'warning', 'win', 'show', 'gift']);
  const SAMPLE_FILES = Object.freeze({
    deal: '/audio/pokernow/card-place.mp3', flip: '/audio/pokernow/card-place.mp3',
    show: '/audio/pokernow/card-place.mp3', check: '/audio/pokernow/two-taps.mp3',
    fold: '/audio/pokernow/fold.mp3', call: '/audio/pokernow/chips.mp3',
    raise: '/audio/pokernow/chips.mp3', allin: '/audio/pokernow/chips.mp3',
    turn: '/audio/pokernow/beep.mp3', warning: '/audio/pokernow/warning-beep.mp3',
    win: '/audio/pokernow/winner.mp3', gift: '/audio/pokernow/chat-beep.mp3'
  });
  const SAMPLE_URLS = [...new Set(Object.values(SAMPLE_FILES))];
  const MAX_ACTIVE_CUES = 6;
  const MAX_PENDING_CUES = 24;
  const MAX_DELAY_MS = 3_000;
  const MAX_CUE_SECONDS = 3;
  const SAMPLE_FALLBACK_MS = 800;
  const RESUME_TIMEOUT_MS = 1_200;
  const RECOVERY_CUE_MS = 1_200;
  const CRITICAL_RECOVERY_CUE_MS = 1_800;
  const APPLE_MOBILE = (() => {
    try {
      const agent = navigator.userAgent || '';
      return /iPhone|iPad|iPod/.test(agent) ||
        (/Macintosh/.test(agent) && Number(navigator.maxTouchPoints) > 1);
    } catch { return false; }
  })();

  let enabled = true;
  let volume = 0.45;
  try {
    enabled = localStorage.getItem(ENABLED_KEY) !== 'false';
    const stored = localStorage.getItem(VOLUME_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) volume = parsed;
  } catch { /* Private browsing can deny storage. */ }

  let context = null;
  let master = null;
  let masterConnected = false;
  let noiseBuffer = null;
  const rawSamples = new Map();
  const decodedSamples = new Map();
  const sampleControllers = new Set();
  const resumeAttempts = new Set();
  let recoveryCue = null;
  let recoveryTimer = null;
  let sampleFallbackTimer = null;
  let originalSessionType = null;
  let sessionManaged = false;
  let sessionRecoveryTimer = null;
  let gesturePrime = null;
  let gesturePrimedContext = null;
  let wasHidden = false;
  let disposed = false;
  const pending = new Set();
  const active = new Set();

  function getSettings() {
    return { enabled, volume, available: AVAILABLE && !disposed,
      ready: Boolean(context && context.state === 'running' && !sessionRecoveryTimer && !disposed) };
  }

  function announceSettings() {
    try {
      document.dispatchEvent(new CustomEvent('poker-sound-settings-change',
        { detail: getSettings() }));
    } catch { /* Audio and settings remain usable in limited DOM environments. */ }
  }

  function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* In-memory setting still works. */ }
  }

  function makeNoiseBuffer(audio) {
    const length = Math.ceil(audio.sampleRate * 0.5);
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = buffer.getChannelData(0);
    // Audio texture only. This has no connection to the poker dealer's RNG.
    let seed = 0x6ac3d9e1;
    for (let index = 0; index < length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[index] = (seed / 0x80000000 - 1) * 0.8;
    }
    return buffer;
  }

  function rawSample(url) {
    if (rawSamples.has(url)) return rawSamples.get(url);
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) sampleControllers.add(controller);
    const options = { cache: 'default', ...(controller ? { signal: controller.signal } : {}) };
    let assetUrl = url;
    try { assetUrl = JSON.parse(document.getElementById?.('public-asset-versions')?.textContent || '{}')[url] || url; } catch { /* Optional asset manifest. */ }
    const request = Promise.resolve().then(() => fetch(assetUrl, options))
      .then(response => response?.ok ? response.arrayBuffer() : null, () => null)
      .catch(() => null)
      .finally(() => { if (controller) sampleControllers.delete(controller); });
    rawSamples.set(url, request);
    return request;
  }

  function preloadSampleBytes() {
    if (!enabled || volume === 0 || disposed) return;
    for (const url of SAMPLE_URLS) void rawSample(url);
  }

  function decodeSample(audio, bytes) {
    if (!bytes || typeof audio.decodeAudioData !== 'function') return Promise.resolve(null);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value || null); } };
      try {
        // Callbacks retain support for older WebKit; modern browsers return a Promise.
        const result = audio.decodeAudioData(bytes.slice(0), finish, () => finish(null));
        if (result?.then) result.then(finish, () => finish(null));
      } catch { finish(null); }
    });
  }

  function ensureSample(url) {
    const existing = decodedSamples.get(url);
    if (existing) return existing;
    const state = { status: 'loading', buffer: null };
    decodedSamples.set(url, state);
    if (typeof fetch !== 'function' || !context) {
      state.status = 'failed';
      return state;
    }
    const audio = context;
    state.promise = rawSample(url).then(bytes => decodeSample(audio, bytes)).then(buffer => {
      if (decodedSamples.get(url) !== state || disposed || audio !== context) return;
      state.buffer = buffer;
      state.status = buffer ? 'ready' : 'failed';
      flushRecoveryCue();
    }, () => {
      if (decodedSamples.get(url) !== state || disposed || audio !== context) return;
      state.status = 'failed';
      flushRecoveryCue();
    });
    return state;
  }

  function mobileAudioSession() {
    if (!APPLE_MOBILE) return null;
    try { return navigator.audioSession || null; }
    catch { return null; }
  }

  function ensurePlaybackSession() {
    if (!enabled || volume === 0 || disposed || sessionRecoveryTimer) return;
    const session = mobileAudioSession();
    if (!session) return;
    try {
      const previous = session.type;
      if (previous !== 'playback') session.type = 'playback';
      if (!sessionManaged) {
        originalSessionType = previous;
        sessionManaged = true;
      }
    } catch { /* Browsers without a writable AudioSession still use Web Audio. */ }
  }

  function releasePlaybackSession() {
    const wasRecovering = Boolean(sessionRecoveryTimer);
    clearTimeout(sessionRecoveryTimer);
    sessionRecoveryTimer = null;
    if (!sessionManaged) return;
    const session = mobileAudioSession();
    try {
      if (originalSessionType && (session?.type === 'playback' ||
          (wasRecovering && session?.type === 'ambient')) && session.type !== originalSessionType) {
        session.type = originalSessionType;
      }
    } catch { /* The page can still mute its own Web Audio graph. */ }
    originalSessionType = null;
    sessionManaged = false;
  }

  function refreshPlaybackSessionAfterForeground() {
    if (!enabled || volume === 0 || disposed || !context || !sessionManaged) return;
    const session = mobileAudioSession();
    if (!session) return;
    try {
      // iOS can leave a running AudioContext attached to an inaudible ambient
      // route after the tab returns. A real type change refreshes that route.
      if (session.type !== 'playback') {
        ensurePlaybackSession();
        return;
      }
      session.type = 'ambient';
    } catch { return; }
    clearTimeout(sessionRecoveryTimer);
    sessionRecoveryTimer = setTimeout(() => {
      sessionRecoveryTimer = null;
      ensurePlaybackSession();
      flushRecoveryCue();
      announceSettings();
    }, 0);
    announceSettings();
  }

  function ensureContext() {
    if (!AVAILABLE || disposed) return false;
    ensurePlaybackSession();
    if (context?.state === 'closed') {
      clearGesturePrime();
      gesturePrimedContext = null;
      try {
        context.removeEventListener?.('statechange', onContextStateChange);
        if (context.onstatechange === onContextStateChange) context.onstatechange = null;
      } catch { /* Closed already. */ }
      for (const group of [...active]) endCue(group);
      try { master?.disconnect(); } catch { /* Closed already. */ }
      context = null;
      master = null;
      noiseBuffer = null;
      decodedSamples.clear();
      masterConnected = false;
      resumeAttempts.clear();
    }
    if (context) return true;
    try {
      context = new Context();
      master = context.createGain();
      master.gain.value = volume;
      noiseBuffer = makeNoiseBuffer(context);
      master.connect(context.destination);
      masterConnected = true;
      if (typeof context.addEventListener === 'function') {
        context.addEventListener('statechange', onContextStateChange);
      } else context.onstatechange = onContextStateChange;
      preloadSampleBytes();
      for (const url of SAMPLE_URLS) ensureSample(url);
      return true;
    } catch {
      try { void context?.close?.(); } catch { /* Retry on the next gesture. */ }
      context = null;
      master = null;
      noiseBuffer = null;
      masterConnected = false;
      return false;
    }
  }

  function clearGesturePrime() {
    const source = gesturePrime;
    if (!source) return;
    gesturePrime = null;
    source.onended = null;
    try { source.stop(); } catch { /* A one-frame source may have ended. */ }
    try { source.disconnect(); } catch { /* Already detached. */ }
  }

  function primeContextOnGesture() {
    if (!APPLE_MOBILE || !context || gesturePrimedContext === context ||
        (gesturePrime && context.state === 'running')) return;
    clearGesturePrime();
    const audio = context;
    let source;
    try {
      // PokerNow's bundled Howler starts one silent sample during a real touch
      // before resuming Web Audio. This is a one-shot unlock, never a loop.
      source = audio.createBufferSource();
      source.buffer = audio.createBuffer(1, 1, 22_050);
      source.connect(audio.destination);
      gesturePrime = source;
      source.onended = () => {
        if (gesturePrime !== source) return;
        gesturePrime = null;
        gesturePrimedContext = audio;
        try { source.disconnect(); } catch { /* Already detached. */ }
      };
      source.start(0);
    } catch {
      if (gesturePrime === source) gesturePrime = null;
      try { source?.disconnect(); } catch { /* resume() still has a chance. */ }
    }
  }

  function clearRecoveryCue() {
    clearTimeout(recoveryTimer);
    clearTimeout(sampleFallbackTimer);
    recoveryTimer = null;
    sampleFallbackTimer = null;
    recoveryCue = null;
  }

  function flushRecoveryCue() {
    if (!recoveryCue || sessionRecoveryTimer || context?.state !== 'running') return;
    if (ensureSample(SAMPLE_FILES[recoveryCue.kind]).status === 'loading' &&
        Date.now() < recoveryCue.sampleFallbackAt) {
      // Timers can run just before the wall-clock deadline. Keep the fallback
      // scheduled rather than leaving a hung optional download silent forever.
      clearTimeout(sampleFallbackTimer);
      sampleFallbackTimer = setTimeout(flushRecoveryCue, Math.max(1, recoveryCue.sampleFallbackAt - Date.now()));
      return;
    }
    const saved = recoveryCue;
    clearRecoveryCue();
    if (!enabled || volume === 0 || disposed || Date.now() > saved.expiresAt ||
        (document.hidden && !((saved.kind === 'turn' || saved.kind === 'warning') && saved.allowHidden))) return;
    const delay = Math.max(0, saved.dueAt - Date.now());
    for (let index = 0; index < saved.count; index++) {
      scheduleCue(saved.kind, delay + index * 90, saved.allowHidden);
    }
  }

  function onContextStateChange() {
    announceSettings();
    if (context?.state === 'running') flushRecoveryCue();
  }

  function unlock(forceGestureRetry = false) {
    if (!enabled || volume === 0 || disposed || !AVAILABLE) return Promise.resolve(false);
    ensurePlaybackSession();
    if (!ensureContext()) {
      announceSettings();
      return Promise.resolve(false);
    }
    if (forceGestureRetry) primeContextOnGesture();
    if (context.state === 'running') {
      flushRecoveryCue();
      return Promise.resolve(true);
    }
    const existing = [...resumeAttempts].at(-1);
    if (existing && (!forceGestureRetry || resumeAttempts.size >= 2)) return existing;
    const audio = context;
    let resumeResult;
    // resume() must be called in the user gesture's synchronous stack on iOS.
    try { resumeResult = audio.resume(); }
    catch {
      announceSettings();
      return Promise.resolve(false);
    }
    let timeout;
    const attempt = Promise.race([
      Promise.resolve(resumeResult).then(() => audio === context && audio.state === 'running', () => false),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), RESUME_TIMEOUT_MS); })
    ]).then(ready => {
      if (ready) flushRecoveryCue();
      announceSettings();
      return ready;
    }).finally(() => {
      clearTimeout(timeout);
      resumeAttempts.delete(attempt);
    });
    resumeAttempts.add(attempt);
    return attempt;
  }

  function setEnabled(value) {
    if (typeof value !== 'boolean' || disposed) return getSettings();
    if (enabled === value) return getSettings();
    enabled = value;
    save(ENABLED_KEY, enabled);
    if (!enabled) stop();
    if (!enabled) releasePlaybackSession();
    else {
      preloadSampleBytes();
      void unlock(true); // A settings click is usually a valid mobile gesture.
    }
    announceSettings();
    return getSettings();
  }

  function setVolume(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || disposed) return getSettings();
    const next = Math.min(1, Math.max(0, number));
    if (volume === next) return getSettings();
    volume = next;
    save(VOLUME_KEY, volume);
    if (master && context) {
      if (typeof master.gain.setTargetAtTime === 'function') {
        master.gain.setTargetAtTime(volume, context.currentTime, 0.012);
      } else master.gain.value = volume;
    }
    if (volume === 0) {
      stop();
      releasePlaybackSession();
    }
    else {
      preloadSampleBytes();
      if (context?.state !== 'running') void unlock(true);
    }
    announceSettings();
    return getSettings();
  }

  function connectMaster() {
    if (!masterConnected && master && context) {
      master.connect(context.destination);
      masterConnected = true;
    }
  }

  function envelope(group, at, duration, peak, attack = 0.003) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    gain.connect(master);
    group.nodes.push(gain);
    return gain;
  }

  function tone(group, at, frequency, duration, peak, options = {}) {
    const oscillator = context.createOscillator();
    oscillator.type = options.type || 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    if (options.to) oscillator.frequency.exponentialRampToValueAtTime(options.to, at + duration);
    oscillator.connect(envelope(group, at, duration, peak, options.attack ?? 0.003));
    group.sources.push(oscillator);
    group.nodes.push(oscillator);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.005);
  }

  function noise(group, at, duration, peak, options = {}) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = options.type || 'bandpass';
    filter.frequency.setValueAtTime(options.frequency || 1_800, at);
    if (options.to) filter.frequency.exponentialRampToValueAtTime(options.to, at + duration);
    filter.Q.value = options.q ?? 0.7;
    source.connect(filter);
    filter.connect(envelope(group, at, duration, peak, options.attack ?? 0.002));
    group.sources.push(source);
    group.nodes.push(source, filter);
    source.start(at, 0);
    source.stop(at + duration + 0.005);
  }

  function card(group, at, strength = 1, length = 0.1) {
    noise(group, at, length, 0.115 * strength,
      { type: 'bandpass', frequency: 1_350, to: 2_850, q: 0.5, attack: 0.004 });
    tone(group, at + 0.012, 220, 0.025, 0.025 * strength, { to: 130 });
  }

  function tap(group, at, strength = 1) {
    tone(group, at, 245, 0.055, 0.085 * strength, { to: 115, type: 'triangle' });
    noise(group, at, 0.032, 0.045 * strength,
      { frequency: 1_450, to: 900, q: 0.8 });
  }

  function chip(group, at, strength = 1) {
    tone(group, at, 1_300, 0.044, 0.038 * strength, { to: 800, type: 'triangle' });
    noise(group, at, 0.05, 0.058 * strength,
      { type: 'highpass', frequency: 2_600, to: 1_500, q: 0.7 });
  }

  function sampledCue(group, kind, at) {
    const buffer = decodedSamples.get(SAMPLE_FILES[kind])?.buffer;
    if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) return null;
    const duration = Math.min(buffer.duration, MAX_CUE_SECONDS);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    group.sources.push(source);
    group.nodes.push(source);
    source.start(at);
    source.stop(at + duration);
    return duration;
  }

  function cue(group, kind, at) {
    switch (kind) {
      case 'deal': card(group, at, 0.8, 0.105); return 0.12;
      case 'flip': card(group, at, 1, 0.052); tap(group, at + 0.027, 0.42); return 0.11;
      case 'check': tap(group, at, 0.7); tap(group, at + 0.085, 0.62); return 0.17;
      case 'fold': card(group, at, 0.8, 0.14); tap(group, at + 0.12, 0.3); return 0.19;
      case 'call': chip(group, at, 0.9); chip(group, at + 0.045, 0.7); return 0.11;
      case 'raise':
        for (const [index, strength] of [0.7, 0.8, 0.9, 0.7].entries()) chip(group, at + index * 0.043, strength);
        return 0.19;
      case 'allin':
        for (const [index, strength] of [0.9, 1, 0.8, 1, 0.85, 0.7].entries()) chip(group, at + index * 0.055, strength);
        tap(group, at + 0.085, 0.7); tap(group, at + 0.26, 0.8);
        return 0.38;
      case 'turn':
        tone(group, at, 523.25, 0.11, 0.085);
        tone(group, at + 0.11, 659.25, 0.16, 0.075);
        return 0.29;
      case 'warning':
        tone(group, at, 182, 0.12, 0.105, { to: 165, type: 'triangle' });
        tone(group, at + 0.16, 170, 0.12, 0.09, { to: 145, type: 'triangle' });
        return 0.3;
      case 'win':
        tone(group, at, 392, 0.23, 0.06);
        tone(group, at + 0.015, 493.88, 0.23, 0.057);
        tone(group, at + 0.03, 587.33, 0.27, 0.052);
        return 0.32;
      case 'show':
        card(group, at, 0.75, 0.065);
        card(group, at + 0.075, 0.75, 0.065);
        tone(group, at + 0.125, 783.99, 0.085, 0.028);
        return 0.23;
      case 'gift':
        tone(group, at, 783.99, 0.11, 0.038);
        tone(group, at + 0.09, 1_046.5, 0.16, 0.032);
        return 0.27;
      default: return 0;
    }
  }

  function endCue(group) {
    if (!active.has(group)) return;
    active.delete(group);
    clearTimeout(group.cleanup);
    for (const source of group.sources) {
      try { source.stop(); } catch { /* It may have already ended. */ }
    }
    for (const node of group.nodes) {
      try { node.disconnect(); } catch { /* Already detached. */ }
    }
  }

  function fire(kind, allowHidden = false) {
    if (!enabled || volume === 0 || disposed || sessionRecoveryTimer || context?.state !== 'running' ||
        (document.hidden && !((kind === 'turn' || kind === 'warning') && allowHidden))) return false;
    ensurePlaybackSession();
    if (active.size >= MAX_ACTIVE_CUES) endCue(active.values().next().value);
    connectMaster();
    const group = { sources: [], nodes: [], cleanup: null };
    active.add(group);
    try {
      const at = context.currentTime + 0.008;
      const duration = Math.min(MAX_CUE_SECONDS, sampledCue(group, kind, at) ?? cue(group, kind, at));
      group.cleanup = setTimeout(() => endCue(group), Math.ceil((duration + 0.08) * 1_000));
      return true;
    } catch {
      endCue(group);
      return false;
    }
  }

  function scheduleCue(kind, delay, allowHidden) {
    if (!delay) return fire(kind, allowHidden);
    if (pending.size >= MAX_PENDING_CUES) {
      const oldest = pending.values().next().value;
      clearTimeout(oldest);
      pending.delete(oldest);
    }
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (!fire(kind, allowHidden) && (sessionRecoveryTimer || context?.state !== 'running')) {
        // A mobile browser may interrupt audio between queuing and this cue.
        // This is still the current cue, so give it the same short resume window.
        play(kind, { allowHidden });
      }
    }, delay);
    pending.add(timer);
    return true;
  }

  function play(kind, options = {}) {
    const allowHidden = options?.allowHidden === true;
    if (!KINDS.has(kind) || !enabled || volume === 0 || disposed || !AVAILABLE ||
        (document.hidden && !((kind === 'turn' || kind === 'warning') && allowHidden))) return false;
    ensurePlaybackSession();
    const delay = Number(options?.delay);
    const bounded = Number.isFinite(delay) ? Math.min(MAX_DELAY_MS, Math.max(0, delay)) : 0;
    const count = kind === 'flip' && Number.isInteger(options?.count)
      ? Math.min(3, Math.max(1, options.count)) : 1;
    if (!ensureContext()) return false;
    const loading = ensureSample(SAMPLE_FILES[kind]).status === 'loading';
    if (sessionRecoveryTimer || context?.state !== 'running' || loading) {
      // Hold only the newest current cue for a brief resume window. A later hand
      // or reconnect cannot replay a history after unlock or sample decoding.
      clearRecoveryCue();
      const now = Date.now();
      const freshness = kind === 'turn' || kind === 'warning'
        ? CRITICAL_RECOVERY_CUE_MS : RECOVERY_CUE_MS;
      const expiresAt = now + Math.min(2_500, bounded + freshness);
      recoveryCue = { kind, count, allowHidden, dueAt: now + bounded, expiresAt,
        sampleFallbackAt: loading ? now + SAMPLE_FALLBACK_MS : Infinity };
      recoveryTimer = setTimeout(clearRecoveryCue, expiresAt - now);
      if (loading) sampleFallbackTimer = setTimeout(flushRecoveryCue, SAMPLE_FALLBACK_MS);
      if (!sessionRecoveryTimer && context?.state !== 'running') void unlock();
      return true;
    }
    let accepted = false;
    for (let index = 0; index < count; index++) {
      accepted = scheduleCue(kind, bounded + index * 90, allowHidden) || accepted;
    }
    return accepted;
  }

  function stop() {
    clearRecoveryCue();
    clearGesturePrime();
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
    for (const group of [...active]) endCue(group);
    if (masterConnected) {
      try { master.disconnect(); } catch { /* Already disconnected. */ }
      masterConnected = false;
    }
  }

  function onGesture(event) {
    // WebKit recognizes touchend/click/keydown as activation; creating a
    // context on pointerdown can happen before iOS considers the tap valid.
    if (APPLE_MOBILE && event?.type === 'pointerdown') return;
    if (enabled && volume > 0 && (!context || context.state !== 'running' ||
        (APPLE_MOBILE && gesturePrimedContext !== context))) void unlock(true);
  }

  function onVisibility() {
    if (document.hidden) {
      wasHidden = true;
      // A hidden page may still receive a live turn or deadline update. Keep
      // its short, explicitly allowed cues; fire() filters other cue kinds.
      // The browser can still suspend the page or AudioContext independently.
    } else {
      if (wasHidden) refreshPlaybackSessionAfterForeground();
      wasHidden = false;
      if (enabled && volume > 0 && context && context.state !== 'running') void unlock();
    }
  }

  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
    releasePlaybackSession();
    document.removeEventListener('pointerdown', onGesture, true);
    document.removeEventListener('touchend', onGesture, true);
    document.removeEventListener('click', onGesture, true);
    document.removeEventListener('keydown', onGesture, true);
    document.removeEventListener('visibilitychange', onVisibility);
    try {
      context?.removeEventListener?.('statechange', onContextStateChange);
      if (context?.onstatechange === onContextStateChange) context.onstatechange = null;
    } catch { /* Closing. */ }
    try { void context?.close?.(); } catch { /* Browser is shutting down. */ }
    for (const controller of sampleControllers) controller.abort();
    sampleControllers.clear();
    rawSamples.clear();
    decodedSamples.clear();
    context = null;
    master = null;
    noiseBuffer = null;
    announceSettings();
  }

  // Optional sounds begin on a real user gesture instead of every page refresh.
  document.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  document.addEventListener('touchend', onGesture, { capture: true, passive: true });
  document.addEventListener('click', onGesture, true);
  document.addEventListener('keydown', onGesture, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.PokerSounds = Object.freeze({ getSettings, setEnabled, setVolume, unlock,
    play, stop, reset: stop, dispose });
})();
