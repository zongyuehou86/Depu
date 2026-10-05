import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, chmodSync, writeFileSync, renameSync, existsSync,
  realpathSync, statSync, lstatSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, GameError, capacityValue, ROOM_CLOSED_MESSAGE } from './room.js';
import { cardLabel } from './engine.js';
import { EquityPool } from './equity-pool.js';
import { sendLatestState, clearSocketQueue, startHeartbeat } from './realtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const handRecordsDir = path.resolve(process.env.HAND_RECORDS_DIR || path.join(here, 'hand-records'));
const realPublicDir = realpathSync(publicDir);
if (handRecordsDir === publicDir || handRecordsDir.startsWith(`${publicDir}${path.sep}`)) {
  throw new Error('私有牌局记录目录不能位于 public 内');
}
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const recordsDirExisted = existsSync(handRecordsDir);
mkdirSync(handRecordsDir, { recursive: true, mode: 0o700 });
if (lstatSync(handRecordsDir).isSymbolicLink() || !statSync(handRecordsDir).isDirectory() ||
    realpathSync(handRecordsDir) === realPublicDir ||
    realpathSync(handRecordsDir).startsWith(`${realPublicDir}${path.sep}`)) {
  throw new Error('私有牌局记录目录必须是 public 外的真实目录');
}
if (process.env.HAND_RECORDS_DIR && recordsDirExisted && (statSync(handRecordsDir).mode & 0o777) !== 0o700) {
  throw new Error('自定义私有牌局记录目录须预先设置为 0700 权限');
}
chmodSync(handRecordsDir, 0o700);

const rooms = new Map();
const deadlines = new Map();
const nextHandTimers = new Map();
const pauseTimers = new Map();
const expiryTimers = new Map();
const recentRequests = new Map();
const transactionIndex = new Map();
const roomSocketHandlers = new WeakMap();
// A just-created identity may be joined by a second tab before its first socket opens.
const pendingWelcomes = new WeakMap();
const equityPool = new EquityPool();
const equityJobs = new WeakMap();
const roomOptions = { deferEquity: true };

// Limit data is keyed by IP, not room. Expired entries are removed even when
// a previously seen IP never sends another request.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, timestamps] of recentRequests) {
    const recent = timestamps.filter(at => at > cutoff);
    if (recent.length) recentRequests.set(key, recent);
    else recentRequests.delete(key);
  }
}, 60_000).unref();

function sendJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(body);
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true; // Native clients do not send Origin; they still need a bearer token.
  try {
    const claimed = new URL(origin);
    const knownHosts = [request.headers.host, request.headers['x-forwarded-host']]
      .filter(Boolean).flatMap(value => String(value).split(',').map(item => item.trim()));
    return ['http:', 'https:'].includes(claimed.protocol) && knownHosts.includes(claimed.host);
  } catch { return false; }
}

function rateLimit(request, scope, maximum) {
  const ip = request.socket.remoteAddress || 'unknown';
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const history = (recentRequests.get(key) || []).filter(at => at > now - 60_000);
  if (history.length >= maximum) throw new GameError('请求过于频繁，请稍后再试', 429);
  history.push(now);
  recentRequests.set(key, history);
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new GameError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GameError('请求须为 JSON 对象');
    return value;
  }
  catch (error) {
    if (error instanceof GameError) throw error;
    throw new GameError('JSON 格式错误');
  }
}

function tokenFromRequest(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,80})$/.exec(request.headers.authorization || '');
  if (!match) throw new GameError('请先输入昵称进入房间', 401);
  return match[1];
}

function persistSnapshot(code, snapshot, durable = false) {
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw new Error('房间编号无效');
  const target = path.join(dataDir, `${code}.json`);
  const temporary = `${target}.${process.pid}.${randomInt(1_000_000)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flush: durable });
    renameSync(temporary, target);
    if (durable) {
      const directory = openSync(dataDir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Rename may already have succeeded. */ }
    throw error;
  }
}

function persist(room, durable = false) { persistSnapshot(room.code, room.toJSON(), durable); }

function privateTransactionDir(room) {
  if (!/^\d{4,8}$/.test(room.code)) throw new Error('交易记录房间编号无效');
  const roomDir = path.join(handRecordsDir, room.code);
  const transactionDir = path.join(roomDir, 'transactions');
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  for (const [directory, expected] of [[roomDir, path.join(realpathSync(handRecordsDir), room.code)],
    [transactionDir, path.join(realpathSync(handRecordsDir), room.code, 'transactions')]]) {
    if (lstatSync(directory).isSymbolicLink() || !statSync(directory).isDirectory() ||
        realpathSync(directory) !== expected) throw new Error('私有交易记录目录无效');
    chmodSync(directory, 0o700);
  }
  return transactionDir;
}

function transactionFilename(transaction) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(transaction.requestId)) {
    throw new Error('交易请求编号无效');
  }
  if (transaction.type === 'gift' || transaction.type === 'unload' || transaction.type === 'rebuy') {
    if (!Number.isSafeInteger(transaction.seq) || transaction.seq < 1) throw new Error('交易序号无效');
    return `${String(transaction.seq).padStart(10, '0')}-${transaction.type}-${transaction.requestId}.txt`;
  }
  if (transaction.type === 'sneak') return `sneak-${transaction.requestId}.txt`;
  throw new Error('未知交易记录类型');
}

function privateTransactionText(room, transaction) {
  const header = `POKER_TRANSACTION_JSON ${JSON.stringify(transaction)}`;
  const lines = [header, `房间：${room.code}`, `时间 (UTC)：${transaction.at ?? transaction.effect?.at}`,
    `本手：${transaction.handNo ?? '手间'}`];
  if (transaction.type === 'gift') {
    lines.push(`类型：${transaction.roseType === 'redRose' ? '红玫瑰' : '白玫瑰'}花束`,
      `结算：${transaction.transactionVersion === 2 && transaction.handNo !== null ? '本手结束后' : '当下'}`,
      `赠送者：${transaction.effect.sender.nickname}（${transaction.senderId}）`,
      `接收者：${transaction.effect.recipient.nickname}（${transaction.recipientId}）`,
      `数量：${transaction.quantity} 束`, `筹码转移：${transaction.cost}`,
      `可见范围：${transaction.effect.scope}`);
  } else if (transaction.type === 'rebuy') {
    lines.push('类型：手动补码', `玩家：${transaction.nickname}（${transaction.playerId}）`,
      `补入筹码：${transaction.amount}`,
      `结算：${transaction.handNo === null ? '当下' : '本手结束后'}`);
  } else if (transaction.type === 'unload') {
    lines.push('类型：卸码', `玩家：${transaction.nickname}（${transaction.playerId}）`,
      `卸出筹码：${transaction.amount}`,
      `结算：${transaction.transactionVersion === 2 && transaction.handNo !== null ? '本手结束后（余额不足将取消）' : '当下'}`);
  } else {
    lines.push('类型：免费悄悄话', `玩家：${transaction.effect.sender.nickname}（${transaction.playerId}）`,
      '文案：悄悄地进村 → 打枪的不要');
  }
  return `${lines.join('\n')}\n`;
}

function writePrivateTransaction(room, transaction) {
  const directory = privateTransactionDir(room);
  const target = path.join(directory, transactionFilename(transaction));
  const content = privateTransactionText(room, transaction);
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || readFileSync(target, 'utf8') !== content) {
      throw new Error('现有交易记录与请求不一致');
    }
    chmodSync(target, 0o600);
    return;
  }
  const temporary = `${target}.${process.pid}.${randomInt(1_000_000)}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* No temporary file. */ }
    throw error;
  }
}

