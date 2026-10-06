import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phone fixtures use the reserved fictional +1 202-555-01xx range.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('real server limits shared caching to public resources; room identity and state remain no-store',
  { timeout: 15000 }, async t => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const directory = await mkdtemp(path.join(os.tmpdir(), 'poker-cache-private-'));
    const child = spawn(process.execPath, ['server.js'], { cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
        DATA_DIR: path.join(directory, 'data'), HAND_RECORDS_DIR: path.join(directory, 'records') },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(directory, { recursive: true, force: true });
    });
    const request = (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options);
    const deadline = Date.now() + 10000;
    while (true) {
      assert.equal(child.exitCode, null, output);
      try { if ((await request('/api/health')).ok) break; }
      catch { /* Waiting for this isolated process. */ }
      if (Date.now() > deadline) assert.fail(`Server did not start: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const health = await request('/api/health', { headers: { 'If-None-Match': '*' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('etag'), null);
    const created = await request('/api/rooms', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capacity: 4, nickname: 'cache-privacy', phone: '+12025550101' }) });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const code = (await created.json()).roomCode;
    const joined = await request(`/api/rooms/${code}/join`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'cache-privacy', phone: '+12025550101' }) });
    assert.equal(joined.headers.get('cache-control'), 'no-store');
    assert.equal(joined.headers.get('etag'), null);
    const { token } = await joined.json();
    assert.ok(token);
    for (const operation of ['state', 'ledger', 'history']) {
      const response = await request(`/api/rooms/${code}/${operation}?v=${'a'.repeat(64)}`, {
        headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' }
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
      await response.json();
    }
    for (const route of [`/data/${code}.json`, `/hand-records/${code}/1.txt`, '/server.js', '/public-assets.js',
      '/api/unknown', `/api/rooms/${code}/state`]) {
      const response = await request(route, { headers: { 'If-None-Match': '*' } });
      assert.ok([401, 404].includes(response.status), route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
      assert.ok(!(await response.text()).includes(token));
    }
    const crossed = await request('/app.js', { headers: { Origin: 'https://another.invalid' } });
    assert.equal(crossed.status, 403);
    assert.equal(crossed.headers.get('cache-control'), 'no-store');
    const htmlResponse = await request('/?room=' + code);
    assert.equal(htmlResponse.headers.get('cache-control'), 'no-cache');
    const html = await htmlResponse.text();
    assert.ok(!html.includes(token));
    const scriptPath = /src="(\/app\.js\?v=[a-f0-9]{64})"/.exec(html)?.[1];
    assert.ok(scriptPath);
    const script = await request(scriptPath);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.ok(!(await script.text()).includes(token));
    const hit = await request(scriptPath, { headers: { 'If-None-Match': script.headers.get('etag') } });
    assert.equal(hit.status, 304);
    assert.equal(await hit.text(), '');
  });
