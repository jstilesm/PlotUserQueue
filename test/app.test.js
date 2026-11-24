import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../app.js';
import { createStore } from '../store.js';

const SQUARE = 'IN;SP1;PU0,0;PD1000,0,1000,1000,0,1000,0,0;PU;SP0;';

// One server for the whole file, on a fresh temp DATA_DIR. The worker is a
// stub: routes only need wake(), and the tests count how often it's called.
let dir, store, server, base;
let woke = 0;
let running = null;                         // what the stub's current() reports
const calls = [];                           // cancel/pause/resume calls the routes made
const notFound = () => Object.assign(new Error('job not found'), { status: 404 });
const nothing = () => Object.assign(new Error('nothing plotting'), { status: 409 });
const worker = {
  wake() { woke++; },
  current() { return running; },
  async cancel(id) { calls.push(['cancel', id]); if (running?.id !== id) throw notFound(); },
  async pause() { calls.push(['pause']); if (!running) throw nothing(); },
  async resume() { calls.push(['resume']); if (!running) throw nothing(); },
};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'plotq-app-'));
  store = await createStore(dir);
  server = createApp({ store, worker });
  await new Promise(resolve => server.listen(0, resolve)); // port 0 = any free port
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

// Queues n jobs of one print and returns their ids, in seq order.
async function queue(n) {
  const print = await store.createPrint({ user: 'Dan', name: 'sq.hpgl', sourceType: 'hpgl', source: SQUARE, hpgl: SQUARE });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(store.enqueue('Dan', print.id).id);
  return ids;
}

const post = (p) => fetch(`${base}${p}`, { method: 'POST' });
const pendingIds = () => store.listPending().map(j => j.id);

// Clean slate between tests: no jobs, no flags.
async function reset() {
  for (const id of pendingIds()) store.cancelPending(id);
  store.clearFlag('hold');
  woke = 0;
  running = null;
  calls.length = 0;
}

// ---- Step 1 (unchanged behaviour) ----

test('GET /health returns ok with CORS header', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { ok: true });
});

test('serves a file from public/ with its content type', async () => {
  const r = await fetch(`${base}/hello.html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
});

test('missing file is a JSON 404, still with CORS', async () => {
  const r = await fetch(`${base}/nope.html`);
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { error: 'not found' });
});

test('encoded ../ cannot escape public/', async () => {
  const r = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(r.status, 403);
});

test('a .ts file from public/ is served as JavaScript with its types removed', async () => {
  const r = await fetch(`${base}/hello.ts`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/javascript/);
  const body = await r.text();
  assert.doesNotMatch(body, /: string/, 'type annotations must be gone');
  assert.match(body, /export const greeting/);

  // The browser must be able to run it: load it as a module and call it.
  const mod = await import(`data:text/javascript,${encodeURIComponent(body)}`);
  assert.equal(mod.shout('hi'), 'HI');
});

test('a missing .ts file is still a JSON 404', async () => {
  const r = await fetch(`${base}/nope.ts`);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not found' });
});

// ---- Step 4: read route ----

test('GET /queue.json on an empty queue has the kiosk shape', async () => {
  await reset();
  const r = await fetch(`${base}/queue.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { hold: false, active: null, pending: [], recent: [] });
});

test('GET /queue.json lists queued jobs in order with only the kiosk fields', async () => {
  await reset();
  const [a, b] = await queue(2);
  const q = await (await fetch(`${base}/queue.json`)).json();
  assert.deepEqual(q.pending.map(j => j.id), [a, b]);
  assert.deepEqual(Object.keys(q.pending[0]).sort(), ['id', 'name', 'preview', 'user']);
  assert.equal(q.pending[0].user, 'Dan');
});

// ---- Step 4: control routes ----

test('POST /jobs/<id>/move?to=up reorders the queue', async () => {
  await reset();
  const [a, b, c] = await queue(3);
  const r = await post(`/jobs/${c}/move?to=up`);
  assert.equal(r.status, 200);
  assert.deepEqual(pendingIds(), [a, c, b]);
});

test('POST /jobs/<id>/move?to=top goes to the front', async () => {
  await reset();
  const [a, b, c] = await queue(3);
  assert.equal((await post(`/jobs/${c}/move?to=top`)).status, 200);
  assert.deepEqual(pendingIds(), [c, a, b]);
});

test('move with a bad direction is a 400 from the store, as JSON', async () => {
  await reset();
  const [a] = await queue(1);
  const r = await post(`/jobs/${a}/move?to=sideways`);
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { error: 'invalid position' });
});

test('move with no ?to= at all is also a 400', async () => {
  await reset();
  const [a] = await queue(1);
  assert.equal((await post(`/jobs/${a}/move`)).status, 400);
});

test('move of an unknown job is a 404 with the store message', async () => {
  await reset();
  const r = await post('/jobs/nope/move?to=up');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'job not found' });
});

test('POST /jobs/<id>/cancel removes a pending job', async () => {
  await reset();
  const [a, b] = await queue(2);
  const r = await post(`/jobs/${a}/cancel`);
  assert.equal(r.status, 200);
  assert.deepEqual(pendingIds(), [b]);
});

test('cancel of an unknown job is a 404', async () => {
  await reset();
  const r = await post('/jobs/nope/cancel');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'job not found' });
});

test('POST /queue/hold sets hold; /queue.json shows it', async () => {
  await reset();
  assert.equal((await post('/queue/hold')).status, 200);
  assert.equal((await (await fetch(`${base}/queue.json`)).json()).hold, true);
  assert.equal((await post('/queue/hold')).status, 200, 'hold twice is fine');
});