function readPrivateTransactions(room) {
  const directory = path.join(handRecordsDir, room.code, 'transactions');
  if (!existsSync(directory)) return [];
  privateTransactionDir(room);
  return readdirSync(directory).filter(file => /^(?:\d{10}-(?:gift|unload|rebuy)|sneak)-[0-9a-f-]{36}\.txt$/i.test(file))
    .map(file => {
      const full = path.join(directory, file);
      if (!lstatSync(full).isFile()) throw new Error('交易记录不是普通文件');
      const first = readFileSync(full, 'utf8').split('\n', 1)[0];
      if (!first.startsWith('POKER_TRANSACTION_JSON ')) throw new Error('交易记录缺少可恢复元数据');
      const transaction = JSON.parse(first.slice('POKER_TRANSACTION_JSON '.length));
      if (transactionFilename(transaction) !== file) throw new Error('交易记录文件名与内容不符');
      return transaction;
    });
}

function recoverMoneyTransactions(room) {
  const transactions = readPrivateTransactions(room);
  const index = new Map();
  for (const item of transactions) {
    const playerId = item.senderId ?? item.playerId;
    const key = `${playerId}:${item.requestId}`;
    if (index.has(key)) throw new Error('重复的私有交易请求编号');
    index.set(key, item);
  }
  const pending = transactions
    .filter(item => (item.type === 'gift' || item.type === 'unload' || item.type === 'rebuy') && item.seq > room.transactionSeq)
    .sort((a, b) => a.seq - b.seq);
  for (const transaction of pending) {
    if (transaction.type === 'gift') room.applyGiftTransaction(transaction);
    else if (transaction.type === 'rebuy') room.applyRebuyTransaction(transaction);
    else room.applyUnloadTransaction(transaction);
  }
  transactionIndex.set(room.code, index);
}

function previousPrivateTransaction(room, member, requestId, type) {
  if (typeof requestId !== 'string') return null;
  const previous = transactionIndex.get(room.code)?.get(`${member.id}:${requestId.toLowerCase()}`);
  if (previous && previous.type !== type) throw new GameError('请求编号已用于其他操作');
  return previous ?? null;
}

function indexPrivateTransaction(room, member, transaction) {
  let index = transactionIndex.get(room.code);
  if (!index) { index = new Map(); transactionIndex.set(room.code, index); }
  index.set(`${member.id}:${transaction.requestId}`, transaction);
}

