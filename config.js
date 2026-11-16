import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.PORT ?? 3001);
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(os.homedir(), 'plotq-data'));
export const PLOT_CMD = process.env.PLOT_CMD ?? path.join(os.homedir(), 'plotter-web/plot_task.sh');
export const PLOT_ARGS = (process.env.PLOT_ARGS ?? '{file}').split(/\s+/).filter(Boolean);
export const CANCEL_CMD = process.env.CANCEL_CMD ?? '';
