import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const FOLDERS = ['users'];

// HELPERS

// takes name and generates a safe filename for prints
function slugify(name) {
    const slug = path.parse(name).name
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '')
    return slug || 'print'
}

// Pads string with 0 if it is length 1
const pad = (n) => String(n).padStart(2, '0');

// Makes a UTC Stamp
function utcStamp() {
     const date = new Date();
        const utc = 
        pad(date.getUTCFullYear()) + 
        pad(date.getUTCMonth() + 1) + 
        pad(date.getUTCDate()) + "-" + 
        pad(date.getUTCHours()) +
        pad(date.getUTCMinutes()) +
        pad(date.getUTCSeconds())
        return utc
}

function error(message, code) {
    throw Object.assign(new Error(message), {status: code});
}
export async function createStore(dataDir) {


     for (const folder of FOLDERS) {
        await mkdir(p(folder), {recursive: true})
    }
    const db = new DatabaseSync(p('plotq.db'))
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(`
        CREATE TABLE IF NOT EXISTS prints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            user TEXT NOT NULL,
            created TEXT NOT NULL,
            sourceType TEXT NOT NULL)`)
    db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            user TEXT NOT NULL,
            state TEXT NOT NULL,
            seq INTEGER NOT NULL,
            submitted TEXT NOT NULL,
            started TEXT,
            finished TEXT,
            exitCode INTEGER,
            reason TEXT,
            printID TEXT NOT NULL,
            CONSTRAINT print_id
                FOREIGN KEY (printID)
                REFERENCES prints(id) )`)
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`)

    // build paths 
    function p(...parts) {
        return path.join(dataDir, ...parts)
    }

    function checkName(name) {
        if (typeof name !== 'string' || !(/^[A-Za-z0-9_-]+$/).test(name)) {
            error('invalid name', 400)
        }
    }

    function makeJobId() {
        return utcStamp() + "-" + randomBytes(2).toString('hex')   
    }

    function cancelPending(id) {
        const cancel = db.prepare('DELETE FROM jobs WHERE id = ? AND state = ?').run(id, 'pending')
        if (cancel.changes === 0) {
            error('job not found', 404);
        }
    }
    function listPending() {
        return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER by seq').all('pending')
    }
    function swapJob(job, neighbor) {
        if (neighbor === undefined) {
            return
        }
        db.prepare('UPDATE jobs SET seq = ? WHERE id = ?').run(neighbor.seq, job.id)
        db.prepare('UPDATE jobs SET seq = ? WHERE id = ?').run(job.seq, neighbor.id)
    }
    function moveJob(id, to) {
        if (to !== 'top' && to !== 'up' && to !== 'down') {
            error('invalid position', 400)
        }
        let pending = listPending()
        let index = pending.findIndex(job => job.id === id);

        if (index < 0) {
            error('job isnt pending', 404)
        }
        let job = pending[index]
        let neighbor
        db.exec('BEGIN IMMEDIATE')
        try {
            if (to === 'up') {
                neighbor = pending[index - 1]
                swapJob(job, neighbor)

            } else if (to === 'down') {
                neighbor = pending[index + 1]
                swapJob(job, neighbor)
            } else {
                while (index !== 0) {
                    neighbor = pending[index - 1]
                    swapJob(job, neighbor)
                    
                    // reset to continue the chain
                    pending = listPending()
                    index = pending.findIndex(job => job.id === id)
                    job = pending[index]
                    
                }
            }
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            throw err
        }

    }

    function setFlag(name) {
        if (name !== 'pause' && name !== 'hold') {
            error('invalid query', 400)
        }
        db.prepare('INSERT OR REPLACE INTO settings (name, value) VALUES (?,?)').run(name, '1')
    }
    function clearFlag(name) {
        if (name !== 'pause' && name !== 'hold') {
            error('invalid query', 400)
        }
        db.prepare('DELETE FROM settings WHERE name = ?').run(name)
    }

    // provides sequencing for the queue
    function nextSeq() {
        return db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next from jobs').get().next
    }
    function enqueue(user, printId) {
        checkName(user)
        checkName(printId)

        const selection = db.prepare('SELECT name FROM prints WHERE id = ?').get(printId)
        if (selection === undefined) {
            error('print not found', 404)
        }
        const id = makeJobId();
        let job;
        db.exec('BEGIN IMMEDIATE')
        try {
            const seq = nextSeq();
            const created = new Date().toISOString()
            job = { id, name: selection.name, user, state:'pending',seq: seq, submitted: created, started: null, finished: null, exitCode: null, reason: null, printID: printId}
            const insert = db.prepare('INSERT INTO jobs (id, name, user, state, seq, submitted, started, finished, exitCode, reason, printID) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            insert.run(job.id, job.name, job.user, job.state, job.seq, job.submitted, null, null, null, null, job.printID)
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            throw err
        }

        return job
    } 
    function readQueue() {
        const settings = db.prepare('SELECT name FROM settings WHERE name = ?'); 

        const row = db.prepare('SELECT * FROM jobs WHERE state = ?').get('active');

        const active = row ? {id: row.id, name: row.name, user: row.user, preview: null, progress: null, paused: settings.get('pause') !== undefined} : null;

        const pending = listPending().map(job => ({
            id: job.id,
            name: job.name,
            user: job.user,
            preview: null,
        }));

        const hold = settings.get('hold') !== undefined;

        const recent = db.prepare('SELECT * FROM jobs WHERE state IN (?,?,?) ORDER BY finished DESC LIMIT 10').all('done','failed','cancelled').map(job => ({
            id: job.id,
            name: job.name,
            user: job.user,
            state: job.state,
            finished: job.finished,
        }));

        return {
           hold, active, pending, recent
        }
    }

    function pruneFinished(keep = 50) {
        return db.prepare(`DELETE FROM jobs WHERE state IN ('done', 'failed', 'cancelled') AND id NOT IN (
      SELECT id FROM jobs
      WHERE state IN ('done', 'failed', 'cancelled')
      ORDER BY finished DESC
      LIMIT ?
    )`).run(keep).changes
    }

    async function createPrint({name, user, sourceType, source, hpgl}) {
        checkName(user)
        if (typeof hpgl !== 'string' || typeof source !== 'string' || !hpgl || !source) {
            error('invalid name or hpgl', 400)
        }
        if (sourceType !==  "hpgl") {
            error('invalid file format', 400)
        }
        await mkdir(p('users', user, 'prints'), {recursive: true})
        const base = utcStamp().slice(0,13) + "-" + slugify(name);

        let id;
        let directory;
        for (let n = 1; ; n++) {
            id = n === 1 ? base : `${base}-${n}`;
            try {
                directory = p('users', user, 'prints', id)
                await mkdir(directory)
                break
            } catch(err) {
                if (err.code === 'EEXIST') {
                    continue
                } else throw err;
            }
        }
        const created = new Date().toISOString()
        await writeFile(path.join(directory, 'source.hpgl'), source)
        await writeFile(path.join(directory, 'plot.hpgl'), hpgl)
        const insert = db.prepare('INSERT INTO prints (id, name, user, created, sourceType) VALUES (?,?,?,?,?)')
        insert.run(id ,name, user, created, sourceType)
        
        return { id , name, user, created, sourceType }
    }

    let last = Promise.resolve();

    function withLock(fn) {
        const run = last.then(fn)
        last = run.catch(() => {})
        return run
    }
    return { withLock, createPrint, pruneFinished, enqueue, readQueue, moveJob, listPending, cancelPending, setFlag, clearFlag }
}


