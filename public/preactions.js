/* A local preaction choice. Only the caller may send the returned action to the server. */
(() => {
  'use strict';

  const eventId = (event) => Number.isSafeInteger(Number(event?.id)) ? Number(event.id) : 0;
  const latestEventId = (data) => Math.max(0, ...(Array.isArray(data?.events) ? data.events.map(eventId) : []));
  const streetOf = (data) => String(data?.streetIndex ?? data?.street ?? '');
  const betOf = (data) => Number(data?.currentBet);
  const timeOf = (data) => {
    const value = Number(data?.serverTime);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const identityOf = (data) => `${data.roomCode}\u0000${data.hero.playerId}\u0000${data.hero.seat}\u0000${data.handNo}`;
  const actionEvent = (event) => / (?:过牌|弃牌|跟注 \d+(?:，全下)?|(?:加注|下注)至 \d+(?:，全下)?(?:（不足额加注）)?)$/.test(String(event?.text ?? ''));
  const raiseEvent = (event) => / (?:加注|下注)至 \d+(?:，全下)?(?:（不足额加注）)?$/.test(String(event?.text ?? ''));

  function activeSeat(data) {
    if (!data || data.status !== 'playing' || data.runout || !data.roomCode ||
        !Number.isInteger(Number(data.handNo)) || Number(data.handNo) < 1) return null;
    const hero = data.hero;
    const seat = hero?.seat;
    if (!Number.isInteger(seat) || seat < 0 || !hero.playerId ||
        hero.sittingOut || hero.pendingSitOut || hero.waitingNextHand) return null;
    const player = data.seats?.[seat];
    if (!player || player.playerId !== hero.playerId || !player.inHand || player.folded ||
        player.allIn || player.sittingOut || player.pendingSitOut || player.waitingNextHand) return null;
    return player;
  }

  function outstanding(data, player) {
    const bet = betOf(data);
    const committed = Number(player?.streetCommit);
    if (!Number.isSafeInteger(bet) || !Number.isSafeInteger(committed) || bet < 0 || committed < 0) return Infinity;
    return Math.max(0, bet - committed);
  }

  function actionFor(kind, data) {
    const player = activeSeat(data);
    if (!player || data.pause || !data.hero.canAct) return null;
    if (kind === 'fold') return 'fold';
    if (kind !== 'check' && kind !== 'checkFold') return null;
    const due = Math.max(outstanding(data, player), Number(data.hero.toCall) || 0);
    if (kind === 'checkFold') return due > 0 ? 'fold' : 'check';
    return due === 0 ? 'check' : null;
  }

  function createController() {
    let selected = null;
    let forceFold = false;
    let identity = '';
    let lastServerTime = 0;
    let lastEventId = 0;
    let street = '';
    let currentBet = 0;

    function reset() {
      selected = null;
      forceFold = false;
      identity = '';
      lastServerTime = 0;
      lastEventId = 0;
      street = '';
      currentBet = 0;
    }

    function canSelect(kind, data) {
      if (kind !== 'fold' && kind !== 'check' && kind !== 'checkFold') return false;
      const player = activeSeat(data);
      if (!player || data.pause || data.hero.canAct || data.actingSeat == null ||
          Number(data.actingSeat) === data.hero.seat) return false;
      if (identity === identityOf(data) && lastServerTime && timeOf(data) &&
          timeOf(data) < lastServerTime) return false;
      return kind !== 'check' || outstanding(data, player) === 0;
    }

    function ingest(data) {
      const snapshotTime = timeOf(data);
      if (identity && snapshotTime && lastServerTime && snapshotTime < lastServerTime) return false;
      if (!activeSeat(data)) { reset(); return false; }
      const nextIdentity = identityOf(data);
      if (identity && identity !== nextIdentity) reset();
      if (!identity) {
        identity = nextIdentity;
        lastServerTime = snapshotTime;
        lastEventId = latestEventId(data);
        street = streetOf(data);
        currentBet = betOf(data);
        return true;
      }

      const nextStreet = streetOf(data);
      const nextBet = betOf(data);
      const events = Array.isArray(data.events) ? data.events : [];
      const fresh = events.filter((event) => eventId(event) > lastEventId);
      if (selected === 'check' || selected === 'checkFold') {
        const raised = nextBet > currentBet || fresh.some((event) => Number(event.handNo) === Number(data.handNo) &&
          Number(event.seat) !== data.hero.seat && event.seat != null && raiseEvent(event));
        const eventGap = fresh.length && Math.min(...fresh.map(eventId)) > lastEventId + 1;
        if (nextStreet !== street || eventGap) selected = null;
        else if (selected === 'check' && (raised || outstanding(data, activeSeat(data)) > 0)) selected = null;
        else if (selected === 'checkFold' && (raised || outstanding(data, activeSeat(data)) > 0)) forceFold = true;
      }
      if (selected && fresh.some((event) => Number(event.handNo) === Number(data.handNo) &&
          Number(event.seat) === data.hero.seat && event.seat != null && actionEvent(event))) selected = null;
      if (!selected) forceFold = false;
      lastEventId = Math.max(lastEventId, latestEventId(data));
      lastServerTime = Math.max(lastServerTime, snapshotTime);
      street = nextStreet;
      currentBet = nextBet;
      return true;
    }

    function toggle(kind, data) {
      if (!ingest(data)) return selected;
      if (!canSelect(kind, data)) return selected;
      selected = selected === kind ? null : kind;
      forceFold = selected === 'checkFold' && outstanding(data, activeSeat(data)) > 0;
      return selected;
    }

    function observe(data, { consume = true } = {}) {
      if (!ingest(data) || !selected || !consume || data.pause || !data.hero.canAct) return null;
      const action = selected === 'checkFold' && forceFold ? 'fold' : actionFor(selected, data);
      selected = null;
      forceFold = false;
      return action ? { action } : null;
    }

    return Object.freeze({ toggle, observe, canSelect, getSelected: () => selected, reset });
  }

  window.PokerPreactions = Object.freeze({ createController, actionFor });
})();
