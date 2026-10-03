import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('all production browser scripts initialize in actual HTML order with the new details controller', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const listeners = new Map();
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    id, value: '', textContent: '', innerHTML: '', hidden: false, dataset: {}, style: {}, options: [],
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener(kind, callback) { listeners.set(`${id}:${kind}`, callback); },
    setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; }
  }]));
  const document = {
    hidden: false, readyState: 'loading', documentElement: { lang: '' },
    getElementById: id => nodes.get(id) || null,
    querySelector(selector) {
      if (selector.startsWith('#')) {
        const node = nodes.get(selector.slice(1));
        assert.ok(node, `startup requested missing HTML node ${selector}`);
        return node;
      }
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(kind, callback) { listeners.set(`document:${kind}`, callback); },
    removeEventListener() {}, dispatchEvent() {}
  };
  const window = { addEventListener(kind, callback) { listeners.set(`window:${kind}`, callback); } };
  const localStorage = { getItem: key => key === 'poker-sound-enabled' ? 'false' : null, setItem() {}, removeItem() {} };
  const context = vm.createContext({ window, document, localStorage,
    navigator: { userAgent: 'startup-test', maxTouchPoints: 0 },
    location: { search: '', pathname: '/', protocol: 'http:', host: 'localhost' },
    URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch() { throw new Error('No network operation belongs in the idle startup test'); }
  });
  const scripts = [...html.matchAll(/<script src="\/([^"]+)" defer><\/script>/g)].map(([, name]) => name);
  assert.ok(scripts.indexOf('details.js') < scripts.indexOf('app.js'));
  for (const file of scripts) vm.runInContext(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  assert.equal(typeof window.PokerDetails.createController, 'function');
  for (const event of ['lobby-form:submit', 'history-details:toggle', 'fairness-details:toggle', 'window:online']) {
    assert.equal(typeof listeners.get(event), 'function', event);
  }
  assert.equal(nodes.get('sound-enabled').disabled, true, 'no audio capability does not prevent table startup');
});
