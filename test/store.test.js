import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createStore, FOLDERS } from '../store.js';


// Test Print

const SQUARE = 'IN;SP1;PU0,0;PD1000,0,1000,1000,0,1000,0,0;PU;SP0;';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshStore(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plotq-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createStore(dir);
  return { dir, store };
}

// Opens the store's database file directly, so a test can look at the rows.
// Rows from node:sqlite have no prototype, so they're spread into plain objects
// before being compared with assert.deepEqual.
function openDb(t, dir) {
  const db = new DatabaseSync(path.join(dir, 'plotq.db'));
  t.after(() => db.close());
  return {
    get: (sql, ...args) => { const r = db.prepare(sql).get(...args); return r && { ...r }; },
    all: (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r })),
    run: (sql, ...args) => db.prepare(sql).run(...args),
  };
}

async function addPrint(store, user = 'Dan', name = 'test.hpgl') {
  return store.createPrint({ user, name, sourceType: 'hpgl', source: SQUARE, hpgl: SQUARE });
}

test('createStore makes every folder', async (t) => {
  const { dir } = await freshStore(t);
  for (const name of FOLDERS) {
    const info = await stat(path.join(dir, name));
    assert.ok(info.isDirectory(), `${name} should be a folder`);
  }
});
test('withLock runs calls one at a time, in order', async (t) => {
    const order = [];
    const { store } = await freshStore(t);
    await Promise.all([store.withLock(async () => { await sleep(30); order.push(1); }),
    store.withLock(async () => { await sleep(20); order.push(2); }),
    store.withLock(async () => { await sleep(10); order.push(3); })])
    assert.deepEqual(order,[1,2, 3])

});
test('a failing call rejects for its caller but does not block the next', async (t) => {
    const { store } = await freshStore(t);
    const bad = store.withLock(async () => { throw new Error('boom')})
    const good = store.withLock(async () => { return 'ok'})
    await assert.rejects(bad, /boom/)
    assert.equal(await good, 'ok')
});

// ---- createPrint ----

test('createPrint writes the two files and a prints row', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);
    const folder = path.join(dir, 'users', 'Dan', 'prints', print.id);

    assert.equal(await readFile(path.join(folder, 'source.hpgl'), 'utf8'), SQUARE);
    assert.equal(await readFile(path.join(folder, 'plot.hpgl'), 'utf8'), SQUARE);

    const row = openDb(t, dir).get('SELECT * FROM prints WHERE id = ?', print.id);
    assert.deepEqual(row, { id: print.id, name: 'test.hpgl', user: 'Dan', created: print.created, sourceType: 'hpgl' });
});
test('two uploads with the smae name get different ids', async (t) => {
    const { store } = await freshStore(t);
    const A = await addPrint(store);
    const B = await addPrint(store);
    assert.notEqual(A.id, B.id)
});
test('a bad user or sourceType throws 400', async (t) => {
    const { store } = await freshStore(t);
   await assert.rejects(store.createPrint({ user: '../evil', name: "test.hpgl"}), {status: 400})
   await assert.rejects(store.createPrint({user: "Dan", name: "test.hpgl", sourceType: "svg", source: SQUARE, hpgl: SQUARE
    }), {status: 400})
   await assert.rejects(store.createPrint({user: "Dan", name: "test.hpgl", sourceType: "hpgl", source: undefined, hpgl: SQUARE
    }), {status: 400})
   await assert.rejects(store.createPrint({user: "Dan", name: "test.hpgl", sourceType: "hpgl", source: SQUARE, hpgl: undefined
    }), {status: 400})
   await assert.rejects(store.createPrint({user: "Dan", name: "test.hpgl", sourceType: "hpgl", source: SQUARE, hpgl: ''
    }), {status: 400})
});

// ---- enqueue ----

test('enqueue returns a pending job and stores the same row', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);

    const job = await store.withLock(() => store.enqueue('Dan', print.id));

    assert.match(job.id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.match(job.submitted, /^\d{4}-\d{2}-\d{2}T/);           // an ISO timestamp
    assert.deepEqual(job, {
        id: job.id,
        name: 'test.hpgl',               // copied from the print
        user: 'Dan',
        state: 'pending',
        seq: 1,                          // first job in an empty queue
        submitted: job.submitted,
        started: null, finished: null, exitCode: null, reason: null,
        printID: print.id,
    });

    // The row in the table must equal what enqueue returned.
    const row = openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', job.id);
    assert.deepEqual(row, job);
});

