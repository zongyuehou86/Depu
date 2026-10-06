/**
 * Display-only identity helpers for JSON-compatible room/history records.
 * `members` may be an array of { id, nickname }, a Map, or an id-keyed object.
 * Map/object values are member objects; their explicit id takes precedence over
 * the map key (room member Maps may be keyed by a session token instead).
 * Neither helper mutates the input or member objects, or merges identities.
 */

const LABELS = [['playerId', 'nickname'], ['senderId', 'sender'], ['recipientId', 'recipient']];

function memberIndex(members) {
  const entries = Array.isArray(members) ? members.map(member => [undefined, member]) :
    members instanceof Map ? members.entries() : Object.entries(members ?? {});
  const byId = new Map(), idsByName = new Map();
  for (const [key, member] of entries) {
    if (!member || typeof member !== 'object') continue;
    const id = member.id ?? member.playerId ?? key;
    if (typeof id !== 'string' || !id || typeof member.nickname !== 'string' || !member.nickname) continue;
    const previous = byId.get(id);
    // An inconsistent member list is not enough evidence to choose a name.
    byId.set(id, previous !== undefined && previous !== member.nickname ? null : member.nickname);
    if (!idsByName.has(member.nickname)) idsByName.set(member.nickname, new Set());
    idsByName.get(member.nickname).add(id);
  }
  const legacyNames = new Map();
  for (const [name, ids] of idsByName) {
    const [id] = ids;
    legacyNames.set(name, ids.size === 1 && byId.get(id) !== null ? id : null);
  }
  return { byId, legacyNames };
}

function cloneRecords(value, visit) {
  const copy = structuredClone(value), pending = [copy], seen = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (!Array.isArray(item)) visit(item);
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return copy;
}

// These are generated room-event suffixes, never player-supplied free text.
// Matching the suffix as well as the name distinguishes “Ann” from “Ann #2”.
const GENERATED_SUFFIX = /^(?:带入 \d+ 筹码坐在 \d+ 号位(?:；下一手开始参与)?|从 \d+ 号位离座|选择下手暂离；本手已锁定，仍参与跑马结算|暂时离席(?:，本手弃牌|；已全下的手牌继续参与本手结算)?|取消了超时后的待暂离|返回牌桌；从下一手起参与|申请补码 \d+，本手结算后到账|补码 \d+|可用筹码归零，本手(?:弃牌|不再行动)|卸码 \d+|设置.+|选择发 [12] 次|选择超时，默认发一次|确认超时，默认拒绝发两次|弃牌|过牌|跟注 \d+(?:，全下)?|(?:加注|下注)至 \d+(?:，全下)?(?:（不足额加注）)?|(?:按主动选择|因行动超时)，从下一手起暂时离席|连续完整暂离 5 手，自动离座成为观战者|已连续完整暂离 \d+\/5 手|赢得底池 \d+（其他玩家弃牌）|退回无人跟注的 \d+ 筹码|以.+获得 \d+|两次牌面合计获得 \d+|主动亮牌：.+|加时 10 秒，支付 \d+ 筹码入底池|行动超时，自动(?:弃牌|过牌)；下一手暂离)$/u;

function legacyNameRefs(text, names) {
  const candidates = [];
  const handPrefix = /^第 \d+ 手开始；/u.exec(text)?.[0];
  for (const [name, playerId] of names) {
    let start = null;
    if (text.startsWith(`${name} `) && GENERATED_SUFFIX.test(text.slice(name.length + 1))) start = 0;
    if (text === `${name}接受发两次` || text === `${name}拒绝发两次`) start = 0;
    if (handPrefix && text.startsWith(`${handPrefix}${name} 持按钮`) &&
        /^(?:，小盲 \d+，大盲 \d+)?$/u.test(text.slice(handPrefix.length + name.length + ' 持按钮'.length))) {
      start = handPrefix.length;
    }
    if (text === `等待领先方 ${name} 接受或拒绝发两次`) start = '等待领先方 '.length;
    if (start !== null) candidates.push({ playerId, start, end: start + name.length });
  }
  // Duplicate legacy names and overlapping valid interpretations stay unbound.
  return candidates.length === 1 && candidates[0].playerId ? candidates : null;
}

/**
 * One-time legacy migration: call with the ORIGINAL member names, before any
 * rename, and persist the returned copy. Only exact, unique name matches receive
 * IDs. Existing IDs/nameRefs are authoritative, including unknown IDs and empty
 * nameRefs. Unresolved records must never later be inferred from renamed users.
 */
export function attachLegacyPlayerIds(value, members) {
  const { legacyNames } = memberIndex(members);
  return cloneRecords(value, item => {
    for (const [idKey, nameKey] of LABELS) {
      if (item[idKey] != null || typeof item[nameKey] !== 'string') continue;
      const id = legacyNames.get(item[nameKey]);
      if (id) item[idKey] = id;
    }
    if (!Object.hasOwn(item, 'nameRefs') && typeof item.text === 'string') {
      const refs = legacyNameRefs(item.text, legacyNames);
      if (refs) item.nameRefs = refs;
    }
  });
}

function isStringBoundary(text, index) {
  return !(index > 0 && index < text.length &&
    /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]));
}

function projectEvent(item, byId) {
  if (typeof item.text !== 'string' || !Array.isArray(item.nameRefs) || !item.nameRefs.length) return;
  const refs = item.nameRefs.map((ref, index) => ({ ref, index }));
  if (refs.some(({ ref }) => !ref || typeof ref !== 'object' || typeof ref.playerId !== 'string' ||
      !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 ||
      ref.end <= ref.start || ref.end > item.text.length ||
      !isStringBoundary(item.text, ref.start) || !isStringBoundary(item.text, ref.end))) return;
  refs.sort((a, b) => a.ref.start - b.ref.start);
  if (refs.some(({ ref }, index) => index > 0 && ref.start < refs[index - 1].ref.end)) return;

  const original = item.text;
  let text = '', cursor = 0;
  for (const { ref, index } of refs) {
    text += original.slice(cursor, ref.start);
    const nickname = byId.get(ref.playerId) ?? original.slice(ref.start, ref.end);
    // Rebase the cloned references so projecting an already-public copy is safe.
    item.nameRefs[index] = { ...ref, start: text.length, end: text.length + nickname.length };
    text += nickname;
    cursor = ref.end;
  }
  item.text = text + original.slice(cursor);
}

/**
 * Return a public/display copy using current names and stable IDs only. Never
 * infer identities from historical labels here. nameRefs are half-open UTF-16
 * string offsets, as used by String.slice; valid refs are rebased in the copy.
 * Unknown players keep their stored names. Malformed/overlapping refs leave the
 * entire event text untouched. Amounts, cards, IDs and other data are preserved.
 */
export function displayRecord(value, members) {
  const { byId } = memberIndex(members);
  return cloneRecords(value, item => {
    for (const [idKey, nameKey] of LABELS) {
      if (typeof item[nameKey] !== 'string') continue;
      const nickname = byId.get(item[idKey]);
      if (typeof nickname === 'string') item[nameKey] = nickname;
    }
    projectEvent(item, byId);
  });
}
