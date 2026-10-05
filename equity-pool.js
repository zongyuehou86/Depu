import { Worker } from 'node:worker_threads';

// One CPU worker leaves the other core available for HTTP, sockets and timers.
// Only exposed cards enter this worker; it never receives the dealing deck.
export class EquityPool {
  constructor({ timeoutMs = 30_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.worker = null;
    this.active = null;
    this.closed = false;
  }
  calculate(input) {
    if (this.closed) return Promise.reject(new Error('Equity pool closed'));
    if (this.queue.length >= 64) return Promise.reject(new Error('Equity queue full'));
    return new Promise((resolve, reject) => {
      const task = { input, resolve, reject };
      task.timer = setTimeout(() => {
        if (this.active === task) this.failWorker(this.worker, new Error('Equity calculation timed out'));
        else {
          this.queue = this.queue.filter(item => item !== task);
          task.reject(new Error('Equity calculation timed out'));
        }
      }, this.timeoutMs);
      this.queue.push(task);
      this.next();
    });
  }
  next() {
    if (this.closed || this.active || !this.queue.length) return;
    const task = this.queue.shift();
    this.active = task;
    if (!this.worker) {
      let worker;
      try { worker = new Worker(new URL('./equity-worker.js', import.meta.url)); }
      catch (error) {
        this.active = null;
        clearTimeout(task.timer);
        task.reject(error);
        setImmediate(() => this.next());
        return;
      }
      this.worker = worker;
      worker.on('message', packet => {
        if (this.worker !== worker || !this.active) return;
        const task = this.active;
        this.active = null;
        clearTimeout(task.timer);
        if (packet.error) task.reject(new Error(packet.error));
        else task.resolve(packet.result);
        worker.unref();
        this.next();
      });
      const failed = error => this.failWorker(worker, error);
      worker.on('error', failed);
      worker.on('exit', code => failed(new Error(`Equity worker exited (${code})`)));
    }
    const worker = this.worker;
    worker.ref();
    try { worker.postMessage(task.input); }
    catch (error) { this.failWorker(worker, error); }
  }
  failWorker(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    const task = this.active;
    this.active = null;
    if (task) { clearTimeout(task.timer); task.reject(error); }
    void worker?.terminate();
    setImmediate(() => this.next());
  }
  close() {
    this.closed = true;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.reject(new Error('Equity pool closed'));
      this.active = null;
    }
    for (const task of this.queue.splice(0)) {
      clearTimeout(task.timer);
      task.reject(new Error('Equity pool closed'));
    }
    const worker = this.worker;
    this.worker = null;
    return worker?.terminate();
  }
}