test('enqueue numbers jobs 1, 2, 3 and keeps counting after a restart', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);

    const seqs = [];
    for (let i = 0; i < 3; i++) seqs.push((await store.enqueue('Dan', print.id)).seq);
    assert.deepEqual(seqs, [1, 2, 3]);

    const reopened = await createStore(dir);                 // same folder, same database
    assert.equal((await reopened.enqueue('Dan', print.id)).seq, 4);
});

test('enqueue rejects an unknown print with 404 and a bad user with 400', async (t) => {
    const { store } = await freshStore(t);
    await assert.rejects(async () => store.enqueue('Dan', '20261110-1200-nope'), { status: 404 });
    await assert.rejects(async () => store.enqueue('../evil', '20261110-1200-nope'), { status: 400 });
});

// ---- listPending ----

test('listPending returns pending jobs in seq order', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);
    const a = await store.enqueue('Dan', print.id);
    const b = await store.enqueue('Dan', print.id);
    const c = await store.enqueue('Dan', print.id);

    const ids = (await store.listPending()).map((j) => j.id);
    assert.deepEqual(ids, [a.id, b.id, c.id]);

    // Pretend the worker took job a: it's no longer pending.
    openDb(t, dir).run("UPDATE jobs SET state = 'active' WHERE id = ?", a.id);
    assert.deepEqual((await store.listPending()).map((j) => j.id), [b.id, c.id]);
});

test('listPending is empty for a fresh store', async (t) => {
    const { store } = await freshStore(t);
    assert.deepEqual(await store.listPending(), []);
});

// ---- moveJob ----

// Queues three jobs for one print and returns their ids as [A, B, C].
async function threeJobs(store) {
    const print = await addPrint(store);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await store.enqueue('Dan', print.id)).id);
    return ids;
}
const order = async (store) => (await store.listPending()).map((j) => j.id);

test('moveJob up swaps a job with the one before it', async (t) => {
    const { store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.moveJob(C, 'up');
    assert.deepEqual(await order(store), [A, C, B]);
});

test('moveJob down swaps a job with the one after it', async (t) => {
    const { store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.moveJob(A, 'down');
    assert.deepEqual(await order(store), [B, A, C]);
});

test('moveJob top moves a job to the front', async (t) => {
    const { store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.moveJob(C, 'top');
    assert.deepEqual(await order(store), [C, A, B]);
});

test('moveJob keeps the same set of seq numbers (a swap, not a renumber)', async (t) => {
    const { store } = await freshStore(t);
    const [, , C] = await threeJobs(store);
    await store.moveJob(C, 'top');
    const seqs = (await store.listPending()).map((j) => j.seq);
    assert.deepEqual(seqs, [1, 2, 3]);
});

test('an impossible move does nothing and does not throw', async (t) => {
    const { store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.moveJob(A, 'up');      // already first
    await store.moveJob(C, 'down');    // already last
    await store.moveJob(A, 'top');     // already at the top
    assert.deepEqual(await order(store), [A, B, C]);
});

test('moveJob rejects an unknown job with 404 and a bad direction with 400', async (t) => {
    const { store } = await freshStore(t);
    const [A] = await threeJobs(store);
    await assert.rejects(async () => store.moveJob('20261110-120000-dead', 'up'), { status: 404 });
    await assert.rejects(async () => store.moveJob(A, 'sideways'), { status: 400 });
});

// ---- cancelPending ----

test('cancelPending removes the job from the queue and the table', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.cancelPending(B);
    assert.deepEqual(await order(store), [A, C]);
    assert.equal(openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', B), undefined);
});

test('cancelPending rejects an unknown job and an active job with 404', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A] = await threeJobs(store);
    await assert.rejects(async () => store.cancelPending('20261110-120000-dead'), { status: 404 });

    openDb(t, dir).run("UPDATE jobs SET state = 'active' WHERE id = ?", A);   // the worker took A
    await assert.rejects(async () => store.cancelPending(A), { status: 404 });
    assert.ok(openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', A), 'the active job must still exist');
});

// ---- setFlag / clearFlag ----

test('setFlag and clearFlag are idempotent and visible in settings', async (t) => {
    const { dir, store } = await freshStore(t);
    const db = openDb(t, dir);
    const flag = () => db.get('SELECT * FROM settings WHERE name = ?', 'hold');

    await store.setFlag('hold');
    await store.setFlag('hold');            // twice: no error
    assert.ok(flag(), 'hold should be set');

    await store.clearFlag('hold');
    await store.clearFlag('hold');          // twice: no error
    assert.equal(flag(), undefined);
});

test('flags other than pause and hold are rejected with 400', async (t) => {
    const { store } = await freshStore(t);
    await assert.rejects(async () => store.setFlag('../x'), { status: 400 });
    await assert.rejects(async () => store.clearFlag('nope'), { status: 400 });
    await store.setFlag('pause');           // the other allowed name
});

// ---- readQueue ----

test('readQueue on a fresh store is the empty shape', async (t) => {
    const { store } = await freshStore(t);
    assert.deepEqual(await store.readQueue(), { hold: false, active: null, pending: [], recent: [] });
});

test('readQueue reports the active job, the pending list and both flags', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    const db = openDb(t, dir);
    db.run("UPDATE jobs SET state = 'active', started = ? WHERE id = ?", '2026-11-11T10:00:00.000Z', A);
    await store.setFlag('hold');
    await store.setFlag('pause');

    assert.deepEqual(await store.readQueue(), {
        hold: true,
        active: { id: A, user: 'Dan', name: 'test.hpgl', preview: null, progress: null, paused: true },
        pending: [
            { id: B, user: 'Dan', name: 'test.hpgl', preview: null },
            { id: C, user: 'Dan', name: 'test.hpgl', preview: null },
        ],
        recent: [],
    });
});

test('readQueue: paused follows the pause flag; a set pause flag does not invent an active job', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A] = await threeJobs(store);
    const db = openDb(t, dir);

    await store.setFlag('pause');
    assert.equal((await store.readQueue()).active, null);        // nothing active yet

    db.run("UPDATE jobs SET state = 'active' WHERE id = ?", A);
    assert.equal((await store.readQueue()).active.paused, true);

    await store.clearFlag('pause');
    assert.equal((await store.readQueue()).active.paused, false);
    assert.equal((await store.readQueue()).hold, false);
});

