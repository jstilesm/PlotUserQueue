import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../store.js';
import { createWorker } from '../worker.js';

const FAKE = path.join(import.meta.dirname, 'fake-plot.sh');
const SQUARE = 'IN;SP1;PU0,0;PD1000,0,1000,1000,0,1000,0,0;PU;SP0;';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls fn until it returns true, or fails the test after ms.
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(20);
    }
    throw new Error('until(): timed out');
}

// A fresh store + worker. The fake plot takes 0.2 s and exits with `exit`.
// The worker is created but NOT started; each test starts it when ready.
async function setup(t, { exit = 0, plotCmd = FAKE, tickMs = 50 } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'plotq-w-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    process.env.FAKE_PLOT_SECONDS = '0.2';
    process.env.FAKE_PLOT_EXIT = String(exit);

    const store = await createStore(dir);
    const worker = createWorker(store, { plotCmd, plotArgs: ['{file}'], logDir: path.join(dir, 'logs'), tickMs });
    t.after(() => worker.stop());

    const db = new DatabaseSync(path.join(dir, 'plotq.db'));
    t.after(() => db.close());
    const jobs = () => db.prepare('SELECT * FROM jobs ORDER BY seq').all().map((r) => ({ ...r }));
    return { dir, store, worker, jobs };
}

async function queue(store, n) {
    const print = await store.createPrint({ user: 'Dan', name: 'test.hpgl', sourceType: 'hpgl', source: SQUARE, hpgl: SQUARE });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await store.enqueue('Dan', print.id)).id);
    return ids;
}

// Hold is set after every job (W4). These W3 tests pretend someone taps
// Release each time, so they only test start/finish/order.
const releasing = (store, fn) => async () => { await store.clearFlag('hold'); return fn(); };

test('worker plots three queued jobs in order, each ending done', async (t) => {
    const { store, worker, jobs } = await setup(t);
    const ids = await queue(store, 3);
    worker.start();

    await until(releasing(store, () => jobs().every((j) => j.state === 'done')));

    const rows = jobs();
    assert.deepEqual(rows.map((j) => j.id), ids);
    for (const j of rows) {
        assert.equal(j.exitCode, 0);
        assert.match(j.started, /^\d{4}-/);
        assert.match(j.finished, /^\d{4}-/);
    }
    // Strictly one at a time: each job started after the previous one finished.
    assert.ok(rows[1].started >= rows[0].finished, 'job 2 started before job 1 finished');
    assert.ok(rows[2].started >= rows[1].finished, 'job 3 started before job 2 finished');
    assert.equal(worker.current(), null);
});

test('a plot command that exits 1 makes the job failed with exitCode 1', async (t) => {
    const { store, worker, jobs } = await setup(t, { exit: 1 });
    await queue(store, 1);
    worker.start();

    await until(releasing(store, () => jobs()[0].state !== 'active' && jobs()[0].state !== 'pending'));
    assert.equal(jobs()[0].state, 'failed');
    assert.equal(jobs()[0].exitCode, 1);
});

test('a plot command that cannot start fails the job with the error, and the worker keeps going', async (t) => {
    const { store, worker, jobs } = await setup(t, { plotCmd: '/nope/plot.sh' });
    await queue(store, 2);
    worker.start();

    await until(releasing(store, () => jobs().every((j) => j.state === 'failed')));
    for (const j of jobs()) assert.match(j.reason, /ENOENT/);
    assert.equal(worker.current(), null);
});

test('the plot output goes to logs/<job-id>.log', async (t) => {
    const { dir, store, worker, jobs } = await setup(t);
    const [id] = await queue(store, 1);
    worker.start();
    await until(releasing(store, () => jobs()[0].state === 'done'));

    const log = await readFile(path.join(dir, 'logs', `${id}.log`), 'utf8');
    assert.match(log, new RegExp(`plotting ${store.plotPath(jobs()[0])}`));
});

test('current() describes the running plot, and wake() starts one without waiting for a tick', async (t) => {
    const { store, worker } = await setup(t, { tickMs: 60_000 });   // ticks effectively never
    worker.start();                                                  // empty queue: first tick finds nothing
    await sleep(50);
    assert.equal(worker.current(), null);

    const [id] = await queue(store, 1);
    worker.wake();
    await until(() => worker.current() !== null, 1000);

    const cur = worker.current();
    assert.equal(cur.id, id);
    assert.equal(typeof cur.pid, 'number');
    assert.match(cur.startedAt, /^\d{4}-/);

    // Let the plot finish before the test ends, or onExit would run after the temp dir is gone.
    await until(releasing(store, () => worker.current() === null));
});

// ---- hold after each job, and startup recovery (W4) ----

test('after a job finishes, hold is set and nothing starts until it is cleared', async (t) => {
    const { store, worker, jobs } = await setup(t);
    await queue(store, 2);
    worker.start();

    await until(() => jobs()[0].state === 'done');            // job 1 finished (no releasing here)
    assert.equal((await store.readQueue()).hold, true, 'hold should be set after a job');

    await sleep(300);                                         // several ticks go by
    assert.equal(jobs()[1].state, 'pending', 'job 2 must wait for release');
    assert.equal(worker.current(), null);

    await store.clearFlag('hold');                            // the kiosk's Release button
    await until(() => jobs()[1].state === 'done');
    assert.equal((await store.readQueue()).hold, true, 'hold is set again after job 2');
});

test('a job left active from a previous run is failed as interrupted on start, and hold is set', async (t) => {
    const { store, worker, jobs } = await setup(t);
    const [A, B] = await queue(store, 2);
    await store.takeNext();                                   // A is active, as if plotpi died mid-plot

    await worker.start();
    const a = jobs().find((j) => j.id === A);
    assert.equal(a.state, 'failed');
    assert.equal(a.reason, 'interrupted');
    assert.equal((await store.readQueue()).hold, true, 'checklist before anything else runs');
    assert.equal(jobs().find((j) => j.id === B).state, 'pending');

    await store.clearFlag('hold');                            // Release → B runs normally
    await until(() => jobs().find((j) => j.id === B).state === 'done');
});
