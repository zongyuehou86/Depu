import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};
const OPTIONAL_ASSETS = [
  ...['gift-bouquet-classic', 'gift-bouquet-grand', 'gift-red-rose-classic', 'gift-red-rose-grand']
    .map(name => `/assets/${name}.png`),
  ...['card-place', 'two-taps', 'fold', 'chips', 'beep', 'warning-beep', 'winner', 'chat-beep']
    .map(name => `/audio/pokernow/${name}.mp3`)
];
const HASH = /^[a-f0-9]{64}$/;
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const digest = body => createHash('sha256').update(body).digest('hex');
const notFound = () => new PublicAssetError('页面不存在', 404);

export class PublicAssetError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function ifNoneMatch(value, etag) {
  if (typeof value !== 'string') return false;
  // GET/HEAD use weak comparison, including lists and the wildcard validator.
  return value.split(',').some(item => item.trim() === '*' || (etag && item.trim().replace(/^W\//, '') === etag));
}

/** Public bytes only. Request queries, cookies, tokens and API responses never enter the cache. */
export class PublicAssets {
  constructor(directory, { maxBytes = 32 * 1024 * 1024, maxFileBytes = 8 * 1024 * 1024,
    maxEntries = 128, maxReads = 4, maxPending = 64, maxStreams = 16, maxHtmlBytes = 256 * 1024,
    optionalAssets = OPTIONAL_ASSETS, fileSystem = fs } = {}) {
    this.directory = path.resolve(directory);
    this.fs = fileSystem;
    this.realDirectory = this.fs.realpath(this.directory);
    this.maxBytes = maxBytes;
    this.maxFileBytes = Math.min(maxFileBytes, maxBytes);
    this.maxEntries = maxEntries;
    this.maxReads = maxReads;
    this.maxPending = maxPending;
    this.maxStreams = maxStreams;
    this.maxHtmlBytes = maxHtmlBytes;
    this.optionalAssets = optionalAssets.slice(0, 32);
    this.cache = new Map();
    this.inflight = new Map();
    this.bytes = 0;
    this.activeReads = 0;
    this.activeStreams = 0;
    this.waiting = [];
    this.rendering = null;
    this.rendered = null;
  }

  resolve(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch { throw new PublicAssetError('无效路径', 400); }
    if (decoded.includes('\0')) throw new PublicAssetError('无效路径', 400);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const resolved = path.resolve(this.directory, relative);
    if (!resolved.startsWith(`${this.directory}${path.sep}`)) throw notFound();
    return resolved;
  }

  async inspect(resolved) {
    try {
      const realFile = await this.fs.realpath(resolved);
      if (!realFile.startsWith(`${await this.realDirectory}${path.sep}`)) throw notFound();
      const stat = await this.fs.stat(realFile, { bigint: true });
      if (!stat.isFile()) throw notFound();
      return { realFile, stat, signature: signature(stat) };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) throw notFound();
      throw error;
    }
  }

  async slot(work) {
    if (this.activeReads >= this.maxReads) {
      await new Promise(resolve => this.waiting.push(resolve));
    } else this.activeReads++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeReads--;
    }
  }

  remember(key, entry) {
    const previous = this.cache.get(key);
    if (previous) this.bytes -= previous.body?.length || 0;
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.bytes += entry.body?.length || 0;
    while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value;
      this.bytes -= this.cache.get(oldest).body?.length || 0;
      this.cache.delete(oldest);
    }
    return entry;
  }

  get(pathname) {
    const resolved = this.resolve(pathname);
    if (this.inflight.has(resolved)) return this.inflight.get(resolved);
    if (this.inflight.size >= this.maxPending) {
      return Promise.reject(new PublicAssetError('静态资源繁忙，请稍后重试', 503));
    }
    // One stat/read/hash per concurrent path burst; arbitrary query strings do not add entries.
    const pending = this.slot(async () => {
      try {
        const info = await this.inspect(resolved);
        const previous = this.cache.get(resolved);
        if (previous && previous.realFile === info.realFile && previous.signature === info.signature) {
          return this.remember(resolved, previous);
        }
        return this.remember(resolved, await this.readStable(resolved, info));
      } catch (error) {
        const previous = this.cache.get(resolved);
        this.bytes -= previous?.body?.length || 0;
        this.cache.delete(resolved);
        throw error;
      }
    });
    this.inflight.set(resolved, pending);
    const cleanup = () => this.inflight.delete(resolved);
    pending.then(cleanup, cleanup);
    return pending;
  }

  async openChecked(resolved, info) {
    let handle;
    try {
      handle = await this.fs.open(info.realFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const current = await this.inspect(resolved);
      const stat = await handle.stat({ bigint: true });
      if (current.realFile !== info.realFile || signature(stat) !== current.signature) {
        await handle.close();
        return null;
      }
      return { handle, ...current };
    } catch (error) {
      if (handle) await handle.close();
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) throw notFound();
      throw error;
    }
  }

