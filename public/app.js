(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const i18n = window.PokerI18n;
  const t = (key, params = {}) => i18n.t(key, params);
  const hand = (value) => i18n.hand(value);
  const message = (value) => i18n.message(value);
  const chips = window.PokerChips;
  const sounds = window.PokerSounds;
  const soundPlanner = window.PokerSoundEvents?.createPlanner();
  const preactions = window.PokerPreactions.createController();
  const state = { roomCode: '', token: '', data: null, socket: null, retry: null, poll: null, timer: null, soundTurnTimer: null, soundResumeAt: 0, clockOffset: 0, session: 0, mode: 'create', pending: false, resumeCancelled: false, newRunoutCards: new Set(), seatDialogSeat: null, tableSettingsRoomCode: '', tableSettingsSeenId: 0 };
  const names = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌', waiting: '等待开局' };
  const suits = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const ranks = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
  const money = (value) => Math.round(Number(value) || 0).toLocaleString('en-US');
  const chipAmount = (value, data = state.data) => chips.format(value, data);
  const signed = (value, data = state.data) => `${Number(value) >= 0 ? '+' : '−'}${chipAmount(Math.abs(Number(value) || 0), data)}`;
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const details = window.PokerDetails?.createController({ request, getContext: () => state, t, message, safe, copyText });
  let toastTimer;
  const roomEffects = { seen: new Set(), queue: [], active: false, timer: null };
  const giftPicker = { open: false, recipientId: '', roseType: 'whiteRose', retries: new Map(), retryContext: '' };
  const giftEffects = { seen: new Set(), active: new Map(), frame: 0, preload: null };

  function syncSoundControls() {
    const settings = sounds?.getSettings?.() || { enabled: false, volume: 0, available: false };
    $('#sound-enabled').checked = Boolean(settings.enabled);
    $('#sound-enabled').disabled = !settings.available;
    $('#sound-volume').value = String(Math.round((Number(settings.volume) || 0) * 100));
    $('#sound-volume').disabled = !settings.available || !settings.enabled;
    $('#sound-volume-value').textContent = `${$('#sound-volume').value}%`;
    $('#sound-preview').disabled = !settings.available || !settings.enabled || Number(settings.volume) === 0;
    $('#sound-open').classList.toggle('is-muted', !settings.enabled || Number(settings.volume) === 0 || !settings.available);
    const status = $('#sound-status');
    if (status) status.textContent = !settings.available ? t('此浏览器不支持音效') : !settings.enabled ? t('已静音') :
      Number(settings.volume) === 0 ? t('音量为 0') : settings.ready ? t('声音已就绪') : t('点击试听启用声音');
  }

  function closeSoundPanel() {
    $('#sound-panel').hidden = true;
    $('#sound-open').setAttribute('aria-expanded', 'false');
  }

  function playSoundCues(cues) {
    if (!sounds || !Array.isArray(cues) || !cues.length) return;
    let delay = 0;
    for (const cue of cues) {
      if (cue.kind === 'turn') {
        clearTimeout(state.soundTurnTimer);
        const roomCode = state.roomCode;
        const session = state.session;
        const handNo = state.data?.handNo;
        const announceTurn = () => {
          state.soundTurnTimer = null;
          const hero = state.data?.hero;
          if (session === state.session && roomCode === state.roomCode && handNo === state.data?.handNo &&
              state.data?.status === 'playing' && !state.data?.pause &&
              (hero?.canAct || hero?.canChooseRunout || hero?.canRespondRunout)) {
            sounds.play('turn', { allowHidden: true });
          }
        };
        if (document.hidden) announceTurn();
        else state.soundTurnTimer = setTimeout(announceTurn, Math.max(delay, cue.delay || 0));
      } else {
        sounds.play(cue.kind, { delay, count: cue.count });
        delay += cue.kind === 'flip' && cue.count === 3 ? 300 : 130;
      }
    }
  }

  function showToast(message) {
    const element = $('#toast');
    element.textContent = i18n.message(message);
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 3300);
  }

  function fireworksHtml() {
    const bursts = [
      { x: 25, y: 31, color: '#ffd575' },
      { x: 72, y: 22, color: '#ff91a7' },
      { x: 52, y: 67, color: '#8bebd9' }
    ];
    return bursts.map((burst, burstIndex) => Array.from({ length: 12 }, (_, index) => {
      const angle = (index / 12) * Math.PI * 2;
      const distance = 56 + (index % 3) * 11;
      const dx = Math.round(Math.cos(angle) * distance);
      const dy = Math.round(Math.sin(angle) * distance);
      const delay = (burstIndex * 0.25 + (index % 4) * 0.07).toFixed(2);
      return `<i class="effect-spark" style="--cx:${burst.x}%;--cy:${burst.y}%;--dx:${dx}px;--dy:${dy}px;--spark-color:${burst.color};--spark-delay:${delay}s"></i>`;
    }).join('')).join('');
  }

  function pixelFaceHtml() {
    return `<svg class="effect-pixel-face" viewBox="0 0 32 32" role="img" aria-label="${safe(t('像素🥹表情'))}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4d382a" d="M10 2h12v2h4v3h3v4h2v12h-2v4h-4v3H7v-3H3v-4H1V11h2V7h3V4h4z"/>
      <path fill="#ffdc79" d="M10 4h12v2h4v3h2v3h1v10h-1v3h-3v3H7v-3H4v-3H3V12h1V9h2V6h4z"/>
      <rect x="6" y="19" width="4" height="3" fill="#f7a972"/><rect x="22" y="19" width="4" height="3" fill="#f7a972"/>
      <rect x="8" y="12" width="7" height="8" fill="#39415f"/><rect x="17" y="12" width="7" height="8" fill="#39415f"/>
      <rect x="9" y="13" width="3" height="4" fill="#fcffff"/><rect x="18" y="13" width="3" height="4" fill="#fcffff"/>
      <rect x="12" y="17" width="2" height="2" fill="#91e0ff"/><rect x="21" y="17" width="2" height="2" fill="#91e0ff"/>
      <rect x="10" y="20" width="3" height="3" fill="#5ec8f4"/><rect x="19" y="20" width="3" height="3" fill="#5ec8f4"/>
      <rect x="15" y="23" width="3" height="1" fill="#84534c"/><rect x="14" y="24" width="1" height="1" fill="#84534c"/><rect x="18" y="24" width="1" height="1" fill="#84534c"/>
      <rect x="2" y="23" width="4" height="3" fill="#f8ad91"/><rect x="26" y="23" width="4" height="3" fill="#f8ad91"/>
      <rect x="4" y="25" width="3" height="2" fill="#ffd1a9"/><rect x="25" y="25" width="3" height="2" fill="#ffd1a9"/>
    </svg>`;
  }

  function drawPixelWords(canvas, words) {
    const context = canvas?.getContext?.('2d');
    if (!context) {
      if (canvas) canvas.hidden = true;
      const fallback = canvas?.parentElement?.querySelector('.effect-pixel-fallback');
      if (fallback) fallback.hidden = false;
      return;
    }
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'miter';
    let size = 23;
    do {
      context.font = `900 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      size -= 1;
    } while (context.measureText(words).width > width - 12 && size > 13);
    context.lineWidth = 3;
    context.strokeStyle = '#322836';
    context.fillStyle = '#fff2cc';
    context.strokeText(words, width / 2, height / 2 + 1);
    context.fillText(words, width / 2, height / 2 + 1);
  }

  function playNextRoomEffect() {
    const effect = roomEffects.queue.shift();
    if (!effect) { roomEffects.active = false; return; }
    roomEffects.active = true;
    const overlay = $('#room-effect');
    overlay.className = `room-effect is-${effect.style}`;
    overlay.dataset.effectId = effect.id;
    overlay.hidden = false;
    if (effect.style === 'fireworks') {
      overlay.innerHTML = `<div class="effect-scene effect-fireworks"><div class="effect-fireworks-sparks" aria-hidden="true">${fireworksHtml()}</div><div class="effect-welcome" aria-hidden="true">${safe(t('欢迎可可姐'))}</div></div><span class="effect-accessible">${safe(t('欢迎可可姐'))}</span>`;
    } else {
      overlay.innerHTML = `<div class="effect-scene effect-pixel"><div class="effect-pixel-card" aria-hidden="true"><div class="effect-pixel-caption"><canvas class="effect-pixel-words" width="186" height="40"></canvas><span class="effect-pixel-fallback" hidden>${safe(t('收手吧Kelly'))}</span></div>${pixelFaceHtml()}</div></div><span class="effect-accessible">${safe(t('收手吧Kelly🥹'))}</span>`;
      drawPixelWords(overlay.querySelector('canvas'), t('收手吧Kelly'));
    }
    const duration = effect.style === 'fireworks' ? 5000 : 3000;
    roomEffects.timer = setTimeout(() => {
      overlay.hidden = true;
      overlay.innerHTML = '';
      delete overlay.dataset.effectId;
      roomEffects.timer = null;
      roomEffects.active = false;
      playNextRoomEffect();
    }, duration);
  }

  function queueRoomEffect(effect) {
    if (!state.roomCode || !effect || (effect.roomCode && effect.roomCode !== state.roomCode) || !['fireworks', 'pixel'].includes(effect.style) || !['join', 'sit', 'rebuy'].includes(effect.trigger)) return;
    const id = String(effect.id ?? '');
    if (!id || roomEffects.seen.has(id)) return;
    roomEffects.seen.add(id);
    if (roomEffects.seen.size > 128) roomEffects.seen.delete(roomEffects.seen.values().next().value);
    if (roomEffects.queue.length >= 10) roomEffects.queue.shift();
    roomEffects.queue.push({ id, style: effect.style });
    if (!roomEffects.active) playNextRoomEffect();
  }

  function clearRoomEffects() {
    clearTimeout(roomEffects.timer);
    roomEffects.timer = null;
    roomEffects.queue.length = 0;
    roomEffects.seen.clear();
    roomEffects.active = false;
    const overlay = $('#room-effect');
    overlay.hidden = true;
    overlay.innerHTML = '';
    delete overlay.dataset.effectId;
  }

  function closeGiftPicker(restoreFocus = true) {
    giftPicker.open = false;
    window.removeEventListener('resize', positionGiftPicker);
    window.removeEventListener('scroll', positionGiftPicker);
    $('#gift-panel').hidden = true;
    $('#gift-backdrop').hidden = true;
    $('#gift-open').setAttribute('aria-expanded', 'false');
    if (restoreFocus && !$('#room-screen').hidden) $('#gift-open').focus();
  }

  function closeSeatDialog() {
    state.seatDialogSeat = null;
    $('#seat-panel').hidden = true;
    $('#seat-backdrop').hidden = true;
  }

  function openSeatDialog(index) {
    if (!state.data || Number.isInteger(state.data.hero?.seat) || state.data.seats?.[index] || state.data.pause ||
        (Number.isInteger(state.data.pendingCapacity) && index >= state.data.pendingCapacity)) return;
    state.seatDialogSeat = index;
    renderSeatPanel(state.data);
    const buyInInput = $('#seat-buyin-input');
    const minimum = Math.max(2, Number(state.data.bigBlind) || 20);
    if (!Number.isSafeInteger(Number(buyInInput.value)) || Number(buyInInput.value) < minimum) buyInInput.value = String(Math.max(2000, minimum));
    buyInInput.focus();
  }

  function giftQuantity() {
    const raw = $('#gift-count').value.trim();
    if (!/^\d+$/.test(raw)) return NaN;
    const quantity = Number(raw);
    return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 20000 ? quantity : NaN;
  }

  function updateGiftPicker(data = state.data) {
    if (!data) return;
    const hero = data.hero || {};
    const seats = Array.isArray(data.seats) ? data.seats : [];
    const me = Number.isInteger(hero.seat) ? seats[hero.seat] : null;
    const recipients = seats.filter((seat) => seat && seat.playerId && seat.playerId !== hero.playerId);
    const select = $('#gift-recipient');
    const signature = recipients.map((seat) => `${seat.playerId}:${seat.nickname}:${seat.seat}`).join('|');
    if (select.dataset.signature !== signature) {
      const previous = giftPicker.recipientId || select.value;
      select.innerHTML = recipients.map((seat) => `<option value="${safe(seat.playerId)}">${safe(t('{name} · {seat} 号位', { name: seat.nickname, seat: seat.seat + 1 }))}</option>`).join('');
      if (recipients.some((seat) => seat.playerId === previous)) select.value = previous;
      giftPicker.recipientId = select.value;
      select.dataset.signature = signature;
    }
    const quantity = giftQuantity();
    const total = Number.isFinite(quantity) ? quantity * 50 : NaN;
    const paused = Boolean(data.pause);
    const valid = Number.isSafeInteger(total) && total >= 50 && total <= 1000000;
    $('#gift-total').textContent = valid ? t('{amount} 筹码', { amount: money(total) }) : '—';
    for (const button of document.querySelectorAll('[data-gift-count]')) button.setAttribute('aria-pressed', String(Number(button.dataset.giftCount) === quantity));
    for (const button of document.querySelectorAll('[data-rose-type]')) button.setAttribute('aria-pressed', String(button.dataset.roseType === giftPicker.roseType));
    let hint = '';
    if (!me) hint = t('入座后可送花；暗号可免费发送。');
    else if (!recipients.length) hint = t('等另一位玩家入座后即可送花。');
    else if (!valid) hint = t('请输入 1–20,000 束，合计最多 1,000,000 筹码。');
    else if (paused) hint = t('本房间礼物演出中，请稍后再送。');
    else hint = t(data.status === 'playing' ? '现在展示花束，手末统一结算；不足会按 2,000 筹码自动补足。' : '立即结算；不足会按 2,000 筹码自动补足。');
    $('#gift-hint').textContent = hint;
    $('#gift-open').disabled = paused;
    select.disabled = !recipients.length;
    $('#gift-count').disabled = !me;
    $('#gift-send-bouquet').disabled = !me || !recipients.length || !valid || paused || state.pending || state.recovering;
    $('#gift-send-sneak').disabled = paused || state.pending || state.recovering;
  }

  function positionGiftPicker() {
    if (!giftPicker.open || window.innerWidth <= 640) return;
    const anchor = $('#gift-open').getBoundingClientRect();
    const panel = $('#gift-panel');
    const { width, height } = panel.getBoundingClientRect();
    const inset = 12;
    const gap = 8;
    const left = Math.min(Math.max(inset, anchor.left), Math.max(inset, window.innerWidth - width - inset));
    const below = anchor.bottom + gap;
    const above = anchor.top - height - gap;
    const preferredTop = below + height <= window.innerHeight - inset ? below
      : above >= inset ? above
        : Math.min(Math.max(inset, below), Math.max(inset, window.innerHeight - height - inset));
    const top = Math.min(Math.max(inset, preferredTop), Math.max(inset, window.innerHeight - height - inset));
    panel.style.setProperty('--gift-left', `${Math.round(left)}px`);
    panel.style.setProperty('--gift-top', `${Math.round(top)}px`);
  }

  function openGiftPicker() {
    if (!state.data) return;
    updateGiftPicker(state.data);
    const panel = $('#gift-panel');
    giftPicker.open = true;
    panel.hidden = false;
    $('#gift-backdrop').hidden = false;
    $('#gift-open').setAttribute('aria-expanded', 'true');
    positionGiftPicker();
    window.addEventListener('resize', positionGiftPicker);
    window.addEventListener('scroll', positionGiftPicker, { passive: true });
    $('#gift-close').focus();
  }

  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function idempotentCommand(payload) {
    const context = state.roomCode && state.data?.hero?.playerId
      ? `poker-pending-money:${state.roomCode}:${state.data.hero.playerId}` : '';
    if (context !== giftPicker.retryContext) {
      giftPicker.retries.clear();
      giftPicker.retryContext = context;
      if (context) {
        try {
          const saved = JSON.parse(stored(context));
          if (Array.isArray(saved)) for (const [signature, id] of saved.slice(-20)) {
            if (typeof signature === 'string' && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) giftPicker.retries.set(signature, id);
          }
        } catch { /* Storage may be unavailable or from an older version. */ }
      }
    }
    const signature = JSON.stringify(payload);
    if (!giftPicker.retries.has(signature)) giftPicker.retries.set(signature, requestId());
    if (context) remember(context, JSON.stringify([...giftPicker.retries].slice(-20)));
    const ok = await command({ ...payload, requestId: giftPicker.retries.get(signature) });
    if (ok) {
      giftPicker.retries.delete(signature);
      if (context) remember(context, JSON.stringify([...giftPicker.retries].slice(-20)));
    }
    return ok;
  }

  const giftNow = () => Date.now() + state.clockOffset;
  const limit = (value, low, high) => Math.max(low, Math.min(high, value));

  function giftSeatPoint(person) {
    const seat = [...document.querySelectorAll('#opponent-seats [data-player-id], #my-seat[data-player-id]')]
      .find((node) => node.dataset.playerId === person?.playerId && !node.hidden);
    const rect = seat?.getBoundingClientRect();
    const scrollRect = seat?.closest('#opponent-seats')?.getBoundingClientRect();
    const field = $('.felt')?.getBoundingClientRect();
    const fallbackLeft = person?.seat == null || person.seat % 2 === 0;
    const rawX = rect ? rect.left + rect.width / 2 : (fallbackLeft ? 22 : window.innerWidth - 22);
    const rawY = rect ? rect.top + rect.height / 2 : (field ? field.top + 74 : window.innerHeight / 2);
    const lowX = scrollRect ? Math.max(18, scrollRect.left + 15) : 18;
    const highX = scrollRect ? Math.min(window.innerWidth - 18, scrollRect.right - 15) : window.innerWidth - 18;
    const x = limit(rawX, lowX, Math.max(lowX, highX));
    const y = limit(rawY, 48, window.innerHeight - 48);
    const clipped = !rect || Math.abs(rawX - x) > 2 || Math.abs(rawY - y) > 2 ||
      (scrollRect && (rect.right < scrollRect.left || rect.left > scrollRect.right));
    const arrow = rawX < x ? '←' : rawX > x ? '→' : rawY < y ? '↑' : rawY > y ? '↓' : '↗';
    return { x, y, clipped, arrow };
  }

  function giftFlightMarkup(effect) {
    const grand = effect.scope === 'grand';
    const red = effect.roseType === 'redRose';
    const image = red
      ? (grand ? '/assets/gift-red-rose-grand.png' : '/assets/gift-red-rose-classic.png')
      : (grand ? '/assets/gift-bouquet-grand.png' : '/assets/gift-bouquet-classic.png');
    const pending = effect.settlementPending ? t('待结算') : '';
    return `<div class="gift-flight-scene" aria-hidden="true"><span class="gift-transfer gift-transfer-from">${safe(pending)} −${money(effect.cost)}</span><span class="gift-transfer gift-transfer-to">${safe(pending)} +${money(effect.cost)}</span><span class="gift-edge-label gift-edge-from"></span><span class="gift-edge-label gift-edge-to"></span><div class="gift-fly-bouquet ${grand ? 'gift-fly-grand' : ''}"><img src="${image}" alt=""><strong>${safe(t('×{quantity} · {amount} 筹码', { quantity: money(effect.quantity), amount: money(effect.cost) }))}${effect.settlementPending ? ` ${safe(t('（待结算）'))}` : ''}</strong></div></div>`;
  }

  function clearGiftEffects() {
    cancelAnimationFrame(giftEffects.frame);
    giftEffects.frame = 0;
    giftEffects.active.clear();
    giftEffects.seen.clear();
    $('#gift-effects').replaceChildren();
    document.body.classList.remove('gift-grand-active');
  }

  function renderGiftFlight(record, now) {
    const { effect, node } = record;
    const scene = node.querySelector('.gift-flight-scene');
    if (!scene) return;
    const from = giftSeatPoint(effect.sender);
    const to = giftSeatPoint(effect.recipient);
    const start = Number(effect.flightStartAt ?? effect.startAt);
    const end = Number(effect.flightEndAt ?? effect.endAt);
    const progress = limit((now - start) / Math.max(1, end - start), 0, 1);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const eased = reduced ? 1 : progress * progress * (3 - 2 * progress);
    const x = from.x + (to.x - from.x) * eased + (effect.roseType === 'redRose' && !reduced ? Math.sin(Math.PI * 2 * progress) * 18 : 0);
    const y = from.y + (to.y - from.y) * eased - (reduced ? 0 : Math.sin(Math.PI * progress) * Math.min(100, window.innerHeight * .15));
    const bouquet = scene.querySelector('.gift-fly-bouquet');
    const halfWidth = Math.max(bouquet.offsetWidth / 2, (bouquet.querySelector('strong')?.offsetWidth || 0) / 2, effect.scope === 'grand' ? 85 : 50);
    const halfHeight = Math.max(bouquet.offsetHeight / 2, effect.scope === 'grand' ? 110 : 72);
    bouquet.style.left = `${limit(x, halfWidth + 8, Math.max(halfWidth + 8, window.innerWidth - halfWidth - 8))}px`;
    bouquet.style.top = `${limit(y, halfHeight + 8, Math.max(halfHeight + 8, window.innerHeight - halfHeight - 8))}px`;
    const fromChip = scene.querySelector('.gift-transfer-from');
    const toChip = scene.querySelector('.gift-transfer-to');
    const chipOffset = effect.scope === 'grand' ? 150 : 105;
    const chipX = (point, element) => {
      const half = Math.max(34, element.offsetWidth / 2 + 7);
      return limit(point.x + (point.x < window.innerWidth / 2 ? chipOffset : -chipOffset), half, window.innerWidth - half);
    };
    fromChip.style.left = `${chipX(from, fromChip)}px`;
    fromChip.style.top = `${from.y}px`;
    toChip.style.left = `${chipX(to, toChip)}px`;
    toChip.style.top = `${to.y}px`;
    for (const [edge, point, person] of [
      [scene.querySelector('.gift-edge-from'), from, effect.sender],
      [scene.querySelector('.gift-edge-to'), to, effect.recipient]
    ]) {
      edge.hidden = !point.clipped;
      edge.textContent = `${point.arrow} ${person?.nickname || t('玩家')}`;
      edge.style.left = `${limit(point.x, 62, window.innerWidth - 62)}px`;
      edge.style.top = `${limit(point.y - 42, 25, window.innerHeight - 25)}px`;
    }
  }

  function tickGiftEffects() {
    giftEffects.frame = 0;
    const now = giftNow();
    let grandActive = false;
    for (const [id, record] of giftEffects.active) {
      const { effect, node } = record;
      if (now >= Number(effect.endAt)) {
        node.remove();
        giftEffects.active.delete(id);
        continue;
      }
      if (now < Number(effect.startAt)) {
        node.hidden = true;
        continue;
      }
      node.hidden = false;
      if (effect.kind === 'sneak') {
        const phrase = now < Number(effect.secondAt) ? t('悄悄地进村') : t('打枪的不要');
        if (record.phrase !== phrase) {
          record.phrase = phrase;
          drawPixelWords(node.querySelector('canvas'), phrase);
          node.querySelector('.effect-pixel-fallback').textContent = phrase;
          node.querySelector('.effect-accessible').textContent = phrase;
        }
      } else if (effect.scope === 'grand') {
        grandActive = true;
        const display = now < Number(effect.grandEndAt);
        node.classList.toggle('is-grand-display', display);
        node.classList.toggle('is-flight', !display);
        if (!display) renderGiftFlight(record, now);
      } else {
        node.classList.add('is-flight');
        renderGiftFlight(record, now);
      }
    }
    document.body.classList.toggle('gift-grand-active', grandActive);
    if (giftEffects.active.size) giftEffects.frame = requestAnimationFrame(tickGiftEffects);
  }

  function showGiftEffect(effect) {
    recordGiftActivity(effect);
    if (!effect || effect.type !== 'giftEffect' || effect.roomCode !== state.roomCode ||
        !['bouquet', 'sneak'].includes(effect.kind) || !effect.id || giftEffects.seen.has(effect.id) ||
        !Number.isFinite(Number(effect.endAt)) || Number(effect.endAt) <= giftNow()) return;
    if (effect.scope === 'private' && ![effect.sender?.playerId, effect.recipient?.playerId].includes(state.data?.hero?.playerId)) return;
    giftEffects.seen.add(effect.id);
    if (giftEffects.seen.size > 256) giftEffects.seen.delete(giftEffects.seen.values().next().value);
    if (effect.scope === 'grand') {
      closeGiftPicker(false);
      for (const [id, record] of giftEffects.active) {
        record.node.remove();
        giftEffects.active.delete(id);
      }
    } else if ([...giftEffects.active.values()].some((record) => record.effect.scope === 'grand')) return;
    if (giftEffects.active.size >= 12) {
      const oldest = giftEffects.active.keys().next().value;
      giftEffects.active.get(oldest)?.node.remove();
      giftEffects.active.delete(oldest);
    }
    const node = document.createElement('div');
    node.className = `gift-effect is-${effect.kind}${effect.scope === 'grand' ? ' is-grand' : ''}${effect.roseType === 'redRose' ? ' rose-red' : ' rose-white'}`;
    node.dataset.effectId = effect.id;
    node.hidden = true;
    if (effect.kind === 'sneak') {
      node.innerHTML = `<div class="gift-sneak-card" aria-hidden="true"><canvas class="effect-pixel-words" width="180" height="38"></canvas><span class="effect-pixel-fallback" hidden></span></div><span class="effect-accessible"></span>`;
    } else {
      const message = t(effect.settlementPending ? '{name} 送给 {recipient} ×{quantity}，{amount} 筹码，手末结算' : '{name} 送给 {recipient} ×{quantity}，{amount} 筹码', {
        name: effect.sender?.nickname || t('玩家'), recipient: effect.recipient?.nickname || t('玩家'),
        quantity: money(effect.quantity), amount: money(effect.cost)
      });
      const red = effect.roseType === 'redRose';
      node.innerHTML = `${effect.scope === 'grand' ? `<div class="gift-grand-scene" aria-hidden="true">${red ? '<div class="rose-petals"><i></i><i></i><i></i><i></i><i></i><i></i></div>' : ''}<img src="${red ? '/assets/gift-red-rose-grand.png' : '/assets/gift-bouquet-grand.png'}" alt=""><span class="gift-grand-overline">${red ? 'Tu es rosa mea rubra' : 'Tu es rosa mea alba'}</span><strong>${safe(t('{name} 致 {recipient}', { name: effect.sender?.nickname || t('玩家'), recipient: effect.recipient?.nickname || t('玩家') }))}</strong><span>${safe(t('×{quantity} 束 · {amount} 筹码', { quantity: money(effect.quantity), amount: money(effect.cost) }))}${effect.settlementPending ? ` · ${safe(t('手末结算'))}` : ''}</span></div>` : ''}${giftFlightMarkup(effect)}<span class="effect-accessible">${safe(message)}</span>`;
    }
    $('#gift-effects').append(node);
    giftEffects.active.set(effect.id, { effect, node, phrase: '' });
    if (!giftEffects.frame) giftEffects.frame = requestAnimationFrame(tickGiftEffects);
  }

  function setConnection(label, status = '') {
    const element = $('#connection');
    element.dataset.labelKey = label;
    element.textContent = t(label);
    element.className = `connection ${status}`;
  }

  function stored(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
  function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* Private browsing may disable storage. */ } }
  function forget(key) { try { localStorage.removeItem(key); } catch { /* Private browsing may disable storage. */ } }
  function giftActivityKey() {
    return state.roomCode && state.data?.hero?.playerId ? `poker-gift-activity:${state.roomCode}:${state.data.hero.playerId}` : '';
  }
  function readGiftActivity() {
    try { const rows = JSON.parse(stored(giftActivityKey())); return Array.isArray(rows) ? rows : []; }
    catch { return []; }
  }
  function recordGiftActivity(effect) {
    if (effect?.kind !== 'bouquet' || effect.roomCode !== state.roomCode) return;
    const heroId = state.data?.hero?.playerId;
    if (![effect.sender?.playerId, effect.recipient?.playerId].includes(heroId)) return;
    const key = giftActivityKey();
    if (!key) return;
    const rows = readGiftActivity();
    if (rows.some((row) => row.id === effect.id)) return;
    rows.push({ id: effect.id, requestId: String(effect.id).split(':').at(-1), at: effect.at,
      roseType: effect.roseType || 'whiteRose', sender: effect.sender?.nickname,
      recipient: effect.recipient?.nickname, quantity: effect.quantity, cost: effect.cost });
    remember(key, JSON.stringify(rows.slice(-40)));
    if (giftPicker.open && state.data) renderGiftActivity(state.data);
  }
  function renderGiftActivity(data) {
    const hero = data.hero || {};
    const key = giftActivityKey();
    const rows = key ? readGiftActivity() : [];
    const pending = Array.isArray(hero.pendingGifts) ? hero.pendingGifts : [];
    const byId = new Map(rows.map((row) => [row.requestId, row]));
    for (const item of pending) if (item?.requestId && !byId.has(item.requestId)) byId.set(item.requestId, {
      requestId: item.requestId, at: item.at, roseType: item.roseType,
      sender: item.sender, recipient: item.recipient, quantity: item.quantity, cost: item.cost
    });
    const pendingIds = new Set(pending.map((item) => item.requestId));
    const recent = [...byId.values()].sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0)).slice(0, 8);
    const activity = recent.length ? recent.map((row) => {
      const sent = row.sender === hero.nickname;
      const when = Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toLocaleString(i18n.getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const rose = t(row.roseType === 'redRose' ? '红玫瑰 ×{quantity}' : '白玫瑰 ×{quantity}', { quantity: money(row.quantity) });
      const direction = t(sent ? '送给 {name}' : '来自 {name}', { name: sent ? row.recipient : row.sender });
      return `<div class="gift-activity-row"><strong>${safe(rose)}</strong><span>${safe(direction)} · ${safe(t('{amount} 筹码', { amount: money(row.cost) }))}</span><small>${safe(when)} · ${safe(t(pendingIds.has(row.requestId) ? '本手待结算' : '已记录'))}</small></div>`;
    }).join('') : `<p class="small-note">${safe(t('还没有赠礼记录。'))}</p>`;
    const settlement = hero.lastFinancialSettlement;
    const auto = Array.isArray(settlement?.autoRebuys) ? settlement.autoRebuys.filter((row) => row.playerId === hero.playerId).reduce((sum, row) => sum + (Number(row.amount) || 0), 0) : 0;
    const canceled = Array.isArray(settlement?.unloads) ? settlement.unloads.filter((row) => row.playerId === hero.playerId && !row.accepted).length : 0;
    $('#gift-activity-content').innerHTML = `${auto || canceled ? `<p class="gift-activity-finance">${safe(t('第 {handNo} 手：', { handNo: money(settlement.handNo) }))}${auto ? safe(t('自动补码 {amount}', { amount: money(auto) })) : ''}${auto && canceled ? ' · ' : ''}${canceled ? safe(t('卸码取消 {count} 次', { count: canceled })) : ''}</p>` : ''}${activity}`;
  }
  function tokenKey(code) { return `poker-room-token:${code}`; }
  function nickKey(code) { return `poker-room-nickname:${code}`; }
  const ROOM_CLOSED_MESSAGE = '房间连续 24 小时未开局，已自动关闭。';
  function isRoomClosedError(cause) {
    return cause?.status === 410 && (!cause.errorCode || cause.errorCode === 'ROOM_CLOSED');
  }

  async function request(path, { method = 'GET', body, token = state.token, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    // New clients explicitly negotiate bounded live state. Older clients retain full views.
    if (/^\/api\/rooms\/[^/?]+\/(join|state|command)$/.test(path)) path += '?compact=1';
    const controller = new AbortController();
    const requests = state.requests || (state.requests = new Set());
    requests.add(controller);
    const abort = () => controller.abort(signal?.reason);
    let timer;
    let onAbort;
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => {
          const reason = controller.signal.reason;
          const error = reason && typeof reason.message === 'string' ? reason : new Error(t('连接已切换。'));
          reject(error);
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => {
        const error = new Error(t('请求超时，请检查网络。'));
        error.errorCode = 'REQUEST_TIMEOUT';
        controller.abort(error);
      }, 10000);
      const responseBody = async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store', signal: controller.signal });
        let data;
        try { data = await response.json(); }
        catch (cause) { if (response.ok) throw cause; data = {}; }
        if (!response.ok) {
          const error = new Error(data?.message || data?.error || t('请求失败（{status}）', { status: response.status }));
          error.status = response.status;
          error.errorCode = data?.errorCode || data?.code || '';
          throw error;
        }
        if (!data || typeof data !== 'object') throw new Error(t('连接中断'));
        return data;
      };
      // Abort fetch AND bound our waiter, including response.json(), even if a transport ignores abort.
      return await Promise.race([responseBody(), cancelled]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      requests.delete(controller);
    }
  }

  function refreshSavedIdentity() {
    const note = $('#saved-identity');
    const code = $('#room-code-input').value.trim();
    const nickname = stored(nickKey(code));
    note.hidden = state.mode !== 'join' || !stored(tokenKey(code));
    if (!note.hidden) note.textContent = nickname
      ? t('此设备已保存「{name}」的身份；进入后将恢复原玩家。需要换人时，请进房后点击“切换玩家”。', { name: nickname })
      : t('此设备已保存一位玩家的身份；进入后将恢复原玩家。需要换人时，请进房后点击“切换玩家”。');
  }

  function setMode(mode) {
    state.mode = mode;
    for (const button of document.querySelectorAll('.mode-button')) {
      const selected = button.dataset.mode === mode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    $('#room-code-field').hidden = mode !== 'join';
    $('#recovery-field').hidden = mode !== 'join';
    $('#create-options').hidden = mode !== 'create';
    $('#enter-button').textContent = t(mode === 'create' ? '开设房间' : '进入房间');
    $('#spectate-button').textContent = t(mode === 'create' ? '开房并观战' : '进入房间观战');
    $('#lobby-error').hidden = true;
    refreshSavedIdentity();
  }

  function validateNickname() {
    const nickname = $('#nickname-input').value.trim();
    if (!nickname) throw new Error(t('请输入昵称。'));
    if ([...nickname].length > 18) throw new Error(t('昵称最多 18 个字符。'));
    return nickname;
  }

  async function joinIdentity(code, nickname, manualToken) {
    const session = state.session;
    const current = () => { if (session !== state.session) throw new Error(t('连接已切换。')); };
    const join = async () => {
      current();
      const savedToken = stored(tokenKey(code));
      const token = manualToken || savedToken;
      let joined;
      try {
        joined = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
          method: 'POST', body: { nickname, enter: true, ...(token ? { token } : {}) }, token: ''
        });
      } catch (cause) {
        current();
        if (!manualToken && savedToken && cause.status === 401) {
          forget(tokenKey(code));
          forget(nickKey(code));
          joined = await request(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { nickname, enter: true }, token: '' });
        } else throw cause;
      }
      current();
      if (!joined.token) throw new Error(t('进入房间失败，请重试。'));
      const realName = joined.state?.hero?.nickname || nickname;
      remember('poker-last-nickname', realName);
      remember('poker-last-room', code);
      remember(tokenKey(code), joined.token);
      remember(nickKey(code), realName);
      return joined;
    };
    // Same-origin tabs serialize their first join so the second can reuse the first token.
    if (navigator.locks?.request) return navigator.locks.request(`poker-join:${code}`, join);
    // Best-effort lease for browsers without Web Locks; a stale lease expires quickly.
    const key = `poker-join-lease:${code}`;
    const owner = `${Date.now()}-${Math.random()}`;
    for (let attempt = 0; attempt < 24; attempt++) {
      current();
      let lease;
      try { lease = JSON.parse(stored(key) || 'null'); } catch { lease = null; }
      if (!lease || lease.until < Date.now()) {
        remember(key, JSON.stringify({ owner, until: Date.now() + 5000 }));
        if (!stored(key)) return join();
        await new Promise((resolve) => setTimeout(resolve, 35));
        let confirmed;
        try { confirmed = JSON.parse(stored(key) || 'null'); } catch { confirmed = null; }
        if (confirmed?.owner === owner) {
          try { return await join(); }
          finally {
            let current;
            try { current = JSON.parse(stored(key) || 'null'); } catch { current = null; }
            if (current?.owner === owner) forget(key);
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return join();
  }

  async function enterRoom() {
    if (state.pending || state.roomCode) return;
    const session = state.session;
    state.resumeCancelled = true;
    state.pending = true;
    $('#enter-button').disabled = true;
    $('#spectate-button').disabled = true;
    const error = $('#lobby-error');
    error.hidden = true;
    let code = '';
    try {
      const nickname = validateNickname();
      if (state.mode === 'create') {
        const capacity = Number($('#capacity-input').value);
        const created = await request('/api/rooms', { method: 'POST', body: { capacity }, token: '' });
        if (session !== state.session) return;
        code = String(created.roomCode || '').toUpperCase();
      } else {
        code = $('#room-code-input').value.trim().toUpperCase();
        if (!/^\d{4,8}$/.test(code)) throw new Error(t('房间号须为 4–8 位数字。'));
      }
      if (!code) throw new Error(t('未获取到房间号，请重试。'));
      const enteredRecovery = state.mode === 'join' ? $('#recovery-input').value.trim() : '';
      const joined = await joinIdentity(code, nickname, enteredRecovery);
      if (session !== state.session) return;
      $('#enter-button').disabled = false;
      $('#spectate-button').disabled = false;
      $('#recovery-input').value = '';
      openRoom(code, joined.token, joined.state);
      if (joined.effect) queueRoomEffect(joined.effect);
    } catch (cause) {
      if (session !== state.session) return;
      if (code && isRoomClosedError(cause)) {
        closeExpiredRoom(code);
        return;
      }
      error.dataset.rawMessage = cause.message || '连接失败，请重试。';
      error.textContent = message(error.dataset.rawMessage);
      error.hidden = false;
    } finally {
      if (session === state.session) {
        state.pending = false;
        $('#enter-button').disabled = false;
        $('#spectate-button').disabled = false;
      }
    }
  }

  function stopNetwork() {
    state.session += 1;
    for (const controller of state.requests || []) controller.abort();
    state.requests?.clear();
    state.refresh = null;
    state.recovering = false;
    state.pending = false;
    state.retiredEpochs = new Set();
    if (typeof details !== 'undefined') details?.reset();
    state.socketCleanup?.();
    state.socketCleanup = null;
    state.socketRecover = null;
    state.tableSettingsRoomCode = '';
    state.tableSettingsSeenId = 0;
    clearTimeout(state.soundTurnTimer);
    state.soundTurnTimer = null;
    state.soundResumeAt = 0;
    soundPlanner?.reset();
    preactions.reset();
    sounds?.stop();
    clearRoomEffects();
    clearGiftEffects();
    closeGiftPicker(false);
    closeSeatDialog();
    giftPicker.retries.clear();
    giftPicker.retryContext = '';
    clearTimeout(state.retry);
    clearInterval(state.poll);
    clearInterval(state.timer);
    state.retry = null;
    state.poll = null;
    state.timer = null;
    if (state.socket) {
      state.socket.onclose = null;
      state.socket.close();
      state.socket = null;
    }
  }

  function openRoom(code, token, initial) {
    stopNetwork();
    remember('poker-last-room', code);
    if (initial?.hero?.nickname) {
      remember('poker-last-nickname', initial.hero.nickname);
      remember(nickKey(code), initial.hero.nickname);
    }
    state.roomCode = code;
    state.token = token;
    state.data = initial || null;
    state.tableSettingsRoomCode = code;
    state.tableSettingsSeenId = Number(initial?.tableSettingsNotice?.id) || 0;
    state.soundResumeAt = 0;
    soundPlanner?.baseline(initial, Number(initial?.serverTime) || Date.now());
    state.newRunoutCards = new Set();
    $('#board-cards').dataset.signature = '';
    state.clockOffset = Number(initial?.serverTime) ? Number(initial.serverTime) - Date.now() : 0;
    if (!giftEffects.preload) {
      giftEffects.preload = ['/assets/gift-bouquet-classic.png', '/assets/gift-bouquet-grand.png', '/assets/gift-red-rose-classic.png', '/assets/gift-red-rose-grand.png'].map((src) => {
        const image = new Image();
        image.src = src;
        return image;
      });
    }
    $('#lobby-screen').hidden = true;
    $('#room-screen').hidden = false;
    $('#leave-button').hidden = false;
    history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
    render();
    state.timer = setInterval(updateTimers, 250);
    updateTimers();
    connectSocket(state.session);
    state.poll = setInterval(() => {
      // OPEN alone is not evidence that a suspended/half-open connection still works.
      const stale = !state.socket || state.socket.readyState !== WebSocket.OPEN || Date.now() - state.socketLastSeen > 18000;
      if (stale || state.recovering) void refreshState();
      if (stale && state.socket?.readyState === WebSocket.OPEN) state.socketRecover?.();
    }, 3000);
    if (!initial) void refreshState();
  }

  function leaveRoom() {
    const oldRoom = state.roomCode;
    stopNetwork();
    state.roomCode = '';
    state.token = '';
    state.data = null;
    $('#room-screen').hidden = true;
    $('#lobby-screen').hidden = false;
    $('#leave-button').hidden = true;
    $('#recovery-details').open = false;
    $('#recovery-display').value = '';
    if (stored('poker-last-room') === oldRoom) forget('poker-last-room');
    $('#room-code-input').value = oldRoom;
    setMode('join');
    history.replaceState(null, '', location.pathname);
    setConnection('准备连接');
    state.pending = false;
  }

  function closeExpiredRoom(code, { session, token } = {}) {
    const closedCode = String(code || '').trim().toUpperCase();
    if (!closedCode) return false;
    if (state.roomCode) {
      if (state.roomCode !== closedCode || (session !== undefined && session !== state.session) ||
          (token !== undefined && token !== state.token)) return false;
      state.resumeCancelled = true;
      leaveRoom();
    } else {
      if (session !== undefined && session !== state.session) return false;
      state.resumeCancelled = true;
      $('#room-code-input').value = closedCode;
      setMode('join');
      history.replaceState(null, '', location.pathname);
      setConnection('准备连接');
    }
    forget(tokenKey(closedCode));
    forget(nickKey(closedCode));
    if (stored('poker-last-room') === closedCode) forget('poker-last-room');
    $('#recovery-input').value = '';
    refreshSavedIdentity();
    state.pending = false;
    const error = $('#lobby-error');
    error.dataset.rawMessage = ROOM_CLOSED_MESSAGE;
    error.textContent = t(ROOM_CLOSED_MESSAGE);
    error.hidden = false;
    return true;
  }

  function cannotLeaveSeatDuringHand(data) {
    if (data?.status !== 'playing' || !Number.isInteger(data.hero?.seat)) return false;
    const hero = data.hero;
    const seat = data.seats?.[hero.seat];
    return Boolean(seat?.inHand) || [hero.pendingRebuy ?? seat?.pendingRebuy, hero.pendingUnload ?? seat?.pendingUnload,
      hero.pendingGiftSent, hero.pendingGiftReceived].some((amount) => Number(amount) > 0);
  }

  async function switchPlayer() {
    if (state.pending || state.recovering || !state.roomCode) return;
    const code = state.roomCode;
    const seated = Number.isInteger(state.data?.hero?.seat);
    if (seated && cannotLeaveSeatDuringHand(state.data)) {
      showToast(t('本手进行中，请在结算后切换玩家。'));
      return;
    }
    state.pending = true;
    preactions.reset();
    if (state.data) renderActions(state.data);
    const session = state.session;
    const token = state.token;
    try {
      if (seated) await request(`/api/rooms/${encodeURIComponent(code)}/command`, { method: 'POST', body: { type: 'stand' } });
      if (session !== state.session || code !== state.roomCode || token !== state.token) return;
      forget(tokenKey(code));
      forget(nickKey(code));
      leaveRoom();
      $('#nickname-input').value = '';
      $('#nickname-input').focus();
      showToast(t('已切换身份。输入新昵称即可加入；旧身份可凭恢复码找回。'));
    } catch (cause) {
      if (session !== state.session || code !== state.roomCode || token !== state.token) return;
      if (isRoomClosedError(cause) && closeExpiredRoom(code, { session, token })) return;
      if (!cause.status || cause.status >= 500) {
        showToast(t('操作结果尚未确认，正在同步牌桌；不会自动重试。'));
        await recoverCommandState(session, code, token);
      } else showToast(cause.message || t('切换玩家失败。'));
    } finally {
      if (session === state.session && code === state.roomCode && token === state.token) {
        state.pending = false;
        if (state.data) renderActions(state.data);
      }
    }
  }

  function connectSocket(session) {
    if (session !== state.session || !state.roomCode || state.socket) return;
    clearTimeout(state.retry);
    state.retry = null;
    const roomCode = state.roomCode;
    const token = state.token;
    let receivedState = false;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws?room=${encodeURIComponent(roomCode)}&token=${encodeURIComponent(token)}&compact=1`;
    let socket;
    try { socket = new WebSocket(url); }
    catch {
      setConnection('连接中断', 'offline');
      state.retry = setTimeout(() => connectSocket(session), 2500);
      return;
    }
    state.socket = socket;
    state.socketLastSeen = Date.now();
    const current = () => session === state.session && roomCode === state.roomCode && token === state.token && state.socket === socket;
    let heartbeat;
    let pongTimeout;
    let nonce = '';
    let serial = 0;
    const handshake = setTimeout(() => { if (current() && !receivedState) retire(); }, 8000);
    const cleanup = () => { clearTimeout(handshake); clearInterval(heartbeat); clearTimeout(pongTimeout); };
    const retire = () => {
      if (!current()) return;
      // Reuse the close path immediately; browsers can leave close() pending on a dead connection.
      socket.onclose({ code: 0 });
      try { socket.close(); } catch { /* Already closed. */ }
    };
    const ping = () => {
      if (!current() || socket.readyState !== WebSocket.OPEN || nonce) return;
      nonce = `${session}:${++serial}`;
      try { socket.send(JSON.stringify({ type: 'ping', nonce })); }
      catch { retire(); return; }
      pongTimeout = setTimeout(() => { if (current() && nonce) retire(); }, 8000);
    };
    state.socketCleanup = cleanup;
    state.socketRecover = retire;
    setConnection('连接中');
    socket.onopen = () => {
      if (!current()) return;
      // Online is announced only after an authenticated initial state, not TCP open.
      ping();
      heartbeat = setInterval(ping, 10000);
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'pong' && nonce && packet.nonce === nonce) {
        nonce = '';
        clearTimeout(pongTimeout);
        state.socketLastSeen = Date.now();
        return;
      }
      if (packet.type === 'roomClosed' && packet.reason === 'inactive') {
        closeExpiredRoom(packet.roomCode || roomCode, { session, token });
        return;
      }
      if (packet.type === 'state' && packet.state?.roomCode === roomCode) {
        receivedState = true;
        clearTimeout(handshake);
        state.socketLastSeen = Date.now();
        applyState(packet.state);
        if (!state.recovering) setConnection('实时在线', 'online');
      }
      else if (packet.type === 'roomEffect') queueRoomEffect(packet);
      else if (packet.type === 'giftEffect') showGiftEffect(packet);
      else if (packet.type === 'error') showToast(packet.message || t('操作未完成。'));
    };
    socket.onclose = (event) => {
      if (!current()) return;
      cleanup();
      state.socketCleanup = null;
      state.socketRecover = null;
      state.socket = null;
      if (event.code === 4004) {
        closeExpiredRoom(roomCode, { session, token });
        return;
      }
      preactions.reset();
      if (state.data) renderActions(state.data);
      if (receivedState) {
        state.soundResumeAt = Date.now() + state.clockOffset;
        clearTimeout(state.soundTurnTimer);
        state.soundTurnTimer = null;
        sounds?.stop();
      }
      setConnection('正在重连', 'offline');
      clearTimeout(state.retry);
      state.retry = setTimeout(() => connectSocket(session), 2500);
      void refreshState();
    };
    socket.onerror = () => { if (current()) retire(); };
  }

  async function refreshState() {
    if (!state.roomCode || !state.token) return false;
    if (state.refresh) return state.refresh.promise;
    const session = state.session;
    const roomCode = state.roomCode;
    const token = state.token;
    const active = { controller: new AbortController(), promise: null };
    state.refresh = active;
    active.promise = (async () => {
      try {
        const fresh = await request(`/api/rooms/${encodeURIComponent(roomCode)}/state`, { token, signal: active.controller.signal });
        if (active.controller.signal.aborted || session !== state.session || roomCode !== state.roomCode || token !== state.token) return false;
        const data = fresh.state || fresh;
        if (data?.roomCode !== roomCode || !data.hero) throw new Error('Invalid room state');
        if (data.stateEpoch && state.retiredEpochs?.has(data.stateEpoch)) return false;
        // A successful read is the recovery barrier; an unsolicited WS frame cannot release it.
        const recovering = state.recovering;
        state.recovering = false;
        applyState(data);
        if (recovering) {
          if (state.data) renderActions(state.data);
        }
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) setConnection('正在重连', 'offline');
        else setConnection('实时在线', 'online');
        return true;
      } catch (cause) {
        if (active.controller.signal.aborted || session !== state.session || roomCode !== state.roomCode || token !== state.token) return false;
        if (isRoomClosedError(cause)) {
          closeExpiredRoom(roomCode, { session, token });
          return false;
        }
        preactions.reset();
        if (state.data) renderActions(state.data);
        setConnection('连接中断', 'offline');
        return false;
      } finally {
        if (state.refresh === active) state.refresh = null;
      }
    })();
    return active.promise;
  }

  async function recoverCommandState(session, roomCode, token) {
    state.recovering = true;
    preactions.reset();
    if (state.data) renderActions(state.data);
    setConnection('正在同步牌桌', 'offline');
    // An older GET could have been taken before the uncertain mutation. Cancel it, then reread.
    const active = state.refresh;
    if (active) {
      active.controller.abort();
      await active.promise;
    }
    if (session !== state.session || roomCode !== state.roomCode || token !== state.token) return;
    await refreshState();
  }

  function recoverNetwork() {
    if (!state.roomCode) return;
    preactions.reset();
    if (state.data) renderActions(state.data);
    if (state.socket && Date.now() - state.socketLastSeen > 18000) state.socketRecover?.();
    if (!state.socket) connectSocket(state.session);
    void refreshState();
  }

  async function command(payload) {
    if (state.pending || state.recovering || !state.roomCode) return false;
    state.pending = true;
    // Bind manual actions to the observed turn too. A delayed POST must never act on a later turn.
    if (payload.type === 'action' && !payload.expectedAction && state.data) {
      const data = state.data;
      payload = { ...payload, expectedAction: { handNo: data.handNo, streetIndex: data.streetIndex,
        actingSeat: data.actingSeat, actionDeadline: data.actionDeadline, currentBet: data.currentBet } };
    }
    if (['action', 'stand', 'sitOut'].includes(payload.type)) preactions.reset();
    if (state.data) renderActions(state.data);
    const session = state.session;
    const roomCode = state.roomCode;
    const token = state.token;
    try {
      const response = await request(`/api/rooms/${encodeURIComponent(roomCode)}/command`, { method: 'POST', body: payload, token });
      if (session !== state.session || roomCode !== state.roomCode || token !== state.token) return false;
      if (response.state) applyState(response.state);
      else await refreshState();
      if (session !== state.session || roomCode !== state.roomCode || token !== state.token) return false;
      if (response.effect?.type === 'giftEffect') showGiftEffect(response.effect);
      else if (response.effect) queueRoomEffect(response.effect);
      if (payload.type === 'timebank' && payload.enabled) showToast(t('已开启加时：30秒后每10秒支付10筹码。'));
      if (payload.type === 'sit' && state.data?.hero?.waitingNextHand) showToast(t('已入座；本手不参与，从下一手开始发牌。'));
      if (payload.type === 'rebuy') showToast(t(state.data?.status === 'playing' ? '补码 2,000 已排队，本手结束结算。' : '已补码 2,000。'));
      if (payload.type === 'reveal') showToast(t('你的手牌已公开。'));
      if (payload.type === 'sitOut') showToast(t('已暂时离席；从下一手起不发牌。'));
      if (payload.type === 'return') showToast(t('已返回牌桌；连续暂离计数已清零，从下一手起参与。'));
      if (payload.type === 'gift') showToast(t(state.data?.status === 'playing' ? '{quantity} 束花已展示，本手结束统一结算。' : '已送出 {quantity} 束花。', { quantity: money(payload.quantity) }));
      if (payload.type === 'sneak') showToast(t('暗号已发送。'));
      if (payload.type === 'unload') showToast(t(state.data?.status === 'playing' ? '卸码 2,000 已排队，本手结束结算。' : '已卸码 2,000。'));
      return true;
    } catch (cause) {
      if (session !== state.session || roomCode !== state.roomCode || token !== state.token) return false;
      if (isRoomClosedError(cause)) {
        closeExpiredRoom(roomCode, { session, token });
        return false;
      }
      if (!cause.status || cause.status >= 500) {
        showToast(t('操作结果尚未确认，正在同步牌桌；不会自动重试。'));
        await recoverCommandState(session, roomCode, token);
      } else showToast(cause.message || t('操作未完成，请重试。'));
      return false;
    } finally {
      if (session === state.session && roomCode === state.roomCode && token === state.token) {
        state.pending = false;
        if (state.data) {
          renderActions(state.data);
          runPreaction();
        }
      }
    }
  }

  function runPreaction() {
    if (state.pending || state.recovering || !state.roomCode || !state.data) return;
    const data = state.data;
    const queued = preactions.observe(data);
    if (!queued) return;
    renderActions(data);
    void command({ type: 'action', action: queued.action, expectedAction: {
      handNo: data.handNo, streetIndex: data.streetIndex, actingSeat: data.actingSeat, actionDeadline: data.actionDeadline, currentBet: data.currentBet
    } });
  }

  function tableSettingsNoticeText(fresh, previous, seenId = 0) {
    const notice = fresh.tableSettingsNotice;
    if (!previous || previous.roomCode !== fresh.roomCode || !notice || !Number.isFinite(Number(notice.id)) ||
        Number(notice.id) <= Math.max(seenId, Number(previous.tableSettingsNotice?.id ?? -1)) ||
        Number(notice.nextHandNo) <= Number(fresh.handNo)) return '';
    if (notice.kind === 'bigBlind') return t('下一局大盲筹码数为{amount}筹码', { amount: money(notice.bigBlind) });
    if (notice.kind === 'capacity') return t('下一局牌桌人数为{count}人', { count: notice.capacity });
    return '';
  }

  function applyState(fresh, { soundSilent = false } = {}) {
    if (!fresh || typeof fresh !== 'object') return;
    const serverTime = Number(fresh.serverTime);
    const previous = state.data;
    const previousTime = Number(previous?.serverTime);
    // A late HTTP response must not undo a newer WS state, including same-ms snapshots.
    const epoch = typeof fresh.stateEpoch === 'string' ? fresh.stateEpoch : '';
    const previousEpoch = typeof previous?.stateEpoch === 'string' ? previous.stateEpoch : '';
    const retired = state.retiredEpochs || (state.retiredEpochs = new Set());
    if (epoch && retired.has(epoch)) return;
    const sameRoom = previous?.roomCode === fresh.roomCode;
    const sameEpoch = epoch && epoch === previousEpoch;
    if (sameRoom && sameEpoch && Number.isSafeInteger(fresh.stateSequence) && Number.isSafeInteger(previous.stateSequence) &&
        fresh.stateSequence < previous.stateSequence) return;
    if (sameRoom && (!epoch || !previousEpoch || sameEpoch) &&
        !(sameEpoch && Number.isSafeInteger(fresh.stateSequence) && Number.isSafeInteger(previous.stateSequence)) &&
        Number.isFinite(serverTime) && serverTime > 0 && Number.isFinite(previousTime) && serverTime < previousTime) return;
    if (sameRoom && epoch && previousEpoch && epoch !== previousEpoch) retired.add(previousEpoch);
    const cues = soundPlanner?.observe(fresh, { silent: soundSilent, since: state.soundResumeAt,
      now: Number.isFinite(serverTime) && serverTime > 0 ? serverTime : Date.now() + state.clockOffset }) || [];
    if (state.soundResumeAt && Number.isFinite(serverTime) && serverTime >= state.soundResumeAt &&
        (!Number.isFinite(previousTime) || serverTime >= previousTime)) state.soundResumeAt = 0;
    const knownCards = new Set((previous?.runout?.boards || [previous?.board || []]).flat());
    state.newRunoutCards = new Set();
    if (previous && previous.handNo === fresh.handNo && Array.isArray(fresh.runout?.boards)) {
      fresh.runout.boards.forEach((board, boardIndex) => {
        if (!Array.isArray(board)) return;
        board.forEach((card, cardIndex) => {
          if (!knownCards.has(card)) state.newRunoutCards.add(`${boardIndex}:${cardIndex}`);
        });
      });
    }
    state.data = fresh;
    preactions.observe(fresh, { consume: false });
    if (fresh.serverTime != null && Number.isFinite(Number(fresh.serverTime))) state.clockOffset = Number(fresh.serverTime) - Date.now();
    render();
    if (!fresh.hero?.canAct && !fresh.hero?.canChooseRunout && !fresh.hero?.canRespondRunout || fresh.pause) {
      clearTimeout(state.soundTurnTimer);
      state.soundTurnTimer = null;
    }
    playSoundCues(cues);
    runPreaction();
    const event = fresh.hero?.lastPresenceEvent;
    const previousEvent = previous?.hero?.lastPresenceEvent;
    if (previous && event && (event.type !== previousEvent?.type || event.at !== previousEvent?.at || event.handNo !== previousEvent?.handNo)) {
      if (event.type === 'timeoutSitOut') showToast(t(fresh.hero?.pendingSitOut ? '行动超时：本手已自动过牌，下手将暂离。点“返回牌桌”可取消。' : '行动超时：本手已自动弃牌并暂离。点“返回牌桌”可恢复。'));
      if (event.type === 'autoStand') showToast(t('连续暂离 5 手，已自动转为观战；可重新选座。'));
    }
    const financial = fresh.hero?.lastFinancialNotice;
    const priorFinancial = previous?.hero?.lastFinancialNotice;
    if (previous && financial && (financial.at !== priorFinancial?.at || financial.type !== priorFinancial?.type)) {
      showToast(financial.message || t(financial.type === 'unloadCanceled' ? '本手结算后余额不足，卸码已取消。' : '筹码结算已更新。'));
    }
    const noticeId = Number(fresh.tableSettingsNotice?.id);
    const sameSettingsRoom = state.tableSettingsRoomCode === fresh.roomCode;
    const settingsText = sameSettingsRoom ? tableSettingsNoticeText(fresh, previous, state.tableSettingsSeenId) : '';
    state.tableSettingsRoomCode = fresh.roomCode;
    if (!sameSettingsRoom) state.tableSettingsSeenId = Number.isFinite(noticeId) ? noticeId : 0;
    else if (Number.isFinite(noticeId)) state.tableSettingsSeenId = Math.max(state.tableSettingsSeenId, noticeId);
    if (settingsText) showToast(settingsText);
  }

  function updateTimers() {
    const data = state.data;
    const roomTimer = $('#timer-label');
    const actionTimer = $('#action-timer');
    roomTimer.hidden = true;
    actionTimer.hidden = true;
    const playing = data?.status === 'playing' && !data?.runout;
    const deadline = Number(data?.actionDeadline);
    const paused = data?.pause && Number(data.pause.endAt) > giftNow();
    const effectiveNow = paused ? Number(data.pause.endAt) : giftNow();
    const windowMs = Number(data?.actionWindowMs) || (Number(data?.actionTimebankBlocks) > 0 ? 10_000 : 30_000);
    const fraction = playing && Number.isFinite(deadline) ? limit((deadline - effectiveNow) / windowMs, 0, 1) : 0;
    for (const bar of document.querySelectorAll('.seat-clock-fill')) {
      bar.style.width = `${(fraction * 100).toFixed(1)}%`;
      bar.classList.toggle('is-paid-time', Number(data?.actionTimebankBlocks) > 0);
    }
    if (!state.soundResumeAt) {
      const warning = soundPlanner?.warning(data, giftNow());
      if (warning) sounds?.play(warning.kind, { allowHidden: true });
    }
  }

  function cardHtml(code, small = false, reveal = false) {
    if (!code || code === '??') return `<span class="card ${small ? 'small ' : ''}back" aria-label="${safe(t('暗牌'))}"></span>`;
    const match = /^([2-9TJQKA])([shdc])$/i.exec(String(code));
    if (!match) return `<span class="card ${small ? 'small ' : ''}back" aria-label="${safe(t('暗牌'))}"></span>`;
    const r = ranks[match[1].toUpperCase()] || match[1];
    const suit = suits[match[2].toLowerCase()];
    const red = /[hd]/i.test(match[2]);
    return `<span class="card ${small ? 'small ' : ''}${red ? 'red ' : ''}${reveal ? 'deal-flip' : ''}" aria-label="${safe(r + suit)}"><span>${safe(r)}</span><span class="suit">${suit}</span></span>`;
  }

  function seatMarkers(index, data) {
    const flags = [];
    if (index === data.dealerSeat) flags.push({ label: 'D' });
    if (index === data.smallBlindSeat) flags.push({ label: 'SB' });
    if (index === data.bigBlindSeat) flags.push({ label: 'BB' });
    const seat = data.seats?.[index];
    if (seat?.sittingOut) flags.push({ label: t('暂离 {count}/5', { count: Math.min(5, Math.max(0, Number(seat.awayHands) || 0)) }), className: 'away-marker' });
    else if (seat?.pendingSitOut) flags.push({ label: t('下手暂离'), className: 'away-marker' });
    else if (seat?.waitingNextHand) flags.push({ label: t('下手参与'), className: 'waiting-marker' });
    return flags.map((flag) => `<span class="marker ${flag.className || ''}">${safe(flag.label)}</span>`).join('');
  }

  function seatHtml(seat, index, data, mine = false) {
    const cards = mine ? data.hero?.cards : seat.shownCards;
    const inHand = Boolean(seat.inHand);
    const roundCommit = data.status === 'playing' && !data.runout && inHand
      ? `<span class="seat-round-commit" aria-label="${safe(t('本轮投入 {amount}', { amount: chipAmount(seat.streetCommit, data) }))}">${safe(t('本轮'))} <strong>${chipAmount(seat.streetCommit, data)}</strong></span>`
      : '';
    let visibleCards = '';
    if (Array.isArray(cards) && cards.length) visibleCards = cards.map((card) => cardHtml(card, !mine)).join('');
    else if (inHand) visibleCards = [cardHtml(null, !mine), cardHtml(null, !mine)].join('');
    const actionNames = { fold: '已弃牌', check: '已过牌', call: '已跟注', raise: '已加注', allIn: '全下' };
    const action = seat.folded ? t('已弃牌') : seat.sittingOut ? t('暂离 {count}/5 手', { count: Math.min(5, Math.max(0, Number(seat.awayHands) || 0)) }) : seat.pendingSitOut ? t('下手将暂离') : seat.waitingNextHand ? t('下手参与') : actionNames[seat.lastAction] ? t(actionNames[seat.lastAction]) : seat.lastAction || (seat.folded ? t('已弃牌') : seat.allIn ? t('全下') : seat.pendingRebuy ? t('补码待入账') : '');
    const ownHand = mine && Array.isArray(cards) && cards.length === 2 && data.hero?.handDisplay
      ? `<span class="seat-hand-badge ${Number(data.hero.handCategory) === 8 ? 'royal-hand' : ''}" title="${safe(hand(data.hero.handName || data.hero.handDisplay))}">${Number(data.hero.handCategory) === 8 ? '<span aria-hidden="true">👑</span>' : ''}${safe(hand(data.hero.handDisplay))}</span>` : '';
    const nickname = safe(seat.nickname || t('座位 {seat}', { seat: index + 1 }));
    const clock = data.status === 'playing' && !data.runout && data.actingSeat === index && Number.isFinite(Number(data.actionDeadline))
      ? `<div class="seat-clock" aria-label="${safe(t('当前玩家行动进度'))}"><i class="seat-clock-fill"></i></div>` : '';
    return `<div class="seat-cards">${visibleCards}</div><div class="seat-name"><span class="seat-nickname" title="${nickname}">${nickname}</span><span class="seat-markers">${seatMarkers(index, data)}</span></div><div class="seat-finance"><span class="seat-stack">${safe(chips.getUnit() === 'bb' ? chipAmount(seat.stack, data) : t('筹码 {amount}', { amount: chipAmount(seat.stack, data) }))}</span>${roundCommit}</div><div class="seat-action ${mine ? 'seat-action-self' : ''}"><span class="${seat.folded ? 'seat-fold-label' : ''}">${seat.folded ? '<span aria-hidden="true">×</span> ' : ''}${safe(action)}</span>${ownHand}</div>${clock}`;
  }

  function tableSeatSlot(index, anchor, capacity, spectator) {
    if (spectator && index === anchor) return { x: 50, y: 90, mx: 50, my: 88 };
    const rank = ((index - anchor + capacity) % capacity) - 1;
    const count = capacity - 1;
    const leftCount = Math.ceil((count - 1) / 2);
    const rightCount = count - 1 - leftCount;
    const sideY = { 1: [30], 2: [27, 82], 3: [13, 31, 82], 4: [12, 30, 66, 84] };
    let mobile;
    if (rank < leftCount) mobile = { x: 12, y: sideY[leftCount][leftCount - rank - 1] };
    else if (rank === leftCount) mobile = { x: 50, y: 9 };
    else {
      const rightRank = rank - leftCount - 1;
      mobile = { x: 88, y: rightCount === 1 ? 82 : sideY[rightCount][rightRank] };
    }
    const ring = [{ x: 24, y: 88 }, { x: 9, y: 64 }, { x: 9, y: 34 },
      { x: 25, y: 13 }, { x: 50, y: 9 }, { x: 75, y: 13 },
      { x: 91, y: 34 }, { x: 91, y: 64 }, { x: 76, y: 88 }];
    const along = rank * 8 / Math.max(1, count - 1);
    const before = ring[Math.floor(along)];
    const after = ring[Math.min(8, Math.ceil(along))];
    const mix = along - Math.floor(along);
    const desktop = { x: before.x + (after.x - before.x) * mix, y: before.y + (after.y - before.y) * mix };
    return { x: desktop.x, y: desktop.y, mx: mobile.x, my: mobile.y };
  }

  function runoutWinners(data, boardIndex) {
    const settled = Array.isArray(data.result?.runouts);
    const boardResult = (settled ? data.result.runouts : Array.isArray(data.runout?.boardResults) ? data.runout.boardResults : [])
      .find((item) => Number(item.boardIndex) === boardIndex);
    if (!boardResult) return '';
    const totals = new Map();
    for (const pot of boardResult.pots || []) {
      for (const winner of pot.winners || []) {
        const seat = Number(winner.seat);
        const previous = totals.get(seat);
        totals.set(seat, {
          nickname: winner.nickname || previous?.nickname || t('{seat} 号位', { seat: seat + 1 }),
          handDisplay: winner.handDisplay || previous?.handDisplay || '',
          handCategory: Number.isInteger(winner.handCategory) ? winner.handCategory : previous?.handCategory,
          amount: (previous?.amount || 0) + (Number(winner.amount) || 0)
        });
      }
    }
    if (!totals.size) return '';
    return `${settled ? '' : `<span class="runout-preview-label">${safe(t('本板赢家'))}</span>`}${[...totals.values()].map((winner) => `<span class="runout-payout"><span>${safe(winner.nickname)}</span><span class="${winner.handCategory === 8 ? 'royal-hand' : ''}">${winner.handCategory === 8 ? '<span aria-hidden="true">👑</span>' : ''}${safe(hand(winner.handDisplay))}</span><b>+${chipAmount(winner.amount, data)}</b></span>`).join('')}`;
  }

  function streetLabel(data, board, boardIndex) {
    if (!data.runout) return data.street ? t(names[data.street] || data.street) : t('盲注 {small} / {big}', { small: money(data.smallBlind ?? 10), big: money(data.bigBlind ?? 20) });
    const street = board.length >= 5 ? '河牌' : board.length >= 4 ? '转牌' : board.length >= 3 ? '翻牌' : '待翻牌';
    return Number(data.runout.times) === 2 ? t('第 {index} 次{street}', { index: boardIndex + 1, street: t(street) }) : t('跑马{street}', { street: t(street) });
  }

  function handResultHtml(data) {
    if (!isFinished(data) || !Array.isArray(data.result?.winners) || !data.result.winners.length) return '';
    const netOf = (winner) => winner.netProfit === null || winner.netProfit === undefined ? NaN : Number(winner.netProfit);
    const ordered = data.result.winners.map((winner, index) => ({ winner, index })).sort((a, b) => {
      const left = netOf(a.winner);
      const right = netOf(b.winner);
      if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
      return Number.isFinite(left) ? right - left || a.index - b.index : a.index - b.index;
    });
    const winners = ordered.map(({ winner }) => {
      const nickname = safe(winner.nickname || t('{seat} 号位', { seat: Number(winner.seat) + 1 }));
      const net = netOf(winner);
      const hasNet = Number.isFinite(net);
      const label = hasNet ? net < 0 ? t('净亏 −{amount}', { amount: chipAmount(Math.abs(net), data) }) : net > 0 ? t('净赢 +{amount}', { amount: chipAmount(net, data) }) : t('净赢 0')
        : t('分得 {amount}', { amount: chipAmount(winner.amount, data) });
      const tone = !hasNet ? 'is-gross' : net < 0 ? 'is-loss' : net > 0 ? 'is-profit' : 'is-even';
      return `<span class="hand-result-item ${tone}" role="listitem" aria-label="${nickname}，${safe(label)}"><span class="hand-result-name" title="${nickname}">${nickname}</span><strong>${safe(label)}</strong></span>`;
    }).join('');
    return `<span class="hand-result-title">${safe(t('本手结果'))}</span><div class="hand-result-list" role="list">${winners}</div>`;
  }

  function renderTable(data) {
    const capacity = Math.min(10, Math.max(4, Number(data.seatingCapacity) || Number(data.capacity) || 4));
    const seats = Array.isArray(data.seats) ? data.seats : [];
    const myIndex = Number.isInteger(data.hero?.seat) ? data.hero.seat : null;
    const runout = data.runout;
    const runoutBoards = Array.isArray(runout?.boards) ? [...runout.boards] : [];
    if (Number(runout?.times) === 2 && runoutBoards.length === 1) runoutBoards.push([]);
    const boardIndex = runout ? Math.min(Math.max(0, Number(runout.boardIndex) || 0), Math.max(0, runoutBoards.length - 1)) : 0;
    const board = runout && Array.isArray(runoutBoards[boardIndex]) ? runoutBoards[boardIndex] : Array.isArray(data.board) ? data.board : [];
    const felt = $('.felt');
    felt.classList.toggle('has-runout', Boolean(runout));
    felt.classList.toggle('seating-medium', capacity >= 5 && capacity <= 7);
    felt.classList.toggle('seating-seven', capacity === 7);
    felt.classList.toggle('seating-crowded', capacity >= 8);
    $('#room-code').textContent = data.roomCode || state.roomCode;
    $('#hand-label').textContent = data.handNo ? t('第 {handNo} 手', { handNo: data.handNo }) : t('等待开局');
    $('#street-label').textContent = streetLabel(data, board, boardIndex);
    $('#pot-label').textContent = t('底池 {amount}', { amount: chipAmount(data.pot, data) });
    const cards = $('#board-cards');
    const boardSignature = `${data.roomCode || state.roomCode}:${data.handNo}:${runout ? `runout-${boardIndex}` : 'normal'}:${board.join(',')}`;
    if (cards.dataset.signature !== boardSignature) {
      cards.innerHTML = [...board.map((card, index) => cardHtml(card, false, Boolean(runout && state.newRunoutCards.has(`${boardIndex}:${index}`)))), ...Array.from({ length: Math.max(0, 5 - board.length) }, () => `<span class="card slot" aria-label="${safe(t('未翻出的公共牌'))}"></span>`)].join('');
      cards.dataset.signature = boardSignature;
    }
    const votingOnEmptyBoard = runout && board.length === 0 && ['trailingVote', 'leaderVote'].includes(runout.phase);
    $('#board-caption').textContent = isFinished(data) ? '' : votingOnEmptyBoard ? t('跑马投票中 · 尚未翻公共牌')
      : runout ? (Number(runout.times) === 2 ? t('第 {index} / 2 次牌面', { index: boardIndex + 1 }) : t('跑马牌面')) : '';
    const handResult = $('#hand-result');
    const resultMarkup = handResultHtml(data);
    felt.classList.toggle('has-result', Boolean(resultMarkup));
    handResult.hidden = !resultMarkup;
    handResult.innerHTML = resultMarkup;
    const equity = $('#runout-equity');
    const equityRows = Array.isArray(runout?.equity) ? runout.equity : [];
    equity.hidden = isFinished(data) || equityRows.length === 0;
    if (!equity.hidden) equity.innerHTML = `<span class="equity-label">${safe(t(runout?.equityMethod === 'monteCarlo' ? '估计胜率' : '协商时胜率'))}</span>${equityRows.map((row) => {
      const nickname = seats[Number(row.seat)]?.nickname || t('{seat} 号位', { seat: Number(row.seat) + 1 });
      const percentage = Number.isFinite(Number(row.equityPct)) ? `${Math.round(Number(row.equityPct) * 10) / 10}%` : '—';
      return `<span class="equity-chip" title="${safe(nickname)}：${safe(percentage)}"><span class="equity-name">${safe(nickname)}</span><strong>${safe(percentage)}</strong></span>`;
    }).join('')}`;
    const lanes = $('#runout-lanes');
    lanes.hidden = !(Number(runout?.times) === 2 && runoutBoards.length > 1);
    if (!lanes.hidden) lanes.innerHTML = runoutBoards.slice(0, 2).map((lane, index) => {
      const winners = runoutWinners(data, index);
      const ownHand = data.hero?.runoutHandDisplays?.[index];
      return `<div class="runout-lane ${index === boardIndex ? 'active' : ''}"><strong>${safe(t('第 {index} 次牌面', { index: index + 1 }))}</strong><div class="cards">${[...(Array.isArray(lane) ? lane.map((card) => cardHtml(card, true)) : []), ...Array.from({ length: Math.max(0, 5 - (Array.isArray(lane) ? lane.length : 0)) }, () => `<span class="card small slot" aria-label="${safe(t('未翻出的公共牌'))}"></span>`)].join('')}</div>${ownHand?.label ? `<p class="runout-own-hand">${safe(t('我的牌型'))} <span class="${Number(ownHand.category) === 8 ? 'royal-hand' : ''}">${Number(ownHand.category) === 8 ? '<span aria-hidden="true">👑</span>' : ''}${safe(hand(ownHand.label))}</span></p>` : ''}${winners ? `<div class="runout-winner">${winners}</div>` : ''}</div>`;
    }).join('');
    const opponentSeats = $('#opponent-seats');
    const anchor = myIndex ?? capacity - 1;
    opponentSeats.innerHTML = Array.from({ length: capacity }, (_, index) => {
      if (index === myIndex) return '';
      const seat = seats[index];
      const slot = tableSeatSlot(index, anchor, capacity, myIndex === null);
      const placement = `--x:${slot.x}%;--y:${slot.y}%;--mx:${slot.mx}%;--my:${slot.my}%`;
      if (!seat) return myIndex !== null || (Number.isInteger(data.pendingCapacity) && index >= data.pendingCapacity)
        ? `<span class="table-empty-seat is-unavailable" data-seat="${index}" style="${placement}" aria-label="${safe(t('{seat} 号空位', { seat: index + 1 }))}">${safe(t('空位'))}</span>`
        : `<button class="table-empty-seat" type="button" data-seat="${index}" style="${placement}" ${data.pause ? 'disabled' : ''} aria-label="${safe(t('选择 {seat} 号空位', { seat: index + 1 }))}">${safe(t('＋ 入座'))}</button>`;
      const classes = ['opponent-seat', data.actingSeat === index ? 'active' : '', seat.folded ? 'folded' : '', seat.sittingOut ? 'sitting-out' : '', seat.waitingNextHand ? 'waiting-next' : ''].filter(Boolean).join(' ');
      return `<div class="${classes}" data-player-id="${safe(seat.playerId || '')}" data-seat="${index}" style="${placement}" aria-label="${safe(t('{name}，座位 {seat}', { name: seat.nickname, seat: index + 1 }))}">${seatHtml(seat, index, data)}</div>`;
    }).join('');
    opponentSeats.setAttribute('aria-label', t('环绕牌桌的玩家与空位'));
    const mySeat = $('#my-seat');
    if (myIndex !== null && seats[myIndex]) {
      mySeat.hidden = false;
      mySeat.dataset.playerId = seats[myIndex].playerId || '';
      mySeat.dataset.seat = String(myIndex);
      mySeat.className = `my-seat ${data.hero?.canAct ? 'active' : ''} ${seats[myIndex].folded ? 'folded' : ''} ${seats[myIndex].sittingOut ? 'sitting-out' : ''} ${seats[myIndex].waitingNextHand ? 'waiting-next' : ''}`;
      mySeat.innerHTML = seatHtml(seats[myIndex], myIndex, data, true);
    } else {
      mySeat.hidden = true;
      delete mySeat.dataset.playerId;
      delete mySeat.dataset.seat;
      mySeat.innerHTML = '';
    }
    const actor = seats[data.actingSeat];
    let notice = t('等待玩家坐下开局。');
    if (isFinished(data)) {
      const winners = data.result?.winners;
      const ownSeat = Number.isInteger(data.hero?.seat) ? seats[data.hero.seat] : null;
      const canReveal = Boolean(currentRevealable(data.hero, data.handNo) || (ownSeat && Array.isArray(data.hero?.cards) && data.hero.cards.length === 2 && !ownSeat.shownCards?.length));
      notice = t(canReveal ? '本手已结算。可选择亮出自己的底牌。' : '本手已结算。');
    }
    else if (runout?.phase === 'paused') notice = t('本手跑马已暂停，请房主检查本机服务。');
    else if (runout?.phase === 'trailingVote') notice = t('已全下，等待落后方选择跑马次数。');
    else if (runout?.phase === 'leaderVote') notice = t('等待领先方决定是否跑两次。');
    else if (runout?.phase === 'firstBoardPause') notice = t('第 1 次牌面已定，正在准备第 2 次牌面。');
    else if (runout?.phase === 'dealing') notice = t('正在翻第 {index} 次牌面。', { index: boardIndex + 1 });
    else if (actor) notice = data.hero?.canAct ? t('轮到你行动。') : t('轮到 {name} 行动。', { name: actor.nickname });
    else if (data.status === 'playing' || data.status === 'active') notice = t('牌局进行中。');
    $('#table-notice').textContent = notice;
  }

  function isFinished(data) { return Boolean(data.result) || ['finished', 'complete', 'ended'].includes(data.status); }
  function canStart(data) { return !data.hero?.canAct && (isFinished(data) || ['waiting', 'idle', 'ready'].includes(data.status)); }
  function currentRevealable(hero, handNo) {
    return (Array.isArray(hero?.revealableHands) ? hero.revealableHands : [])
      .find((hand) => Number(hand.handNo) === Number(handNo) && !hand.shown) || null;
  }

  function renderSeatPanel(data) {
    $('#seat-buyin-input').min = String(Math.max(2, Number(data.bigBlind) || 20));
    const mySeat = Number.isInteger(data.hero?.seat) ? data.hero.seat : null;
    const seats = Array.isArray(data.seats) ? data.seats : [];
    const capacity = Math.min(10, Math.max(4, Number(data.seatingCapacity) || Number(data.capacity) || 4));
    let chosen = state.seatDialogSeat;
    if (chosen !== null && (mySeat !== null || !Number.isInteger(chosen) || chosen < 0 || chosen >= capacity ||
        (Number.isInteger(data.pendingCapacity) && chosen >= data.pendingCapacity) || seats[chosen])) {
      state.seatDialogSeat = null;
      chosen = null;
    }
    const visible = chosen !== null && !data.pause;
    $('#seat-panel').hidden = !visible;
    $('#seat-backdrop').hidden = !visible;
    if (!visible) return;
    const occupied = seats.filter(Boolean).length;
    const handRunning = data.status === 'playing';
    $('#seat-title').textContent = t('坐到 {seat} 号位', { seat: chosen + 1 });
    $('#seat-count').textContent = t('{occupied} / {capacity} 人已入座', { occupied, capacity });
    $('#seat-note').textContent = t(handRunning ? '本手进行中入座，下手开始参与。' : '入座后可随时补码。');
    $('#seat-picker').innerHTML = `<button class="button primary full" type="button" data-seat="${chosen}">${safe(t('确认入座'))}</button>`;
  }

  function raiseSuggestion(data, fraction) {
    const pot = Math.max(0, Number(data.pot) || 0);
    return Math.round(pot * fraction);
  }

  function raisePreviewText(data, amount) {
    const currentBet = Math.max(0, Number(data.currentBet) || 0);
    const min = Math.max(0, Number(data.minRaiseTo) || 0);
    const max = Math.max(0, Number(data.hero?.maxRaiseTo) || 0);
    if (!Number.isSafeInteger(amount)) return t('请输入有效筹码数。');
    if (amount > max) return t('最多加注至 {amount}。', { amount: chipAmount(max, data) });
    if (amount < min && amount !== max) return max < min ? t('本手只能全下至 {amount}。', { amount: chipAmount(max, data) }) : t('最低加注至 {amount}。', { amount: chipAmount(min, data) });
    if (amount <= currentBet) return t('须高于当前下注 {amount}。', { amount: chipAmount(currentBet, data) });
    return '';
  }

  function defaultRaiseAmount(data) {
    const currentBet = Math.max(0, Number(data.currentBet) || 0);
    const min = Math.max(0, Number(data.minRaiseTo) || Number(data.bigBlind) || 20);
    const me = Number.isInteger(data.hero?.seat) ? data.seats?.[data.hero.seat] : null;
    const max = Math.max(0, Number(data.hero?.maxRaiseTo ?? (Number(me?.stack || 0) + Number(me?.streetCommit || 0))) || 0);
    return Math.min(max, Math.max(min, currentBet * 2));
  }

  function stepRaiseAmount(data, value, direction) {
    const min = Math.max(0, Number(data.minRaiseTo) || Number(data.bigBlind) || 20);
    const max = Math.max(0, Number(data.hero?.maxRaiseTo) || 0);
    const legalMin = Math.min(min, max);
    const base = Number.isSafeInteger(value) ? value : defaultRaiseAmount(data);
    return Math.max(legalMin, Math.min(max, base + (direction > 0 ? 50 : -50)));
  }

  function bettingControlsHtml(data) {
    const hero = data.hero || {};
    const me = Number.isInteger(hero.seat) ? data.seats?.[hero.seat] : null;
    const paused = data.pause && Number(data.pause.endAt) > Date.now() + state.clockOffset;
    const acting = Boolean(hero.canAct && !paused && !state.pending && !state.recovering && !data.runout && data.status === 'playing');
    const selected = preactions.getSelected();
    const foldEnabled = acting || (!state.pending && !state.recovering && preactions.canSelect('fold', data));
    const checkEnabled = acting || (!state.pending && !state.recovering && preactions.canSelect('check', data));
    const checkFoldEnabled = !hero.canAct && !state.pending && !state.recovering && preactions.canSelect('checkFold', data);
    const toCall = Math.max(0, Number(hero.toCall) || 0);
    const fold = `<button class="button danger action-fold" data-action="fold" ${hero.canAct ? '' : `data-preaction="fold" aria-pressed="${selected === 'fold'}"`} ${foldEnabled ? '' : 'disabled'}>${safe(t('弃牌'))}</button>`;
    const call = hero.canAct && toCall > 0
      ? `<button class="button secondary action-call" data-action="call" ${acting ? '' : 'disabled'}>${safe(t('跟注 {amount}', { amount: chipAmount(toCall, data) }))}</button>`
      : `<button class="button action-check" data-action="check" ${hero.canAct ? '' : `data-preaction="check" aria-pressed="${selected === 'check'}"`} ${checkEnabled ? '' : 'disabled'}>${safe(t('过牌'))}</button>`;
    const checkFold = `<button class="button action-checkfold" ${hero.canAct ? 'aria-pressed="false"' : `data-preaction="checkFold" aria-pressed="${selected === 'checkFold'}"`} ${checkFoldEnabled ? '' : 'disabled'} aria-label="${safe(t('自动过牌/弃牌'))}">${safe(t('过牌/弃牌'))}</button>`;
    const canRaise = acting && Boolean(hero.canRaise);
    const disabled = canRaise ? '' : 'disabled';
    const min = Number(data.minRaiseTo) || Number(data.bigBlind) || 20;
    const max = Math.max(0, Number(hero.maxRaiseTo ?? (Number(me?.stack || 0) + Number(me?.streetCommit || 0))) || 0);
    const minLegal = Math.min(min, max);
    const raiseContext = `${data.handNo}:${data.streetIndex ?? data.street}:${data.actingSeat}:${data.currentBet}`;
    const previousInput = $('#raise-amount');
    const previousRaise = previousInput?.dataset.actionContext === raiseContext ? previousInput.value : null;
    const initial = previousRaise !== null ? previousRaise : chips.inputValue(defaultRaiseAmount(data), data);
    const inputUnit = chips.getUnit();
    const verb = t('加码');
    const sizes = [{ fraction: 1 / 2, label: '1/2池' }, { fraction: 1, label: '1倍池' }];
    const sizeButtons = sizes.map(({ fraction, label }) => {
      const amount = raiseSuggestion(data, fraction);
      return `<button class="size-button" data-fraction="${fraction}" data-amount="${amount}" aria-pressed="false" type="button" ${disabled}>${safe(t(label))}</button>`;
    }).join('');
    const timebankEnabled = Boolean(hero.timebankEnabled);
    const canTimebank = !state.pending && !state.recovering && !paused && Boolean(hero.canUseTimebank || timebankEnabled);
    const timebank = `<button class="size-button action-timebank" data-timebank="${!timebankEnabled}" aria-pressed="${timebankEnabled}" type="button" ${canTimebank ? '' : 'disabled'} title="${safe(t('30秒后每10秒支付10筹码入池'))}" aria-label="${safe(t('付费加时'))}">${safe(t('加时'))}</button>`;
    return `${fold}${call}${checkFold}<div class="raise-control"><input id="raise-amount" class="amount-input" type="number" inputmode="${inputUnit === 'bb' ? 'decimal' : 'numeric'}" min="${chips.inputValue(minLegal, data)}" max="${chips.inputValue(max, data)}" step="${chips.inputStep(data)}" data-chip-unit="${inputUnit}" value="${safe(initial)}" data-action-context="${safe(raiseContext)}" aria-label="${safe(inputUnit === 'bb' ? t('输入{verb}BB数', { verb }) : t('输入{verb}筹码数', { verb }))}" ${disabled}>${inputUnit === 'bb' ? '<span class="raise-unit" aria-hidden="true">BB</span>' : ''}<button class="raise-step" data-step="-1" type="button" ${disabled} aria-label="${safe(t('减少50筹码'))}">−</button><button class="raise-step" data-step="1" type="button" ${disabled} aria-label="${safe(t('增加50筹码'))}">+</button><button class="button action-raise" data-action="raise" ${disabled}>${safe(verb)}</button></div><div class="raise-sizes">${timebank}${sizeButtons}<button class="size-button action-allin" data-fill="allin" type="button" title="${safe(t('先填入全下金额，再点{verb}确认', { verb }))}" ${disabled}>${safe(t('全押'))}</button></div>`;
  }

  function renderActions(data) {
    const hero = data.hero || {};
    const seated = Number.isInteger(hero.seat);
    const finished = isFinished(data);
    const autoStood = !seated && hero.lastPresenceEvent?.type === 'autoStand';
    const title = $('#action-title');
    const panel = $('#action-panel');
    const controls = $('#action-controls');
    const runout = data.status === 'playing' ? data.runout : null;
    panel.classList.toggle('is-special', Boolean(finished || runout));
    panel.classList.toggle('is-turn', Boolean(hero.canAct || hero.canChooseRunout || hero.canRespondRunout));
    panel.hidden = false;
    $('#to-call-label').textContent = '';
    if (state.recovering) {
      panel.classList.remove('is-turn');
      title.textContent = t('正在同步牌桌');
      controls.innerHTML = `<span class="muted-text">${safe(t('正在同步牌桌'))}</span>`;
      return;
    }
    if (data.pause && Number(data.pause.endAt) > Date.now() + state.clockOffset) {
      panel.classList.remove('is-turn');
      title.textContent = t('礼物展示中');
      controls.innerHTML = finished || runout ? '' : bettingControlsHtml(data);
      panel.hidden = Boolean(finished || runout);
      return;
    }
    if (finished) {
      title.textContent = t(autoStood ? '已转为观战' : '本手已结束');
      const mySeat = seated ? data.seats?.[hero.seat] : null;
      const revealable = currentRevealable(hero, data.handNo) || (seated && Array.isArray(hero.cards) && hero.cards.length === 2 && !(Array.isArray(mySeat?.shownCards) && mySeat.shownCards.length) ? { handNo: data.handNo } : null);
      controls.innerHTML = revealable ? `<button class="button secondary" data-command="reveal" data-hand="${Number(revealable.handNo)}">${safe(t('亮出我的牌'))}</button>` : '';
      panel.hidden = !revealable;
      return;
    }
    if (runout) {
      if (runout.phase === 'paused') {
        title.textContent = t('跑马已暂停');
        controls.innerHTML = `<span class="muted-text">${safe(t('本手跑马已暂停，请房主检查本机服务。'))}</span>`;
      } else if (runout.phase === 'trailingVote') {
        title.textContent = t('选择跑马次数');
        controls.innerHTML = hero.seat === runout.trailingSeat
          ? `<button class="button secondary" data-runout-choice="1">${safe(t('发一次'))}</button><button class="button primary" data-runout-choice="2">${safe(t('发两次'))}</button>`
          : `<span class="muted-text">${safe(t('等待落后方选择一次或两次。'))}</span>`;
      } else if (runout.phase === 'leaderVote') {
        title.textContent = t('决定是否跑两次');
        controls.innerHTML = hero.seat === runout.leadingSeat
          ? `<button class="button primary" data-runout-response="true">${safe(t('同意跑两次'))}</button><button class="button secondary" data-runout-response="false">${safe(t('只跑一次'))}</button>`
          : `<span class="muted-text">${safe(t('等待领先方决定。'))}</span>`;
      } else if (runout.phase === 'firstBoardPause') {
        title.textContent = t('第 1 次牌面已揭完');
        controls.innerHTML = `<span class="muted-text">${safe(t('即将翻第 2 次牌面'))}</span>`;
      } else {
        title.textContent = t(runout.phase === 'finished' ? '等待结算' : '正在跑马发牌');
        controls.innerHTML = `<span class="muted-text">${safe(runout.phase === 'finished' ? t('牌面已揭完') : t('第 {index} 次牌面', { index: Math.max(0, Number(runout.boardIndex) || 0) + 1 }))}</span>`;
      }
      panel.hidden = false;
      return;
    }
    title.textContent = t(hero.canAct ? '轮到你行动' : '牌局操作');
    if (hero.canAct) {
      const toCall = Math.max(0, Number(hero.toCall) || 0);
      $('#to-call-label').textContent = toCall ? t('需跟注 {amount}', { amount: chipAmount(toCall, data) }) : t('可免费过牌');
    }
    controls.innerHTML = bettingControlsHtml(data);
    if (canStart(data) && seated && !hero.sittingOut && !hero.pendingSitOut && data.nextHandAt) {
      controls.innerHTML += `<button class="button primary" data-command="nextHand">${safe(t('立即开始牌局'))}</button>`;
    }
  }

  function renderSidebar(data) {
    const hero = data.hero || {};
    const seated = Number.isInteger(hero.seat);
    const me = seated ? data.seats?.[hero.seat] : null;
    const capacity = Math.min(10, Math.max(4, Number(data.capacity) || 4));
    const seatingCapacity = Math.min(10, Math.max(capacity, Number(data.seatingCapacity) || capacity));
    const occupied = (data.seats || []).filter(Boolean).length;
    $('#room-summary').innerHTML = `<span>${safe(t('座位'))}</span><strong>${occupied} / ${seatingCapacity}</strong><span>${safe(t('观战人数'))}</span><strong>${money(data.spectatorCount)}</strong><span>${safe(t('盲注'))}</span><strong>${chipAmount(data.smallBlind ?? 10, data)} / ${chipAmount(chips.getBlind(data), data)}</strong>${me ? `<span>${safe(t('你的筹码'))}</span><strong>${chipAmount(me.stack, data)}</strong><span>${safe(t('你的状态'))}</span><strong>${safe(hero.sittingOut ? t('暂离 {count}/5 手', { count: Math.min(5, Math.max(0, Number(hero.awayHands) || 0)) }) : t(hero.pendingSitOut ? '下手暂离' : hero.waitingNextHand ? '下手参与' : '在座'))}</strong>` : ''}`;
    const pending = Number(hero.pendingRebuy ?? me?.pendingRebuy) || 0;
    const pendingUnload = Number(hero.pendingUnload ?? me?.pendingUnload) || 0;
    const pendingSent = Number(hero.pendingGiftSent ?? me?.pendingGiftSent) || 0;
    const pendingReceived = Number(hero.pendingGiftReceived ?? me?.pendingGiftReceived) || 0;
    const controls = [];
    if (seated) {
      const canUnload = !data.pause && (data.status === 'playing' || Number(hero.spendableStack ?? me?.stack ?? 0) >= 2000);
      const pendingParts = [[pending, '补码'], [pendingUnload, '卸码'], [pendingSent, '送礼'], [pendingReceived, '收礼']]
        .filter(([amount]) => amount > 0).map(([amount, label]) => t('{label} {amount}', { label: t(label), amount: chipAmount(amount, data) }));
      controls.push(`<div class="room-chip-actions"><button class="button secondary compact" type="button" data-command="rebuy" ${data.pause ? 'disabled' : ''}>${safe(t('{label} {amount}', { label: t('补码'), amount: chipAmount(2000, data) }))}</button><button class="button secondary compact" type="button" data-command="unload" ${canUnload ? '' : `disabled title="${safe(t('可用筹码不足 2,000'))}"`}>${safe(t('{label} {amount}', { label: t('卸码'), amount: chipAmount(2000, data) }))}</button>${pendingParts.length ? `<small>${safe(t('本手待结算：{items}', { items: pendingParts.join(' · ') }))}</small>` : ''}</div>`);
      $('#secondary-presence').innerHTML = `<button class="quiet-button" type="button" data-command="${hero.sittingOut || hero.pendingSitOut ? 'return' : 'sitOut'}" ${data.pause ? 'disabled' : ''}>${safe(t(hero.sittingOut || hero.pendingSitOut ? '返回牌桌' : '暂时离席'))}</button><button class="quiet-button" type="button" data-command="stand" ${data.pause || cannotLeaveSeatDuringHand(data) ? `disabled title="${safe(t('本手结算后才能离座'))}"` : ''}>${safe(t('离开座位'))}</button>`;
    } else {
      $('#secondary-presence').innerHTML = '';
    }
    if (!seated) {
      const nextCapacity = Number.isInteger(data.pendingCapacity) ? data.pendingCapacity : capacity;
      const existingCapacity = $('#capacity-change');
      const capacityDraft = existingCapacity?.dataset.roomCode === String(data.roomCode) &&
        existingCapacity?.dataset.serverCapacity === String(nextCapacity) ? Number(existingCapacity.value) : nextCapacity;
      controls.push(`<label class="field" for="capacity-change"><span>${safe(t('调整牌桌人数'))}</span><span class="inline-control"><select id="capacity-change" data-room-code="${safe(data.roomCode)}" data-server-capacity="${nextCapacity}" aria-label="${safe(t('调整牌桌人数'))}" ${data.pause ? 'disabled' : ''}>${Array.from({ length: 7 }, (_, i) => i + 4).map((count) => `<option value="${count}" ${count === capacityDraft ? 'selected' : ''}>${safe(t('{count} 人', { count }))}</option>`).join('')}</select><button class="button secondary compact" type="button" data-command="setCapacity" ${data.pause ? 'disabled' : ''}>${safe(t('确定'))}</button></span></label>`);
      const blind = Math.max(2, Number(data.pendingBigBlind ?? data.bigBlind) || 20);
      const existingBlind = $('#big-blind-change');
      const blindDraft = existingBlind?.dataset.roomCode === String(data.roomCode) && existingBlind?.dataset.serverBlind === String(blind)
        ? existingBlind.value : String(blind);
      controls.push(`<label class="field blind-setting" for="big-blind-change"><span>${safe(t('调整大盲（筹码）'))}</span><span class="inline-control"><input id="big-blind-change" type="number" inputmode="numeric" min="2" max="1000000" step="1" value="${safe(blindDraft)}" data-room-code="${safe(data.roomCode)}" data-server-blind="${blind}" aria-label="${safe(t('调整大盲（筹码）'))}" ${data.pause ? 'disabled' : ''}><button class="button secondary compact" type="button" data-command="setBigBlind" ${data.pause ? 'disabled' : ''}>${safe(t('确定'))}</button></span></label>`);
    }
    const nextSettings = [];
    if (Number.isInteger(data.pendingCapacity)) nextSettings.push(t('人数 {count}', { count: data.pendingCapacity }));
    if (Number.isInteger(data.pendingBigBlind)) nextSettings.push(t('大盲 {amount}', { amount: money(data.pendingBigBlind) }));
    if (nextSettings.length) controls.push(`<p class="small-note pending-table-settings">${safe(t('下手设置：{items}', { items: nextSettings.join(' · ') }))}</p>`);
    const financial = hero.lastFinancialNotice;
    const financialText = financial?.message || (financial?.type === 'unloadCanceled' ? '本手结算后筹码不足，排队卸码已取消。' : '');
    if (financialText) controls.push(`<p class="small-note financial-note">${safe(message(financialText))}</p>`);
    $('#room-controls').innerHTML = controls.join('');
    $('#switch-player').disabled = Boolean(data.pause) || (seated && cannotLeaveSeatDuringHand(data));
    $('#switch-player').title = data.pause ? t('礼物展示结束后可切换玩家') : $('#switch-player').disabled ? t('本手结束后可切换玩家') : '';
    $('#recovery-display').value = state.token;
  }

  function renderLedger(data) {
    const ledger = Array.isArray(data.ledger) ? data.ledger : Array.isArray(data.ledger?.players) ? data.ledger.players : [];
    $('#ledger-content').innerHTML = ledger.length ? ledger.map((person) => {
      const rebuyCount = Number(person.rebuyCount ?? person.rebuys) || 0;
      const rebuyTotal = Number(person.rebuyTotal ?? person.rebuyChips) || 0;
      const profit = Number(person.profitLoss ?? person.pnl ?? person.net) || 0;
      return `<div class="ledger-row"><strong>${safe(person.nickname || person.name || t('玩家'))}</strong><strong class="${profit >= 0 ? 'profit' : 'loss'}">${signed(profit, data)}</strong><small>${safe(t('带入 {buyIn} · 补码 {count} 次 / {rebuy}', { buyIn: chipAmount(person.buyInTotal, data), count: rebuyCount, rebuy: chipAmount(rebuyTotal, data) }))}</small><small>${safe(t('当前 {amount}', { amount: chipAmount(person.stack, data) }))}${person.cashOutTotal ? ` · ${safe(t('已带走 {amount}', { amount: chipAmount(person.cashOutTotal, data) }))}` : ''}</small><small>${safe(t('送花 {sent} · 收花 {received}', { sent: chipAmount(person.giftSentTotal, data), received: chipAmount(person.giftReceivedTotal, data) }))}</small><small>${safe(t('礼物净额 {amount}', { amount: signed(person.giftNet, data) }))}</small></div>`;
    }).join('') : `<p class="ledger-empty">${safe(t('暂无筹码记录。'))}</p>`;
  }

  function renderFairness(data) {
    const fair = data.fairness;
    if (!fair) {
      $('#fairness-content').innerHTML = `<p class="ledger-empty">${safe(t('本房间还没有发牌记录。'))}</p>`;
      return;
    }
    const short = (value) => value ? `${String(value).slice(0, 12)}…${String(value).slice(-8)}` : '—';
    $('#fairness-content').innerHTML = `<p class="small-note">${safe(t('每手由 UTC 时间和系统加密随机数生成独立牌堆。承诺与证明可核对已公开牌和开局牌堆的一致性，不能单凭它们证明随机源绝对不可操纵。'))}</p><dl class="fairness-list"><dt>${safe(t('发牌时间（UTC）'))}</dt><dd>${safe(fair.utc)}</dd><dt>${safe(t('牌堆承诺'))}</dt><dd><code title="${safe(fair.deckRoot)}">${safe(short(fair.deckRoot))}</code> <button type="button" class="mini-button" data-copy-proof="deckRoot">${safe(t('复制'))}</button></dd><dt>${safe(t('种子承诺'))}</dt><dd><code title="${safe(fair.seedCommitment)}">${safe(short(fair.seedCommitment))}</code> <button type="button" class="mini-button" data-copy-proof="seedCommitment">${safe(t('复制'))}</button></dd><dt>${safe(t('已公开牌的证明'))}</dt><dd>${safe(t('{count} 张', { count: Array.isArray(fair.visibleCardProofs) ? fair.visibleCardProofs.length : Number(fair.visibleCardCount) || 0 }))}</dd></dl>`;
  }

  function render() {
    const data = state.data;
    if (!data) return;
    renderTable(data);
    renderSeatPanel(data);
    renderActions(data);
    renderSidebar(data);
    renderLedger(data);
    renderFairness(data);
    details?.update(data);
    updateGiftPicker(data);
    renderGiftActivity(data);
    updateTimers();
    if (data.pause?.effect) showGiftEffect(data.pause.effect);
  }

  function refreshLiveEffectsLanguage() {
    const overlay = $('#room-effect');
    if (!overlay.hidden) {
      const welcome = overlay.classList.contains('is-fireworks');
      const label = t(welcome ? '欢迎可可姐' : '收手吧Kelly');
      const visible = overlay.querySelector('.effect-welcome, .effect-pixel-fallback');
      if (visible) visible.textContent = label;
      const accessible = overlay.querySelector('.effect-accessible');
      if (accessible) accessible.textContent = t(welcome ? '欢迎可可姐' : '收手吧Kelly🥹');
      if (!welcome) {
        const face = overlay.querySelector('.effect-pixel-face');
        if (face) face.setAttribute('aria-label', t('像素🥹表情'));
        drawPixelWords(overlay.querySelector('canvas'), label);
      }
    }
    for (const record of giftEffects.active.values()) {
      const { effect, node } = record;
      if (effect.kind === 'sneak') {
        record.phrase = '';
        continue;
      }
      const label = t(effect.settlementPending ? '{name} 送给 {recipient} ×{quantity}，{amount} 筹码，手末结算' : '{name} 送给 {recipient} ×{quantity}，{amount} 筹码', {
        name: effect.sender?.nickname || t('玩家'), recipient: effect.recipient?.nickname || t('玩家'),
        quantity: money(effect.quantity), amount: money(effect.cost)
      });
      const accessible = node.querySelector('.effect-accessible');
      if (accessible) accessible.textContent = label;
      const pending = effect.settlementPending ? t('待结算') : '';
      const from = node.querySelector('.gift-transfer-from');
      const to = node.querySelector('.gift-transfer-to');
      if (from) from.textContent = `${pending} −${money(effect.cost)}`;
      if (to) to.textContent = `${pending} +${money(effect.cost)}`;
      const badge = node.querySelector('.gift-fly-bouquet strong');
      if (badge) badge.textContent = `${t('×{quantity} · {amount} 筹码', { quantity: money(effect.quantity), amount: money(effect.cost) })}${effect.settlementPending ? ` ${t('（待结算）')}` : ''}`;
      const grand = node.querySelector('.gift-grand-scene');
      if (grand) {
        const names = grand.querySelector('strong');
        const amount = grand.querySelector('span:last-child');
        if (names) names.textContent = t('{name} 致 {recipient}', { name: effect.sender?.nickname || t('玩家'), recipient: effect.recipient?.nickname || t('玩家') });
        if (amount) amount.textContent = `${t('×{quantity} 束 · {amount} 筹码', { quantity: money(effect.quantity), amount: money(effect.cost) })}${effect.settlementPending ? ` · ${t('手末结算')}` : ''}`;
      }
    }
  }

  $('#chip-unit-select').addEventListener('change', (event) => {
    const nextUnit = event.target.value === 'bb' ? 'bb' : 'chips';
    if (nextUnit === chips.getUnit()) return;
    const input = $('#raise-amount');
    const wasFocused = document.activeElement === input;
    const chipValue = chips.toChips(input?.value, state.data, input?.dataset.chipUnit);
    chips.setUnit(nextUnit);
    // Preserve the same wager across units, including through the next state repaint.
    if (input) {
      input.value = chips.inputValue(chipValue, state.data);
      input.dataset.chipUnit = nextUnit;
    }
    state.newRunoutCards.clear();
    if (state.data) render();
    if (wasFocused) $('#raise-amount')?.focus();
  });

  document.addEventListener('poker-language-change', () => {
    const raise = $('#raise-amount');
    const raiseValue = raise?.value;
    const raiseFocused = document.activeElement === raise;
    const giftCount = $('#gift-count').value;
    const recipient = $('#gift-recipient').value;
    const buyIn = $('#seat-buyin-input').value;
    const nickname = $('#nickname-input').value;
    const roomCode = $('#room-code-input').value;
    i18n.applyStatic();
    $('#enter-button').textContent = t(state.mode === 'create' ? '开设房间' : '进入房间');
    $('#spectate-button').textContent = t(state.mode === 'create' ? '开房并观战' : '进入房间观战');
    $('#connection').textContent = t($('#connection').dataset.labelKey || '准备连接');
    const error = $('#lobby-error');
    if (error.dataset.rawMessage) error.textContent = message(error.dataset.rawMessage);
    $('#board-cards').dataset.signature = '';
    state.newRunoutCards.clear();
    $('#gift-recipient').dataset.signature = '';
    giftPicker.recipientId = recipient || giftPicker.recipientId;
    if (state.data) render();
    refreshSavedIdentity();
    $('#gift-count').value = giftCount;
    $('#seat-buyin-input').value = buyIn;
    $('#nickname-input').value = nickname;
    $('#room-code-input').value = roomCode;
    if (raiseValue !== undefined && $('#raise-amount')) {
      $('#raise-amount').value = raiseValue;
      if (raiseFocused) $('#raise-amount').focus();
    }
    if (recipient && [...$('#gift-recipient').options].some((option) => option.value === recipient)) $('#gift-recipient').value = recipient;
    refreshLiveEffectsLanguage();
    if (!$('#toast').hidden) $('#toast').hidden = true;
  });

  async function copyText(value, success) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(success);
    } catch {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      try {
        showToast(document.execCommand('copy') ? success : t('复制失败，可展开“手动查看”选择恢复码。'));
      } catch { showToast(t('复制失败，可展开“手动查看”选择恢复码。')); }
      field.remove();
    }
  }

  for (const button of document.querySelectorAll('.mode-button')) button.addEventListener('click', () => setMode(button.dataset.mode));
  $('#room-code-input').addEventListener('input', refreshSavedIdentity);
  $('#lobby-form').addEventListener('submit', (event) => { event.preventDefault(); void enterRoom(); });
  $('#spectate-button').addEventListener('click', () => { void enterRoom(); });
  $('#leave-button').addEventListener('click', leaveRoom);
  $('#copy-room').addEventListener('click', () => { void copyText(state.roomCode, t('房间号已复制。')); });
  $('#copy-link').addEventListener('click', () => { void copyText(`${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomCode)}`, t('邀请链接已复制。')); });
  $('#copy-recovery').addEventListener('click', () => { if (state.token) void copyText(state.token, t('恢复码已复制，请仅自己保存。')); });
  $('#switch-player').addEventListener('click', () => { void switchPlayer(); });
  $('#sound-open').addEventListener('click', () => {
    if (!$('#sound-panel').hidden) closeSoundPanel();
    else {
      syncSoundControls();
      $('#sound-panel').hidden = false;
      $('#sound-open').setAttribute('aria-expanded', 'true');
    }
  });
  $('#sound-close').addEventListener('click', closeSoundPanel);
  $('#sound-enabled').addEventListener('change', (event) => {
    sounds?.setEnabled(event.target.checked);
    if (event.target.checked) void sounds?.unlock();
    syncSoundControls();
  });
  $('#sound-volume').addEventListener('input', (event) => {
    sounds?.setVolume(Number(event.target.value) / 100);
    syncSoundControls();
  });
  $('#sound-preview').addEventListener('click', async () => {
    const ready = await sounds?.unlock(true);
    if (ready && sounds.play('turn')) sounds.play('raise', { delay: 320 });
    else if (sounds?.getSettings().enabled && sounds.getSettings().volume > 0) {
      showToast(t('浏览器暂未允许播放，请再点一次试听。'));
    }
    syncSoundControls();
  });
  document.addEventListener('poker-sound-settings-change', syncSoundControls);
  document.addEventListener('poker-language-change', syncSoundControls);
  document.addEventListener('click', (event) => {
    if (!$('#sound-panel').hidden && !$('.topbar-right').contains(event.target)) closeSoundPanel();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.roomCode) {
      state.soundResumeAt = giftNow();
      recoverNetwork();
    }
  });
  window.addEventListener('online', recoverNetwork);
  $('#gift-open').addEventListener('click', () => { if (giftPicker.open) closeGiftPicker(); else openGiftPicker(); });
  $('#gift-close').addEventListener('click', () => closeGiftPicker());
  $('#gift-backdrop').addEventListener('click', () => closeGiftPicker());
  $('#seat-close').addEventListener('click', closeSeatDialog);
  $('#seat-backdrop').addEventListener('click', closeSeatDialog);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#sound-panel').hidden) closeSoundPanel();
    else if (giftPicker.open) closeGiftPicker();
    else if (state.seatDialogSeat !== null) closeSeatDialog();
  });
  $('#gift-recipient').addEventListener('change', (event) => { giftPicker.recipientId = event.target.value; updateGiftPicker(); });
  $('#gift-count').addEventListener('input', () => updateGiftPicker());
  for (const button of document.querySelectorAll('[data-gift-count]')) button.addEventListener('click', () => {
    $('#gift-count').value = button.dataset.giftCount;
    updateGiftPicker();
  });
  for (const button of document.querySelectorAll('[data-rose-type]')) button.addEventListener('click', () => {
    giftPicker.roseType = button.dataset.roseType;
    updateGiftPicker();
  });
  $('#gift-send-bouquet').addEventListener('click', async () => {
    updateGiftPicker();
    if ($('#gift-send-bouquet').disabled) return;
    const recipientId = $('#gift-recipient').value;
    const quantity = giftQuantity();
    if (await idempotentCommand({ type: 'gift', recipientId, quantity, roseType: giftPicker.roseType })) closeGiftPicker();
  });
  $('#gift-send-sneak').addEventListener('click', async () => {
    updateGiftPicker();
    if ($('#gift-send-sneak').disabled) return;
    if (await idempotentCommand({ type: 'sneak' })) closeGiftPicker();
  });
  $('#recovery-display').addEventListener('focus', (event) => event.target.select());
  $('#fairness-content').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-copy-proof]');
    if (button) void copyText(state.data?.fairness?.[button.dataset.copyProof] || '', t('发牌承诺已复制。'));
  });
  $('#seat-picker').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-seat]');
    if (!button || button.disabled) return;
    const buyIn = Number($('#seat-buyin-input').value);
    const minimum = Math.max(2, Number(state.data?.bigBlind) || 20);
    if (!Number.isSafeInteger(buyIn) || buyIn < minimum || buyIn > 1000000) return showToast(t('带入筹码须为 {min} 至 1,000,000 的整数。', { min: money(minimum) }));
    void command({ type: 'sit', seat: Number(button.dataset.seat), buyIn }).then((ok) => { if (ok) closeSeatDialog(); });
  });
  $('#opponent-seats').addEventListener('click', (event) => {
    const button = event.target.closest('button.table-empty-seat[data-seat]');
    if (button && !button.disabled) openSeatDialog(Number(button.dataset.seat));
  });
  $('#action-controls').addEventListener('click', (event) => {
    const pressed = event.target.closest('button');
    if (pressed?.disabled || state.pending || state.recovering) return;
    const preaction = event.target.closest('button[data-preaction]');
    if (preaction && state.data) {
      preactions.toggle(preaction.dataset.preaction, state.data);
      renderActions(state.data);
      return;
    }
    const timebank = event.target.closest('button[data-timebank]');
    if (timebank) {
      void command({ type: 'timebank', enabled: timebank.dataset.timebank === 'true' });
      return;
    }
    const checkFold = event.target.closest('button[data-check-fold]');
    if (checkFold) {
      const kind = window.PokerPreactions.actionFor('checkFold', state.data);
      if (kind) void command({ type: 'action', action: kind });
      return;
    }
    const step = event.target.closest('button[data-step]');
    if (step) {
      const input = $('#raise-amount');
      if (input && state.data) {
        const value = chips.toChips(input.value, state.data, input.dataset.chipUnit);
        input.value = chips.inputValue(stepRaiseAmount(state.data, value, Number(step.dataset.step)), state.data, input.dataset.chipUnit);
        for (const button of document.querySelectorAll('.size-button[data-fraction]')) button.setAttribute('aria-pressed', 'false');
      }
      return;
    }
    const runoutChoice = event.target.closest('button[data-runout-choice]');
    if (runoutChoice) {
      void command({ type: 'runoutChoice', times: Number(runoutChoice.dataset.runoutChoice) });
      return;
    }
    const runoutResponse = event.target.closest('button[data-runout-response]');
    if (runoutResponse) {
      void command({ type: 'runoutResponse', accept: runoutResponse.dataset.runoutResponse === 'true' });
      return;
    }
    const allInFill = event.target.closest('button[data-fill="allin"]');
    if (allInFill) {
      const input = $('#raise-amount');
      if (input && state.data) {
        input.value = chips.inputValue(state.data.hero?.maxRaiseTo, state.data, input.dataset.chipUnit);
        for (const button of document.querySelectorAll('.size-button[data-fraction]')) button.setAttribute('aria-pressed', 'false');
        showToast(t('已填入全下金额 {amount}；点“{verb}”确认。', { amount: chipAmount(state.data.hero?.maxRaiseTo), verb: t('加码') }));
      }
      return;
    }
    const size = event.target.closest('button[data-fraction]');
    if (size) {
      const input = $('#raise-amount');
      if (input && state.data) input.value = chips.inputValue(size.dataset.amount, state.data, input.dataset.chipUnit);
      for (const button of document.querySelectorAll('.size-button[data-fraction]')) button.setAttribute('aria-pressed', String(button === size));
      return;
    }
    const action = event.target.closest('button[data-action]');
    if (action) {
      const kind = action.dataset.action;
      const input = $('#raise-amount');
      const amount = kind === 'raise' ? chips.toChips(input?.value, state.data, input?.dataset.chipUnit) : undefined;
      if (kind === 'raise') {
        const currentBet = Number(state.data?.currentBet) || 0;
        const min = Number(state.data?.minRaiseTo) || 0;
        const max = Number(state.data?.hero?.maxRaiseTo) || 0;
        if (!Number.isSafeInteger(amount) || amount <= currentBet || amount > max || (amount < min && amount !== max)) {
          return showToast(raisePreviewText(state.data, amount));
        }
      }
      void command({ type: 'action', action: kind, ...(amount === undefined ? {} : { amount }) });
      return;
    }
    const button = event.target.closest('button[data-command]');
    if (button) void command({ type: button.dataset.command, ...(button.dataset.hand ? { handNo: Number(button.dataset.hand) } : {}) });
  });
  $('#action-controls').addEventListener('input', (event) => {
    if (event.target.id !== 'raise-amount') return;
    for (const button of document.querySelectorAll('.size-button[data-fraction]')) button.setAttribute('aria-pressed', 'false');
  });
  $('#room-controls').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-command]');
    if (!button || button.disabled) return;
    const type = button.dataset.command;
    if (type === 'rebuy') void idempotentCommand({ type, amount: 2000 });
    else if (type === 'unload') void idempotentCommand({ type });
    else if (type === 'setCapacity') void command({ type, capacity: Number($('#capacity-change').value) });
    else if (type === 'setBigBlind') {
      const raw = $('#big-blind-change')?.value.trim() || '';
      const amount = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amount) || amount < 2 || amount > 1000000) return showToast(t('大盲须为 2 至 1,000,000 的整数。'));
      void command({ type, amount });
    }
    else void command({ type, ...(button.dataset.hand ? { handNo: Number(button.dataset.hand) } : {}) });
  });
  $('#secondary-room-actions').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-command]');
    if (button && !button.disabled) void command({ type: button.dataset.command });
  });

  $('#chip-unit-select').value = chips.getUnit();
  $('#nickname-input').value = stored('poker-last-nickname');
  syncSoundControls();
  const invited = new URLSearchParams(location.search).get('room') || stored('poker-last-room');
  if (invited) {
    const code = invited.trim().toUpperCase();
    $('#room-code-input').value = code;
    setMode('join');
    const token = stored(tokenKey(code));
    if (token) {
      request(`/api/rooms/${encodeURIComponent(code)}/state`, { token }).then((response) => {
        if (!state.resumeCancelled) openRoom(code, token, response.state || response);
      }).catch((cause) => {
        if (state.resumeCancelled) return;
        if (isRoomClosedError(cause)) {
          closeExpiredRoom(code);
          return;
        }
        if (cause.status === 401) { forget(tokenKey(code)); forget(nickKey(code)); refreshSavedIdentity(); }
        if ((cause.status === 401 || cause.status === 404) && stored('poker-last-room') === code) forget('poker-last-room');
        const error = $('#lobby-error');
        error.dataset.rawMessage = cause.message || '暂时无法连接房间，请稍后刷新。';
        error.textContent = message(error.dataset.rawMessage);
        error.hidden = false;
        setConnection(cause.status ? '准备连接' : '连接中断', cause.status ? '' : 'offline');
      });
    }
  }
})();
