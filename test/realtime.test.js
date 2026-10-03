import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { sendLatestState, clearSocketQueue, startHeartbeat } from '../realtime.js';

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  callbacks = [];
  send(text, callback) { this.sent.push(text); if (callback) this.callbacks.push(callback); }
  ping() { this.emit('ping'); }
  terminate() { this.readyState = WebSocket.CLOSED; }
}

test('a slow connection receives only the latest unsent turn, without an unbounded state queue', () => {
  const socket = new Socket();
  sendLatestState(socket, 'turn-1');
  for (let turn = 2; turn <= 500; turn++) sendLatestState(socket, `turn-${turn}`);
  assert.deepEqual(socket.sent, ['turn-1']);
  socket.callbacks.shift()();
  assert.deepEqual(socket.sent, ['turn-1', 'turn-500']);
  socket.callbacks.shift()();
  clearSocketQueue(socket);
});

test('a connection with excessive buffered bytes is terminated so it can resynchronize', () => {
  const socket = new Socket();
  socket.bufferedAmount = 600 * 1024;
  sendLatestState(socket, 'latest');
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.deepEqual(socket.sent, []);
});

test('ping responders stay alive while half-open sockets are removed', async () => {
  const live = new Socket(), dead = new Socket();
  live.on('ping', () => { live.isAlive = true; });
  const server = new EventEmitter();
  server.clients = new Set([live, dead]);
  const stop = startHeartbeat(server, 10);
  try {
    await new Promise(resolve => setTimeout(resolve, 55));
    assert.equal(live.readyState, WebSocket.OPEN);
    assert.equal(dead.readyState, WebSocket.CLOSED);
    assert.ok(live.sent.every(packet => JSON.parse(packet).type === 'heartbeat'));
  } finally { stop(); }
});
