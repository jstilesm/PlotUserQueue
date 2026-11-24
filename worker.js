import { spawn } from 'node:child_process';
import { open, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { error } from './store.js';

// Helper to process signal commands
function signal(pid, sig) {
  try { process.kill(-pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}
// Runs cancelCmd with its output appended to the job log, and waits for it.
function runCancelCmd(cancelCmd, log) {
  return new Promise((resolve) => {
    const c = spawn(cancelCmd, [], { stdio: ['ignore', log.fd, log.fd] });
    c.on('exit', resolve);
    c.on('error', resolve);
  });
}


export function createWorker(store, { plotCmd, plotArgs, logDir, cancelCmd, stallMs, tickMs = 1000 }) {
    let running = null;      
    let timer = null; 

    function armTimeout() {
        if (!stallMs) return;
        const id = running.id;
        running.lastGrowth = Date.now();
        running.stallTimer = setInterval(() => onTimeout(id), Math.min(1000, stallMs / 4));
    }

     function tick() {
        return store.withLock(async () => {
            if (running) {
                return
            }
            const job = store.takeNext();
            if(!job) {
                return
            }
            running = { id: job.id, pid: null, startedAt: new Date().toISOString(), paused: false, ending: null, killTimer: null, stallTimer: null,  logPath: path.join(logDir, `${job.id}.log`), lastSize: 0, lastGrowth: null }
            const log = await open(running.logPath, 'a');
            const args = plotArgs.map(arg => arg === '{file}' ? store.plotPath(job) : arg)
            const child = spawn(plotCmd, args, { detached: true, stdio: ['ignore', log.fd, log.fd] })
            running.pid = child.pid;
            armTimeout();
            child.on('exit', (code, signal) => onExit(job, log, code, signal))
            child.on('error', (err) => onExit(job, log, null, null, err))
        })
    }

    async function onExit(job, log, code, signal, err) {
        let result
        if (running?.id !== job.id) return;
        clearInterval(running.stallTimer)
        clearTimeout(running.killTimer)

        if (running.ending === 'cancelled') {
            result = { exitCode: null, reason: 'cancelled', state: 'cancelled'}
        } else if (running.ending === 'stalled') {
            result = { exitCode: null, reason: 'stalled'}
        } else if (err) {
            result = {exitCode: 1, reason: err.message}
        } else {
            result = {exitCode: code ?? 1, reason: signal ?? null }
        }
        if (running.ending && cancelCmd) {
            await runCancelCmd(cancelCmd, log)
        }

        await log.close();
        await store.withLock(async () => {
            store.finishJob(job.id, result)
            store.clearFlag('pause')
            store.setFlag('hold')
            store.pruneFinished()
            running = null
        })
        tick()
    }
    async function start() {
        const interrupted = store.recoverInterrupted();
        store.clearFlag('pause')
        if (interrupted) {
            store.setFlag('hold')
        } 
        await mkdir(logDir, {recursive: true})
        tick();
        timer = setInterval(tick, tickMs)
    }
    function endPlot(reason) {
         running.ending = reason
            signal(running.pid, 'SIGCONT')
            signal(running.pid, 'SIGTERM')
            const pid = running.pid
            running.killTimer = setTimeout(() => {
                 signal(pid, 'SIGKILL')
            }, 2000);
    }
    function cancel(id) {
        return store.withLock(async () => {
            if (running?.id !== id) {
                error('job not found', 404)
            }
           endPlot('cancelled')
        })
    }
    function onTimeout(id) {
        return store.withLock(async () => {
            if (running?.id !== id || running.ending) return;
            const stats = await stat(running.logPath)
            if (stats.size > running.lastSize) {
                running.lastSize = stats.size
                running.lastGrowth = Date.now()
            } else if (Date.now() - running.lastGrowth > stallMs) {
                endPlot('stalled')
            }
        })
    }
    function pause() {
        return store.withLock(async () => {
            if (!running) {
                error('nothing plotting', 409)
            }
            store.setFlag('pause')
            running.paused = true;
            signal(running.pid, 'SIGSTOP')
            clearInterval(running.stallTimer)
        })
    }
    function resume() {
        return store.withLock(async () => {
            if (!running) {
                error('nothing plotting', 409)
            }
            if (running.paused === false) return;
            store.clearFlag('pause')
            running.paused = false;
            signal(running.pid, 'SIGCONT')
            armTimeout();
        })

    }
    function stop() {
        clearInterval(running?.stallTimer)
        clearInterval(timer)
    }
    function wake() {
        tick()
    }
    function current() {
        return running;
    }


    return { start, stop, wake, current, cancel, pause, resume };
}