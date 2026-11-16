# Step 4 tutor guide: read and control routes (`app.js`)

> **For Claude, reading this file:** you are Jess's tutor for this step, not
> the builder. Jess writes the routes in `app.js` by hand. Read "How to tutor"
> first, then the "Progress log" at the bottom to see where the last session
> stopped. `docs/handoff-step-4-routes.md` has the state of the project on
> 2026-11-16 (what runs on plotpi, known problems); the Step 2 and 3 guides
> have the full history of what Jess already understands.

---

## How to tutor

Same rules as Steps 2 and 3:

1. **Tests first.** The tutor writes `test/app.test.js` before Jess starts,
   says in a sentence what each case asserts, and reads failures with her.
   Jess types `app.js`.
2. **Don't write `app.js` for Jess.** Exception: she says "write this one for
   me" about a specific piece. Regex and string plumbing (the route pattern,
   query parsing) are the tutor's job and are offered ready-made below.
3. **Hint ladder:** question → concept → API name → pseudocode → ≤3-line snippet.
4. **Open each lesson by explaining, then asking.** Tiny examples that are
   not plotq code.
5. **Review like a kind senior engineer:** what's good, at most 2–3 issues.
6. **Explain-back** at the end of each lesson.
7. **Update only the Progress log** in this file.

### Things to know about Jess

- Comfortable now with: the store's whole API, errors with `status`,
  idempotence, `withLock` as a queue of callers, "await is the gap", the
  worker's tick/onExit split, policy vs mechanism (worker sets hold, a human
  clears it), env-var config.
- New in this step: `node:http` request handling beyond static files
  (method + path dispatch, query strings, status codes, CORS preflight),
  turning a thrown error into a response, testing a server with `fetch`
  against port 0, stubbing a collaborator (the worker) in tests.
- Slips to expect: forgetting `return` after `sendJson` (two responses →
  "headers already sent"); matching the path before the method; reading
  `searchParams` off `req.url` without the base URL; calling store functions
  outside `withLock`; catching the store's error and losing its `status`.

---

## Context

The kiosk on plotscreen (Step 5) is a web page. It can't call `store.js`; it
can only make HTTP requests to plotq on plotpi. Step 4 is that door:

```
kiosk page ──GET /queue.json──▶ app.js ──readQueue()──▶ store
           ──POST /queue/release─▶ app.js ──withLock(clearFlag('hold'))─▶ store
                                        └──wake()──▶ worker
```

`app.js` today serves `/health` and static files. It does not know the store
or the worker exist. After Step 4 it takes both as arguments.

Verified before this step (handoff doc): a real plot ran end to end on
plotpi through plotq with `PLOT_CMD=./plot-file.sh`. So the routes are the
only thing between "works from a scratch script" and "works from a button".

---

## What Step 4 must produce

### Routes (all in `app.js`)

| Route | Store call | Success |
|---|---|---|
| `GET /queue.json` | `readQueue()` | 200, the queue object |
| `POST /jobs/<id>/move?to=up\|down\|top` | `moveJob(id, to)` | 200 `{ ok: true }` |
| `POST /jobs/<id>/cancel` | `cancelPending(id)` | 200 `{ ok: true }` |
| `POST /queue/hold` | `setFlag('hold')` | 200 `{ ok: true }` |
| `POST /queue/release` | `clearFlag('hold')` then `worker.wake()` | 200 `{ ok: true }` |
| `OPTIONS` any path | none | 204 + `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: Content-Type` |

Rules:
- `createApp({ store, worker })`; `server.js` passes the real ones, tests pass
  a temp store and a stub worker `{ wake() {} }`.
- Every store call that changes the queue runs inside `store.withLock(...)`.
  `readQueue()` may run outside it (one synchronous read).
- A thrown error with a `status` becomes that status and `{ error: message }`.
  Anything else stays 500 `{ error: 'internal error' }` and is logged.
- Every response carries `Access-Control-Allow-Origin: *`. All bodies are JSON.
- Unknown `POST` paths are 404 `{ error: 'not found' }`. `POST` never falls
  through to static files.

`GET /queue.json` shape is fixed by `readQueue()`; do not reshape it here.

### Not in this step

Uploads (`POST /jobs`), pause/resume, cancelling the active job, the kiosk
page, the systemd unit.

### Done when

- `npm test` green (`test/app.test.js` has 21 cases).
- With `PLOT_CMD=test/fake-plot.sh DATA_DIR=/tmp/plotq-dev node server.js`
  running, these behave as the table says:

```sh
curl -s localhost:3001/queue.json
curl -s -X POST localhost:3001/queue/hold
curl -s -X POST localhost:3001/jobs/<id>/move?to=top
curl -s -X POST "localhost:3001/jobs/<id>/move?to=sideways"   # 400
curl -s -X POST localhost:3001/jobs/nope/cancel                # 404
curl -s -X POST localhost:3001/queue/release                   # plot starts at once
curl -s -i -X OPTIONS localhost:3001/queue/release              # 204
```

---

## Design decisions already made (explain the "why" to Jess)

- **Routes are thin.** Validation and state live in the store; a route maps
  URL → store call → status. If a route needs an `if` about queue state,
  something belongs in the store instead.
- **`{ ok: true }` on control routes, not the queue.** The kiosk polls
  `/queue.json` anyway; returning the queue from every POST would be a second
  contract to keep in sync.
- **`worker.wake()` after release, outside the lock.** `wake()` calls `tick()`,
  which takes the lock itself; calling it inside `withLock` would deadlock
  (the lock is not re-entrant, as in W3).
- **The store's error messages go straight to the client.** They're short and
  safe (`job not found`, `invalid position`). Status-less errors are hidden
  behind `internal error`.
- **Preflight is answered for every path.** Chromium sends `OPTIONS` before a
  cross-origin POST with a JSON body (Step 5's upload page). Answering it once
  at the top of `handle` is simpler than per-route.

## Decisions to let Jess make

- **Where the lock goes:** around each store call in the route (`withLock(() =>
  store.moveJob(id, to))`), or one `withLock` around the whole POST dispatch.
  *Recommend: per call. Shorter critical sections, and the GET stays lock-free.*
- **Match on the id pattern in the route or let the store's name check do it.**
  *Recommend: the route regex only accepts `[A-Za-z0-9_-]+`, so a bad id is a
  404 from the pattern, and the store's check is a second fence.*
- **One `console.log` per control POST?** The `finish` logger already prints
  method, URL and status; probably enough.

---

## Plumbing the tutor provides

Route pattern (regex is the tutor's job):

```js
const JOB_ROUTE = /^\/jobs\/([A-Za-z0-9_-]+)\/(move|cancel)$/;
// const m = JOB_ROUTE.exec(pathname);  m[1] = id, m[2] = 'move' | 'cancel', null if no match
```

Query string:

```js
const { pathname, searchParams } = new URL(req.url, 'http://localhost');
// searchParams.get('to')  → 'up' | 'down' | 'top' | null
```

Note: `moveJob(id, null)` already throws 400 `invalid position`, so a missing
`?to=` needs no extra check in the route.

---

## Lessons

### Lesson R0: Orientation (no code)

- **Explain:** the request lifecycle in `handle`: headers set, method + path
  read, one branch runs, exactly one response is sent. Why `return sendJson(...)`
  (one response per request). What CORS is and why the kiosk needs it even
  though both pages come from plotq (the upload page will be opened by phones
  via the tunnel; `*` is already there from Step 1). Preflight = the browser
  asking permission before a POST with a JSON body.
- **Ask (the handoff's opening question):** "A `POST /queue/release` arrives
  while the worker is inside `onExit` for a job that just finished and is
  about to call `setFlag('hold')`. What should the person who tapped Release
  see, and does `withLock` alone guarantee it?"
  (Answer to steer toward: `withLock` serialises them, so either release runs
  first and onExit sets hold afterwards, or onExit sets hold and release clears
  it. Both are consistent. But the *outcome* differs: in the first order the
  next job stays held, in the second it starts. The tap meant "I checked the
  paper for the job that's about to start", and the job that just finished
  used that paper, so the first order is the one the person wanted. There is
  no bug to fix here, but it's why Step 5's kiosk should disable Release while
  `active` is non-null. Policy lives in the UI; the lock only gives consistency.)
- **Ask:** "Why must `wake()` be called *after* `withLock` resolves, not inside?"
- **Checkpoint:** Jess can list the five routes and say which ones need the
  lock and why `GET /queue.json` doesn't.

### Lesson R1: `createApp({ store, worker })` and the error-to-status mapping

- **Tutor writes tests first:** the whole of `test/app.test.js` is written up
  front (21 cases). The 4 Step 1 cases now build a store on a temp dir and a
  stub worker; they pass as soon as `createApp` accepts the argument.
- **Build:** change the signature; thread `store` and `worker` into `handle`
  (closure or parameters, Jess's choice); in the `.catch`, answer with
  `err.status` and `{ error: err.message }` when `status` is a number, else
  the existing 500. `server.js` passes `{ store, worker }`.
- **Watch for:** `handle` is a module-level function today, so `store` isn't in
  scope; either move `handle` inside `createApp` or pass the deps along.
  Checking `err.status` truthiness vs `typeof err.status === 'number'`.

### Lesson R2: `GET /queue.json` and `OPTIONS`

- **Build:** the read route (before the static fallback), and the preflight
  answer near the top of `handle`.
- **Ask:** "Does `/queue.json` need `withLock`? What could a concurrent
  `moveJob` make it return?" (A consistent snapshot from one process; SQLite
  gives a consistent read per statement, and a mid-transaction state can't be
  seen because moveJob runs in BEGIN/COMMIT. Slightly stale is fine; the kiosk
  polls.)
- **Watch for:** `res.writeHead(204)` then `res.end()` with no body;
  `Content-Type` on a 204 is unnecessary.

### Lesson R3: the control routes

- **Build:** `POST /queue/hold`, `POST /queue/release`, then the two `/jobs/`
  routes using `JOB_ROUTE`. Each: `await store.withLock(() => store.x(...))`,
  then `sendJson(res, 200, { ok: true })`. Release calls `worker.wake()` after
  the lock.
- **Ask:** "Release is tapped twice quickly. What happens on the second
  request, in the store and in the worker?" (clearFlag idempotent; second
  `wake()` ticks, sees `running` or takes nothing: harmless.)
- **Watch for:** wake inside the lock; forgetting `await` on `withLock` (the
  200 goes out before the change lands, and an error becomes an unhandled
  rejection instead of a 400/404); dispatching `/jobs/...` by `startsWith`
  instead of the full pattern.

### Lesson R4: wiring, the "done when" run, wrap-up

- **Build:** `server.js` passes `{ store, worker }`. Run the curl list against
  the fake plotter; watch a release start a plot within a tick.
- **Explain-back:** the path of one tap on Release from finger to pen moving,
  naming every function on the way (kiosk fetch → handle → withLock →
  clearFlag → wake → tick → takeNext → spawn).
- **Commit:** `Add queue read and control routes (step 4)`.
- **Carry forward to Step 5:** the kiosk polls `/queue.json` every 1–2 s;
  disable Release while `active` is non-null; `preview` is always null for
  now.

---

## Progress log

- 2026-11-16, setup: tutor wrote this guide and the 21 tests in
  `test/app.test.js` (Step 1's 4 cases rewritten to build a temp store and a
  stub worker; 17 new: queue.json shape and ordering, move up/top, 400 for a
  bad or missing `to`, 404 for unknown job on move and cancel, cancel removes a
  pending job, hold sets, release clears + wakes exactly once (and still wakes
  when already clear), CORS/JSON on control responses, odd id → 4xx not 500,
  OPTIONS 204 with method/header lists, unknown POST 404, POST to a static
  path 404). Trimmed `plot-file.sh` to its three lines. Next: R0 with the
  handoff's opening question.

---

## Lesson R5 (added at Jess's request): the upload route, `POST /jobs`

Pulled forward from "after Step 4" because it replaces `send-test.js`.

- **Contract:** `POST /jobs`, JSON body `{ user, name, hpgl }`. Calls
  `createPrint({ user, name, sourceType: 'hpgl', source: hpgl, hpgl })`, then
  `enqueue(user, print.id)`, then `worker.wake()`. Replies `201 { id, printId }`.
  Errors: store 400s pass through; a body that isn't JSON → 400 `invalid json`;
  over 5 MB → 413 `too large`.
- **Explain:** `req` is a readable stream; the body arrives in chunks after the
  headers. `for await (const chunk of req)` collects them; count bytes as they
  come and stop at a limit (a client can lie in `Content-Length` or omit it).
  `JSON.parse` throws a `SyntaxError` with no `status`; the route turns it into
  a 400 so it doesn't become a 500.
- **Ask:** "`createPrint` writes files (slow, awaits) and `enqueue` is one
  transaction. Which of the two needs `withLock`, and what happens to the
  worker's tick if the lock is held across the file writes?" (createPrint
  claims its id with an atomic `mkdir` and needs no lock; `enqueue` goes under
  the lock like every other queue change. Holding the lock across the writes
  would only delay ticks by milliseconds, so either is defensible; recommend
  lock on `enqueue` only.)
- **Tutor writes tests first** (6 cases appended to `test/app.test.js`): 201
  with `id`/`printId`, job pending with name and user, `plot.hpgl` on disk
  equals the upload, wake once; same name twice → distinct prints, in order;
  missing hpgl → 400 from the store, nothing queued or woken; bad user → 400
  `invalid name`; non-JSON body → 400 `invalid json`; 5 MB + 1 → 413.
- **Plumbing offered:** a `readJson(req, limit)` helper (stream collection and
  the two error mappings) if Jess wants it ready-made; the route itself is hers.
- **Watch for:** `wake()` before `enqueue` has committed; calling `wake()` on
  the error path; parsing JSON inside the lock; forgetting that `source` and
  `hpgl` are the same string for HPGL uploads.