function privateHandRecord(room) {
  if (room.status !== 'finished' || !room.hand?.result) return null;
  const participants = room.handPlayers();
  const completeHoles = participants.length >= 2 && participants.every(player =>
    Array.isArray(player.hand.hole) && player.hand.hole.length === 2 &&
    player.hand.hole.every(item => Number.isInteger(item.card) && item.card >= 0 && item.card < 52));
  if (!completeHoles) {
    if (room.hand.recordVersion === 1) throw new Error('已结算牌局的底牌不完整，已暂停下一手');
    // Old finished snapshots can lack the hidden cards. Never invent or infer them.
    return null;
  }
  if (room.hand.recordVersion === 1 && (!Array.isArray(room.hand.actions) || room.hand.actions.length < 2)) {
    throw new Error('已结算牌局的操作记录不完整，已暂停下一手');
  }
  const oldHand = room.hand.recordVersion !== 1;
  const board = room.hand.board.map(item => cardLabel(item.card));
  const result = room.hand.result;
  const handEvents = room.events.filter(event => event.handNo === room.handNo);
  const finishedAt = handEvents.at(-1)?.at ?? new Date().toISOString();
  const lines = [
    `房间 ${room.code} · 第 ${room.handNo} 手`,
    `开始时间 (UTC)：${room.hand.startedAt ?? room.hand.fair?.utc ?? '未知'}`,
    `结算时间 (UTC)：${finishedAt}`,
    `位置：按钮 ${room.hand.dealerSeat + 1} 号位；小盲 ${room.hand.smallBlindSeat + 1} 号位；大盲 ${room.hand.bigBlindSeat + 1} 号位`,
    `本手盲注：小盲 ${room.hand.smallBlind ?? 10}；大盲 ${room.hand.bigBlind ?? 20}`,
    `公共牌：${board.length ? board.join(' ') : '无'}`,
    `翻牌：${board.length >= 3 ? board.slice(0, 3).join(' ') : '未发'}；转牌：${board[3] ?? '未发'}；河牌：${board[4] ?? '未发'}`,
    '', '实际参与者及底牌：'
  ];
  if (Array.isArray(result.boards) && result.boards.length === 2) {
    lines.splice(lines.length - 1, 0,
      `第 1 次公共牌：${result.boards[0].join(' ')}`,
      `第 2 次公共牌：${result.boards[1].join(' ')}`,
      `共享前 ${room.hand.runout?.sharedBoard?.length ?? 3} 张公共牌；每个分池先对半拆分，奇数筹码归第 1 次牌面。`);
  }
  if (room.hand.runout) {
    const runout = room.hand.runout;
    lines.splice(lines.length - 1, 0,
      `跑马：${runout.times} 次；${runout.reason === 'multiway' ? '超过两名有效争夺者，仅发一次' :
        runout.reason === 'equityTie' ? '胜率相同，仅发一次' : '双人协商'}`,
      `协商胜率：${runout.equityMethod === 'monteCarlo' ?
        `翻前独立蒙特卡洛估计 ${runout.equitySamples} 次，单人份额约 95% ±${runout.equityErrorPct} 个百分点` : '已公开公共牌的精确枚举'}`,
      `落后方位置：${runout.trailingSeat === null ? '无' : runout.trailingSeat + 1}；领先方位置：${runout.leadingSeat === null ? '无' : runout.leadingSeat + 1}；提议：${runout.proposal ?? '无'}；领先方${runout.response === null ? '未表态' : runout.response ? '接受' : '拒绝'}`);
    for (const item of runout.equity ?? []) lines.splice(lines.length - 1, 0,
      `协商时胜率 ${item.seat + 1} 号位：独赢 ${item.winPct}%；平局 ${item.tiePct}%；含平局份额 ${item.equityPct}%`);
  }
  for (const player of participants.sort((a, b) => a.hand.seat - b.hand.seat)) {
    lines.push(`  ${player.hand.seat + 1} 号位 ${player.nickname}：${player.hand.hole.map(item => cardLabel(item.card)).join(' ')}${player.hand.folded ? '（已弃牌）' : ''}`);
  }
  for (const player of room.seats.map(token => room.members.get(token)).filter(Boolean)) {
    if (!participants.includes(player)) lines.push(`  ${player.seat + 1} 号位 ${player.nickname}：未发牌（暂离或未参与）`);
  }
  const spectators = [...room.members.values()].filter(member => member.seat === null).length;
  if (spectators) lines.push(`  观战者：未发牌（${spectators} 人）`);
  lines.push('', '逐条操作：');
  if (oldHand) {
    lines.push('  旧版本牌局：结构化操作不完整；以下为升级前保留的公开事件原文。');
    const firstStructuredAt = room.hand.actions?.[0]?.at;
    for (const event of handEvents.filter(event => !firstStructuredAt || event.at < firstStructuredAt)) {
      lines.push(`  [${event.at}] ${event.street ?? '牌局'} | ${event.text}`);
    }
  }
  const actionNames = { smallBlind: '小盲', bigBlind: '大盲', fold: '弃牌', check: '过牌',
    call: '跟注', raise: '加注', uncalledReturn: '退回无人跟注筹码', timeout: '行动超时', timebank: '购买加时',
    runoutChoice: '选择跑马次数', runoutResponse: '回应跑马提议' };
  for (const action of room.hand.actions ?? []) {
    const label = actionNames[action.action] ?? action.action;
    const target = action.action === 'raise' ? `；本轮加注至 ${action.target}` :
      action.action === 'timebank' ? `；购买 ${action.target} 个 10 秒加时块，费用进入主池` :
      action.action === 'runoutChoice' ? `；选择 ${action.target} 次` :
      action.action === 'runoutResponse' ? `；${action.target === 2 ? '接受' : '拒绝'}两次` : '';
    const source = action.source === 'timeout' ? '（超时自动）' : action.source === 'sitOut' ? '（暂离）' : '';
    const movement = action.action === 'uncalledReturn' ? '实际退回' : '实际支付';
    lines.push(`  [${action.at}] ${action.street} | ${action.seat + 1} 号位 ${action.nickname} | ${label}${source}；${movement} ${action.amount}${target}`);
  }
  if (room.hand.runout) {
    lines.push('', '跑马公开与计时事件：');
    for (const event of handEvents.filter(item => /共享翻牌|第 1 次翻牌|独立翻牌|进入跑马|跑马确定|跑马|第 [12] 次[转河]牌|牌面赢家|展示结束|选择超时|确认超时/.test(item.text))) {
      lines.push(`  [${event.at}] ${event.text}`);
    }
  }
  lines.push('', '结算：', `  类型：${result.type === 'fold' ? '其余玩家弃牌' : '摊牌'}`, `  底池：${result.pot}`);
  if (Array.isArray(result.pots)) for (const [index, pot] of result.pots.entries()) {
    lines.push(`  分池 ${index + 1}：${pot.amount}；争夺座位 ${pot.eligibleSeats.map(seat => seat + 1).join(', ')}`);
  }
  if (Array.isArray(result.runouts)) for (const runout of result.runouts) {
    lines.push(`  第 ${runout.boardIndex + 1} 次牌面：${runout.board.join(' ')}`);
    for (const pot of runout.pots) {
      lines.push(`    分池 ${pot.potIndex + 1} 本次份额 ${pot.amount}；${pot.winners.map(winner =>
        `${winner.seat + 1} 号位 ${winner.nickname}${winner.handDisplay ? ` 以${winner.handDisplay}` : ''} 获得 ${winner.amount}`).join('、')}`);
    }
  }
  for (const winner of result.winners ?? []) lines.push(`  ${winner.seat + 1} 号位 ${winner.nickname} 获得 ${winner.amount}`);
  const transactions = readPrivateTransactions(room).filter(item => item.handNo === room.handNo);
  transactions.sort((a, b) => String(a.at ?? a.effect?.at).localeCompare(String(b.at ?? b.effect?.at)));
  const settlement = room.hand.financialSettlement;
  if (settlement) {
    lines.push('', '本手礼物结算（牌局底池已经先行结算）：');
    for (const item of settlement.manualRebuys) lines.push(`  手动补码：${item.nickname} +${item.amount}${item.legacy ? '（旧存档排队补码）' : ''}`);
    for (const item of settlement.autoRebuys) lines.push(`  礼物不足自动补码：${item.nickname} +${item.amount}（${item.count} 次 × 2000）`);
    for (const item of settlement.gifts) lines.push(`  [${item.at}] ${item.sender} 送给 ${item.recipient} ${item.quantity} 束${item.roseType === 'redRose' ? '红玫瑰' : '白玫瑰'}，转移 ${item.cost} 筹码`);
    for (const item of settlement.unloads) lines.push(`  卸码：${item.nickname} ${item.accepted ? `成功 ${item.amount}` : `取消（${item.reason}）`}`);
    if (!settlement.manualRebuys.length && !settlement.autoRebuys.length && !settlement.gifts.length && !settlement.unloads.length) lines.push('  无待结算筹码操作');
  }
  const legacyTransactions = transactions.filter(item =>
    (item.type === 'gift' || item.type === 'unload') && item.transactionVersion !== 2);
  if (legacyTransactions.length) {
    // A hand started before deployment may contain both old immediate transfers
    // and new deferred transfers. Preserve both in the final private record.
    lines.push('', '旧版本手期间即时礼物与卸码：');
    for (const item of legacyTransactions) {
      if (item.type === 'gift') lines.push(`  [${item.at}] ${item.effect.sender.nickname} 送给 ${item.effect.recipient.nickname} ${item.quantity} 束花，转移 ${item.cost} 筹码`);
      else if (item.type === 'unload') lines.push(`  [${item.at}] ${item.nickname} 卸码 ${item.amount}`);
    }
  }
  for (const item of transactions.filter(item => item.type === 'sneak')) {
    lines.push(`  [${item.effect.at}] ${item.effect.sender.nickname} 使用免费悄悄话`);
  }
  lines.push('', `记录完毕：房间 ${room.code} 第 ${room.handNo} 手`);
  return `${lines.join('\n')}\n`;
}

