import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cardLabel, cardProof, compareValues, describeHandValue, evaluateBest, HAND_NAMES, makeFairDeck, STREET_NAMES } from './engine.js';

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const MAX_BIG_BLIND = 1_000_000;
export const DEFAULT_BUY_IN = 2000;
export const ACTION_TIME_MS = 35_000;
export const ACTION_DISPLAY_TIME_MS = 30_000;
export const ACTION_GRACE_MS = ACTION_TIME_MS - ACTION_DISPLAY_TIME_MS;
export const TIMEBANK_BLOCK_MS = 10_000;
export const TIMEBANK_BLOCK_COST = 10;
export const NEXT_HAND_DELAY_MS = 5_000;
export const VOLUNTARY_REVEAL_DELAY_MS = 5_000;
export const RUNOUT_VOTE_MS = 15_000;
export const RUNOUT_TURN_MS = 5_000;
export const RUNOUT_RIVER_MS = 10_000;
export const RUNOUT_PAUSE_MS = 5_000;
export const PREFLOP_EQUITY_SAMPLES = 20_000;
export const BOUQUET_COST = 50;
export const MAX_BOUQUETS = 20_000;
export const GRAND_DISPLAY_MS = 8_000;
export const GRAND_FLIGHT_MS = 2_000;
export const GRAND_COOLDOWN_MS = 60_000;
export const ROOM_IDLE_MS = 24 * 60 * 60 * 1_000;
export const ROOM_CLOSED_MESSAGE = '房间连续 24 小时未开局，已自动关闭。';
const MAX_CHIPS = 1_000_000;
const RECEIPT_LIMIT = 1_000;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The exposed equity uses only live players' face-up cards and the public board.
// Folded cards, burn cards and the committed deck order remain unknown to it.
export function calculateShowdownEquity(players, board) {
  if (![0, 3, 4, 5].includes(board.length) || players.length < 2) {
    throw new Error('胜率计算需要合法公共牌和至少两名玩家');
  }
  const known = new Set([...board, ...players.flatMap(player => player.hole)]);
  const unseen = Array.from({ length: 52 }, (_, card) => card).filter(card => !known.has(card));
  const scores = players.map(player => ({ seat: player.seat, outright: 0, tied: 0, share: 0 }));
  let scenarios = 0;
  const score = additional => {
    const completeBoard = [...board, ...additional];
    const values = players.map(player => evaluateBest([...player.hole, ...completeBoard]));
    let best = values[0], winners = [0];
    for (let index = 1; index < values.length; index++) {
      const comparison = compareValues(values[index], best);
      if (comparison > 0) { best = values[index]; winners = [index]; }
      else if (comparison === 0) winners.push(index);
    }
    scenarios++;
    for (const winner of winners) {
      scores[winner].share += 1 / winners.length;
      if (winners.length === 1) scores[winner].outright++;
      else scores[winner].tied++;
    }
  };
  if (board.length === 0) {
    // Independent, reproducible public-information simulation. It never reads
    // the committed dealing deck, its seed, burns, or any folded private cards.
    const canonical = JSON.stringify(players.map(player => ({ seat: player.seat,
      hole: [...player.hole].sort((a, b) => a - b) })).sort((a, b) => a.seat - b.seat));
    const key = createHash('sha256').update('holdem-equity-monte-carlo-v1\0').update(canonical).digest();
    let counter = 0, chunk = Buffer.alloc(0), offset = 0;
    const random32 = () => {
      if (offset + 4 > chunk.length) {
        const input = Buffer.alloc(8);
        input.writeBigUInt64BE(BigInt(counter++));
        chunk = createHmac('sha256', key).update(input).digest();
        offset = 0;
      }
      const value = chunk.readUInt32BE(offset);
      offset += 4;
      return value;
    };
    const randomInt = max => {
      const ceiling = 0x100000000 - (0x100000000 % max);
      for (;;) {
        const value = random32();
        if (value < ceiling) return value % max;
      }
    };
    for (let sample = 0; sample < PREFLOP_EQUITY_SAMPLES; sample++) {
      const pool = unseen.slice(), additional = [];
      for (let index = 0; index < 5; index++) {
        const swap = index + randomInt(pool.length - index);
        [pool[index], pool[swap]] = [pool[swap], pool[index]];
        additional.push(pool[index]);
      }
      score(additional);
    }
  } else if (board.length === 3) {
    for (let first = 0; first < unseen.length - 1; first++)
      for (let second = first + 1; second < unseen.length; second++) score([unseen[first], unseen[second]]);
  } else if (board.length === 4) {
    for (const card of unseen) score([card]);
  } else score([]);
  const pct = count => Math.round(count * 10000 / scenarios) / 100;
  // Round shared equity as a group so the displayed percentages sum to 100.00.
  const rawHundredths = scores.map(item => item.share * 10000 / scenarios);
  const equityHundredths = rawHundredths.map(Math.floor);
  let remaining = 10000 - equityHundredths.reduce((sum, amount) => sum + amount, 0);
  const byRemainder = rawHundredths.map((amount, index) => ({ index, fraction: amount - Math.floor(amount) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remaining; index++) equityHundredths[byRemainder[index % byRemainder.length].index]++;
  return {
    scenarios, scores, method: board.length === 0 ? 'monteCarlo' : 'exact',
    errorPct: board.length === 0 ? 1 : 0,
    equity: scores.map((item, index) => ({ seat: item.seat, winPct: pct(item.outright),
      tiePct: pct(item.tied), equityPct: equityHundredths[index] / 100 }))
  };
}

export class GameError extends Error {
  constructor(message, status = 400, errorCode = null) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

function validTimestamp(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function handStartFromSnapshot(data) {
  if (validTimestamp(data?.lastHandStartedAt)) return validTimestamp(data.lastHandStartedAt);
  if ((data?.handNo ?? 0) < 1) return null;
  const latestHand = data?.hand;
  const fromHand = validTimestamp(latestHand?.startedAt) ?? validTimestamp(latestHand?.fair?.utc);
  if (fromHand) return fromHand;
  const startEvent = Array.isArray(data?.events) ? data.events.findLast(event =>
    event?.handNo === data.handNo && /^第 \d+ 手开始；/.test(event.text ?? '') && validTimestamp(event.at)) : null;
  return validTimestamp(startEvent?.at);
}

function chips(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_CHIPS) {
    throw new GameError(`${label}须为 ${minimum} 至 ${MAX_CHIPS} 的整数`);
  }
  return value;
}

function nickname(value) {
  if (typeof value !== 'string') throw new GameError('请输入昵称');
  const clean = value.trim().normalize('NFKC');
  if (!clean || [...clean].length > 18 || /[<>\u0000-\u001f\u007f]/u.test(clean)) {
    throw new GameError('昵称须为 1–18 个字符，不能包含控制字符或尖括号');
  }
  return clean;
}

function requestIdValue(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) {
    throw new GameError('此操作需要有效的请求编号');
  }
  return value.toLowerCase();
}

export function capacityValue(value) {
  if (!Number.isInteger(value) || value < 4 || value > 10) throw new GameError('房间人数须为 4–10');
  return value;
}

export function bigBlindValue(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_BIG_BLIND) {
    throw new GameError(`大盲须为 2 至 ${MAX_BIG_BLIND} 的整数`);
  }
  return value;
}

export class Room {
  constructor(code, capacity = 4, onChange = () => {}, options = {}) {
    this.code = code;
    this.capacity = capacityValue(capacity);
    this.bigBlind = BIG_BLIND;
    this.smallBlind = SMALL_BLIND;
    this.pendingBigBlind = null;
    this.pendingCapacity = null;
    this.tableSettingsNotice = null;
    this.ownerToken = null;
    this.members = new Map();
    this.seats = Array(this.capacity).fill(null);
    this.status = 'waiting';
    this.handNo = 0;
    this.hand = null;
    this.nextHandAt = null;
    this.events = [];
    this.history = [];
    this.eventSeq = 0;
    this.stateVersion = 0;
    this.transactionSeq = 0;
    this.commandReceipts = [];
    this.pendingFinancial = [];
    this.lastSneakAt = 0;
    this.grandCooldownUntil = 0;
    this.pause = null;
    this.createdAt = new Date().toISOString();
    this.lastHandStartedAt = null;
    this.closedAt = null;
    this.closeReason = null;
    this.onChange = onChange;
    this.deferEquity = options.deferEquity === true;
  }

  static expiryInfoFromJSON(data) {
    const createdAt = validTimestamp(data?.createdAt) ?? new Date().toISOString();
    const lastHandStartedAt = handStartFromSnapshot(data);
    return { createdAt, lastHandStartedAt,
      expiryAt: Date.parse(lastHandStartedAt ?? createdAt) + ROOM_IDLE_MS };
  }

  static fromJSON(data, onChange = () => {}, options = {}) {
    const room = new Room(data.code, data.capacity, onChange, options);
    room.bigBlind = bigBlindValue(data.bigBlind ?? BIG_BLIND);
    room.smallBlind = Math.max(1, Math.floor(room.bigBlind / 2));
    room.pendingBigBlind = data.pendingBigBlind == null ? null : bigBlindValue(data.pendingBigBlind);
    room.pendingCapacity = data.pendingCapacity == null ? null : capacityValue(data.pendingCapacity);
    room.tableSettingsNotice = data.tableSettingsNotice ?? null;
    room.stateVersion = Number.isSafeInteger(data.stateVersion) && data.stateVersion >= 0 ? data.stateVersion : 0;
    const expiry = Room.expiryInfoFromJSON(data);
    room.createdAt = expiry.createdAt;
    room.lastHandStartedAt = expiry.lastHandStartedAt;
    room.closedAt = validTimestamp(data.closedAt);
    room.closeReason = room.closedAt ? (data.closeReason ?? 'inactive') : null;
    room.ownerToken = data.ownerToken;
    room.members = new Map(data.members.map(member => [member.token, {
      ...member, sittingOut: member.sittingOut ?? false,
      celebrationGuest: member.celebrationGuest ?? /^(kelly|like)(?: #\d+)?$/i.test(member.nickname),
      giftLocked: member.giftLocked ?? 0,
      giftSentTotal: member.giftSentTotal ?? 0,
      giftReceivedTotal: member.giftReceivedTotal ?? 0,
      pendingRebuy: member.pendingRebuy ?? 0,
      cashOutTotal: member.cashOutTotal ?? 0,
      lastFinancialNotice: member.lastFinancialNotice ?? null,
      lastFinancialSettlement: member.lastFinancialSettlement ?? null,
      lastSneakAt: member.lastSneakAt ?? 0,
      pendingSitOut: member.pendingSitOut ?? false,
      pendingSitOutReason: member.pendingSitOutReason ?? (member.pendingSitOut ? 'timeout' : null),
      awayHands: member.awayHands ?? 0,
      lastPresenceEvent: member.lastPresenceEvent ?? null,
      revealable: member.revealable ?? null,
      connections: new Set()
    }]));
    room.seats = data.seats;
    room.seats.length = Math.max(room.capacity, room.pendingCapacity ?? room.capacity);
    for (let seat = 0; seat < room.seats.length; seat++) room.seats[seat] ??= null;
    room.status = data.status;
    room.handNo = data.handNo;
    room.hand = data.hand;
    if (room.hand) {
      room.hand.voluntaryRevealHandled = room.hand.voluntaryRevealHandled === true;
      // Hands begun before configurable blinds existed always used 10/20.
      room.hand.smallBlind ??= SMALL_BLIND;
      room.hand.bigBlind ??= BIG_BLIND;
      room.hand.actions ||= [];
      room.hand.startedAt ||= room.hand.fair?.utc ?? data.createdAt;
      room.hand.actionTimebankBlocks ??= 0;
      if (room.hand.runout && !Array.isArray(room.hand.runout.boardResults)) {
        room.hand.runout.boardResults = [];
        if (room.hand.runout.times === 2 && room.hand.board?.length === 5 &&
            room.hand.runout.boardIndex === 1) {
          room.hand.runout.boardResults.push(room.calculateBoardResult(room.hand.board, 0, 2, room.buildPots()));
        }
      }
    }
    room.nextHandAt = data.nextHandAt ?? null;
    room.events = data.events;
    room.history = data.history;
    for (const record of room.history ?? []) {
      // Every record without a blind snapshot predates this setting.
      record.smallBlind ??= SMALL_BLIND;
      record.bigBlind ??= BIG_BLIND;
    }
    room.eventSeq = data.eventSeq;
    room.transactionSeq = data.transactionSeq ?? data.giftSeq ?? 0;
    room.commandReceipts = data.commandReceipts ?? [];
    room.pendingFinancial = data.pendingFinancial ?? [];
    room.lastSneakAt = data.lastSneakAt ?? 0;
    room.grandCooldownUntil = data.grandCooldownUntil ?? 0;
    room.pause = data.pause?.endAt > Date.now() ? data.pause : null;
    const restoredRunout = room.hand?.runout;
    if (restoredRunout && !Number.isInteger(restoredRunout.initialStreet)) {
      // Preserve an older in-progress runout exactly as its cards were already
      // shown. New preflop hands use a blank board and an explicit street 0.
      restoredRunout.initialStreet = restoredRunout.sharedBoard?.length === 4 ? 2 : 1;
    }
    for (const member of room.members.values()) {
      if (member.hand) {
        member.hand.timebankEnabled ??= false;
        member.hand.timebankCommit ??= 0;
      }
      if (member.skippedHandNo === undefined) {
        member.skippedHandNo = room.status === 'playing' && member.seat !== null &&
          member.sittingOut && member.hand?.handNo !== room.handNo ? room.handNo : null;
      }
    }
    if (room.status === 'playing' && room.hand && room.hand.timerVersion !== 4 &&
        Number.isInteger(room.hand.actingSeat) && !room.hand.runout) {
      // Upgrade the existing free window exactly once. Purchased ten-second
      // blocks and runout timers never gain a free-window grace period.
      if (!(room.hand.actionTimebankBlocks > 0)) {
        const previousFreeMs = room.hand.timerVersion === 3 ? 30_000 :
          room.hand.timerVersion === 2 ? 25_000 : null;
        if (previousFreeMs && Number.isFinite(room.hand.actionDeadline)) {
          room.hand.actionDeadline += ACTION_TIME_MS - previousFreeMs;
        } else {
          room.hand.actionDeadline = Math.min(room.hand.actionDeadline ?? Date.now() + ACTION_TIME_MS,
            Date.now() + ACTION_TIME_MS);
        }
      }
      room.hand.timerVersion = 4;
    }
    if (!room.closedAt && !room.isExpired() && room.status === 'finished' && room.hand) {
      room.prepareRevealables();
      if (!room.hand.financialSettlement && ([...room.members.values()].some(member => member.pendingRebuy > 0) ||
          room.pendingFinancial.some(item => item.handNo === room.handNo))) room.settleFinancialForHand();
      room.backfillCurrentWinnerNet();
    }
    if (!room.closedAt && !room.isExpired()) room.reconcileAutoStart();
    return room;
  }

  toJSON() {
    return {
      code: this.code, capacity: this.capacity, bigBlind: this.bigBlind,
      smallBlind: this.smallBlind, pendingBigBlind: this.pendingBigBlind,
      pendingCapacity: this.pendingCapacity, tableSettingsNotice: this.tableSettingsNotice,
      ownerToken: this.ownerToken,
      members: [...this.members.values()].map(({ connections, ...member }) => member),
      seats: this.seats, status: this.status, handNo: this.handNo, hand: this.hand,
      nextHandAt: this.nextHandAt,
      events: this.events, history: this.history, eventSeq: this.eventSeq,
      stateVersion: this.stateVersion, createdAt: this.createdAt,
      lastHandStartedAt: this.lastHandStartedAt, closedAt: this.closedAt, closeReason: this.closeReason,
      transactionSeq: this.transactionSeq, commandReceipts: this.commandReceipts,
      pendingFinancial: this.pendingFinancial,
      lastSneakAt: this.lastSneakAt, grandCooldownUntil: this.grandCooldownUntil,
      pause: this.pause
    };
  }

  changed({ reconcileAutoStart = true } = {}) {
    if (reconcileAutoStart) this.reconcileAutoStart();
    this.stateVersion++;
    this.onChange(this);
  }
  expiryAt() { return Date.parse(this.lastHandStartedAt ?? this.createdAt) + ROOM_IDLE_MS; }
  isExpired(now = Date.now()) { return !this.closedAt && now >= this.expiryAt(); }
  assertOpen(now = Date.now()) {
    if (this.closedAt || this.isExpired(now)) throw new GameError(ROOM_CLOSED_MESSAGE, 410, 'ROOM_CLOSED');
  }
  markClosedInactive(now = Date.now()) {
    if (this.closedAt || !this.isExpired(now)) return false;
    this.closedAt = new Date(now).toISOString();
    this.closeReason = 'inactive';
    return true;
  }
  addEvent(text, seat = null, handNo = this.handNo) {
    const event = { id: ++this.eventSeq, handNo, street: handNo === this.handNo && this.hand ? STREET_NAMES[this.hand.street] : null,
      seat, text, at: new Date().toISOString() };
    this.events.push(event);
    return event;
  }

  join(name, resumeToken = null) {
    this.assertOpen();
    if (resumeToken != null) {
      const existing = this.members.get(resumeToken);
      if (!existing) throw new GameError('登录凭证已失效，请重新输入昵称', 401);
      return existing;
    }
    const clean = nickname(name);
    let unique = clean, suffix = 2;
    const used = value => [...this.members.values()].some(member => member.nickname.toLocaleLowerCase() === value.toLocaleLowerCase());
    while (used(unique)) {
      const tail = ` #${suffix++}`;
      unique = `${[...clean].slice(0, 18 - [...tail].length).join('')}${tail}`;
    }
    const member = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'), nickname: unique,
      celebrationGuest: /^(kelly|like)$/i.test(clean),
      seat: null, stack: 0, buyInTotal: 0, rebuyCount: 0, rebuyTotal: 0,
      giftLocked: 0, giftSentTotal: 0, giftReceivedTotal: 0, lastSneakAt: 0,
      pendingRebuy: 0, cashOutTotal: 0, lastFinancialNotice: null,
      lastFinancialSettlement: null, sittingOut: false,
      pendingSitOut: false, pendingSitOutReason: null,
      awayHands: 0, skippedHandNo: null, lastPresenceEvent: null,
      hand: null, revealable: null, connections: new Set()
    };
    this.members.set(member.token, member);
    if (!this.ownerToken) this.ownerToken = member.token;
    this.changed();
    return member;
  }

  requireMember(token) {
    this.assertOpen();
    const member = this.members.get(token);
    if (!member) throw new GameError('登录凭证已失效，请重新进入房间', 401);
    return member;
  }

  seatMember(index) { return this.members.get(this.seats[index]) ?? null; }
  eligiblePlayers() {
    return this.seats.map(token => this.members.get(token))
      .filter(player => player && !player.sittingOut && !player.pendingSitOut && player.stack + player.pendingRebuy > 0);
  }
  reconcileAutoStart() {
    if (this.closedAt || this.isExpired()) return;
    if (this.status === 'playing' || this.eligiblePlayers().length < 2) {
      this.nextHandAt = null;
    } else if (!Number.isFinite(this.nextHandAt)) {
      this.nextHandAt = Math.max(Date.now(), this.pause?.endAt ?? 0) + NEXT_HAND_DELAY_MS;
    }
  }
  isPaused() { return !!this.pause && Date.now() < this.pause.endAt; }
  timerBase() { return Math.max(Date.now(), this.isPaused() ? this.pause.endAt : 0); }
  spendableStack(member) { return Math.max(0, member.stack - (member.giftLocked ?? 0)); }
  shiftDeadline(deadline, startAt, endAt) {
    return Number.isFinite(deadline) ? endAt + Math.max(0, deadline - startAt) : deadline;
  }
  activateGrandPause(effect) {
    if (this.isPaused()) throw new GameError('礼物展示中，请稍后再试');
    const { startAt, endAt } = effect;
    this.nextHandAt = this.shiftDeadline(this.nextHandAt, startAt, endAt);
    if (this.hand) {
      this.hand.actionDeadline = this.shiftDeadline(this.hand.actionDeadline, startAt, endAt);
      if (this.hand.runout) {
        this.hand.runout.deadline = this.shiftDeadline(this.hand.runout.deadline, startAt, endAt);
        this.hand.runout.nextCardAt = this.shiftDeadline(this.hand.runout.nextCardAt, startAt, endAt);
      }
    }
    this.pause = { kind: 'grandGift', startAt, grandEndAt: effect.grandEndAt,
      flightStartAt: effect.flightStartAt, flightEndAt: effect.flightEndAt, endAt,
      effect };
    this.grandCooldownUntil = endAt + GRAND_COOLDOWN_MS;
  }
  endPauseIfDue() {
    if (!this.pause || Date.now() < this.pause.endAt) return false;
    this.pause = null;
    this.changed();
    return true;
  }
  prepareRevealables() {
    if (!this.hand || this.status !== 'finished') return;
    for (const player of this.handPlayers()) {
      if (player.revealable?.handNo === this.handNo) continue;
      player.revealable = {
        handNo: this.handNo, seat: player.hand.seat ?? player.seat,
        cards: player.hand.hole.map(item => cardLabel(item.card)),
        proofs: player.hand.hole.map(item => cardProof(this.hand.fair, item.position)),
        shown: player.hand.shown
      };
    }
  }
  nextSeat(after, predicate) {
    for (let n = 1; n <= this.capacity; n++) {
      const seat = (after + n) % this.capacity;
      if (predicate(this.seatMember(seat), seat)) return seat;
    }
    return null;
  }
  handPlayers() { return [...this.members.values()].filter(member => member.hand?.handNo === this.handNo && member.hand.inHand); }
  livePlayers() { return this.handPlayers().filter(member => !member.hand.folded); }
  activePlayers() { return this.livePlayers().filter(member => !member.hand.allIn); }
  pot() { return this.handPlayers().reduce((sum, member) =>
    sum + member.hand.totalCommit + (member.hand.timebankCommit ?? 0), 0); }
  toCall(member) { return Math.max(0, this.hand.currentBet - member.hand.streetCommit); }
  maxRaiseTo(member) { return member.hand.streetCommit + this.spendableStack(member); }
  minRaiseTo() { return this.hand.currentBet === 0 ? this.hand.bigBlind : this.hand.currentBet + this.hand.lastFullRaise; }
  canRaise(member) {
    if (!member?.hand || this.status !== 'playing' || member.seat !== this.hand.actingSeat) return false;
    const state = member.hand;
    const actionReopened = state.lastActedBet === null || this.hand.currentBet - state.lastActedBet >= this.hand.lastFullRaise;
    return actionReopened && this.maxRaiseTo(member) > this.hand.currentBet &&
      this.livePlayers().some(other => other !== member && !other.hand.allIn);
  }

  sit(member, seat, buyIn = DEFAULT_BUY_IN) {
    if (member.seat !== null) throw new GameError('你已经入座');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) throw new GameError('无效座位');
    if (this.pendingCapacity !== null && seat >= this.pendingCapacity) {
      throw new GameError('该座位将在下一手移除，不能入座');
    }
    if (this.seats[seat]) throw new GameError('该座位已有人');
    chips(buyIn, '带入筹码', this.bigBlind);
    member.seat = seat;
    member.stack = buyIn;
    member.buyInTotal += buyIn;
    member.sittingOut = false;
    member.pendingSitOut = false;
    member.pendingSitOutReason = null;
    member.awayHands = 0;
    member.skippedHandNo = null;
    member.lastPresenceEvent = null;
    this.seats[seat] = member.token;
    this.addEvent(`${member.nickname} 带入 ${buyIn} 筹码坐在 ${seat + 1} 号位${this.status === 'playing' ? '；下一手开始参与' : ''}`, seat);
  }

  stand(member) {
    if (member.seat === null) throw new GameError('你尚未入座');
    if (this.status === 'playing' && member.hand?.handNo === this.handNo && member.hand.inHand) {
      throw new GameError('已参与当前手，结算后才能离座');
    }
    if (this.pendingFinancial.some(item => item.handNo === this.handNo &&
        (item.playerId === member.id || item.senderId === member.id || item.recipientId === member.id))) {
      throw new GameError('本手还有待结算的礼物或筹码操作，结算后才能离座');
    }
    const oldSeat = member.seat;
    member.cashOutTotal += member.stack;
    member.stack = 0;
    member.giftLocked = 0;
    member.pendingRebuy = 0;
    member.sittingOut = false;
    member.pendingSitOut = false;
    member.pendingSitOutReason = null;
    member.awayHands = 0;
    member.skippedHandNo = null;
    this.seats[oldSeat] = null;
    member.seat = null;
    this.addEvent(`${member.nickname} 从 ${oldSeat + 1} 号位离座`, oldSeat);
  }

  sitOut(member) {
    if (member.seat === null) throw new GameError('你尚未入座');
    if (member.sittingOut) throw new GameError('你已经暂时离席');
    const handState = member.hand?.handNo === this.handNo ? member.hand : null;
    if (this.status === 'playing' && this.hand?.runout && handState?.inHand && !handState.folded) {
      if (member.pendingSitOut) throw new GameError('已安排从下一手暂离');
      member.pendingSitOut = true;
      member.pendingSitOutReason = 'manual';
      member.awayHands = 0;
      member.lastPresenceEvent = { type: 'runoutSitOut', handNo: this.handNo, at: new Date().toISOString() };
      this.addEvent(`${member.nickname} 选择下手暂离；本手已锁定，仍参与跑马结算`, member.seat);
      return;
    }
    member.sittingOut = true;
    member.pendingSitOut = false;
    member.pendingSitOutReason = null;
    member.awayHands = 0;
    if (this.status === 'playing' && handState?.inHand && !handState.folded && !handState.allIn) {
      handState.folded = true;
      handState.needsAction = false;
      handState.lastAction = 'fold';
      this.recordAction(member, 'fold', 0, null, 'sitOut');
      this.addEvent(`${member.nickname} 暂时离席，本手弃牌`, member.seat);
      if (this.livePlayers().length === 1) this.finishByFold();
      else if (this.hand.actingSeat === member.seat) {
        this.setActor(this.nextActor(member.seat));
        if (this.hand.actingSeat === null) this.advanceStreet();
      }
    } else if (this.status === 'playing' && handState?.allIn && !handState.folded) {
      this.addEvent(`${member.nickname} 暂时离席；已全下的手牌继续参与本手结算`, member.seat);
    } else {
      this.addEvent(`${member.nickname} 暂时离席`, member.seat);
    }
  }

  returnToTable(member) {
    if (member.seat === null) throw new GameError('你尚未入座');
    if (!member.sittingOut && member.pendingSitOut) {
      member.pendingSitOut = false;
      member.pendingSitOutReason = null;
      member.awayHands = 0;
      member.skippedHandNo = null;
      member.lastPresenceEvent = null;
      this.addEvent(`${member.nickname} 取消了超时后的待暂离`, member.seat);
      return;
    }
    if (!member.sittingOut) throw new GameError('你已在牌桌上');
    member.sittingOut = false;
    member.pendingSitOut = false;
    member.pendingSitOutReason = null;
    member.awayHands = 0;
    member.skippedHandNo = null;
    member.lastPresenceEvent = null;
    this.addEvent(`${member.nickname} 返回牌桌；从下一手起参与`, member.seat);
  }

  rebuy(member, amount, requestId = null, writeAhead = () => {}) {
    if (this.isPaused()) throw new GameError('礼物展示中，牌局暂时暂停');
    if (member.seat === null) throw new GameError('先选择座位才能补码');
    if (amount !== DEFAULT_BUY_IN) throw new GameError('每次补码须为 2000');
    if (member.stack + member.pendingRebuy + amount > MAX_CHIPS) throw new GameError('补码后筹码超过上限');
    if (!Number.isSafeInteger(member.rebuyTotal + member.pendingRebuy + amount) ||
        !Number.isSafeInteger(member.rebuyCount + 1)) throw new GameError('补码累计金额过大');
    if (requestId !== null) {
      const id = requestIdValue(requestId);
      if (this.commandReceipt(member, id, 'rebuy')) return { duplicate: true };
      const transaction = { type: 'rebuy', transactionVersion: 2, seq: this.transactionSeq + 1,
        requestId: id, playerId: member.id, nickname: member.nickname, seat: member.seat,
        amount, at: new Date().toISOString(), handNo: this.status === 'playing' ? this.handNo : null };
      writeAhead(transaction);
      this.applyRebuyTransaction(transaction);
      return { duplicate: false, transaction };
    }
    if (this.status === 'playing') {
      member.pendingRebuy += amount;
      this.addEvent(`${member.nickname} 申请补码 ${amount}，本手结算后到账`, member.seat);
    } else {
      member.stack += amount;
      member.rebuyCount++;
      member.rebuyTotal += amount;
      this.addEvent(`${member.nickname} 补码 ${amount}`, member.seat);
    }
  }

  applyRebuyTransaction(transaction) {
    if (transaction.seq <= this.transactionSeq) return false;
    if (transaction.seq !== this.transactionSeq + 1) throw new Error('资金记录序号不连续');
    const member = this.memberById(transaction.playerId);
    if (!member || member.seat === null || !Number.isSafeInteger(transaction.amount) ||
        transaction.amount < 1 || transaction.amount > MAX_CHIPS) throw new Error('补码记录无效');
    if (transaction.handNo !== null && this.status === 'playing' && transaction.handNo === this.handNo) {
      member.pendingRebuy += transaction.amount;
      this.pendingFinancial.push(transaction);
      this.addEvent(`${member.nickname} 申请补码 ${transaction.amount}，本手结算后到账`, member.seat);
    } else if (transaction.handNo === null) {
      member.stack += transaction.amount;
      member.rebuyCount++;
      member.rebuyTotal += transaction.amount;
      this.addEvent(`${member.nickname} 补码 ${transaction.amount}`, member.seat);
    } else throw new Error('补码记录对应的手牌状态不一致');
    this.transactionSeq = transaction.seq;
    this.storeCommandReceipt({ type: 'rebuy', playerId: member.id, requestId: transaction.requestId });
    return true;
  }

  commandReceipt(member, requestId, type) {
    const id = requestIdValue(requestId);
    const receipt = this.commandReceipts.find(item => item.playerId === member.id && item.requestId === id);
    if (receipt && receipt.type !== type) throw new GameError('请求编号已用于其他操作');
    return receipt ?? null;
  }

  storeCommandReceipt(receipt) {
    this.commandReceipts.push(receipt);
    if (this.commandReceipts.length > RECEIPT_LIMIT) this.commandReceipts.splice(0, this.commandReceipts.length - RECEIPT_LIMIT);
  }

  memberById(id) { return [...this.members.values()].find(member => member.id === id) ?? null; }

  gift(member, data, writeAhead = () => {}) {
    const requestId = requestIdValue(data.requestId);
    const existing = this.commandReceipt(member, requestId, 'gift');
    if (existing) return { duplicate: true, effect: existing.effect };
    if (this.isPaused()) throw new GameError('礼物展示中，请稍后再试');
    if (member.seat === null) throw new GameError('入座后才能赠送花束');
    const recipient = this.memberById(data.recipientId);
    if (!recipient || recipient.seat === null) throw new GameError('收礼玩家尚未入座');
    if (recipient === member) throw new GameError('不能送礼给自己');
    const quantity = data.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_BOUQUETS) {
      throw new GameError(`花束数量须为 1 至 ${MAX_BOUQUETS} 的整数`);
    }
    const roseType = data.roseType ?? 'whiteRose';
    if (roseType !== 'whiteRose' && roseType !== 'redRose') throw new GameError('请选择白玫瑰或红玫瑰');
    const cost = quantity * BOUQUET_COST;
    const totalPending = this.pendingFinancial.filter(item => item.type === 'gift' && item.senderId === member.id)
      .reduce((sum, item) => sum + item.cost, 0);
    if (!Number.isSafeInteger(totalPending + cost)) throw new GameError('待结算礼物总额过大');
    const pendingIncoming = this.pendingFinancial.filter(item => item.type === 'gift' && item.recipientId === recipient.id)
      .reduce((sum, item) => sum + item.cost, 0);
    if (!Number.isSafeInteger(member.giftSentTotal + totalPending + cost) ||
        !Number.isSafeInteger(recipient.giftReceivedTotal + pendingIncoming + cost) ||
        !Number.isSafeInteger(member.rebuyTotal + Math.ceil((totalPending + cost) / DEFAULT_BUY_IN) * DEFAULT_BUY_IN)) {
      throw new GameError('礼物累计金额过大');
    }
    const startAt = Date.now();
    const scope = quantity >= 99 ? 'grand' : quantity >= 9 ? 'room' : 'private';
    if (scope === 'grand' && startAt < this.grandCooldownUntil) throw new GameError('巨型花束正在冷却中，请稍后再试');
    const grandEndAt = scope === 'grand' ? startAt + GRAND_DISPLAY_MS : null;
    const flightStartAt = grandEndAt ?? startAt;
    const flightEndAt = flightStartAt + (scope === 'grand' ? GRAND_FLIGHT_MS : 1_800);
    const effect = {
      type: 'giftEffect', id: `${member.id}:${requestId}`, roomCode: this.code,
      kind: 'bouquet', roseType, scope, settlementPending: this.status === 'playing',
      at: new Date(startAt).toISOString(), startAt,
      grandEndAt, flightStartAt, flightEndAt, endAt: flightEndAt,
      sender: { playerId: member.id, nickname: member.nickname, seat: member.seat },
      recipient: { playerId: recipient.id, nickname: recipient.nickname, seat: recipient.seat },
      quantity, cost
    };
    const transaction = {
      type: 'gift', transactionVersion: 2, seq: this.transactionSeq + 1, requestId,
      senderId: member.id, recipientId: recipient.id, roseType, quantity, cost, at: effect.at,
      handNo: this.status === 'playing' ? this.handNo : null, effect
    };
    if (transaction.handNo === null) this.settleFinancialEntries([transaction], false, true);
    writeAhead(transaction); // A failed local record must never spend chips.
    this.applyGiftTransaction(transaction);
    return { duplicate: false, effect, transaction };
  }

  applyGiftTransaction(transaction) {
    if (transaction.transactionVersion !== 2) return this.applyLegacyGiftTransaction(transaction);
    if (transaction.seq <= this.transactionSeq) return false;
    if (transaction.seq !== this.transactionSeq + 1) throw new Error('资金记录序号不连续');
    const sender = this.memberById(transaction.senderId);
    const recipient = this.memberById(transaction.recipientId);
    if (!sender || !recipient || sender === recipient || sender.seat === null || recipient.seat === null ||
        !Number.isSafeInteger(transaction.cost) || transaction.cost < BOUQUET_COST ||
        !Number.isSafeInteger(transaction.quantity) || transaction.quantity * BOUQUET_COST !== transaction.cost) {
      throw new Error('礼物记录无法应用到当前房间');
    }
    if (transaction.handNo !== null && this.status === 'playing' && transaction.handNo === this.handNo) {
      this.pendingFinancial.push(transaction);
    } else if (transaction.handNo === null) {
      this.settleFinancialEntries([transaction], false);
    } else throw new Error('礼物记录对应的手牌状态不一致');
    this.transactionSeq = transaction.seq;
    this.storeCommandReceipt({ type: 'gift', playerId: sender.id,
      requestId: transaction.requestId, effect: transaction.effect });
    if (transaction.effect.scope === 'grand') this.activateGrandPause(transaction.effect);
    return true;
  }

  // Records written before the deferred settlement upgrade paid immediately.
  // Replay them with their original semantics so old WAL cannot pay twice.
  applyLegacyGiftTransaction(transaction) {
    if (transaction.seq <= this.transactionSeq) return false;
    if (transaction.seq !== this.transactionSeq + 1) throw new Error('资金记录序号不连续');
    const sender = this.memberById(transaction.senderId);
    const recipient = this.memberById(transaction.recipientId);
    if (!sender || !recipient || sender === recipient || sender.seat === null || recipient.seat === null ||
        this.spendableStack(sender) < transaction.cost) throw new Error('礼物记录无法应用到当前筹码状态');
    sender.stack -= transaction.cost;
    recipient.stack += transaction.cost;
    sender.giftSentTotal += transaction.cost;
    recipient.giftReceivedTotal += transaction.cost;
    if (this.status === 'playing' && recipient.hand?.handNo === this.handNo && recipient.hand.inHand) {
      recipient.giftLocked += transaction.cost;
    }
    this.transactionSeq = transaction.seq;
    this.storeCommandReceipt({ type: 'gift', playerId: sender.id,
      requestId: transaction.requestId, effect: transaction.effect });
    if (transaction.effect.scope === 'grand') this.activateGrandPause(transaction.effect);
    const handState = sender.hand?.handNo === this.handNo ? sender.hand : null;
    if (this.status === 'playing' && !this.hand.runout && handState?.inHand &&
        !handState.folded && !handState.allIn && this.spendableStack(sender) === 0) {
      if (handState.totalCommit === 0 || this.toCall(sender) > 0) {
        handState.folded = true;
        handState.lastAction = 'fold';
        this.recordAction(sender, 'fold', 0, null, 'stackTransfer');
        this.addEvent(`${sender.nickname} 可用筹码归零，本手弃牌`, sender.seat);
      } else {
        handState.allIn = true;
        handState.lastAction = 'allIn';
        this.addEvent(`${sender.nickname} 可用筹码归零，本手不再行动`, sender.seat);
      }
      handState.needsAction = false;
      if (this.livePlayers().length === 1) this.finishByFold();
      else if (this.hand.actingSeat === sender.seat) {
        this.setActor(this.nextActor(sender.seat));
        if (this.hand.actingSeat === null) this.advanceStreet();
      }
    }
    return true;
  }

  sneak(member, data, writeAhead = () => {}) {
    const requestId = requestIdValue(data.requestId);
    const existing = this.commandReceipt(member, requestId, 'sneak');
    if (existing) return { duplicate: true, effect: existing.effect };
    if (this.isPaused()) throw new GameError('礼物展示中，请稍后再试');
    const startAt = Date.now();
    if (startAt - member.lastSneakAt < 60_000 || startAt - this.lastSneakAt < 10_000) {
      throw new GameError('悄悄话正在冷却中，请稍后再试');
    }
    const effect = {
      type: 'giftEffect', id: `${member.id}:${requestId}`, roomCode: this.code,
      kind: 'sneak', scope: 'room', at: new Date(startAt).toISOString(), startAt,
      secondAt: startAt + 1_200, endAt: startAt + 2_400,
      sender: { playerId: member.id, nickname: member.nickname, seat: member.seat },
      recipient: null, quantity: 0, cost: 0,
      messages: ['悄悄地进村', '打枪的不要']
    };
    writeAhead({ type: 'sneak', requestId, playerId: member.id,
      handNo: this.status === 'playing' ? this.handNo : null, effect });
    member.lastSneakAt = startAt;
    this.lastSneakAt = startAt;
    this.storeCommandReceipt({ type: 'sneak', playerId: member.id, requestId, effect });
    return { duplicate: false, effect };
  }

  unload(member, requestId, writeAhead = () => {}) {
    const id = requestIdValue(requestId);
    if (this.commandReceipt(member, id, 'unload')) return { duplicate: true };
    if (this.isPaused()) throw new GameError('礼物展示中，请稍后再试');
    if (member.seat === null) throw new GameError('你尚未入座');
    if (this.status !== 'playing' && this.spendableStack(member) < DEFAULT_BUY_IN) {
      throw new GameError('当前可卸筹码不足 2000');
    }
    const transaction = { type: 'unload', transactionVersion: 2, seq: this.transactionSeq + 1,
      requestId: id, playerId: member.id,
      nickname: member.nickname, seat: member.seat, amount: DEFAULT_BUY_IN,
      at: new Date().toISOString(), handNo: this.status === 'playing' ? this.handNo : null };
    if (transaction.handNo === null) this.settleFinancialEntries([transaction], false, true);
    writeAhead(transaction);
    this.applyUnloadTransaction(transaction);
    return { duplicate: false, transaction };
  }

  applyUnloadTransaction(transaction) {
    if (transaction.transactionVersion !== 2) return this.applyLegacyUnloadTransaction(transaction);
    if (transaction.seq <= this.transactionSeq) return false;
    if (transaction.seq !== this.transactionSeq + 1) throw new Error('资金记录序号不连续');
    const member = this.memberById(transaction.playerId);
    if (!member || member.seat === null || transaction.amount !== DEFAULT_BUY_IN) {
      throw new Error('卸码记录无法应用到当前房间');
    }
    if (transaction.handNo !== null && this.status === 'playing' && transaction.handNo === this.handNo) {
      this.pendingFinancial.push(transaction);
      member.lastFinancialNotice = { type: 'unloadPending', amount: DEFAULT_BUY_IN,
        handNo: this.handNo, at: transaction.at };
    } else if (transaction.handNo === null) {
      this.settleFinancialEntries([transaction], false);
    } else throw new Error('卸码记录对应的手牌状态不一致');
    this.transactionSeq = transaction.seq;
    this.storeCommandReceipt({ type: 'unload', playerId: member.id,
      requestId: transaction.requestId });
    return true;
  }

  applyLegacyUnloadTransaction(transaction) {
    if (transaction.seq <= this.transactionSeq) return false;
    if (transaction.seq !== this.transactionSeq + 1) throw new Error('资金记录序号不连续');
    const member = this.memberById(transaction.playerId);
    const currentHand = member?.hand?.handNo === this.handNo ? member.hand : null;
    if (!member || member.seat === null || transaction.amount !== DEFAULT_BUY_IN ||
        this.spendableStack(member) < transaction.amount ||
        (this.status === 'playing' && currentHand?.inHand && !currentHand.folded)) {
      throw new Error('卸码记录无法应用到当前筹码状态');
    }
    member.stack -= transaction.amount;
    member.cashOutTotal += transaction.amount;
    this.transactionSeq = transaction.seq;
    this.storeCommandReceipt({ type: 'unload', playerId: member.id,
      requestId: transaction.requestId });
    this.addEvent(`${member.nickname} 卸码 ${DEFAULT_BUY_IN}`, member.seat);
    return true;
  }

  // Plan the entire batch before touching any balance. Incoming gifts never
  // finance another gift in the same hand, regardless of request order.
  settleFinancialEntries(entries, includePendingRebuy, dryRun = false) {
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);
    const members = [...this.members.values()];
    const byId = new Map(members.map(member => [member.id, member]));
    const balances = new Map(members.map(member => [member.id, member.stack]));
    const manualRebuys = [], autoRebuys = [], gifts = [], unloads = [];
    const outgoing = new Map(), incoming = new Map();
    const checkedAdd = (left, right) => {
      const value = left + right;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('筹码结算超出安全整数范围');
      return value;
    };
    if (includePendingRebuy) {
      for (const member of members) {
        const amount = member.pendingRebuy ?? 0;
        if (!amount) continue;
        balances.set(member.id, checkedAdd(balances.get(member.id), amount));
        const requests = ordered.filter(item => item.type === 'rebuy' && item.playerId === member.id);
        const recorded = requests.reduce((sum, item) => checkedAdd(sum, item.amount), 0);
        if (recorded > amount) throw new Error('待补码记录与房间状态不一致');
        for (const item of requests) manualRebuys.push({ playerId: member.id, nickname: member.nickname,
          amount: item.amount, requestId: item.requestId, at: item.at });
        if (amount > recorded) manualRebuys.push({ playerId: member.id, nickname: member.nickname,
          amount: amount - recorded, requestId: null, at: null, legacy: true });
      }
    }
    for (const item of ordered.filter(item => item.type === 'gift')) {
      const sender = byId.get(item.senderId), recipient = byId.get(item.recipientId);
      if (!sender || !recipient || sender.seat === null || recipient.seat === null) {
        throw new Error('待结算礼物玩家已离座');
      }
      outgoing.set(sender.id, checkedAdd(outgoing.get(sender.id) ?? 0, item.cost));
      incoming.set(recipient.id, checkedAdd(incoming.get(recipient.id) ?? 0, item.cost));
      gifts.push({ requestId: item.requestId, at: item.at, roseType: item.roseType ?? 'whiteRose',
        senderId: sender.id, sender: sender.nickname, senderSeat: sender.seat,
        recipientId: recipient.id, recipient: recipient.nickname, recipientSeat: recipient.seat,
        quantity: item.quantity, cost: item.cost, scope: item.effect?.scope ?? 'private' });
    }
    for (const [id, due] of outgoing) {
      const available = balances.get(id);
      const shortage = Math.max(0, due - available);
      if (!shortage) continue;
      const amount = Math.ceil(shortage / DEFAULT_BUY_IN) * DEFAULT_BUY_IN;
      balances.set(id, checkedAdd(available, amount));
      const member = byId.get(id);
      autoRebuys.push({ playerId: id, nickname: member.nickname, amount,
        count: amount / DEFAULT_BUY_IN, reason: 'giftShortfall' });
    }
    for (const [id, due] of outgoing) balances.set(id, balances.get(id) - due);
    for (const [id, amount] of incoming) balances.set(id, checkedAdd(balances.get(id), amount));
    for (const item of ordered.filter(item => item.type === 'unload')) {
      const member = byId.get(item.playerId);
      if (!member || member.seat === null) throw new Error('待卸码玩家已离座');
      const accepted = balances.get(member.id) >= DEFAULT_BUY_IN;
      if (accepted) balances.set(member.id, balances.get(member.id) - DEFAULT_BUY_IN);
      unloads.push({ playerId: member.id, nickname: member.nickname, seat: member.seat,
        requestId: item.requestId, amount: DEFAULT_BUY_IN, accepted, at: item.at,
        reason: accepted ? null : '余额不足，卸码申请已取消' });
    }
    const rebuyTotals = new Map(members.map(member => [member.id, member.rebuyTotal]));
    const rebuyCounts = new Map(members.map(member => [member.id, member.rebuyCount]));
    const giftSentTotals = new Map(members.map(member => [member.id, member.giftSentTotal]));
    const giftReceivedTotals = new Map(members.map(member => [member.id, member.giftReceivedTotal]));
    const cashOutTotals = new Map(members.map(member => [member.id, member.cashOutTotal]));
    for (const item of manualRebuys) {
      rebuyTotals.set(item.playerId, checkedAdd(rebuyTotals.get(item.playerId), item.amount));
      rebuyCounts.set(item.playerId, checkedAdd(rebuyCounts.get(item.playerId), 1));
    }
    for (const item of autoRebuys) {
      rebuyTotals.set(item.playerId, checkedAdd(rebuyTotals.get(item.playerId), item.amount));
      rebuyCounts.set(item.playerId, checkedAdd(rebuyCounts.get(item.playerId), item.count));
    }
    for (const [id, amount] of outgoing) giftSentTotals.set(id, checkedAdd(giftSentTotals.get(id), amount));
    for (const [id, amount] of incoming) giftReceivedTotals.set(id, checkedAdd(giftReceivedTotals.get(id), amount));
    for (const item of unloads) if (item.accepted) {
      cashOutTotals.set(item.playerId, checkedAdd(cashOutTotals.get(item.playerId), item.amount));
    }
    if (dryRun) return { manualRebuys, autoRebuys, gifts, unloads };
    for (const member of members) {
      member.stack = balances.get(member.id);
      member.rebuyTotal = rebuyTotals.get(member.id);
      member.rebuyCount = rebuyCounts.get(member.id);
      member.giftSentTotal = giftSentTotals.get(member.id);
      member.giftReceivedTotal = giftReceivedTotals.get(member.id);
      member.cashOutTotal = cashOutTotals.get(member.id);
    }
    for (const item of unloads) {
      const member = byId.get(item.playerId);
      member.lastFinancialNotice = { type: item.accepted ? 'unloadSettled' : 'unloadCanceled',
        amount: item.amount, handNo: this.status === 'finished' ? this.handNo : null,
        at: new Date().toISOString(), message: item.accepted ? '卸码 2000 已到账' : item.reason };
    }
    if (includePendingRebuy) for (const member of members) member.pendingRebuy = 0;
    const settlement = { handNo: includePendingRebuy ? this.handNo : null,
      settledAt: new Date().toISOString(), manualRebuys, autoRebuys, gifts, unloads };
    this.rememberFinancialSettlement(settlement);
    return settlement;
  }

  rememberFinancialSettlement(settlement) {
    for (const member of this.members.values()) {
      const own = {
        handNo: settlement.handNo, settledAt: settlement.settledAt,
        manualRebuys: settlement.manualRebuys.filter(item => item.playerId === member.id),
        autoRebuys: settlement.autoRebuys.filter(item => item.playerId === member.id),
        gifts: settlement.gifts.filter(item => item.senderId === member.id || item.recipientId === member.id),
        unloads: settlement.unloads.filter(item => item.playerId === member.id)
      };
      if (own.manualRebuys.length || own.autoRebuys.length || own.gifts.length || own.unloads.length) {
        member.lastFinancialSettlement = own;
        const auto = own.autoRebuys[0];
        if (auto && !own.unloads.length) member.lastFinancialNotice = {
          type: 'autoRebuy', amount: auto.amount, handNo: settlement.handNo,
          at: settlement.settledAt, message: `礼物差额自动补码 ${auto.amount}` };
      }
    }
  }

  settleFinancialForHand() {
    if (!this.hand || this.hand.financialSettlement) return;
    const entries = this.pendingFinancial.filter(item => item.handNo === this.handNo);
    const settlement = this.settleFinancialEntries(entries, true);
    this.hand.financialSettlement = settlement; // Private: small gifts must not appear in public result/history.
    this.pendingFinancial = this.pendingFinancial.filter(item => item.handNo !== this.handNo);
  }

  setCapacity(member, capacity) {
    if (member.seat !== null) throw new GameError('只有观战者可以调整人数', 403);
    capacity = capacityValue(capacity);
    if (this.seats.slice(capacity).some(Boolean)) throw new GameError('缩小人数前请先清空末尾座位');
    if (capacity === (this.pendingCapacity ?? this.capacity)) return;
    this.pendingCapacity = capacity === this.capacity ? null : capacity;
    // Expansion opens reservable seats immediately so a full table of players
    // sitting out cannot prevent newcomers from forming the next hand.
    this.seats.length = Math.max(this.capacity, this.pendingCapacity ?? this.capacity);
    for (let seat = 0; seat < this.seats.length; seat++) this.seats[seat] ??= null;
    const message = `下一局牌桌人数为${capacity}人`;
    const event = this.addEvent(`${member.nickname} 设置${message}`);
    this.tableSettingsNotice = { id: event.id, kind: 'capacity',
      bigBlind: this.pendingBigBlind ?? this.bigBlind, capacity,
      handNo: this.handNo, nextHandNo: this.handNo + 1, message, at: event.at };
  }

  setBigBlind(member, amount) {
    if (member.seat !== null) throw new GameError('只有观战者可以调整大盲', 403);
    const bigBlind = bigBlindValue(amount);
    if (bigBlind === (this.pendingBigBlind ?? this.bigBlind)) return;
    this.pendingBigBlind = bigBlind === this.bigBlind ? null : bigBlind;
    const message = `下一局大盲筹码数为${bigBlind}筹码`;
    const event = this.addEvent(`${member.nickname} 设置${message}`);
    this.tableSettingsNotice = { id: event.id, kind: 'bigBlind',
      bigBlind, capacity: this.pendingCapacity ?? this.capacity,
      handNo: this.handNo, nextHandNo: this.handNo + 1, message, at: event.at };
  }

  applyPendingTableSettings() {
    const capacity = this.pendingCapacity ?? this.capacity;
    if (this.seats.slice(capacity).some(Boolean)) {
      throw new GameError('缩小人数前请先清空末尾座位');
    }
    const bigBlind = this.pendingBigBlind ?? this.bigBlind;
    // Validate both before mutating either: the next hand starts with one
    // consistent table configuration or keeps the entire pending request.
    capacityValue(capacity);
    bigBlindValue(bigBlind);
    this.capacity = capacity;
    this.seats.length = capacity;
    for (let seat = 0; seat < capacity; seat++) this.seats[seat] ??= null;
    this.bigBlind = bigBlind;
    this.smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    this.pendingCapacity = null;
    this.pendingBigBlind = null;
  }

  draw() {
    const position = this.hand.nextCard++;
    if (position >= 52) throw new Error('牌堆已耗尽');
    return { card: this.hand.fair.deck[position], position };
  }
  post(member, amount) {
    const paid = Math.min(amount, this.spendableStack(member));
    member.stack -= paid;
    member.hand.streetCommit += paid;
    member.hand.totalCommit += paid;
    if (!this.spendableStack(member)) member.hand.allIn = true;
    return paid;
  }
  recordAction(member, action, amount = 0, target = null, source = 'player', type = 'action') {
    if (!this.hand) return null;
    this.hand.actions ||= [];
    const entry = {
      id: this.hand.actions.length + 1,
      type, action, seat: member?.seat ?? null, nickname: member?.nickname ?? null,
      street: STREET_NAMES[this.hand.street], streetIndex: this.hand.street,
      amount, target, source, at: new Date().toISOString()
    };
    this.hand.actions.push(entry);
    return entry;
  }
  setActor(seat) {
    this.hand.actingSeat = seat;
    this.hand.actionTimebankBlocks = 0;
    this.hand.actionDeadline = seat === null ? null : this.timerBase() + ACTION_TIME_MS;
  }
  nextActor(after) {
    return this.nextSeat(after, member => member?.hand?.handNo === this.handNo &&
      member.hand.inHand && !member.hand.folded && !member.hand.allIn && member.hand.needsAction);
  }

  canUseTimebank(member) {
    const state = member?.hand;
    return !!member && this.status === 'playing' && !this.hand?.runout &&
      member.seat !== null && state?.handNo === this.handNo &&
      state.inHand && !state.folded && !state.allIn && state.needsAction;
  }

  setTimebank(member, enabled) {
    if (typeof enabled !== 'boolean') throw new GameError('加时开关必须为开启或关闭');
    if (!this.canUseTimebank(member)) throw new GameError('当前无法使用加时');
    member.hand.timebankEnabled = enabled;
  }

  startRunout() {
    if (this.hand.runout || this.livePlayers().length < 2 || this.hand.board.length >= 5) return;
    this.returnUncalledFoldedBet();
    const initialStreet = this.hand.street;
    const sharedBoard = [...this.hand.board];
    this.setActor(null);
    this.hand.currentBet = 0;
    this.hand.lastFullRaise = this.hand.bigBlind;
    for (const player of this.handPlayers()) {
      player.hand.streetCommit = 0;
      player.hand.needsAction = false;
      player.hand.timebankEnabled = false;
    }
    for (const player of this.livePlayers()) player.hand.shown = true;
    this.hand.runout = {
      phase: 'calculating', eligibleForTwice: false, reason: null,
      equity: [], equityMethod: null, equitySamples: null, equityErrorPct: null,
      trailingSeat: null, leadingSeat: null, proposal: null, response: null,
      times: null, deadline: null, nextCardAt: null,
      boardIndex: 0, initialStreet, sharedBoard, secondBoard: null,
      boardResults: []
    };
    if (!this.deferEquity) {
      const { players, board } = this.runoutEquityInput();
      this.completeRunoutEquity(calculateShowdownEquity(players, board));
    }
  }

  runoutEquityInput() {
    if (this.status !== 'playing' || this.hand?.runout?.phase !== 'calculating') return null;
    return {
      players: this.livePlayers().map(player => ({
        seat: player.seat, hole: player.hand.hole.map(item => item.card)
      })),
      board: this.hand.runout.sharedBoard.map(item => item.card)
    };
  }

  // The caller publishes/persists the completed calculation with changed().
  // This also lets the synchronous command path publish only its final state.
  completeRunoutEquity(calculation) {
    const input = this.runoutEquityInput();
    if (!input) return false;
    const { equity = [], scores = [], method = null, scenarios = null, errorPct = null } = calculation ?? {};
    const players = input.players;
    let trailingSeat = null, leadingSeat = null, reason = null;
    if (!calculation) reason = 'equityUnavailable';
    else if (players.length > 2) reason = 'multiway';
    else if (Math.abs(scores[0].share - scores[1].share) < 1e-9) reason = 'equityTie';
    else {
      const leading = scores[0].share > scores[1].share ? 0 : 1;
      leadingSeat = scores[leading].seat;
      trailingSeat = scores[1 - leading].seat;
    }
    const eligibleForTwice = reason === null;
    Object.assign(this.hand.runout, {
      phase: eligibleForTwice ? 'trailingVote' : 'dealing', eligibleForTwice, reason,
      equity, equityMethod: method, equitySamples: scenarios, equityErrorPct: errorPct,
      trailingSeat, leadingSeat, proposal: null, response: null,
      times: eligibleForTwice ? null : 1,
      deadline: eligibleForTwice ? this.timerBase() + RUNOUT_VOTE_MS : null,
      nextCardAt: null
    });
    this.addEvent(`无人可继续下注，底牌公开并进入跑马${reason === 'multiway' ? '；超过两名玩家，仅发一次' :
      reason === 'equityTie' ? '；双方胜率相同，仅发一次' :
      reason === 'equityUnavailable' ? '；胜率暂不可用，继续发一次' : '；等待落后方选择发一次或两次'}`);
    if (!eligibleForTwice) this.decideRunout(1);
    return true;
  }

  nextRunoutDelay(board) { return board.length === 3 ? RUNOUT_TURN_MS : RUNOUT_RIVER_MS; }

  decideRunout(times) {
    const runout = this.hand.runout;
    runout.phase = 'dealing';
    runout.times = times;
    runout.deadline = null;
    runout.boardIndex = 0;
    runout.secondBoard = times === 2 ? [...runout.sharedBoard] : null;
    runout.boardResults = [];
    if (this.hand.board.length === 0 && this.isPaused()) {
      // An async equity result may arrive during a grand gift. Persist the
      // decision, but leave the committed flop untouched until the pause ends.
      runout.nextCardAt = this.pause.endAt;
      return;
    }
    if (this.hand.board.length === 0) {
      this.hand.street = 1;
      this.draw(); // First-board flop is drawn only after the vote resolves.
      for (let index = 0; index < 3; index++) this.hand.board.push(this.draw());
      this.addEvent(`第 1 次翻牌：${this.hand.board.map(item => cardLabel(item.card)).join(' ')}`);
    }
    runout.nextCardAt = this.timerBase() + this.nextRunoutDelay(this.hand.board);
    this.addEvent(`跑马确定发 ${times} 次；转牌等候 5 秒，河牌再等候 10 秒`);
  }

  runoutChoice(member, times) {
    const runout = this.hand?.runout;
    if (this.status !== 'playing' || runout?.phase !== 'trailingVote' || member.seat !== runout.trailingSeat) {
      throw new GameError('当前未轮到你选择跑马次数');
    }
    if (times !== 1 && times !== 2) throw new GameError('请选择发一次或两次');
    runout.proposal = times;
    this.recordAction(member, 'runoutChoice', 0, times, 'player', 'runout');
    this.addEvent(`${member.nickname} 选择发 ${times} 次`, member.seat);
    if (times === 1) this.decideRunout(1);
    else {
      runout.phase = 'leaderVote';
      runout.deadline = Date.now() + RUNOUT_VOTE_MS;
      this.addEvent(`等待领先方 ${this.seatMember(runout.leadingSeat).nickname} 接受或拒绝发两次`);
    }
  }

  runoutResponse(member, accept) {
    const runout = this.hand?.runout;
    if (this.status !== 'playing' || runout?.phase !== 'leaderVote' || member.seat !== runout.leadingSeat) {
      throw new GameError('当前未轮到你确认跑马次数');
    }
    if (typeof accept !== 'boolean') throw new GameError('请选择接受或拒绝');
    runout.response = accept;
    this.recordAction(member, 'runoutResponse', 0, accept ? 2 : 1, 'player', 'runout');
    this.addEvent(`${member.nickname}${accept ? '接受' : '拒绝'}发两次`, member.seat);
    this.decideRunout(accept ? 2 : 1);
  }

  runoutDeadline() {
    const runout = this.hand?.runout;
    if (this.status !== 'playing' || !runout) return null;
    return runout.phase === 'dealing' || runout.phase === 'firstBoardPause'
      ? runout.nextCardAt : runout.deadline;
  }

  advanceRunoutIfDue() {
    if (this.isPaused()) return false;
    const runout = this.hand?.runout;
    const dueAt = this.runoutDeadline();
    if (!runout || !Number.isFinite(dueAt) || Date.now() < dueAt) return false;
    // An in-flight runout restored from the previous release may not yet have
    // returned its folded bettor's excess. Normalize before preview payouts,
    // so a first-board result cannot promise more than the final settlement.
    this.returnUncalledFoldedBet();
    if (runout.phase === 'dealing' && runout.boardIndex === 0 && this.hand.board.length === 0) {
      // This also resumes a pending flop restored after the gift expired while
      // offline. Start the full turn delay from the actual reveal, never catch up.
      this.decideRunout(runout.times);
    } else if (runout.phase === 'trailingVote') {
      const member = this.seatMember(runout.trailingSeat);
      runout.proposal = 1;
      this.recordAction(member, 'runoutChoice', 0, 1, 'timeout', 'runout');
      this.addEvent(`${member.nickname} 选择超时，默认发一次`, member.seat);
      this.decideRunout(1);
    } else if (runout.phase === 'leaderVote') {
      const member = this.seatMember(runout.leadingSeat);
      runout.response = false;
      this.recordAction(member, 'runoutResponse', 0, 1, 'timeout', 'runout');
      this.addEvent(`${member.nickname} 确认超时，默认拒绝发两次`, member.seat);
      this.decideRunout(1);
    } else if (runout.phase === 'firstBoardPause') {
      runout.phase = 'dealing';
      runout.boardIndex = 1;
      if (runout.secondBoard.length === 0) {
        this.draw(); // Independent second flop after a preflop all-in.
        for (let index = 0; index < 3; index++) runout.secondBoard.push(this.draw());
        this.addEvent(`第 2 次独立翻牌：${runout.secondBoard.map(item => cardLabel(item.card)).join(' ')}`);
      } else this.addEvent('第 1 次牌面展示结束，第 2 次牌面开始计时');
      runout.nextCardAt = Date.now() + this.nextRunoutDelay(runout.secondBoard);
    } else if (runout.phase === 'dealing') {
      const board = runout.boardIndex === 0 ? this.hand.board : runout.secondBoard;
      this.draw(); // Every turn and river, including the second board, burns one card.
      const item = this.draw();
      board.push(item);
      if (runout.boardIndex === 0) this.hand.street = board.length === 4 ? 2 : 3;
      this.addEvent(`第 ${runout.boardIndex + 1} 次${board.length === 4 ? '转牌' : '河牌'}：${cardLabel(item.card)}`);
      if (board.length < 5) runout.nextCardAt = Date.now() + RUNOUT_RIVER_MS;
      else if (runout.times === 2 && runout.boardIndex === 0) {
        runout.boardResults = [this.calculateBoardResult(this.hand.board, 0, 2, this.buildPots())];
        runout.phase = 'firstBoardPause';
        runout.nextCardAt = Date.now() + RUNOUT_PAUSE_MS;
        this.addEvent('第 1 次牌面赢家已揭晓；展示 5 秒后开始第 2 次牌面');
      } else {
        runout.phase = 'finished';
        runout.nextCardAt = null;
        this.showdown(runout.times === 2 ? [this.hand.board, runout.secondBoard] : [this.hand.board]);
      }
    }
    this.changed();
    return true;
  }

  nextHand(member, automatic = false) {
    this.assertOpen();
    if (this.isPaused()) throw new GameError('礼物展示中，牌局暂时暂停');
    if (!automatic && (member?.seat == null || member.sittingOut)) throw new GameError('只有在牌桌上的玩家可以开始牌局');
    if (this.status === 'playing') throw new GameError('这一手尚未结束');
    const ready = this.eligiblePlayers();
    if (ready.length < 2) throw new GameError('至少两名入座玩家有筹码才能开始');
    if (!automatic && this.status === 'finished') {
      if (this.nextHandAt === null) this.reconcileAutoStart();
      if (Date.now() < this.nextHandAt) throw new GameError('请等待本手展示结束，下一手将在倒计时后自动开始');
    }
    this.applyPendingTableSettings();
    for (const seatedToken of this.seats) {
      const player = this.members.get(seatedToken);
      if (player) player.giftLocked = 0;
    }
    const participants = this.seats.map(token => this.members.get(token)).filter(player => player && !player.sittingOut && !player.pendingSitOut && player.stack > 0);
    this.handNo++;
    // The old button can be in a removed empty tail seat. In the retained
    // clockwise ring, the next seat after any removed tail seat is seat zero.
    const priorSeat = this.hand?.dealerSeat ?? this.capacity - 1;
    const previousDealer = priorSeat >= this.capacity ? this.capacity - 1 : priorSeat;
    const dealerSeat = this.nextSeat(previousDealer, player => player?.stack > 0 && !player.sittingOut);
    const smallBlindSeat = participants.length === 2 ? dealerSeat : this.nextSeat(dealerSeat, player => player?.stack > 0 && !player.sittingOut);
    const bigBlindSeat = this.nextSeat(smallBlindSeat, player => player?.stack > 0 && !player.sittingOut);
    const fair = makeFairDeck();
    const smallBlind = this.smallBlind, bigBlind = this.bigBlind;
    this.hand = {
      street: 0, board: [], fair, startedAt: fair.utc, actions: [], recordVersion: 1, nextCard: 0,
      dealerSeat, smallBlindSeat, bigBlindSeat, actingSeat: null, actionDeadline: null,
      smallBlind, bigBlind,
      actionTimebankBlocks: 0, currentBet: bigBlind, lastFullRaise: bigBlind,
      result: null, timerVersion: 4, voluntaryRevealHandled: false
    };
    this.status = 'playing';
    this.nextHandAt = null;
    for (const player of this.members.values()) {
      player.skippedHandNo = player.seat !== null && player.sittingOut ? this.handNo : null;
      player.revealable = null;
      player.hand = player.seat !== null && !player.sittingOut && player.stack > 0 ? {
        handNo: this.handNo, seat: player.seat, hole: [], inHand: true, folded: false, allIn: false,
        shown: false, streetCommit: 0, totalCommit: 0, timebankCommit: 0,
        timebankEnabled: false, needsAction: true,
        lastActedBet: null, lastAction: null
      } : null;
    }
    let cursor = dealerSeat;
    for (let round = 0; round < 2; round++) {
      for (let n = 0; n < participants.length; n++) {
        cursor = this.nextSeat(cursor, player => player?.hand?.handNo === this.handNo);
        this.seatMember(cursor).hand.hole.push(this.draw());
      }
    }
    const smallPlayer = this.seatMember(smallBlindSeat), bigPlayer = this.seatMember(bigBlindSeat);
    const sb = this.post(smallPlayer, smallBlind);
    this.recordAction(smallPlayer, 'smallBlind', sb, null, 'system', 'blind');
    const bb = this.post(bigPlayer, bigBlind);
    this.recordAction(bigPlayer, 'bigBlind', bb, null, 'system', 'blind');
    for (const player of participants) player.hand.needsAction = !player.hand.allIn;
    this.addEvent(`第 ${this.handNo} 手开始；${this.seatMember(dealerSeat).nickname} 持按钮，小盲 ${sb}，大盲 ${bb}`);
    this.lastHandStartedAt = fair.utc;
    this.setActor(this.nextActor(bigBlindSeat));
    if (this.hand.actingSeat === null) this.advanceStreet();
  }

  autoStartIfDue() {
    if (this.closedAt || this.isExpired()) return false;
    if (this.isPaused()) return false;
    if (this.status === 'playing' || this.nextHandAt === null || Date.now() < this.nextHandAt) return false;
    if (this.eligiblePlayers().length < 2) {
      this.changed();
      return false;
    }
    this.nextHand(null, true);
    this.changed();
    return true;
  }

  act(member, action, amount, source = 'player') {
    if (this.status !== 'playing' || member.seat !== this.hand.actingSeat || !member.hand?.needsAction) {
      throw new GameError('当前未轮到你行动');
    }
    const state = member.hand;
    const due = this.toCall(member);
    if (action === 'fold') {
      state.folded = true;
      state.needsAction = false;
      state.lastAction = 'fold';
      this.addEvent(`${member.nickname} 弃牌`, member.seat);
      this.recordAction(member, 'fold', 0, null, source);
    } else if (action === 'check') {
      if (due) throw new GameError('面对下注不能过牌');
      state.needsAction = false;
      state.lastActedBet = this.hand.currentBet;
      state.lastAction = 'check';
      this.addEvent(`${member.nickname} 过牌`, member.seat);
      this.recordAction(member, 'check', 0, null, source);
    } else if (action === 'call') {
      if (!due) throw new GameError('目前无需跟注');
      if (!this.spendableStack(member)) throw new GameError('可用筹码不足，不能跟注');
      const paid = this.post(member, due);
      state.needsAction = false;
      state.lastActedBet = this.hand.currentBet;
      state.lastAction = 'call';
      this.addEvent(`${member.nickname} 跟注 ${paid}${state.allIn ? '，全下' : ''}`, member.seat);
      this.recordAction(member, 'call', paid, null, source);
    } else if (action === 'raise') {
      if (!this.canRaise(member)) throw new GameError('当前不能加注');
      const max = this.maxRaiseTo(member), min = this.minRaiseTo();
      if (!Number.isSafeInteger(amount) || amount <= this.hand.currentBet || amount > max || (amount < min && amount !== max)) {
        throw new GameError(`加注总额须至少 ${min}，或全下至 ${max}`);
      }
      const previous = this.hand.currentBet;
      const increment = amount - state.streetCommit;
      const paid = this.post(member, increment);
      const fullRaise = amount - previous >= this.hand.lastFullRaise;
      this.hand.currentBet = amount;
      if (fullRaise) this.hand.lastFullRaise = amount - previous;
      state.needsAction = false;
      state.lastActedBet = amount;
      state.lastAction = 'raise';
      for (const other of this.livePlayers()) {
        if (other !== member && !other.hand.allIn) other.hand.needsAction = other.hand.streetCommit < amount;
      }
      this.addEvent(`${member.nickname} ${previous ? '加注' : '下注'}至 ${amount}${state.allIn ? '，全下' : ''}${fullRaise ? '' : '（不足额加注）'}`, member.seat);
      this.recordAction(member, 'raise', paid, amount, source);
    } else throw new GameError('未知行动');

    state.timebankEnabled = false;
    if (!this.spendableStack(member)) state.allIn = true;
    if (this.livePlayers().length === 1) return this.finishByFold();
    this.setActor(this.nextActor(member.seat));
    if (this.hand.actingSeat === null) this.advanceStreet();
  }

  advanceStreet() {
    for (;;) {
      if (this.hand.street === 3) return this.showdown();
      if (this.livePlayers().length >= 2 && this.activePlayers().length <= 1) return this.startRunout();
      this.hand.street++;
      this.draw(); // Burn card before flop, turn and river.
      for (let n = 0; n < (this.hand.street === 1 ? 3 : 1); n++) this.hand.board.push(this.draw());
      this.hand.currentBet = 0;
      this.hand.lastFullRaise = this.hand.bigBlind;
      for (const player of this.handPlayers()) {
        player.hand.streetCommit = 0;
        player.hand.lastActedBet = null;
        player.hand.needsAction = !player.hand.folded && !player.hand.allIn;
      }
      this.addEvent(`${STREET_NAMES[this.hand.street]}：${this.hand.board.map(item => cardLabel(item.card)).join(' ')}`);
      if (this.activePlayers().length > 1) {
        this.setActor(this.nextActor(this.hand.dealerSeat));
        if (this.hand.actingSeat !== null) return;
      }
      this.setActor(null);
    }
  }

  completeAttendance() {
    for (const member of this.members.values()) {
      if (member.seat === null) continue;
      if (member.pendingSitOut) {
        const reason = member.pendingSitOutReason;
        member.pendingSitOut = false;
        member.pendingSitOutReason = null;
        member.sittingOut = true;
        member.awayHands = 0;
        member.skippedHandNo = null;
        this.addEvent(reason === 'manual' ? `${member.nickname} 按主动选择，从下一手起暂时离席` :
          `${member.nickname} 因行动超时，从下一手起暂时离席`, member.seat);
        continue;
      }
      if (member.sittingOut && member.skippedHandNo === this.handNo) {
        member.awayHands++;
        member.skippedHandNo = null;
        if (member.awayHands >= 5) {
          const oldSeat = member.seat;
          member.cashOutTotal += member.stack;
          member.stack = 0;
          member.giftLocked = 0;
          member.pendingRebuy = 0;
          member.seat = null;
          member.sittingOut = false;
          this.seats[oldSeat] = null;
          member.lastPresenceEvent = { type: 'autoStand', handNo: this.handNo, at: new Date().toISOString() };
          this.addEvent(`${member.nickname} 连续完整暂离 5 手，自动离座成为观战者`, oldSeat);
        } else {
          this.addEvent(`${member.nickname} 已连续完整暂离 ${member.awayHands}/5 手`, member.seat);
        }
      } else if (member.skippedHandNo === this.handNo) {
        member.skippedHandNo = null;
      }
    }
  }

  finishByFold() {
    this.returnUncalledFoldedBet();
    const winner = this.livePlayers()[0];
    const amount = this.pot();
    winner.stack += amount;
    for (const player of this.handPlayers()) player.hand.timebankEnabled = false;
    const totalCommit = winner.hand.totalCommit;
    this.hand.result = { type: 'fold', pot: amount, winners: [{ seat: winner.seat,
      nickname: winner.nickname, amount, totalCommit,
      netProfit: amount - totalCommit - (winner.hand.timebankCommit ?? 0) }] };
    this.status = 'finished';
    this.setActor(null);
    this.addEvent(`${winner.nickname} 赢得底池 ${amount}（其他玩家弃牌）`, winner.seat);
    this.prepareRevealables();
    this.settleFinancialForHand();
    this.releaseGiftLocks();
    this.completeAttendance();
    this.recordFinishedHand();
  }

  releaseGiftLocks() {
    for (const member of this.members.values()) member.giftLocked = 0;
  }

  returnUncalledFoldedBet() {
    // Sitting out can fold a bettor out of turn before shorter stacks call.
    // Only the unique, unmatched excess is refundable. Matched chips remain
    // forfeited when a hand folds; never refund them from an abandoned side pot.
    const players = this.handPlayers().sort((a, b) => b.hand.totalCommit - a.hand.totalCommit);
    const player = players[0];
    if (!player?.hand.folded || players.length < 2) return 0;
    // Preserve the existing rule that a posted blind is forfeited on a fold.
    // Refund only voluntary betting above both the matched amount and that
    // forced contribution, rather than turning sit-out into a blind rebate.
    const seat = player.hand.seat ?? player.seat;
    const blind = seat === this.hand.bigBlindSeat ? this.hand.bigBlind :
      seat === this.hand.smallBlindSeat ? this.hand.smallBlind : 0;
    const amount = player.hand.totalCommit - Math.max(players[1].hand.totalCommit, blind);
    if (amount <= 0) return 0;
    player.stack += amount;
    player.hand.totalCommit -= amount;
    player.hand.streetCommit -= Math.min(amount, player.hand.streetCommit);
    this.recordAction(player, 'uncalledReturn', amount, null, 'system', 'refund');
    this.addEvent(`${player.nickname} 退回无人跟注的 ${amount} 筹码`, player.seat);
    return amount;
  }

  buildPots() {
    const players = this.handPlayers();
    const levels = [...new Set(players.map(player => player.hand.totalCommit).filter(Boolean))].sort((a, b) => a - b);
    let previous = 0;
    const pots = [];
    for (const level of levels) {
      const contributors = players.filter(player => player.hand.totalCommit >= level);
      const pot = { amount: (level - previous) * contributors.length,
        eligibleSeats: contributors.filter(player => !player.hand.folded).map(player => player.seat) };
      previous = level;
      if (pot.eligibleSeats.length) pots.push(pot);
      else {
        // Out-of-turn folds can leave a matched side pot with no live hand.
        // That dead money goes to the nearest lower eligible pot, not back to
        // folded players and not to an empty set of showdown winners.
        const lower = pots.at(-1);
        if (!lower) throw new Error('底池没有符合条件的玩家');
        lower.amount += pot.amount;
      }
    }
    // Timebank fees are dead money in the main pot: they are not a wager by
    // the payer and must not change side-pot caps or betting commitments.
    const fees = players.reduce((sum, player) => sum + (player.hand.timebankCommit ?? 0), 0);
    if (fees && pots.length) pots[0].amount += fees;
    return pots;
  }

  calculateBoardResult(board, boardIndex, boardCount, pots) {
    const boardPots = pots.map((pot, potIndex) => {
      const amount = boardCount === 2
        ? (boardIndex === 0 ? Math.ceil(pot.amount / 2) : Math.floor(pot.amount / 2)) : pot.amount;
      let winningSeats = [], best = null;
      const values = new Map();
      for (const seat of pot.eligibleSeats) {
        const player = this.seatMember(seat);
        const value = evaluateBest([...player.hand.hole, ...board].map(item => item.card));
        values.set(seat, value);
        if (!best || compareValues(value, best) > 0) { best = value; winningSeats = [seat]; }
        else if (compareValues(value, best) === 0) winningSeats.push(seat);
      }
      if (!winningSeats.length) throw new Error('分池没有符合条件的赢家');
      const individual = new Map(winningSeats.map(seat => [seat, Math.floor(amount / winningSeats.length)]));
      let remainder = amount % winningSeats.length;
      let cursor = this.hand.dealerSeat;
      while (remainder > 0) {
        cursor = (cursor + 1) % this.capacity;
        if (individual.has(cursor)) { individual.set(cursor, individual.get(cursor) + 1); remainder--; }
      }
      const winners = [...individual].map(([seat, paid]) => {
        const display = describeHandValue(values.get(seat));
        return { seat, nickname: this.seatMember(seat).nickname, amount: paid,
          handDisplay: display.label, handCategory: display.category };
      });
      return { potIndex, amount, eligibleSeats: pot.eligibleSeats, winners };
    });
    return { boardIndex, board: board.map(item => cardLabel(item.card)), pots: boardPots };
  }

  showdown(boards = [this.hand.board]) {
    this.returnUncalledFoldedBet();
    const payouts = new Map(), pots = this.buildPots();
    const runouts = boards.map((board, boardIndex) =>
      this.calculateBoardResult(board, boardIndex, boards.length, pots));
    if (this.hand.runout) this.hand.runout.boardResults = runouts;
    for (const runout of runouts) {
      for (const pot of runout.pots) for (const winner of pot.winners) {
        payouts.set(winner.seat, (payouts.get(winner.seat) ?? 0) + winner.amount);
      }
    }
    const winners = [...payouts].filter(([, amount]) => amount > 0).map(([seat, amount]) => {
      const player = this.seatMember(seat);
      const totalCommit = player.hand.totalCommit;
      player.stack += amount;
      return { seat, nickname: player.nickname, amount,
        totalCommit, netProfit: amount - totalCommit - (player.hand.timebankCommit ?? 0) };
    });
    for (const player of this.handPlayers()) player.hand.timebankEnabled = false;
    for (const player of this.livePlayers()) player.hand.shown = true;
    this.hand.result = { type: boards.length === 2 ? 'runoutTwice' : 'showdown',
      pot: this.pot(), pots, winners, boards: runouts.map(item => item.board), runouts };
    this.status = 'finished';
    this.setActor(null);
    for (const winner of winners) {
      if (boards.length === 1) {
        const player = this.seatMember(winner.seat);
        const value = evaluateBest([...player.hand.hole, ...this.hand.board].map(item => item.card));
        this.addEvent(`${winner.nickname} 以${HAND_NAMES[value[0]]}获得 ${winner.amount}`, winner.seat);
      } else this.addEvent(`${winner.nickname} 两次牌面合计获得 ${winner.amount}`, winner.seat);
    }
    this.prepareRevealables();
    this.settleFinancialForHand();
    this.releaseGiftLocks();
    this.completeAttendance();
    this.recordFinishedHand();
  }

  reveal(member, handNo = null) {
    if (this.status !== 'finished' || (handNo !== null && handNo !== this.handNo)) {
      throw new GameError('只能在当前手结算后亮出自己的底牌');
    }
    if (this.status === 'finished' && member.hand?.handNo === this.handNo && !member.revealable) {
      this.prepareRevealables(); // Compatibility with snapshots created before revealable existed.
    }
    const available = member.revealable;
    if (!available || available.handNo !== this.handNo || available.shown) {
      throw new GameError('只能亮出自己当前手已结算且尚未公开的底牌');
    }
    const record = this.history.find(item => item.handNo === available.handNo);
    if (!record) throw new GameError('找不到该手的结算记录');
    available.shown = true;
    if (member.hand?.handNo === available.handNo) member.hand.shown = true;
    const event = this.addEvent(`${member.nickname} 主动亮牌：${available.cards.join(' ')}`, available.seat, available.handNo);
    record.events ||= [];
    record.events.push(event);
    record.shownHands ||= [];
    record.shownHands.push({ seat: available.seat, nickname: member.nickname, cards: available.cards });
    record.fairness ||= { visibleCardProofs: [] };
    record.fairness.visibleCardProofs ||= [];
    const seen = new Set(record.fairness.visibleCardProofs.map(item => item.position));
    for (const proof of available.proofs) if (!seen.has(proof.position)) record.fairness.visibleCardProofs.push(proof);
    record.fairness.visibleCardProofs.sort((a, b) => a.position - b.position);
    if (available.handNo === this.handNo) this._fairCacheKey = null;
    // Consume the first voluntary reveal even when no next hand is scheduled.
    // Extend only an existing deadline; a reveal must never restart a held room.
    if (!this.hand.voluntaryRevealHandled) {
      this.hand.voluntaryRevealHandled = true;
      if (Number.isFinite(this.nextHandAt)) this.nextHandAt += VOLUNTARY_REVEAL_DELAY_MS;
    }
  }

  recordFinishedHand() {
    const record = {
      handNo: this.handNo,
      startedAt: this.hand.startedAt ?? this.hand.fair.utc,
      smallBlind: this.hand.smallBlind, bigBlind: this.hand.bigBlind,
      board: this.hand.board.map(item => cardLabel(item.card)),
      boards: this.hand.result?.boards ?? [this.hand.board.map(item => cardLabel(item.card))],
      result: this.hand.result,
      events: this.events.filter(event => event.handNo === this.handNo),
      shownHands: this.handPlayers().filter(player => player.hand.shown).map(player => ({
        seat: player.seat, nickname: player.nickname,
        cards: player.hand.hole.map(item => cardLabel(item.card))
      })),
      fairness: this.publicFairness()
    };
    const previous = this.history.findIndex(item => item.handNo === this.handNo);
    if (previous >= 0) this.history[previous] = record;
    else this.history.push(record);
  }

  backfillCurrentWinnerNet() {
    // Older history lacks per-hand commitments. Only the current finished hand
    // still has its original participant records, including the dealt seat.
    const participants = this.handPlayers();
    const byDealtSeat = new Map();
    if (participants.length < 2) return;
    for (const player of participants) {
      const seat = player.hand?.seat, committed = player.hand?.totalCommit;
      if (!Number.isInteger(seat) || seat < 0 || seat >= this.capacity ||
          !Number.isSafeInteger(committed) || committed < 0 || byDealtSeat.has(seat)) return;
      byDealtSeat.set(seat, player);
    }
    const original = this.hand.result;
    const pot = participants.reduce((sum, player) =>
      sum + player.hand.totalCommit + (player.hand.timebankCommit ?? 0), 0);
    if (!Number.isSafeInteger(pot) || pot !== original?.pot) return;
    const validWinners = result => {
      if (!result || result.type !== original.type || result.pot !== pot ||
          !Array.isArray(result.winners) || !result.winners.length) return false;
      const seen = new Set();
      let paid = 0;
      for (const winner of result.winners) {
        const player = byDealtSeat.get(winner.seat);
        if (!player || player.nickname !== winner.nickname || seen.has(winner.seat) ||
            !Number.isSafeInteger(winner.amount) || winner.amount <= 0) return false;
        seen.add(winner.seat);
        paid += winner.amount;
      }
      return paid === pot;
    };
    if (!validWinners(original)) return;
    const enrich = result => {
      for (const winner of result.winners) {
        const totalCommit = byDealtSeat.get(winner.seat).hand.totalCommit;
        winner.totalCommit = totalCommit;
        winner.netProfit = winner.amount - totalCommit -
          (byDealtSeat.get(winner.seat).hand.timebankCommit ?? 0);
      }
    };
    enrich(original);
    const historical = this.history?.find(item => item.handNo === this.handNo)?.result;
    if (historical && historical !== original && validWinners(historical) &&
        historical.winners.length === original.winners.length && historical.winners.every(item =>
          original.winners.some(winner => winner.seat === item.seat &&
            winner.nickname === item.nickname && winner.amount === item.amount))) enrich(historical);
  }

  publicFairness() {
    if (!this.hand) return null;
    const positions = new Set(this.hand.board.map(item => item.position));
    for (const item of this.hand.runout?.secondBoard ?? []) positions.add(item.position);
    for (const player of this.handPlayers()) {
      if (player.hand.shown) for (const item of player.hand.hole) positions.add(item.position);
    }
    const ordered = [...positions].sort((a, b) => a - b);
    const cacheKey = `${this.handNo}:${ordered.join(',')}`;
    if (this._fairCacheKey === cacheKey) return this._fairCache;
    const result = {
      algorithm: 'UTC + crypto entropy; HMAC-SHA256 Fisher–Yates with rejection sampling; Merkle SHA-256 v1',
      utc: this.hand.fair.utc,
      seedCommitment: this.hand.fair.seedCommitment,
      deckRoot: this.hand.fair.deckRoot,
      visibleCardProofs: ordered.map(position => cardProof(this.hand.fair, position))
    };
    this._fairCacheKey = cacheKey;
    this._fairCache = result;
    return result;
  }

  ledger() {
    return [...this.members.values()].filter(member => member.buyInTotal > 0).map(member => {
      const committed = this.status === 'playing' && member.hand?.handNo === this.handNo ?
        member.hand.totalCommit + (member.hand.timebankCommit ?? 0) : 0;
      const profitLoss = member.stack + committed + member.cashOutTotal - member.buyInTotal - member.rebuyTotal;
      const giftNet = member.giftReceivedTotal - member.giftSentTotal;
      const pendingUnload = this.pendingFinancial.filter(item => item.type === 'unload' && item.playerId === member.id)
        .reduce((sum, item) => sum + item.amount, 0);
      return {
        playerId: member.id, nickname: member.nickname, seat: member.seat,
        buyInTotal: member.buyInTotal, rebuyCount: member.rebuyCount, rebuyTotal: member.rebuyTotal,
        pendingRebuy: member.pendingRebuy, pendingUnload,
        stack: member.stack, cashOutTotal: member.cashOutTotal,
        giftSentTotal: member.giftSentTotal, giftReceivedTotal: member.giftReceivedTotal, giftNet,
        profitLoss, pokerProfitLoss: profitLoss - giftNet
      };
    });
  }

  stateFor(token) {
    const viewer = this.requireMember(token);
    const pendingTotals = member => {
      const entries = this.pendingFinancial;
      return {
        pendingUnload: entries.filter(item => item.type === 'unload' && item.playerId === member.id)
          .reduce((sum, item) => sum + item.amount, 0),
        pendingGiftSent: entries.filter(item => item.type === 'gift' && item.senderId === member.id)
          .reduce((sum, item) => sum + item.cost, 0),
        pendingGiftReceived: entries.filter(item => item.type === 'gift' && item.recipientId === member.id)
          .reduce((sum, item) => sum + item.cost, 0)
      };
    };
    const ownPending = pendingTotals(viewer);
    const pendingGifts = this.pendingFinancial.filter(item => item.type === 'gift' &&
      (item.senderId === viewer.id || item.recipientId === viewer.id)).map(item => {
      const sender = this.memberById(item.senderId), recipient = this.memberById(item.recipientId);
      return { requestId: item.requestId, handNo: item.handNo, at: item.at,
        roseType: item.roseType ?? 'whiteRose', quantity: item.quantity, cost: item.cost,
        senderId: item.senderId, sender: sender?.nickname ?? null,
        recipientId: item.recipientId, recipient: recipient?.nickname ?? null,
        direction: item.senderId === viewer.id ? 'sent' : 'received' };
    });
    const hand = this.hand;
    const runout = hand?.runout ?? null;
    const activeBoard = runout?.boardIndex === 1 && runout.secondBoard ? runout.secondBoard : hand?.board;
    const publicRunout = runout ? {
      phase: runout.phase, eligibleForTwice: runout.eligibleForTwice, reason: runout.reason,
      equity: runout.equity, trailingSeat: runout.trailingSeat, leadingSeat: runout.leadingSeat,
      equityMethod: runout.equityMethod ??
        (runout.phase === 'calculating' || runout.reason === 'equityUnavailable' ? null : 'exact'),
      equitySamples: runout.equitySamples ?? null,
      equityErrorPct: runout.equityErrorPct ?? null,
      proposal: runout.proposal, response: runout.response, times: runout.times,
      deadline: runout.deadline, nextCardAt: runout.nextCardAt,
      boardIndex: runout.boardIndex, sharedBoardCount: runout.sharedBoard?.length ?? 0,
      boardResults: runout.boardResults ?? [],
      boards: [hand.board.map(item => cardLabel(item.card)),
        ...(runout.secondBoard ? [runout.secondBoard.map(item => cardLabel(item.card))] : [])]
    } : null;
    const seats = this.seats.map((seatToken, seat) => {
      const member = this.members.get(seatToken);
      if (!member) return null;
      const playing = member.hand?.handNo === this.handNo ? member.hand : null;
      const shownCards = playing?.shown ? playing.hole.map(item => cardLabel(item.card)) : null;
      const value = shownCards && activeBoard?.length >= 3
        ? evaluateBest([...playing.hole, ...activeBoard].map(item => item.card)) : null;
      const display = describeHandValue(value);
      return {
        seat, nickname: member.nickname, playerId: member.id, stack: member.stack,
        giftLocked: member.giftLocked, spendableStack: this.spendableStack(member),
        sittingOut: !!member.sittingOut,
        pendingSitOut: !!member.pendingSitOut, awayHands: member.awayHands ?? 0,
        waitingNextHand: this.status === 'playing' && !playing && !member.sittingOut && member.stack + member.pendingRebuy > 0,
        inHand: !!playing?.inHand, folded: !!playing?.folded, allIn: !!playing?.allIn,
        streetCommit: playing?.streetCommit ?? 0, totalCommit: playing?.totalCommit ?? 0,
        timebankEnabled: !!playing?.timebankEnabled,
        timebankPaid: playing?.timebankCommit ?? 0,
        lastAction: playing?.lastAction ?? null, shownCards, handName: value ? HAND_NAMES[value[0]] : null,
        handDisplay: display?.label ?? null, handCategory: display?.category ?? null,
        rebuyCount: member.rebuyCount, rebuyTotal: member.rebuyTotal,
        pendingRebuy: member.pendingRebuy,
        pendingUnload: pendingTotals(member).pendingUnload,
        connected: member.connections.size > 0
      };
    });
    const ownHand = viewer.hand?.handNo === this.handNo ? viewer.hand : null;
    const ownValue = ownHand && activeBoard?.length >= 3
      ? evaluateBest([...ownHand.hole, ...activeBoard].map(item => item.card)) : null;
    const ownDisplay = describeHandValue(ownValue);
    const ownRunoutValues = ownHand && runout
      ? [hand.board, ...(runout.secondBoard ? [runout.secondBoard] : [])].map(board =>
        board.length >= 3 ? evaluateBest([...ownHand.hole, ...board].map(item => item.card)) : null)
      : [];
    const ownRunoutHandNames = ownRunoutValues.map(value => value ? HAND_NAMES[value[0]] : null);
    const ownRunoutHandDisplays = ownRunoutValues.map(value => describeHandValue(value));
    const canAct = this.status === 'playing' && Number.isInteger(viewer.seat) &&
      Number.isInteger(hand?.actingSeat) && viewer.seat === hand.actingSeat &&
      viewer.hand?.handNo === this.handNo;
    // Full historical proofs and events remain in the saved history and its
    // paginated API. Repeating them in every player's live snapshot makes a
    // busy ten-seat room consume megabytes of bandwidth for a single action.
    const history = this.history.slice(-5).map(record => ({
      handNo: record.handNo,
      startedAt: record.startedAt ?? record.fairness?.utc ?? null,
      smallBlind: record.smallBlind, bigBlind: record.bigBlind,
      board: record.board, boards: record.boards,
      result: record.result, shownHands: record.shownHands,
      fairness: record.fairness ? {
        utc: record.fairness.utc,
        seedCommitment: record.fairness.seedCommitment,
        deckRoot: record.fairness.deckRoot,
        visibleCardCount: record.fairness.visibleCardProofs?.length ?? 0
      } : null
    }));
    return {
      roomCode: this.code, capacity: this.capacity, seatingCapacity: this.seats.length,
      pendingCapacity: this.pendingCapacity,
      pendingBigBlind: this.pendingBigBlind, tableSettingsNotice: this.tableSettingsNotice,
      status: this.status, handNo: this.handNo,
      serverTime: Date.now(), stateVersion: this.stateVersion, nextHandAt: this.nextHandAt,
      pause: this.isPaused() ? this.pause : null,
      smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      handSmallBlind: hand?.smallBlind ?? null, handBigBlind: hand?.bigBlind ?? null,
      street: hand ? STREET_NAMES[hand.street] : null,
      streetIndex: hand?.street ?? null,
      board: hand?.board.map(item => cardLabel(item.card)) ?? [],
      runout: publicRunout,
      pot: hand ? this.pot() : 0, currentBet: hand?.currentBet ?? 0,
      minRaiseTo: hand && this.status === 'playing' && !runout ? this.minRaiseTo() : null,
      actingSeat: hand?.actingSeat ?? null, actionDeadline: hand?.actionDeadline ?? null,
      // The display reaches zero after 30 seconds; the server accepts actions
      // for five more seconds before timing out or buying the first paid block.
      actionDisplayDeadline: Number.isFinite(hand?.actionDeadline) ? hand.actionDeadline -
        (hand.actionTimebankBlocks > 0 ? 0 : ACTION_GRACE_MS) : null,
      actionWindowMs: this.status === 'playing' && Number.isInteger(hand?.actingSeat) ?
        (hand.actionTimebankBlocks > 0 ? TIMEBANK_BLOCK_MS : ACTION_DISPLAY_TIME_MS) : null,
      actionTimebankBlocks: hand?.actionTimebankBlocks ?? 0,
      dealerSeat: hand?.dealerSeat ?? null, smallBlindSeat: hand?.smallBlindSeat ?? null,
      bigBlindSeat: hand?.bigBlindSeat ?? null, seats,
      hero: {
        playerId: viewer.id, nickname: viewer.nickname, seat: viewer.seat,
        stack: viewer.stack, giftLocked: viewer.giftLocked,
        spendableStack: this.spendableStack(viewer),
        pendingRebuy: viewer.pendingRebuy, ...ownPending, pendingGifts,
        lastFinancialNotice: viewer.lastFinancialNotice ?? null,
        lastFinancialSettlement: viewer.lastFinancialSettlement ?? null,
        sittingOut: !!viewer.sittingOut,
        pendingSitOut: !!viewer.pendingSitOut,
        timebankEnabled: !!ownHand?.timebankEnabled,
        timebankPaid: ownHand?.timebankCommit ?? 0,
        canUseTimebank: this.canUseTimebank(viewer),
        awayHands: viewer.awayHands ?? 0,
        lastPresenceEvent: viewer.lastPresenceEvent ?? null,
        waitingNextHand: viewer.seat !== null && !!seats[viewer.seat]?.waitingNextHand,
        cards: ownHand?.hole.map(item => cardLabel(item.card)) ?? [],
        revealableHands: this.status === 'finished' && viewer.revealable?.handNo === this.handNo ? [{
          handNo: viewer.revealable.handNo,
          cards: viewer.revealable.cards,
          shown: viewer.revealable.shown
        }] : [],
        handName: ownValue ? HAND_NAMES[ownValue[0]] : null,
        handDisplay: ownDisplay?.label ?? null,
        handCategory: ownDisplay?.category ?? null,
        runoutHandNames: ownRunoutHandNames,
        runoutHandDisplays: ownRunoutHandDisplays,
        canAct, toCall: canAct ? this.toCall(viewer) : 0,
        canChooseRunout: runout?.phase === 'trailingVote' && viewer.seat === runout.trailingSeat,
        canRespondRunout: runout?.phase === 'leaderVote' && viewer.seat === runout.leadingSeat,
        minRaiseTo: canAct ? this.minRaiseTo() : null,
        maxRaiseTo: canAct ? this.maxRaiseTo(viewer) : null,
        canRaise: canAct && this.canRaise(viewer), isOwner: viewer.token === this.ownerToken,
        canEditTableSettings: viewer.seat === null
      },
      spectatorCount: [...this.members.values()].filter(member => member.seat === null && member.connections.size > 0).length,
      events: this.events.slice(-250), history, historyTotal: this.history.length,
      ledger: this.ledger(), result: hand?.result ?? null,
      fairness: this.publicFairness()
    };
  }

  command(token, data) {
    const member = this.requireMember(token);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GameError('命令格式错误');
    if (data.type === 'unload' && this.commandReceipt(member, data.requestId, 'unload')) return this.stateFor(token);
    if (this.isPaused()) throw new GameError('礼物展示中，牌局暂时暂停');
    // Resolve the absolute deadline before accepting a late action or switch.
    // A purchased block changes expectedAction.actionDeadline, so stale
    // preactions are rejected against the new state.
    if (data.type === 'action' || data.type === 'timebank') this.timeoutAction();
    if (data.type === 'action' && Object.hasOwn(data, 'expectedAction')) {
      const expected = data.expectedAction;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
          expected.handNo !== this.handNo || expected.streetIndex !== this.hand?.street ||
          expected.actingSeat !== this.hand?.actingSeat ||
          expected.actionDeadline !== this.hand?.actionDeadline ||
          expected.currentBet !== this.hand?.currentBet) {
        throw new GameError('行动已更新，请重新选择。');
      }
    }
    if (data.type === 'action' && data.action === 'call' && Object.hasOwn(data, 'maxCallAmount')) {
      // A preselected short-stack call authorizes only its displayed cost.
      // Recheck the cap after timeout handling and against authoritative funds.
      if (!member.hand || member.seat !== this.hand?.actingSeat ||
          !Number.isSafeInteger(data.maxCallAmount) || data.maxCallAmount <= 0 ||
          Math.min(this.toCall(member), this.spendableStack(member)) > data.maxCallAmount) {
        throw new GameError('行动已更新，请重新选择。');
      }
    }
    switch (data.type) {
      case 'sit': this.sit(member, data.seat, data.buyIn ?? DEFAULT_BUY_IN); break;
      case 'stand': this.stand(member); break;
      case 'sitOut': this.sitOut(member); break;
      case 'return': this.returnToTable(member); break;
      case 'rebuy': this.rebuy(member, data.amount); break;
      case 'unload': this.unload(member, data.requestId); break;
      case 'action': this.act(member, data.action, data.amount); break;
      case 'timebank': this.setTimebank(member, data.enabled); break;
      case 'runoutChoice': this.runoutChoice(member, data.times); break;
      case 'runoutResponse': this.runoutResponse(member, data.accept); break;
      case 'reveal': this.reveal(member, data.handNo ?? null); break;
      case 'nextHand': this.nextHand(member); break;
      case 'setCapacity': this.setCapacity(member, data.capacity); break;
      case 'setBigBlind': this.setBigBlind(member, data.amount); break;
      default: throw new GameError('未知命令');
    }
    this.changed({ reconcileAutoStart: data.type !== 'reveal' });
    return this.stateFor(token);
  }

  timeoutAction() {
    if (this.isPaused()) return false;
    if (this.status !== 'playing' || this.hand?.actingSeat === null || Date.now() < this.hand.actionDeadline) return false;
    const member = this.seatMember(this.hand.actingSeat);
    // A newly seated player has no cards in this hand. An old or corrupt
    // actingSeat must never put that player away for an action they never had.
    if (!this.canUseTimebank(member) || member.seat !== this.hand.actingSeat) {
      this.setActor(this.nextActor(this.hand.actingSeat));
      if (this.hand.actingSeat === null) this.advanceStreet();
      this.changed();
      return true;
    }
    if (member.hand.timebankEnabled) {
      const now = Date.now();
      if (this.spendableStack(member) >= TIMEBANK_BLOCK_COST) {
        member.stack -= TIMEBANK_BLOCK_COST;
        member.hand.timebankCommit += TIMEBANK_BLOCK_COST;
        this.hand.actionTimebankBlocks++;
        // A sleeping server or a restarted process could wake long after the
        // deadline. Charge only one block and provide its full playable time.
        this.hand.actionDeadline = Math.max(this.hand.actionDeadline + TIMEBANK_BLOCK_MS,
          now + TIMEBANK_BLOCK_MS);
        this.recordAction(member, 'timebank', TIMEBANK_BLOCK_COST, 1, 'system', 'timebank');
        this.addEvent(`${member.nickname} 加时 10 秒，支付 ${TIMEBANK_BLOCK_COST} 筹码入底池`, member.seat);
        this.changed();
        return true;
      }
    }
    const action = this.toCall(member) ? 'fold' : 'check';
    member.pendingSitOut = true;
    member.pendingSitOutReason = 'timeout';
    member.lastPresenceEvent = { type: 'timeoutSitOut', handNo: this.handNo, at: new Date().toISOString() };
    this.addEvent(`${member.nickname} 行动超时，自动${action === 'fold' ? '弃牌' : '过牌'}；下一手暂离`, member.seat);
    this.recordAction(member, 'timeout', 0, null, 'system', 'timeout');
    this.act(member, action, undefined, 'timeout');
    this.changed();
    return true;
  }
}
