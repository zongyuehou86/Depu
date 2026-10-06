import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

// Run explicitly with RUN_BROWSER_TESTS=1; normal server tests need no browser.
// CHROME_BIN can point to Chrome/Chromium on other platforms.
const chromePath = process.env.CHROME_BIN || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].find(candidate => existsSync(candidate));
const root = fileURLToPath(new URL('..', import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitUntil(check, label) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* Server/page may still be starting. */ }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(1800)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real browser preserves focused form nodes across unrelated room broadcasts', {
  timeout: 40_000,
  skip: process.env.RUN_BROWSER_TESTS !== '1' ? 'Set RUN_BROWSER_TESTS=1 to run Chrome integration' :
    !chromePath || !existsSync(chromePath) ? 'Chrome unavailable; set CHROME_BIN' : false
}, async t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'poker-input-focus-'));
  const data = path.join(temp, 'data'), records = path.join(temp, 'records'), profile = path.join(temp, 'chrome');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(records, { mode: 0o700 });
  let server, chrome, socket;
  t.after(async () => {
    socket?.close();
    await stop(chrome);
    await stop(server);
    rmSync(temp, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${await freePort()}`;
  server = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, DATA_DIR: data, HAND_RECORDS_DIR: records },
    stdio: 'ignore' });
  await waitUntil(async () => (await fetch(`${origin}/api/health`)).ok, 'local server');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await waitUntil(() => existsSync(portFile), 'isolated Chrome');
  const [debugPort, browserPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data), callback = pending.get(packet.id);
    if (!callback) return;
    pending.delete(packet.id);
    if (packet.error) callback.reject(new Error(packet.error.message));
    else callback.resolve(packet.result);
  });
  function cdp(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async function evaluate(page, expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  async function api(url, body, token = '') {
    const response = await fetch(origin + url, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  async function openPage(code, token) {
    const context = await cdp('Target.createBrowserContext');
    const target = await cdp('Target.createTarget', { url: 'about:blank', browserContextId: context.browserContextId });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await cdp('Page.enable', {}, sessionId);
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('poker-last-room',${JSON.stringify(code)});localStorage.setItem('poker-room-token:'+${JSON.stringify(code)},${JSON.stringify(token)});`
    }, sessionId);
    await cdp('Page.navigate', { url: `${origin}/` }, sessionId);
    await waitUntil(() => evaluate(sessionId, `document.querySelector('#room-screen')?.hidden === false && document.querySelector('#connection')?.textContent === '实时在线'`), 'room connection');
    return sessionId;
  }
  async function focusInput(page, selector, value) {
    return evaluate(page, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus(); input.value = ${JSON.stringify(value)}; window.focusAuditInput = input;
      window.focusAuditObserver?.disconnect(); window.focusAuditRenders = 0;
      window.focusAuditObserver = new MutationObserver(() => { window.focusAuditRenders++; });
      window.focusAuditObserver.observe(document.querySelector('#room-summary'), { childList: true });
      return { focused: document.activeElement === input, disabled: input.disabled };
    })()`);
  }
  async function afterBroadcast(page, selector, text) {
    // The sidebar renders even when a new offline member does not change the spectator count.
    // Observe that independent render, not replacement of the input node under test.
    await waitUntil(() => evaluate(page, `window.focusAuditRenders > 0`), 'room broadcast');
    const result = await evaluate(page, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      return { sameNode: input === window.focusAuditInput, focused: document.activeElement === input, value: input.value };
    })()`);
    if (text) {
      await cdp('Input.insertText', { text }, page);
      result.afterTyping = await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).value`);
    }
    return result;
  }

  // Reserved fictional phone numbers; these rooms exist only in the temporary local server.
  const created = await api('/api/rooms', { capacity: 4, nickname: '焦点测试观众', phone: '+12025550199', enter: true });
  const code = created.roomCode, observer = await openPage(code, created.token);
  const join = (nickname, phone) => api(`/api/rooms/${code}/join`, { nickname, phone, enter: true });
  const command = (token, body) => api(`/api/rooms/${code}/command`, body, token);
  assert.deepEqual(await focusInput(observer, '#big-blind-change', '125'), { focused: true, disabled: false });
  const first = await join('焦点测试甲', '+12025550100');
  const blind = await afterBroadcast(observer, '#big-blind-change', '6');
  assert.deepEqual(await focusInput(observer, '#capacity-change', '6'), { focused: true, disabled: false });
  const second = await join('焦点测试乙', '+12025550101');
  const capacity = await afterBroadcast(observer, '#capacity-change');
  await command(created.token, { type: 'setBigBlind', amount: 50 });
  await waitUntil(() => evaluate(observer, `document.querySelector('#big-blind-change').value === '50'`), 'server blind replaces draft');
  const blindReset = await evaluate(observer, `({ value: document.querySelector('#big-blind-change').value,
    serverBlind: document.querySelector('#big-blind-change').dataset.serverBlind })`);
  await command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
  await command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
  let room = (await api(`/api/rooms/${code}/state`, null, first.token)).state;
  if (room.status !== 'playing') await command(first.token, { type: 'nextHand' });
  room = (await api(`/api/rooms/${code}/state`, null, first.token)).state;
  const actingMember = room.actingSeat === 0 ? first : second;
  const otherMember = room.actingSeat === 0 ? second : first;
  const actor = await openPage(code, actingMember.token);
  assert.deepEqual(await focusInput(actor, '#raise-amount', '123'), { focused: true, disabled: false });
  await join('焦点测试丙', '+12025550102');
  const raise = await afterBroadcast(actor, '#raise-amount', '4');
  const previousContext = await evaluate(actor, `document.querySelector('#raise-amount').dataset.actionContext`);
  await command(actingMember.token, { type: 'action', action: 'raise', amount: 200 });
  await waitUntil(() => evaluate(actor, `document.querySelector('#raise-amount')?.dataset.actionContext !== ${JSON.stringify(previousContext)}`), 'next acting seat');
  const actionReset = await evaluate(actor, `({ value: document.querySelector('#raise-amount').value,
    context: document.querySelector('#raise-amount').dataset.actionContext })`);
  await command(otherMember.token, { type: 'action', action: 'fold' });
  await waitUntil(() => evaluate(actor, `document.querySelector('#raise-amount')?.dataset.actionContext?.startsWith('${room.handNo + 1}:')`), 'next hand');
  const handReset = await evaluate(actor, `({ value: document.querySelector('#raise-amount').value,
    context: document.querySelector('#raise-amount').dataset.actionContext })`);

  await t.test('spectator blind editor keeps its node, focus, and continuous typing', () => {
    assert.deepEqual(blind, { sameNode: true, focused: true, value: '125', afterTyping: '1256' });
  });
  await t.test('spectator capacity selector keeps its node, focus, and draft', () => {
    assert.deepEqual(capacity, { sameNode: true, focused: true, value: '6' });
  });
  await t.test('acting raise editor keeps its node, focus, and continuous typing', () => {
    assert.deepEqual(raise, { sameNode: true, focused: true, value: '123', afterTyping: '1234' });
  });
  await t.test('a server blind update replaces the spectator draft', () => {
    assert.deepEqual(blindReset, { value: '50', serverBlind: '50' });
  });
  await t.test('a changed action context resets the previous raise draft', () => {
    assert.notEqual(actionReset.context, previousContext);
    assert.equal(actionReset.value, '400');
  });
  await t.test('a new hand does not carry a previous hand raise amount', () => {
    assert.ok(handReset.context.startsWith(`${room.handNo + 1}:`));
    assert.equal(handReset.value, '100');
  });
});
