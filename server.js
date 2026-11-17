import { createApp } from './app.js';
import { PORT, DATA_DIR, PLOT_CMD, PLOT_ARGS, CANCEL_CMD, PLOT_STALL_MIN } from './config.js';
import { createStore } from './store.js';
import { createWorker } from './worker.js';
import path from 'node:path';

const store = await createStore(DATA_DIR);

const worker = createWorker(store, { plotCmd: PLOT_CMD, plotArgs: PLOT_ARGS, logDir: path.join(DATA_DIR, 'logs'), cancelCmd: CANCEL_CMD, stallMs: PLOT_STALL_MIN * 60_000  })
await worker.start();

const server = createApp({store, worker}).listen(PORT, () => {
  console.log(`plotq listening on http://localhost:${PORT} (data in ${DATA_DIR})`);
});

process.on('SIGINT', () => { worker.stop(); server.close(); process.exit(0) })
process.on('SIGTERM', () => { worker.stop(); server.close(); process.exit(0) })