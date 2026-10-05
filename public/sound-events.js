/* Pure, room-local cue planner. It only reads public server state and new event ids. */
(() => {
  'use strict';

  const eventId = (event) => Number.isSafeInteger(Number(event?.id)) ? Number(event.id) : 0;
  const boardLengths = (data) => {
    const boards = Array.isArray(data?.runout?.boards) ? data.runout.boards : [data?.board];
    return boards.map((board) => Array.isArray(board) ? board.length : 0);
  };
  const latestEventId = (data) => Math.max(0, ...(Array.isArray(data?.events) ? data.events.map(eventId) : []));
  const eventTime = (event) => typeof event?.at === 'number' ? event.at : Date.parse(event?.at || '');
  const recent = (event, now) => {
    const at = eventTime(event);
    return Number.isFinite(at) && at <= now + 2000 && now - at <= 8000;
  };
  const finished = (data) => Boolean(data?.result) || ['finished', 'complete', 'ended'].includes(data?.status);

  function actionCue(event, data) {
    const seat = Number(event?.seat);
    if (event?.seat == null || !Number.isInteger(seat) || seat < 0) return null;
    const nickname = data?.seats?.[seat]?.nickname;
    if (!nickname || typeof event?.text !== 'string' || !event.text.startsWith(`${nickname} `)) return null;
    const text = event.text.slice(nickname.length + 1);
    if (text === '过牌') return 'check';
    if (text === '弃牌' || text === '暂时离席，本手弃牌' || text === '可用筹码归零，本手弃牌') return 'fold';
    if (/^跟注 \d+(?:，全下)?$/.test(text)) return text.endsWith('，全下') ? 'allin' : 'call';
    if (/^(?:加注|下注)至 \d+(?:，全下)?(?:（不足额加注）)?$/.test(text)) return text.includes('，全下') ? 'allin' : 'raise';
    return null;
  }

  function createPlanner() {
    let roomCode = '';
    let handNo = null;
    let lastId = 0;
    let boards = [];
    let wasFinished = false;
    let wasActing = false;
    let turnCore = '';
    let turnSerial = 0;
    let warnedSerial = 0;
    let lastServerTime = 0;

    function reset() {
      roomCode = '';
      handNo = null;
      lastId = 0;
      boards = [];
      wasFinished = false;
      wasActing = false;
      turnCore = '';
      turnSerial = 0;
      warnedSerial = 0;
      lastServerTime = 0;
    }

    function baseline(data, now = Number(data?.serverTime) || Date.now()) {
      if (!data || typeof data !== 'object') { reset(); return; }
      roomCode = String(data.roomCode || '');
      handNo = Number(data.handNo) || 0;
      lastId = latestEventId(data);
      lastServerTime = Number(data.serverTime) || 0;
      boards = boardLengths(data);
      wasFinished = finished(data);
      wasActing = Boolean(data.hero?.canAct || data.hero?.canChooseRunout || data.hero?.canRespondRunout);
      turnCore = `${handNo}:${data.streetIndex ?? data.street}:${data.actingSeat}:${data.runout?.phase || ''}`;
      turnSerial += 1;
      warnedSerial = Number(data.actionDisplayDeadline ?? data.actionDeadline) - now <= 5000 ? turnSerial : turnSerial - 1;
    }

    function observe(data, { silent = false, since = 0, now = Date.now() } = {}) {
      if (!data || !data.roomCode) return [];
      if (!roomCode || roomCode !== data.roomCode || handNo === null) { baseline(data, now); return []; }
      const serverTime = Number(data.serverTime) || 0;
      if (serverTime && serverTime < lastServerTime) return [];
      const nextHand = Number(data.handNo) || 0;
      if (nextHand < handNo) return [];
      lastServerTime = Math.max(lastServerTime, serverTime);
      const advanced = nextHand > handNo;
      const liveHand = !advanced || nextHand === handNo + 1;
      const cues = [];
      if (advanced) {
        handNo = nextHand;
        boards = [];
        wasFinished = false;
        wasActing = false;
        turnCore = '';
      }

      const incoming = Array.isArray(data.events) ? data.events : [];
      const cutoff = Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0;
      const freshEvents = incoming.filter((event) => eventId(event) > lastId && Number(event.handNo) === nextHand &&
        recent(event, now) && (!cutoff || eventTime(event) >= cutoff));
      lastId = Math.max(lastId, latestEventId(data));
      if (advanced && !silent && liveHand && data.status === 'playing' &&
          (!cutoff || freshEvents.some(event => /^第 \d+ 手开始/.test(event.text)))) cues.push({ kind: 'deal' });
      let opponentActionSeen = false;
      let ownActionSeen = false;
      if (!silent && liveHand) {
        for (const event of freshEvents) {
          const kind = actionCue(event, data);
          if (kind) {
            cues.push({ kind });
            if (Number(event.seat) !== Number(data.hero?.seat)) opponentActionSeen = true;
            else ownActionSeen = true;
          }
        }
      }

      const nextBoards = boardLengths(data);
      if (!silent && liveHand) {
        nextBoards.forEach((length, index) => {
          const shared = index > 0 ? Math.min(length, Number(data.runout?.sharedBoardCount) || 0) : 0;
          const prior = boards[index] ?? shared;
          let added = Math.max(0, length - prior);
          if (cutoff) {
            // A resumed snapshot can contain old cards alongside a brand-new action.
            // Only card-reveal events after the recovery time are allowed to sound.
            const reveals = freshEvents.filter(event => index === 0
              ? /^(?:(?:flop|turn|river|翻牌|转牌|河牌)：|第 1 次(?:独立)?(?:翻牌|转牌|河牌)：)/.test(event.text)
              : /^第 2 次(?:独立)?(?:翻牌|转牌|河牌)：/.test(event.text));
            const freshCount = reveals.reduce((count, event) => count + (/^(?:flop：|翻牌：|第 [12] 次(?:独立)?翻牌：)/.test(event.text) ? 3 : 1), 0);
            added = Math.min(added, freshCount);
          }
          if (added >= 3 && prior === 0) { cues.push({ kind: 'flip', count: 3 }); added -= 3; }
          for (let card = 0; card < added; card++) cues.push({ kind: 'flip', count: 1 });
        });
      }
      boards = nextBoards.map((length, index) => Math.max(length, boards[index] ?? 0));

      const isFinished = finished(data);
      const freshResult = !cutoff || freshEvents.some(event =>
        /(?: 赢得底池 \d+（其他玩家弃牌）| (?:以.+|两次牌面合计)获得 \d+)$/.test(event.text));
      if (!silent && liveHand && isFinished && !wasFinished && !advanced && freshResult) cues.push({ kind: 'win' });
      wasFinished = wasFinished || isFinished;

      const acting = Boolean(data.hero?.canAct || data.hero?.canChooseRunout || data.hero?.canRespondRunout) && data.status === 'playing';
      const nextCore = `${nextHand}:${data.streetIndex ?? data.street}:${data.actingSeat}:${data.runout?.phase || ''}`;
      if (!data.pause) {
        const newTurn = acting && (!wasActing || turnCore !== nextCore || advanced || (ownActionSeen && opponentActionSeen));
        if (newTurn) {
          turnSerial += 1;
          if (!silent) cues.push({ kind: 'turn', delay: cues.some((cue) => cue.kind === 'deal') ? 420 : 100 });
        }
        wasActing = acting;
        turnCore = nextCore;
      }
      if (silent) warnedSerial = Number(data.actionDisplayDeadline ?? data.actionDeadline) - now <= 5000 ? turnSerial : turnSerial - 1;
      return cues;
    }

    function warning(data, now = Date.now()) {
      if (!data || data.roomCode !== roomCode || (Number(data.handNo) || 0) !== handNo ||
          !data.hero?.canAct || data.pause || data.runout || data.status !== 'playing') return null;
      const remaining = Number(data.actionDisplayDeadline ?? data.actionDeadline) - now;
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 5000 || warnedSerial === turnSerial) return null;
      warnedSerial = turnSerial;
      return { kind: 'warning' };
    }

    return Object.freeze({ reset, baseline, observe, warning });
  }

  window.PokerSoundEvents = Object.freeze({ createPlanner, actionCue });
})();
