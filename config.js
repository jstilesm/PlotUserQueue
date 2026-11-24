import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = Number(process.env.PORT ?? 3001);
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(os.homedir(), 'plotq-data'));
export const PLOT_CMD = process.env.PLOT_CMD ?? fileURLToPath(new URL('./plot-file.sh', import.meta.url));
export const PLOT_ARGS = (process.env.PLOT_ARGS ?? '{file}').split(/\s+/).filter(Boolean);
export const CANCEL_CMD = process.env.CANCEL_CMD ?? '';
export const PLOT_STALL_MIN = Number(process.env.PLOT_STALL_MIN ?? 30);
