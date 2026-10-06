import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PublicAssets, PublicAssetError } from '../public-assets.js';

const hash = body => createHash('sha256').update(body).digest('hex');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'poker-public-assets-'));
  const publicDir = path.join(directory, 'public');
  await fs.mkdir(publicDir);
  const assets = new PublicAssets(publicDir, options);
  const server = http.createServer((request, response) => {
    assets.serve(request, response, new URL(request.url, 'http://localhost')).catch(error => {
      if (response.headersSent) return response.destroy();
      response.writeHead(error instanceof PublicAssetError ? error.status : 500,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const write = async (name, body) => {
    const filename = path.join(publicDir, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, body);
    return filename;
  };
  return { assets, directory, publicDir, write,
    request: (pathname, options) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, options) };
}

function trackedFS(delayMs = 0) {
  const counts = { opens: 0, active: 0, peak: 0, bytes: 0 };
  const fileSystem = { ...fs, async open(...args) {
    counts.opens++;
    counts.active++;
    counts.peak = Math.max(counts.peak, counts.active);
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const handle = await fs.open(...args);
    const read = handle.createReadStream.bind(handle);
    const close = handle.close.bind(handle);
    handle.createReadStream = options => {
      const stream = read(options);
      stream.on('data', chunk => { counts.bytes += chunk.length; });
      return stream;
    };
    let closed = false;
    handle.close = async () => {
      try { return await close(); }
      finally { if (!closed) { closed = true; counts.active--; } }
    };
    return handle;
  } };
  return { counts, fileSystem };
}

async function body(response) { return Buffer.from(await response.arrayBuffer()); }

// Public browser caching never depends on the name merely looking versioned.
test('only the exact content hash receives immutable caching; GET and HEAD validators agree', async t => {
  const { write, request } = await fixture(t);
  const bytes = Buffer.from('const greeting = "你好";\n');
  await write('app.js', bytes);
  const first = await request('/app.js');
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${hash(bytes)}"`);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  assert.equal(first.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(first.headers.get('content-length'), String(bytes.length));
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(await body(first), bytes);
  const versioned = `/app.js?v=${hash(bytes)}`;
  const cached = await request(versioned);
  assert.equal(cached.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(await body(cached), bytes);
  for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(versioned, { method, headers: { 'If-None-Match': validator } });
      assert.equal(response.status, 304);
      assert.equal(response.headers.get('etag'), etag);
      assert.equal(response.headers.get('content-length'), null);
      assert.equal((await body(response)).length, 0);
    }
  }
  const head = await request(versioned, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.headers.get('etag'), etag);
  assert.equal((await body(head)).length, 0);
  for (const suffix of ['?v=fake', '?v=' + '0'.repeat(64), `?v=${hash(bytes)}&v=${hash(bytes)}`]) {
    const response = await request('/app.js' + suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    await response.arrayBuffer();
  }
  const changedValidator = await request(versioned, { headers: { 'If-None-Match': '"wrong"' } });
  assert.equal(changedValidator.status, 200);
  await changedValidator.arrayBuffer();
});

test('in-place changes, equal-size replacement, deletion and symlink changes invalidate cached bytes', async t => {
  const { write, request, publicDir, directory, assets } = await fixture(t);
  const filename = await write('asset.txt', 'old!');
  const original = await request('/asset.txt');
  const oldTag = original.headers.get('etag');
  await original.arrayBuffer();
  const initialStat = await fs.stat(filename);
  await fs.writeFile(filename, 'new!');
  await fs.utimes(filename, initialStat.atime, initialStat.mtime);
  let response = await request('/asset.txt', { headers: { 'If-None-Match': oldTag } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'new!');
  assert.notEqual(response.headers.get('etag'), oldTag);
  await fs.writeFile(path.join(publicDir, 'replacement'), 'swap');
  await fs.rename(path.join(publicDir, 'replacement'), filename);
  response = await request('/asset.txt?v=' + hash('old!'));
  assert.equal(await response.text(), 'swap');
  assert.doesNotMatch(response.headers.get('cache-control'), /immutable/);
  await fs.unlink(filename);
  response = await request('/asset.txt', { headers: { 'If-None-Match': '*' } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(assets.cache.size, 0);
  const secret = path.join(directory, 'private-record.txt');
  await fs.writeFile(secret, 'SECRET_HAND_TOKEN');
  await fs.symlink(secret, filename);
  response = await request('/asset.txt');
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /SECRET/);
  await fs.unlink(filename);
  await write('inside.txt', 'public');
  await fs.symlink(path.join(publicDir, 'inside.txt'), filename);
  assert.equal(await (await request('/asset.txt')).text(), 'public');
  await fs.unlink(filename);
  await fs.symlink(secret, filename);
  response = await request('/asset.txt');
  assert.equal(response.status, 404);
  assert.equal(assets.cache.size, 0);
});

test('path traversal, malformed paths, outside symlink directories and methods stay blocked', async t => {
  const { write, request, publicDir, directory, assets } = await fixture(t);
  await write('safe.js', 'safe');
  await fs.writeFile(path.join(directory, 'private.txt'), 'PRIVATE');
  await fs.symlink(directory, path.join(publicDir, 'escape'));
  await fs.mkdir(path.join(publicDir, 'folder'));
  for (const pathname of ['/../private.txt', '/%2e%2e%2fprivate.txt', '/escape/private.txt', '/folder', '/missing']) {
    const response = await request(pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
  for (const pathname of ['/%zz', '/safe.js%00']) {
    const response = await request(pathname);
    assert.equal(response.status, 400);
  }
  assert.throws(() => assets.resolve('/%2e%2e/private.txt'), error => error.status === 404);
  const method = await request('/safe.js', { method: 'POST', body: 'private token' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('cache-control'), 'no-store');
  assert.equal(assets.cache.size, 0);
});

test('refresh bursts coalesce cold reads and hashes, including HEAD and query variants', async t => {
  const { counts, fileSystem } = trackedFS(25);
  const { write, request, assets } = await fixture(t, { fileSystem });
  const bytes = Buffer.alloc(128 * 1024, 3);
  await write('gift.png', bytes);
  const entries = await Promise.all(Array.from({ length: 60 }, () => assets.get('/gift.png')));
  assert.ok(entries.every(entry => entry === entries[0]));
  assert.equal(counts.opens, 1);
  assert.equal(counts.bytes, bytes.length);
  await Promise.all(Array.from({ length: 30 }, async (_, n) => {
    const response = await request(`/gift.png?arbitrary=${n}`, { method: n % 2 ? 'HEAD' : 'GET' });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }));
  assert.equal(counts.opens, 1);
  assert.equal(assets.cache.size, 1);
  assert.equal(assets.bytes, bytes.length);
  assert.equal(assets.inflight.size, 0);
});

test('cache bytes, entry count, parallel reads and unique pending jobs are bounded', async t => {
  const { counts, fileSystem } = trackedFS(20);
  const { write, assets } = await fixture(t, {
    fileSystem, maxBytes: 100, maxFileBytes: 50, maxEntries: 3, maxReads: 2, maxPending: 6
  });
  for (let n = 0; n < 8; n++) await write(`file${n}.txt`, 'x'.repeat(40));
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => assets.get(`/file${n}.txt`)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 6);
  assert.equal(results.filter(item => item.status === 'rejected' && item.reason.status === 503).length, 2);
  assert.ok(counts.peak <= 2);
  assert.equal(assets.cache.size, 2);
  assert.equal(assets.bytes, 80);
  assert.equal(assets.inflight.size, 0);
  assert.equal(assets.waiting.length, 0);
  assert.equal(assets.activeReads, 0);
  for (let n = 0; n < 5; n++) {
    await write(`empty${n}.txt`, '');
    await assets.get(`/empty${n}.txt`);
  }
  assert.equal(assets.cache.size, 3);
  assert.equal(assets.bytes, 0);
});

test('oversized files stream without hashing or retaining buffers and never advertise unstable validators', async t => {
  const { counts, fileSystem } = trackedFS();
  const { write, request, assets } = await fixture(t, { fileSystem, maxFileBytes: 64 });
  const bytes = Buffer.alloc(160 * 1024, 5);
  await write('large.mp3', bytes);
  const first = await request('/large.mp3?v=' + hash(bytes));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'audio/mpeg');
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('etag'), null);
  assert.equal(first.headers.get('content-length'), null);
  assert.deepEqual(await body(first), bytes);
  assert.equal(assets.cache.values().next().value.body, null);
  assert.equal(assets.bytes, 0);
  const reads = counts.opens;
  const second = await request('/large.mp3', { method: 'HEAD', headers: { 'If-None-Match': '*' } });
  assert.equal(second.status, 304);
  assert.equal((await body(second)).length, 0);
  assert.equal(counts.opens, reads);
  const head = await request('/large.mp3', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), null);
  assert.equal(head.headers.get('etag'), null);
  assert.equal((await body(head)).length, 0);
  assert.equal(counts.opens, reads);
  assert.equal(counts.bytes, bytes.length);
  assert.equal(assets.activeStreams, 0);
});

test('HTML versions local public references, preserves external/query URLs, and tracks dependency changes', async t => {
  const { write, request } = await fixture(t);
  await write('app.js', 'version 1');
  await write('styles.css', 'body {}');
  await write('assets/gift-bouquet-classic.png', 'image');
  await write('audio/pokernow/chips.mp3', 'sound');
  await write('index.html', '<html><head><link href="/styles.css"><script src="/app.js" defer></script>' +
    '<script src="https://example.com/a.js"></script><script src="//example.com/b.js"></script>' +
    '<script src="/existing.js?v=old"></script><link href="/other.css#x"></head><body>' +
    '<img data-src="/assets/gift-bouquet-classic.png"><img src="data:fake"></body></html>');
  const response = await request('/?room=1234&token=NEVER_CACHE_THIS');
  const html = await response.text();
  const initialTag = response.headers.get('etag');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(html)));
  assert.equal(initialTag, `"${hash(html)}"`);
  assert.ok(html.includes(`/app.js?v=${hash('version 1')}`));
  assert.ok(html.includes(`/styles.css?v=${hash('body {}')}`));
  assert.ok(html.includes(`data-src="/assets/gift-bouquet-classic.png?v=${hash('image')}"`));
  assert.ok(html.includes('src="https://example.com/a.js"'));
  assert.ok(html.includes('src="//example.com/b.js"'));
  assert.ok(html.includes('src="/existing.js?v=old"'));
  assert.ok(html.includes('href="/other.css#x"'));
  assert.ok(html.includes('src="data:fake"'));
  assert.doesNotMatch(html, /NEVER_CACHE_THIS/);
  const match = /<script id="public-asset-versions" type="application\/json">([^<]*)<\/script>/.exec(html);
  assert.ok(match);
  assert.ok(match.index < html.indexOf('</head>'));
  const manifest = JSON.parse(match[1]);
  assert.equal(manifest['/audio/pokernow/chips.mp3'], `/audio/pokernow/chips.mp3?v=${hash('sound')}`);
  assert.equal(manifest['/assets/gift-red-rose-grand.png'], undefined);
  for (const method of ['GET', 'HEAD']) {
    const same = await request('/index.html', { method, headers: { 'If-None-Match': initialTag } });
    assert.equal(same.status, 304);
    assert.equal((await body(same)).length, 0);
  }
  await write('app.js', 'version 2');
  const changed = await request('/', { headers: { 'If-None-Match': initialTag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), initialTag);
  assert.ok((await changed.text()).includes(`/app.js?v=${hash('version 2')}`));
  const noImmutableHTML = await request('/index.html?v=' + hash(html));
  assert.equal(noImmutableHTML.headers.get('cache-control'), 'no-cache');
  await noImmutableHTML.arrayBuffer();
});

test('HTML transformation size cap does not buffer or rewrite unbounded text', async t => {
  const { write, request } = await fixture(t, { maxHtmlBytes: 40 });
  const html = '<html><head><script src="/app.js"></script></head><body>large</body></html>';
  await write('index.html', html);
  await write('app.js', 'safe');
  const response = await request('/');
  assert.equal(await response.text(), html);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});


test('oversized transfers have a separate bounded stream limit and release capacity after finishing', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const opening = new Promise(resolve => { started = resolve; });
  let opens = 0;
  const fileSystem = { ...fs, async open(...args) {
    opens++;
    const handle = await fs.open(...args);
    const read = handle.createReadStream.bind(handle);
    handle.createReadStream = options => Readable.from((async function* () {
      started();
      await gate;
      yield* read(options);
    })());
    return handle;
  } };
  const { write, request, assets } = await fixture(t, { fileSystem, maxFileBytes: 16, maxStreams: 1 });
  const bytes = Buffer.alloc(1024, 9);
  await write('large.png', bytes);
  const first = request('/large.png').then(body);
  t.after(release);
  await opening;
  assert.equal(assets.activeStreams, 1);
  const overflow = await request('/large.png');
  assert.equal(overflow.status, 503);
  assert.equal(overflow.headers.get('cache-control'), 'no-store');
  await overflow.text();
  assert.equal(opens, 1);
  release();
  assert.deepEqual(await first, bytes);
  // File-handle cleanup is asynchronous and can finish after the client receives the last chunk.
  const cleaned = async () => {
    const deadline = Date.now() + 1000;
    while (assets.activeStreams && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(assets.activeStreams, 0);
  };
  await cleaned();
  assert.deepEqual(await body(await request('/large.png')), bytes);
  await cleaned();
});

test('a streamed file changed immediately before transfer cannot advertise an old strong validator', async t => {
  let changeBeforeStream = true;
  const fileSystem = { ...fs, async open(filename, flags) {
    const handle = await fs.open(filename, flags);
    const read = handle.createReadStream.bind(handle);
    handle.createReadStream = options => {
      if (changeBeforeStream) {
        changeBeforeStream = false;
        writeFileSync(filename, 'MODIFIED AND LONGER');
      }
      return read(options);
    };
    return handle;
  } };
  const { write, request } = await fixture(t, { fileSystem, maxFileBytes: 4 });
  await write('changing.png', 'ORIGINAL');
  const response = await request('/changing.png?v=' + hash('ORIGINAL'),
    { headers: { 'If-None-Match': `"${hash('ORIGINAL')}"` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(await response.text(), 'MODIFIED AND LONGER');
});

test('failed public reads release inflight work and allow a later successful retry', async t => {
  let fail = true;
  const fileSystem = { ...fs, async open(...args) {
    if (fail) {
      fail = false;
      const error = new Error('temporary read failure');
      error.code = 'EIO';
      throw error;
    }
    return fs.open(...args);
  } };
  const { write, assets } = await fixture(t, { fileSystem, maxReads: 1 });
  await write('retry.js', 'recovered');
  await assert.rejects(assets.get('/retry.js'), /temporary read failure/);
  assert.equal(assets.inflight.size, 0);
  assert.equal(assets.activeReads, 0);
  assert.equal(assets.cache.size, 0);
  assert.equal((await assets.get('/retry.js')).body.toString(), 'recovered');
});

test('aborting an oversized transfer releases its file handle and stream capacity', async t => {
  const { counts, fileSystem } = trackedFS();
  const { write, request, assets } = await fixture(t, { fileSystem, maxFileBytes: 16, maxStreams: 1 });
  await write('abort.png', Buffer.alloc(4 * 1024 * 1024, 1));
  const controller = new AbortController();
  const response = await request('/abort.png', { signal: controller.signal });
  controller.abort();
  await response.arrayBuffer().catch(() => {});
  const deadline = Date.now() + 1000;
  while (assets.activeStreams && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(assets.activeStreams, 0);
  assert.equal(counts.active, 0);
  const head = await request('/abort.png', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await body(head)).length, 0);
});