  async readStable(resolved, initial) {
    let info = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (info.stat.size > BigInt(this.maxFileBytes)) {
        // Unbuffered files cannot promise byte-stable validators during in-place writes.
        // Keep only bounded metadata; do not read/hash the entire file before streaming it.
        return { realFile: info.realFile, signature: info.signature,
          length: Number(info.stat.size), body: null };
      }
      const opened = await this.openChecked(resolved, info);
      if (opened) {
        const { handle } = opened;
        try {
          const hash = createHash('sha256');
          let chunks = Number(opened.stat.size) <= this.maxFileBytes ? [] : null;
          let length = 0;
          // Streaming bounds memory even if an on-disk file grows after the stat.
          for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
            hash.update(chunk);
            length += chunk.length;
            if (length > this.maxFileBytes) chunks = null;
            if (chunks) chunks.push(chunk);
          }
          const after = await handle.stat({ bigint: true });
          if (signature(after) === opened.signature && BigInt(length) === after.size) {
            const version = chunks ? hash.digest('hex') : undefined;
            return { realFile: opened.realFile, signature: opened.signature, length, version,
              etag: version ? `"${version}"` : undefined, body: chunks ? Buffer.concat(chunks, length) : null };
          }
        } finally { await handle.close(); }
      }
      info = await this.inspect(resolved);
    }
    throw new PublicAssetError('静态资源正在更新，请稍后重试', 503);
  }

  async renderIndex() {
    if (this.rendering) return this.rendering;
    this.rendering = this.buildIndex();
    try { return await this.rendering; }
    finally { this.rendering = null; }
  }

  async buildIndex() {
    const original = await this.get('/index.html');
    if (!original.body || original.length > this.maxHtmlBytes) return original;
    const html = original.body.toString('utf8');
    const attributes = /\b(src|href|data-src)=(['"])(\/[^\s'"<>?#]*)\2/g;
    const tags = /<(?:script|link|img|source)\b[^>]*>/gi;
    const paths = new Set(this.optionalAssets);
    for (const tag of html.matchAll(tags)) {
      for (const match of tag[0].matchAll(attributes)) {
        if (!match[3].startsWith('//') && path.extname(match[3]) !== '.html' && paths.size < 64) paths.add(match[3]);
      }
    }
    const versions = Object.create(null);
    await Promise.all([...paths].map(async pathname => {
      try {
        const entry = await this.get(pathname);
        // Oversized files stream without caching; only retained, verified bytes get versions.
        if (entry.body) versions[pathname] = `${pathname}?v=${entry.version}`;
      } catch (error) {
        // Optional production binaries need not exist in a text-only checkout.
        if (!(error instanceof PublicAssetError) || error.status !== 404) throw error;
      }
    }));
    const stableVersions = Object.fromEntries(Object.keys(versions).sort().map(key => [key, versions[key]]));
    const mapJSON = JSON.stringify(stableVersions).replace(/</g, '\\u003c').replace(/&/g, '\\u0026');
    const key = `${original.etag}:${mapJSON}`;
    if (this.rendered?.key === key) return this.rendered.entry;
    const rewritten = html.replace(tags, tag => tag.replace(attributes,
      (all, name, quote, pathname) => versions[pathname] ? `${name}=${quote}${versions[pathname]}${quote}` : all));
    const manifest = `<script id="public-asset-versions" type="application/json">${mapJSON}</script>`;
    // The inert map is present before any deferred application scripts execute.
    const output = rewritten.replace(/<\/head>/i, `${manifest}\n</head>`);
    const body = Buffer.from(output);
    const entry = { body, length: body.length, etag: `"${digest(body)}"` };
    this.rendered = { key, entry };
    return entry;
  }

  async serve(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new PublicAssetError('不支持此请求', 405);
    }
    const resolved = this.resolve(url.pathname);
    const isIndex = resolved === path.join(this.directory, 'index.html');
    const isHTML = path.extname(resolved).toLowerCase() === '.html';
    let entry = isIndex ? await this.renderIndex() : await this.get(url.pathname);
    const streaming = !entry.body && request.method !== 'HEAD' &&
      !ifNoneMatch(request.headers['if-none-match'], entry.etag);
    if (streaming && this.activeStreams >= this.maxStreams) {
      throw new PublicAssetError('静态资源繁忙，请稍后重试', 503);
    }
    if (streaming) this.activeStreams++;
    let opened;
    try {
      if (streaming) {
        for (let attempt = 0; attempt < 3 && !entry.body; attempt++) {
          opened = await this.openChecked(resolved, await this.inspect(resolved));
          if (opened?.signature === entry.signature && opened.realFile === entry.realFile) break;
          if (opened) await opened.handle.close();
          opened = null;
          entry = await this.get(url.pathname);
        }
        if (!entry.body && !opened) throw new PublicAssetError('静态资源正在更新，请稍后重试', 503);
      }
      const version = url.searchParams.get('v');
      const immutable = !isHTML && entry.body && HASH.test(version || '') && version === entry.version &&
        url.searchParams.getAll('v').length === 1;
      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      };
      if (isHTML) headers['Cache-Control'] = 'no-cache';
      if (entry.etag) headers.ETag = entry.etag;
      if (!entry.body) headers['Cache-Control'] = 'no-store';
      if (ifNoneMatch(request.headers['if-none-match'], entry.etag)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      // Omit Content-Length for unbuffered responses: a concurrent local write may change size.
      if (entry.body) headers['Content-Length'] = entry.length;
      response.writeHead(200, headers);
      if (request.method === 'HEAD') response.end();
      else if (entry.body) response.end(entry.body);
      else await pipeline(opened.handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }), response);
    } finally {
      try { if (opened) await opened.handle.close(); }
      finally { if (streaming) this.activeStreams--; }
    }
  }
}
