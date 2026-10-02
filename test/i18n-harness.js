import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');
const source = readFileSync(path.join(publicDir, 'i18n.js'), 'utf8');

export function loadI18n({ stored = null, storageThrows = false, nodes = [] } = {}) {
  const writes = [];
  const events = [];
  const document = {
    documentElement: { lang: '' },
    readyState: 'loading',
    addEventListener() {},
    dispatchEvent(event) { events.push(event); },
    getElementById() { return null; },
    querySelectorAll() { return nodes; }
  };
  const localStorage = {
    getItem() { if (storageThrows) throw new Error('storage unavailable'); return stored; },
    setItem(key, value) { if (storageThrows) throw new Error('storage unavailable'); writes.push([key, value]); }
  };
  const window = {};
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }
  vm.runInNewContext(source, { window, document, localStorage, CustomEvent }, { filename: 'public/i18n.js' });
  return { i18n: window.PokerI18n, document, writes, events };
}

export function sourceFile(name) { return readFileSync(path.join(publicDir, name), 'utf8'); }