test('POST /queue/release clears hold and wakes the worker once', async () => {
  await reset();
  store.setFlag('hold');
  const r = await post('/queue/release');
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${base}/queue.json`)).json()).hold, false);
  assert.equal(woke, 1, 'worker.wake() should be called exactly once');
});

test('release when hold is already clear is still a 200 and still wakes', async () => {
  await reset();
  assert.equal((await post('/queue/release')).status, 200);
  assert.equal(woke, 1);
});

test('control routes answer with CORS and JSON on success', async () => {
  await reset();
  const r = await post('/queue/hold');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await r.json(), { ok: true });
});

test('a job id with odd characters never reaches the store', async () => {
  await reset();
  // "..%2f" style tricks are for the static route; here the id just has to
  // fail the name rule and come back as a 4xx, not a 500.
  const r = await post('/jobs/a%20b/cancel');
  assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
});

// ---- Step 4: preflight and unknowns ----

test('OPTIONS on any path is a 204 preflight with the CORS method/header lists', async () => {
  const r = await fetch(`${base}/queue/release`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-methods'), 'GET, POST');
  assert.equal(r.headers.get('access-control-allow-headers'), 'Content-Type');
});

test('an unknown POST path is a JSON 404', async () => {
  const r = await post('/queue/launch');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'not found' });
});

test('POST to a GET-only path is a 404, not a static file', async () => {
  const r = await post('/hello.html');
  assert.equal(r.status, 404);
});

// ---- Step 4b: upload route ----
// POST /jobs with a JSON body { user, name, hpgl }: createPrint, enqueue, wake.
// Replies 201 { id: <job id>, printId }.


const upload = (body, raw = false) => fetch(`${base}/jobs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: raw ? body : JSON.stringify(body),
});

test('POST /jobs creates the print, queues a job, wakes the worker, answers 201', async () => {
  await reset();
  const r = await upload({ user: 'Dan', name: 'spiral.hpgl', hpgl: SQUARE });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.match(body.id, /^\d{8}-/);
  assert.match(body.printId, /spiral/);
  assert.equal(woke, 1, 'wake() once');

  const q = await (await fetch(`${base}/queue.json`)).json();
  assert.deepEqual(q.pending.map(j => [j.id, j.name, j.user]), [[body.id, 'spiral.hpgl', 'Dan']]);

  const job = store.listPending()[0];
  assert.equal(await readFile(store.plotPath(job), 'utf8'), SQUARE, 'plot.hpgl is the uploaded HPGL');
  const sourcePath = path.join(path.dirname(store.plotPath(job)), 'source.hpgl');
  assert.equal(await readFile(sourcePath, 'utf8'), SQUARE, 'source.hpgl is the uploaded HPGL too');
});

test('two uploads with the same name get distinct prints and queue in order', async () => {
  await reset();
  const a = await (await upload({ user: 'Dan', name: 'same.hpgl', hpgl: SQUARE })).json();
  const b = await (await upload({ user: 'Dan', name: 'same.hpgl', hpgl: SQUARE })).json();
  assert.notEqual(a.printId, b.printId);
  assert.deepEqual(pendingIds(), [a.id, b.id]);
});

test('upload without hpgl is a 400 from the store and nothing is queued or woken', async () => {
  await reset();
  const r = await upload({ user: 'Dan', name: 'x.hpgl' });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid name or hpgl' });
  assert.deepEqual(pendingIds(), []);
  assert.equal(woke, 0);
});

test('upload with a bad user name is a 400', async () => {
  await reset();
  const r = await upload({ user: 'a b', name: 'x.hpgl', hpgl: SQUARE });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid name' });
});

test('a body that is not JSON is a 400, not a 500', async () => {
  await reset();
  const r = await upload('{not json', true);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'invalid json' });
});

test('a body over the size limit is a 413', async () => {
  await reset();
  const huge = 'x'.repeat(5 * 1024 * 1024 + 1);          // one byte over 5 MB
  const r = await upload({ user: 'Dan', name: 'big.hpgl', hpgl: huge });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { error: 'too large' });
  assert.deepEqual(pendingIds(), []);
});

// ---- Step 6: control of the running job ----
// The worker owns the running process; routes only decide who to ask.

test('POST /jobs/<id>/cancel for the running job goes to the worker, not the store', async () => {
  await reset();
  const [a] = await queue(1);
  running = { id: 'running-1', pid: 1, startedAt: '', paused: false };
  const r = await post('/jobs/running-1/cancel');
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [['cancel', 'running-1']]);
  assert.deepEqual(pendingIds(), [a], 'the pending job is untouched');
});

test('cancel of a pending job still goes to the store, even while another job is running', async () => {
  await reset();
  const [a] = await queue(1);
  running = { id: 'running-1', pid: 1, startedAt: '', paused: false };
  const r = await post(`/jobs/${a}/cancel`);
  assert.equal(r.status, 200);
  assert.deepEqual(calls, []);
  assert.deepEqual(pendingIds(), []);
});

test('POST /queue/pause and /queue/resume ask the worker', async () => {
  await reset();
  running = { id: 'running-1', pid: 1, startedAt: '', paused: false };
  assert.equal((await post('/queue/pause')).status, 200);
  assert.equal((await post('/queue/resume')).status, 200);
  assert.deepEqual(calls, [['pause'], ['resume']]);
});

test('pause with nothing plotting is the worker\'s 409, as JSON', async () => {
  await reset();
  const r = await post('/queue/pause');
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'nothing plotting' });
});
