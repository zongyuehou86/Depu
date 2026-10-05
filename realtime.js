import { WebSocket } from 'ws';

const queues = new WeakMap();
const BUFFER_LIMIT = 128 * 1024;
const DISCONNECT_LIMIT = 512 * 1024;

// Snapshots supersede each other. Keep one unsent latest state per connection
// instead of queuing every intermediate turn behind a slow mobile connection.
export function sendLatestState(socket, text) {
  if (socket.readyState !== WebSocket.OPEN) return;
  let queue = queues.get(socket);
  if (!queue) {
    queue = { pending: null, sending: false, timer: null };
    queues.set(socket, queue);
  }
  queue.pending = text;
  flushState(socket, queue);
}

function flushState(socket, queue) {
  if (socket.readyState !== WebSocket.OPEN) { clearSocketQueue(socket); return; }
  if (socket.bufferedAmount > DISCONNECT_LIMIT) {
    clearSocketQueue(socket);
    socket.terminate();
    return;
  }
  if (queue.sending || !queue.pending) return;
  if (socket.bufferedAmount > BUFFER_LIMIT) {
    if (!queue.timer) queue.timer = setTimeout(() => {
      queue.timer = null;
      flushState(socket, queue);
    }, 100).unref();
    return;
  }
  const text = queue.pending;
  queue.pending = null;
  queue.sending = true;
  try {
    socket.send(text, error => {
      queue.sending = false;
      if (error) { clearSocketQueue(socket); socket.terminate(); return; }
      flushState(socket, queue);
    });
  } catch {
    clearSocketQueue(socket);
    socket.terminate();
  }
}

export function clearSocketQueue(socket) {
  const queue = queues.get(socket);
  if (queue?.timer) clearTimeout(queue.timer);
  if (queue) queue.pending = null;
  queues.delete(socket);
}

export function startHeartbeat(server, intervalMs = 15_000) {
  const timer = setInterval(() => {
    for (const socket of server.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.isAlive === false) { clearSocketQueue(socket); socket.terminate(); continue; }
      socket.isAlive = false;
      try {
        socket.ping();
        if (socket.bufferedAmount < BUFFER_LIMIT) {
          socket.send(JSON.stringify({ type: 'heartbeat', serverTime: Date.now() }));
        }
      } catch { clearSocketQueue(socket); socket.terminate(); }
    }
  }, intervalMs).unref();
  server.once('close', () => clearInterval(timer));
  return () => clearInterval(timer);
}
