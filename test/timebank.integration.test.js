import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from '../room.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('server recovers one paid block, persists it, and records the fee without replaying it',
  { timeout: 15_000 }, async t => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'poker-timebank-data-'));
    const recordsDir = mkdtempSync(path.join(os.tmpdir(), 'poker-timebank-records-'));
    const port = await freePort();
    let child;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(recordsDir, { recursive: true, force: true });
    });

    const room = new Room('987654', 4);
    const first = room.join('计时玩家');
    const second = room.join('对手');
    room.command(first.token, { type: 'sit', seat: 0, buyIn: 2000 });
    room.command(second.token, { type: 'sit', seat: 1, buyIn: 2000 });
    room.command(first.token, { type: 'nextHand' });
    room.command(first.token, { type: 'timebank', enabled: true });
    room.hand.actionDeadline = Date.now() - 90_000;
    writeFileSync(path.join(dataDir, '987654.json'), JSON.stringify(room.toJSON()), { mode: 0o600 });

    const start = async () => {
      child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
          DATA_DIR: dataDir, HAND_RECORDS_DIR: recordsDir },
        stdio: 'ignore'
      });
      const limit = Date.now() + 4000;
      while (Date.now() < limit) {
        if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (response.ok) return;
        } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('server did not start');
    };
    const stop = async () => {
      child.kill('SIGTERM');
      await once(child, 'exit');
    };
    const request = async (method, suffix, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/rooms/987654/${suffix}`, {
        method, headers: { Authorization: `Bearer ${first.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      assert.equal(response.status, 200);
      return (await response.json()).state;
    };
    await start();
    let state;
    const limit = Date.now() + 4000;
    while (Date.now() < limit) {
      state = await request('GET', 'state');
      if (state.hero.timebankPaid === 10) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(state.hero.timebankPaid, 10);
    assert.equal(state.pot, 40);
    assert.ok(state.actionDeadline > Date.now() + 9000);
    assert.equal(state.hero.pendingSitOut, false);
    const savedDeadline = state.actionDeadline;
    await stop();
    await start();
    state = await request('GET', 'state');
    assert.equal(state.hero.timebankPaid, 10);
    assert.equal(state.actionDeadline, savedDeadline);
    state = await request('POST', 'command', { type: 'action', action: 'fold' });
    assert.equal(state.result.pot, 40);
    assert.equal(state.result.winners[0].netProfit, 20);
    const text = readFileSync(path.join(recordsDir, '987654', '1.txt'), 'utf8');
    assert.match(text, /购买加时/);
    assert.match(text, /费用进入主池/);
    assert.match(text, /实际支付 10/);
  });
