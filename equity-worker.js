import { parentPort } from 'node:worker_threads';
import { calculateShowdownEquity } from './room.js';

parentPort.on('message', ({ players, board }) => {
  try { parentPort.postMessage({ result: calculateShowdownEquity(players, board) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
