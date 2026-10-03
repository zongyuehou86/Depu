(() => {
  'use strict';

  // Large public hand records and proofs are fetched only while their panel is open.
  function createController({ request, getContext, t, message, safe, copyText, document: doc = document }) {
    const historyPanel = doc.querySelector('#history-details');
    const historyContent = doc.querySelector('#history-content');
    const proofPanel = doc.querySelector('#fairness-details');
    const proofContent = doc.querySelector('#fairness-proof-content');
    let current = null;
    let identity = '';
    let generation = 0;
    const history = { items: null, total: 0, offset: 0, latest: true, key: '', error: '', pending: null };
    const proof = { value: null, key: '', error: '', pending: null };
    const contextKey = value => `${value?.session}:${value?.roomCode}:${value?.token}`;
    const active = () => Boolean(current && identity === contextKey(getContext()));
    const historyKey = () => `${current?.stateEpoch || ''}:${current?.historyVersion ?? current?.historyTotal ?? 0}`;
    const proofKey = () => `${current?.stateEpoch || ''}:${current?.handNo}:${current?.fairness?.deckRoot}:${current?.fairness?.visibleCardCount ?? current?.fairness?.visibleCardProofs?.length ?? 0}`;

    function cancel(part) {
      const pending = part.pending;
      part.pending = null;
      pending?.controller.abort();
    }

    function reset() {
      generation++;
      cancel(history);
      cancel(proof);
      current = null;
      identity = '';
      Object.assign(history, { items: null, total: 0, offset: 0, latest: true, key: '', error: '' });
      Object.assign(proof, { value: null, key: '', error: '' });
      if (historyContent) historyContent.textContent = '';
      if (proofContent) proofContent.textContent = '';
    }

    function renderHistory() {
      if (!historyContent) return;
      const rows = history.items || [];
      const summary = rows.map(row => {
        const boards = (Array.isArray(row.boards) ? row.boards : [row.board || []])
          .map(board => Array.isArray(board) ? board.join(' ') : '').join(' / ');
        const events = (Array.isArray(row.events) ? row.events : [])
          .map(event => `<li>${safe(message(event.text || ''))}</li>`).join('');
        return `<details class="history-hand"><summary>${safe(t('第 {handNo} 手', { handNo: row.handNo }))} · ${safe(boards || t('无公共牌'))}</summary><ul>${events}</ul><button type="button" class="mini-button" data-history-proof="${safe(row.handNo)}">${safe(t('复制公开证明'))}</button></details>`;
      }).join('');
      const notice = history.error || (history.pending ? t('正在加载记录…') : !rows.length ? t('暂无已结束的牌局。') : '');
      const older = history.offset > 0 && !history.pending;
      const newer = history.offset + rows.length < history.total && !history.pending;
      historyContent.innerHTML = `${notice ? `<p class="small-note" role="status">${safe(notice)}</p>` : ''}${summary}<div class="history-navigation"><button type="button" class="mini-button" data-history-page="older" ${older ? '' : 'disabled'}>${safe(t('更早记录'))}</button><button type="button" class="mini-button" data-history-page="newer" ${newer ? '' : 'disabled'}>${safe(t('较新记录'))}</button><button type="button" class="mini-button" data-history-page="latest" ${history.pending ? 'disabled' : ''}>${safe(t('刷新最新记录'))}</button></div>`;
    }

    function renderProof() {
      if (!proofContent) return;
      if (!current?.fairness) { proofContent.textContent = ''; return; }
      if (proof.pending) proofContent.innerHTML = `<p class="small-note" role="status">${safe(t('正在加载公开证明…'))}</p>`;
      else if (proof.error) proofContent.innerHTML = `<p class="small-note" role="status">${safe(proof.error)}</p><button type="button" class="mini-button" data-proof-retry>${safe(t('重新加载'))}</button>`;
      else if (proof.value) proofContent.innerHTML = `<button type="button" class="mini-button" data-proof-copy>${safe(t('复制公开证明'))}</button>`;
      else proofContent.textContent = '';
    }

    async function loadHistory(force = false) {
      if (!active() || !historyPanel?.open || history.pending) return;
      const version = historyKey();
      if (!force && ((!history.latest && history.items) || (history.key === version && (history.items || history.error)))) return;
      const total = Math.max(0, Number(current.historyTotal) || 0);
      const offset = history.latest ? Math.max(0, Math.floor((total - 1) / 20) * 20) : Math.min(history.offset, Math.max(0, Math.floor((total - 1) / 20) * 20));
      const context = { ...getContext() };
      const ticket = { controller: new AbortController(), generation };
      history.pending = ticket;
      history.error = '';
      renderHistory();
      try {
        const result = await request(`/api/rooms/${encodeURIComponent(context.roomCode)}/history?offset=${offset}&limit=20`,
          { token: context.token, signal: ticket.controller.signal });
        if (!active() || ticket.generation !== generation || history.pending !== ticket) return;
        if (history.latest && version !== historyKey()) return;
        if (!Array.isArray(result.items)) throw new Error(t('记录加载失败，请重试。'));
        history.items = [...result.items].reverse();
        history.total = Math.max(0, Number(result.total) || 0);
        history.offset = offset;
        history.key = version;
      } catch (cause) {
        if (!active() || ticket.generation !== generation || history.pending !== ticket || ticket.controller.signal.aborted) return;
        history.error = message(cause.message || t('记录加载失败，请重试。'));
        history.key = version;
      } finally {
        if (history.pending === ticket) {
          history.pending = null;
          renderHistory();
          if (active() && historyPanel.open && history.latest && version !== historyKey()) void loadHistory();
        }
      }
    }

    async function loadProof(force = false) {
      if (!active() || !proofPanel?.open || !current.fairness || proof.pending) return;
      const version = proofKey();
      if (!force && proof.key === version && (proof.value || proof.error)) return;
      const context = { ...getContext() };
      const handNo = current.handNo;
      const ticket = { controller: new AbortController(), generation };
      proof.pending = ticket;
      proof.error = '';
      renderProof();
      try {
        const result = await request(`/api/rooms/${encodeURIComponent(context.roomCode)}/fairness?handNo=${encodeURIComponent(handNo)}`,
          { token: context.token, signal: ticket.controller.signal });
        if (!active() || ticket.generation !== generation || proof.pending !== ticket || version !== proofKey()) return;
        if (result.handNo !== handNo || !result.fairness) throw new Error(t('记录加载失败，请重试。'));
        proof.value = result.fairness;
        proof.key = version;
      } catch (cause) {
        if (!active() || ticket.generation !== generation || proof.pending !== ticket || ticket.controller.signal.aborted) return;
        proof.error = message(cause.message || t('记录加载失败，请重试。'));
        proof.key = version;
      } finally {
        if (proof.pending === ticket) {
          proof.pending = null;
          renderProof();
          if (active() && proofPanel.open && version !== proofKey()) void loadProof();
        }
      }
    }

    function update(data) {
      const key = contextKey(getContext());
      if (identity !== key || (current?.stateEpoch && data?.stateEpoch && current.stateEpoch !== data.stateEpoch)) {
        reset();
        identity = key;
      }
      current = data;
      if (!active()) return;
      if (proof.key !== proofKey()) proof.value = null;
      if (historyPanel?.open) { renderHistory(); void loadHistory(); }
      if (proofPanel?.open) { renderProof(); void loadProof(); }
    }

    historyPanel?.addEventListener('toggle', () => {
      if (historyPanel.open) { renderHistory(); void loadHistory(); }
      else cancel(history);
    });
    proofPanel?.addEventListener('toggle', () => {
      if (proofPanel.open) { renderProof(); void loadProof(); }
      else cancel(proof);
    });
    historyContent?.addEventListener('click', event => {
      if (!active()) return;
      const proofButton = event.target.closest('button[data-history-proof]');
      if (proofButton) {
        const record = history.items?.find(row => String(row.handNo) === proofButton.dataset.historyProof);
        if (record?.fairness) void copyText(JSON.stringify({ handNo: record.handNo, fairness: record.fairness }, null, 2), t('公开证明已复制。'));
        return;
      }
      const button = event.target.closest('button[data-history-page]');
      if (!button || button.disabled || history.pending) return;
      const direction = button.dataset.historyPage;
      history.latest = direction === 'latest';
      if (!history.latest) history.offset = Math.max(0, history.offset + (direction === 'older' ? -20 : 20));
      void loadHistory(true);
    });
    proofContent?.addEventListener('click', event => {
      if (!active()) return;
      if (event.target.closest('button[data-proof-retry]')) void loadProof(true);
      else if (event.target.closest('button[data-proof-copy]') && proof.value) {
        void copyText(JSON.stringify({ handNo: current.handNo, fairness: proof.value }, null, 2), t('公开证明已复制。'));
      }
    });
    return { update, reset };
  }

  window.PokerDetails = Object.freeze({ createController });
})();