test('readQueue: recent is the 10 newest finished jobs, newest first, in the contract shape', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);
    const db = openDb(t, dir);
    const states = ['done', 'failed', 'cancelled'];

    // 12 finished jobs with known finish times; job i finished at 10:i.
    const ids = [];
    for (let i = 0; i < 12; i++) {
        const { id } = await store.enqueue('Dan', print.id);
        ids.push(id);
        db.run('UPDATE jobs SET state = ?, finished = ? WHERE id = ?',
            states[i % 3], `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`, id);
    }

    const q = await store.readQueue();
    assert.deepEqual(q.pending, []);
    assert.equal(q.recent.length, 10);
    assert.deepEqual(q.recent.map((j) => j.id), ids.slice(2).reverse());   // 11, 10, ..., 2
    assert.deepEqual(q.recent[0], {
        id: ids[11], user: 'Dan', name: 'test.hpgl', state: states[11 % 3],
        finished: '2026-11-11T10:11:00.000Z',
    });
});

// ---- pruneFinished ----

// Enqueues n jobs for one print and marks each finished at 10:i (i = 0..n-1),
// cycling through done/failed/cancelled. Returns the ids in finish order.
async function finishedJobs(t, dir, store, n) {
    const print = await addPrint(store);
    const db = openDb(t, dir);
    const states = ['done', 'failed', 'cancelled'];
    const ids = [];
    for (let i = 0; i < n; i++) {
        const { id } = await store.enqueue('Dan', print.id);
        ids.push(id);
        db.run('UPDATE jobs SET state = ?, finished = ? WHERE id = ?',
            states[i % 3], `2026-11-11T10:${String(i).padStart(2, '0')}:00.000Z`, id);
    }
    return ids;
}

test('pruneFinished keeps the 50 newest finished jobs and returns how many it removed', async (t) => {
    const { dir, store } = await freshStore(t);
    const ids = await finishedJobs(t, dir, store, 55);

    assert.equal(await store.pruneFinished(), 5);

    const left = openDb(t, dir).all('SELECT id FROM jobs ORDER BY finished').map((r) => r.id);
    assert.deepEqual(left, ids.slice(5));          // the 5 oldest are gone
});

test('pruneFinished with a custom keep, and nothing to do the second time', async (t) => {
    const { dir, store } = await freshStore(t);
    await finishedJobs(t, dir, store, 12);

    assert.equal(await store.pruneFinished(10), 2);
    assert.equal(await store.pruneFinished(10), 0);   // already at 10: nothing removed
    assert.equal(openDb(t, dir).get('SELECT COUNT(*) AS n FROM jobs').n, 10);
});

