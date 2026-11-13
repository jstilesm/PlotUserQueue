import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';


export function createWorker(store, { plotCmd, plotArgs, logDir, tickMs = 1000 }) {
    let running = null;      
    let timer = null;     

    async function onExit(job, log, code, signal, err) {
        let result
        if (err) {
            result = {exitCode: 1, reason: err.message}
        } else {
            result = {exitCode: code ?? 1, reason: signal ?? null }
        }

        await log.close();
        await store.withLock(async () => {
            store.finishJob(job.id, result)
            store.setFlag('hold')
            store.pruneFinished()
            running = null
        })
        tick()
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
            running = { id: job.id, pid: null, startedAt: new Date().toISOString() }
            const log = await open(path.join(logDir, `${job.id}.log`), 'a');
            const args = plotArgs.map(arg => arg === '{file}' ? store.plotPath(job) : arg)
            const child = spawn(plotCmd, args, { detached: true, stdio: ['ignore', log.fd, log.fd] })
            running.pid = child.pid;
            child.on('exit', (code, signal) => onExit(job, log, code, signal))
            child.on('error', (err) => onExit(job, log, null, null, err))
        })
    }
    async function start() {
        const interrupted = store.recoverInterrupted();
        if (interrupted) {
            store.setFlag('hold')
        } 
        await mkdir(logDir, {recursive: true})
        tick();
        timer = setInterval(tick, tickMs)
    }
    function stop() {
        clearInterval(timer)
    }
    function wake() {
        tick()
    }
    function current() {
        return running;
    }


    return { start, stop, wake, current };
}