function ensurePrivateHandRecord(room) {
  if (typeof room.code !== 'string' || !/^\d{4,8}$/.test(room.code) ||
      !Number.isSafeInteger(room.handNo) || room.handNo < 1) {
    throw new Error('私有牌局记录的房间编号或手数无效');
  }
  if (room.status !== 'finished' || !room.hand?.result) return;
  const roomDir = path.join(handRecordsDir, room.code);
  mkdirSync(roomDir, { recursive: true, mode: 0o700 });
  if (lstatSync(roomDir).isSymbolicLink() || !statSync(roomDir).isDirectory() ||
      realpathSync(roomDir) !== path.join(realpathSync(handRecordsDir), room.code)) {
    throw new Error('私有牌局记录房间目录无效');
  }
  chmodSync(roomDir, 0o700);
  const target = path.join(roomDir, `${room.handNo}.txt`);
  if (existsSync(target)) {
    if (!lstatSync(target).isFile() || statSync(target).size === 0) throw new Error('现有私有牌局记录无效');
    const stored = readFileSync(target, 'utf8');
    if (!stored.startsWith(`房间 ${room.code} · 第 ${room.handNo} 手\n`) ||
        !stored.includes('\n实际参与者及底牌：\n') || !stored.includes('\n结算：\n') ||
        !stored.endsWith(`\n记录完毕：房间 ${room.code} 第 ${room.handNo} 手\n`)) {
      throw new Error('现有私有牌局记录与房间或手数不符');
    }
    chmodSync(target, 0o600);
    return;
  }
  const content = privateHandRecord(room);
  if (content === null) return;
  const temporary = `${target}.${process.pid}.${randomInt(1_000_000)}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Temporary file may not exist. */ }
    throw error;
  }
}

function holdForRecordFailure(room, error) {
  console.error(`房间 ${room.code} 第 ${room.handNo} 手私有记录写入失败: ${error.message}`);
  room.nextHandAt = null;
  persist(room);
}

function broadcast(room) {
  if (closeRoomIfInactive(room)) return;
  for (const member of room.members.values()) {
    if (!member.connections.size) continue;
    let text;
    try { text = JSON.stringify({ type: 'state', state: room.stateFor(member.token) }); }
    catch (error) {
      if (error instanceof GameError && error.errorCode === 'ROOM_CLOSED') {
        closeRoomIfInactive(room);
        return;
      }
      throw error;
    }
    for (const socket of member.connections) {
      sendLatestState(socket, text);
    }
  }
}

function roomEffect(room, member, trigger) {
  if (!member.celebrationGuest) return null;
  const welcome = trigger === 'join';
  return {
    type: 'roomEffect', id: randomUUID(), at: new Date().toISOString(), roomCode: room.code,
    trigger, style: welcome ? 'fireworks' : 'pixel',
    text: welcome ? '欢迎可可姐' : '收手吧Kelly🥹',
    playerId: member.id, nickname: member.nickname, seat: member.seat
  };
}

function broadcastEffect(room, effect) {
  if (!effect) return;
  const packet = JSON.stringify(effect);
  for (const member of room.members.values()) {
    for (const socket of member.connections) {
      if (socket.readyState === WebSocket.OPEN) socket.send(packet);
    }
  }
}

function broadcastGiftEffect(room, effect) {
  if (!effect) return;
  const visible = effect.scope === 'private'
    ? new Set([effect.sender.playerId, effect.recipient.playerId]) : null;
  const packet = JSON.stringify(effect);
  for (const member of room.members.values()) {
    if (visible && !visible.has(member.id)) continue;
    for (const socket of member.connections) {
      if (socket.readyState === WebSocket.OPEN) socket.send(packet);
    }
  }
}

function welcomeOnJoin(room, member, fresh, explicitEntry) {
  if (!member.celebrationGuest || (!fresh && !explicitEntry)) return null;
  if (!fresh && (member.connections.size || (pendingWelcomes.get(member) ?? 0) > Date.now())) return null;
  pendingWelcomes.set(member, Date.now() + 10_000);
  const effect = roomEffect(room, member, 'join');
  broadcastEffect(room, effect);
  return effect;
}

function closedRoomError() { return new GameError(ROOM_CLOSED_MESSAGE, 410, 'ROOM_CLOSED'); }

function archivedRoomStatus(code) {
  if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) return 'absent';
  const target = path.join(dataDir, `${code}.json`);
  if (!existsSync(target)) return 'absent';
  try {
    const snapshot = JSON.parse(readFileSync(target, 'utf8'));
    if (snapshot.code !== code) throw new Error('房间编号不符');
    return snapshot.closedAt ? 'closed' : 'unavailable';
  } catch (error) {
    console.error(`房间 ${code} 存档检查失败: ${error.message}`);
    return 'unavailable';
  }
}

function detachedSocketError(error) {
  console.error(`房间关闭后 WebSocket 出错: ${error.message}`);
}

function clearRoomTimers(code) {
  for (const timers of [deadlines, nextHandTimers, pauseTimers, expiryTimers]) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }
}

function closeRoomIfInactive(room) {
  if (rooms.get(room.code) !== room) return true;
  if (!room.closedAt && !room.markClosedInactive()) return false;
  try {
    // The archive, including its members and unfinished hand, reaches disk
    // before anyone is told that their room has closed.
    persist(room, true);
  } catch (error) {
    room.closurePending = true;
    console.error(`房间 ${room.code} 到期关闭状态保存失败: ${error.message}`);
    scheduleDeadline(room);
    return true;
  }
  room.closurePending = false;
  rooms.delete(room.code);
  clearRoomTimers(room.code);
  transactionIndex.delete(room.code);
  const packet = JSON.stringify({ type: 'roomClosed', roomCode: room.code,
    reason: 'inactive', message: ROOM_CLOSED_MESSAGE });
  const sockets = [];
  for (const member of room.members.values()) {
    pendingWelcomes.delete(member);
    for (const socket of member.connections) sockets.push(socket);
    member.connections.clear();
  }
  for (const socket of sockets) {
    const detach = roomSocketHandlers.get(socket);
    if (detach) detach();
    if (socket.readyState !== WebSocket.OPEN) continue;
    try { socket.send(packet); socket.close(4004, 'ROOM_CLOSED'); }
    catch (error) {
      console.error(`房间 ${room.code} 关闭连接失败: ${error.message}`);
      socket.terminate();
    }
  }
  return true;
}

function ensureActiveRoom(room) {
  if (closeRoomIfInactive(room)) {
    if (room.closurePending) throw new GameError('房间关闭状态正在保存，请稍后重试', 503, 'ROOM_CLOSING');
    throw closedRoomError();
  }
}

function scheduleDeadline(room) {
  clearRoomTimers(room.code);
  if (rooms.get(room.code) !== room) return;
  if (room.closedAt) {
    if (room.closurePending) expiryTimers.set(room.code, setTimeout(() => closeRoomIfInactive(room), 5_000));
    return;
  }
  if (room.isExpired()) { closeRoomIfInactive(room); return; }
  expiryTimers.set(room.code, setTimeout(() => {
    if (!closeRoomIfInactive(room)) scheduleDeadline(room);
  }, Math.max(1, room.expiryAt() - Date.now()) + 5));
  if (room.persistenceFault) return;
  if (room.isPaused()) {
    const timer = setTimeout(() => {
      if (closeRoomIfInactive(room)) return;
      try { if (!room.endPauseIfDue()) scheduleDeadline(room); }
      catch (error) { console.error(`房间 ${room.code} 礼物暂停恢复失败: ${error.message}`); }
    }, Math.max(1, room.pause.endAt - Date.now()) + 5);
    pauseTimers.set(room.code, timer);
  }
  const runoutAt = room.runoutDeadline();
  if (room.status === 'playing' && Number.isFinite(runoutAt)) {
    const wait = Math.max(1, runoutAt - Date.now());
    const timer = setTimeout(() => {
      if (closeRoomIfInactive(room)) return;
      try { if (!room.advanceRunoutIfDue()) scheduleDeadline(room); }
      catch (error) {
        console.error(`房间 ${room.code} 跑马计时失败: ${error.message}`);
        if (room.status === 'playing' && room.hand?.runout) {
          room.hand.runout.phase = 'paused';
          room.hand.runout.deadline = null;
          room.hand.runout.nextCardAt = null;
          room.addEvent('跑马因服务器错误暂停，请联系管理员');
          try { room.changed(); } catch (saveError) {
            console.error(`房间 ${room.code} 跑马暂停状态保存失败: ${saveError.message}`);
          }
        }
      }
    }, wait + 5);
    deadlines.set(room.code, timer);
  } else if (room.status === 'playing' && room.hand?.actingSeat !== null && room.hand?.actionDeadline) {
    const wait = Math.max(1, room.hand.actionDeadline - Date.now());
    const timer = setTimeout(() => {
      if (closeRoomIfInactive(room)) return;
      try { if (!room.timeoutAction()) scheduleDeadline(room); }
      catch (error) {
        console.error(`房间 ${room.code} 行动计时失败: ${error.message}`);
        room.persistenceFault = true;
        scheduleDeadline(room);
      }
    }, wait + 5);
    deadlines.set(room.code, timer);
  }
  if (room.status !== 'playing' && room.nextHandAt !== null) {
    const wait = Math.max(1, room.nextHandAt - Date.now());
    const timer = setTimeout(() => {
      if (closeRoomIfInactive(room)) return;
      try {
        if (room.status === 'finished') ensurePrivateHandRecord(room);
        if (!room.autoStartIfDue()) scheduleDeadline(room);
      }
      catch (error) {
        console.error(`房间 ${room.code} 自动开手失败: ${error.message}`);
        if (room.status === 'finished') holdForRecordFailure(room, error);
        else { room.nextHandAt = Date.now() + 5_000; room.changed(); }
        broadcast(room);
        scheduleDeadline(room);
      }
    }, wait + 5);
    nextHandTimers.set(room.code, timer);
  }
}

function roomChanged(room) {
  if (closeRoomIfInactive(room)) return;
  persist(room);
  if (room.status === 'finished') {
    try { ensurePrivateHandRecord(room); }
    catch (error) { holdForRecordFailure(room, error); }
  }
  broadcast(room);
  room.persistenceFault = false;
  scheduleDeadline(room);
  scheduleEquity(room);
}

function scheduleEquity(room) {
  const runout = room.hand?.runout;
  if (room.status !== 'playing' || runout?.phase !== 'calculating' || equityJobs.has(room)) return;
  const input = room.runoutEquityInput();
  if (!input) return;
  equityJobs.set(room, runout);
  // One retry covers a crashed worker. A failed display calculation must never
  // keep the actual hand stuck: the committed deck can still run once safely.
  const calculate = async () => {
    try { return await equityPool.calculate(input); }
    catch { return await equityPool.calculate(input); }
  };
  calculate().catch(error => {
    console.error(`房间 ${room.code} 胜率计算失败，继续发一次: ${error.message}`);
    return null;
  }).then(result => {
    equityJobs.delete(room);
    if (rooms.get(room.code) !== room || room.closedAt || room.hand?.runout !== runout ||
        runout.phase !== 'calculating') return;
    try { if (room.completeRunoutEquity(result)) room.changed(); }
    catch (error) {
      room.persistenceFault = true;
      scheduleDeadline(room);
      console.error(`房间 ${room.code} 胜率状态保存失败: ${error.message}`);
    }
  });
}

function persistFinancialCommand(room) {
  try { room.changed(); }
  catch (error) {
    room.persistenceFault = true;
    scheduleDeadline(room); // Clear this room's timers until the durable snapshot can be retried.
    console.error(`房间 ${room.code} 资金变更后状态保存失败: ${error.message}`);
    throw new GameError('交易已记录，但房间状态暂时保存失败；请用同一请求编号重试', 503);
  }
}

function retryFinancialPersistence(room, token) {
  try { roomChanged(room); }
  catch (error) {
    room.persistenceFault = true;
    scheduleDeadline(room);
    throw new GameError('交易已记录，但房间状态暂时保存失败；请用同一请求编号重试', 503);
  }
  return { state: room.stateFor(token), duplicate: true };
}

function commandRoom(room, token, data) {
  ensureActiveRoom(room);
  const member = room.requireMember(token);
  if (room.persistenceFault) {
    const type = data?.type;
    if ((type === 'gift' || type === 'unload' || type === 'rebuy') &&
        (previousPrivateTransaction(room, member, data.requestId, type) ||
          room.commandReceipt(member, data.requestId, type))) {
      return retryFinancialPersistence(room, token);
    }
    throw new GameError('房间状态保存暂时失败，请稍后再试', 503);
  }
  if (data?.type === 'gift') {
    if (previousPrivateTransaction(room, member, data.requestId, 'gift')) {
      return { state: room.stateFor(token), duplicate: true };
    }
    const result = room.gift(member, data, transaction => {
      try { writePrivateTransaction(room, transaction); }
      catch (error) { throw new GameError('礼物记录保存失败，未扣筹码', 503); }
    });
    if (!result.duplicate) {
      persistFinancialCommand(room);
      indexPrivateTransaction(room, member, result.transaction);
      broadcastGiftEffect(room, result.effect);
    }
    return result.duplicate ? { state: room.stateFor(token), duplicate: true }
      : { state: room.stateFor(token), effect: result.effect };
  }
  if (data?.type === 'sneak') {
    if (previousPrivateTransaction(room, member, data.requestId, 'sneak')) {
      return { state: room.stateFor(token), duplicate: true };
    }
    const result = room.sneak(member, data, transaction => writePrivateTransaction(room, transaction));
    if (!result.duplicate) {
      room.changed();
      indexPrivateTransaction(room, member, { type: 'sneak', requestId: data.requestId.toLowerCase() });
      broadcastGiftEffect(room, result.effect);
    }
    return result.duplicate ? { state: room.stateFor(token), duplicate: true }
      : { state: room.stateFor(token), effect: result.effect };
  }
  if (data?.type === 'unload') {
    if (previousPrivateTransaction(room, member, data.requestId, 'unload')) {
      return { state: room.stateFor(token), duplicate: true };
    }
    const result = room.unload(member, data.requestId, transaction => {
      try { writePrivateTransaction(room, transaction); }
      catch (error) { throw new GameError('卸码记录保存失败，未扣筹码', 503); }
    });
    if (!result.duplicate) {
      persistFinancialCommand(room);
      indexPrivateTransaction(room, member, result.transaction);
    }
    return { state: room.stateFor(token), ...(result.duplicate ? { duplicate: true } : {}) };
  }
  if (data?.type === 'rebuy') {
    if (previousPrivateTransaction(room, member, data.requestId, 'rebuy')) {
      return { state: room.stateFor(token), duplicate: true };
    }
    if (typeof data.requestId !== 'string') throw new GameError('补码需要有效的请求编号');
    const result = room.rebuy(member, data.amount, data.requestId, transaction => {
      try { writePrivateTransaction(room, transaction); }
      catch (error) { throw new GameError('补码记录保存失败，本次补码未受理', 503); }
    });
    if (!result.duplicate) {
      persistFinancialCommand(room);
      indexPrivateTransaction(room, member, result.transaction);
      const effect = roomEffect(room, member, 'rebuy');
      broadcastEffect(room, effect);
      return effect ? { state: room.stateFor(token), effect } : { state: room.stateFor(token) };
    }
    return { state: room.stateFor(token), duplicate: true };
  }
  if (data?.type === 'nextHand' && room.status === 'finished') {
    try { ensurePrivateHandRecord(room); }
    catch (error) {
      holdForRecordFailure(room, error);
      throw new GameError('本手私有记录保存失败，下一手已暂停', 503);
    }
    if (room.nextHandAt === null) {
      room.reconcileAutoStart();
      roomChanged(room);
    }
  }
  const state = room.command(token, data);
  const trigger = data?.type === 'sit' ? data.type : null;
  const effect = trigger ? roomEffect(room, room.requireMember(token), trigger) : null;
  broadcastEffect(room, effect);
  return effect ? { state, effect } : { state };
}

for (const file of readdirSync(dataDir)) {
  if (!/^\d{4,8}\.json$/.test(file)) continue;
  try {
    const record = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8'));
    if (record.code !== file.slice(0, -5) || typeof record.code !== 'string' ||
        !/^\d{4,8}$/.test(record.code)) throw new Error('快照房间编号与文件名不符');
    if (record.closedAt) {
      // Closed archives stay on disk only. Loading them through
      // Room.fromJSON would run migrations and could change chips or a hand.
      continue;
    }
    const expiry = Room.expiryInfoFromJSON(record);
    if (Date.now() >= expiry.expiryAt) {
      const closedAt = new Date().toISOString();
      persistSnapshot(record.code, { ...record, createdAt: expiry.createdAt,
        lastHandStartedAt: expiry.lastHandStartedAt,
        closedAt, closeReason: 'inactive' }, true);
      continue;
    }
    const room = Room.fromJSON(record, roomChanged, roomOptions);
    recoverMoneyTransactions(room);
    if (room.pause && room.pause.endAt <= Date.now()) room.pause = null;
    room.reconcileAutoStart(); // A replayed gift may have ended the previously active hand.
    rooms.set(room.code, room);
    roomChanged(room); // Save migrated fields, retry any unfinished private record, then restore timers.
  } catch (error) {
    console.error(`无法恢复房间 ${file}: ${error.message}`);
  }
}

function getRoom(code) {
  const room = rooms.get(code);
  if (!room) {
    const archived = archivedRoomStatus(code);
    if (archived === 'closed') throw closedRoomError();
    if (archived === 'unavailable') throw new GameError('房间存档暂时不可用，请联系管理员', 503);
    throw new GameError('找不到这个房间号', 404);
  }
  ensureActiveRoom(room);
  return room;
}

function makeCode() {
  for (let n = 0; n < 100; n++) {
    const code = String(randomInt(100000, 1000000));
    if (!rooms.has(code) && !existsSync(path.join(dataDir, `${code}.json`))) return code;
  }
  throw new GameError('暂时无法创建房间，请重试', 503);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function staticFile(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new GameError('不支持此请求', 405);
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new GameError('无效路径'); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, relative);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) || !existsSync(resolved)) throw new GameError('页面不存在', 404);
  const realFile = realpathSync(resolved);
  if (!realFile.startsWith(`${realPublicDir}${path.sep}`) || !statSync(realFile).isFile()) {
    throw new GameError('页面不存在', 404);
  }
  const body = readFileSync(resolved);
  response.writeHead(200, {
    'Content-Type': contentTypes[path.extname(resolved)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function route(request, response) {
  if (!originAllowed(request)) throw new GameError('不允许跨站请求', 403);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return sendJSON(response, 200, { ok: true, rooms: rooms.size });
  }
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    rateLimit(request, 'create', 120);
    const body = await readJSON(request);
    const capacity = capacityValue(body.capacity ?? 4);
    const code = body.roomCode == null || body.roomCode === '' ? makeCode() : String(body.roomCode);
    if (!/^\d{4,8}$/.test(code)) throw new GameError('房间号须为 4–8 位数字');
    if (rooms.has(code) || existsSync(path.join(dataDir, `${code}.json`))) {
      throw new GameError('该房间号已存在', 409);
    }
    const room = new Room(code, capacity, roomChanged, roomOptions);
    rooms.set(code, room);
    persist(room);
    return sendJSON(response, 201, { roomCode: code });
  }
  const match = /^\/api\/rooms\/(\d{4,8})\/(join|state|ledger|history|command)$/.exec(url.pathname);
  if (match) {
    const [, code, operation] = match;
    // Tunnel traffic can share one loopback IP; this limits bursts without capping spectators.
    if (operation === 'join' && request.method === 'POST') rateLimit(request, 'join', 300);
    const hasBody = request.method === 'POST' && (operation === 'join' || operation === 'command');
    if (hasBody && !rooms.has(code)) {
      // Reject archived rooms before waiting for a possibly slow request body,
      // while never retaining an active Room across that await.
      const archived = archivedRoomStatus(code);
      if (archived === 'closed') throw closedRoomError();
      if (archived === 'unavailable') throw new GameError('房间存档暂时不可用，请联系管理员', 503);
      throw new GameError('找不到这个房间号', 404);
    }
    const body = hasBody ? await readJSON(request) : null;
    const room = getRoom(code);
    if (operation === 'join' && request.method === 'POST') {
      const fresh = body.token == null;
      const member = room.join(body.nickname, body.token);
      const effect = welcomeOnJoin(room, member, fresh, body.enter === true);
      return sendJSON(response, 200, { token: member.token, state: room.stateFor(member.token),
        ...(effect ? { effect } : {}) });
    }
    const token = tokenFromRequest(request);
    room.requireMember(token);
    if (operation === 'state' && request.method === 'GET') return sendJSON(response, 200, { state: room.stateFor(token) });
    if (operation === 'ledger' && request.method === 'GET') return sendJSON(response, 200, { ledger: room.ledger() });
    if (operation === 'history' && request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new GameError('记录分页参数无效');
      }
      return sendJSON(response, 200, { total: room.history.length, items: room.history.slice(offset, offset + limit) });
    }
    if (operation === 'command' && request.method === 'POST') {
      return sendJSON(response, 200, commandRoom(room, token, body));
    }
    throw new GameError('不支持此请求', 405);
  }
  if (url.pathname.startsWith('/api/')) throw new GameError('接口不存在', 404);
  return staticFile(request, response, url.pathname);
}

const server = http.createServer((request, response) => {
  route(request, response).catch(error => {
    const status = error instanceof GameError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!response.headersSent) sendJSON(response, status, { error: error.message || '服务器内部错误',
      message: error.message || '服务器内部错误',
      ...(error.errorCode ? { errorCode: error.errorCode } : {}) });
    else response.destroy();
  });
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
  perMessageDeflate: { threshold: 1024, concurrencyLimit: 2,
    serverNoContextTakeover: true, clientNoContextTakeover: true,
    zlibDeflateOptions: { level: 3, memLevel: 7 } } });
startHeartbeat(webSockets);
server.on('upgrade', (request, socket, head) => {
  try {
    if (!originAllowed(request)) throw new GameError('不允许跨站连接', 403);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') throw new GameError('WebSocket 路径不存在', 404);
    const room = getRoom(url.searchParams.get('room'));
    const token = url.searchParams.get('token');
    if (!token || !/^[A-Za-z0-9_-]{40,80}$/.test(token)) throw new GameError('凭证无效', 401);
    const member = room.requireMember(token);
    webSockets.handleUpgrade(request, socket, head, ws => {
      if (closeRoomIfInactive(room)) {
        ws.on('error', detachedSocketError);
        ws.send(JSON.stringify({ type: 'roomClosed', roomCode: room.code,
          reason: 'inactive', message: ROOM_CLOSED_MESSAGE }));
        ws.close(4004, 'ROOM_CLOSED');
        return;
      }
      member.connections.add(ws);
      ws.isAlive = true;
      const onPong = () => { ws.isAlive = true; };
      ws.on('pong', onPong);
      pendingWelcomes.delete(member);
      const onMessage = message => {
        try {
          if (closeRoomIfInactive(room)) return;
          const data = JSON.parse(String(message));
          commandRoom(room, token, data);
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: error.message || '命令失败' }));
        }
      };
      const onClose = () => {
        member.connections.delete(ws);
        detach();
        if (!room.closedAt) {
          try { room.changed(); }
          catch (error) { console.error(`房间 ${room.code} 连接状态保存失败: ${error.message}`); }
        }
      };
      const onError = () => {
        onClose();
        ws.terminate();
      };
      const detach = () => {
        if (!roomSocketHandlers.has(ws)) return;
        roomSocketHandlers.delete(ws);
        clearSocketQueue(ws);
        ws.off('pong', onPong);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        ws.on('error', detachedSocketError);
      };
      roomSocketHandlers.set(ws, detach);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
      room.changed();
    });
  } catch (error) {
    const status = error instanceof GameError ? error.status : 400;
    socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\n\r\n`);
  }
});

server.listen(port, host, () => console.log(`德州扑克联机服务：http://${host}:${port}`));

export { server };