test('pruneFinished never touches pending or active jobs', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);                 // three pending
    openDb(t, dir).run("UPDATE jobs SET state = 'active' WHERE id = ?", A);
    await finishedJobs(t, dir, store, 12);

    assert.equal(await store.pruneFinished(10), 2);
    assert.deepEqual(await order(store), [B, C]);              // pending untouched
    assert.ok(openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', A), 'active job still exists');
    assert.equal(openDb(t, dir).get('SELECT COUNT(*) AS n FROM jobs').n, 13);   // 10 finished + A, B, C
});

// ---- takeNext / finishJob / recoverInterrupted / plotPath (step 3) ----

test('takeNext returns null when there is nothing to start', async (t) => {
    const { store } = await freshStore(t);
    assert.equal(await store.takeNext(), null);                 // empty queue

    const [A] = await threeJobs(store);
    await store.setFlag('hold');
    assert.equal(await store.takeNext(), null);                 // hold is set
    await store.clearFlag('hold');

    const taken = await store.takeNext();                       // now A starts
    assert.equal(taken.id, A);
    assert.equal(await store.takeNext(), null);                 // one active at a time
});

test('takeNext claims the lowest-seq pending job and marks it active', async (t) => {
    const { dir, store } = await freshStore(t);
    const [A, B, C] = await threeJobs(store);
    await store.moveJob(C, 'top');                              // order is now C, A, B

    const job = await store.takeNext();
    assert.equal(job.id, C);
    assert.equal(job.state, 'active');
    assert.match(job.started, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(job.finished, null);

    const row = openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', C);
    assert.deepEqual(row, job);                                 // returned what was stored
    assert.deepEqual(await order(store), [A, B]);               // C is no longer pending
});

test('finishJob marks an active job done or failed', async (t) => {
    const { dir, store } = await freshStore(t);
    const db = openDb(t, dir);
    const [A, B] = await threeJobs(store);

    await store.takeNext();                                     // A
    await store.finishJob(A, { exitCode: 0 });
    const a = db.get('SELECT * FROM jobs WHERE id = ?', A);
    assert.equal(a.state, 'done');
    assert.equal(a.exitCode, 0);
    assert.equal(a.reason, null);
    assert.match(a.finished, /^\d{4}-\d{2}-\d{2}T/);

    await store.takeNext();                                     // B
    await store.finishJob(B, { exitCode: 1, reason: 'exit 1' });
    const b = db.get('SELECT * FROM jobs WHERE id = ?', B);
    assert.equal(b.state, 'failed');
    assert.equal(b.exitCode, 1);
    assert.equal(b.reason, 'exit 1');
});

test('finishJob rejects a job that is not active with 404', async (t) => {
    const { store } = await freshStore(t);
    const [A, , C] = await threeJobs(store);
    await assert.rejects(async () => store.finishJob(C, { exitCode: 0 }), { status: 404 });   // still pending
    await store.takeNext();
    await store.finishJob(A, { exitCode: 0 });
    await assert.rejects(async () => store.finishJob(A, { exitCode: 0 }), { status: 404 });   // already done
    await assert.rejects(async () => store.finishJob('20261110-120000-dead', { exitCode: 0 }), { status: 404 });
});

test('recoverInterrupted fails any active job with reason interrupted', async (t) => {
    const { dir, store } = await freshStore(t);
    assert.equal(await store.recoverInterrupted(), 0);          // clean store

    const [A, B] = await threeJobs(store);
    await store.takeNext();                                     // A is active, as if mid-plot
    assert.equal(await store.recoverInterrupted(), 1);

    const a = openDb(t, dir).get('SELECT * FROM jobs WHERE id = ?', A);
    assert.equal(a.state, 'failed');
    assert.equal(a.reason, 'interrupted');
    assert.match(a.finished, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await order(store), [B, (await order(store))[1]]);   // B still first in line
    assert.equal(await store.recoverInterrupted(), 0);          // nothing left to recover
});

test('plotPath points at the job\'s plot.hpgl, which exists', async (t) => {
    const { dir, store } = await freshStore(t);
    const print = await addPrint(store);
    const job = await store.enqueue('Dan', print.id);

    const file = store.plotPath(job);
    assert.equal(file, path.join(dir, 'users', 'Dan', 'prints', print.id, 'plot.hpgl'));
    assert.equal(await readFile(file, 'utf8'), SQUARE);
});
