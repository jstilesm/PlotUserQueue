# Step 3 tutor guide: the worker (`worker.js`)

> **For Claude, reading this file:** you are Jess's tutor for this step, not
> the builder. Jess writes `worker.js` and the new store functions by hand.
> Read "How to tutor" first, then the "Progress log" at the bottom to see where
> the last session stopped. Then start (or resume) the lessons in order.
> Step 2's guide (`step-2-store.md`) has the full history; its progress log
> ends with the decisions to carry into this step.

---

## How to tutor

Same rules as Step 2, with the working mode Jess asked for there:

1. **Tests first.** For each function, the tutor writes the `node:test` cases
   before Jess starts, explains in a sentence what each asserts, and reads the
   failures with her. Jess types the implementation.
2. **Don't write `worker.js` or the store functions for Jess.** Exception:
   Jess says "write this one for me" about a specific piece; write only that,
   and explain each line. Regex and string plumbing are the tutor's job
   (Jess's standing preference: spend the time on backend ideas).
3. **Hint ladder:** question → concept → API name → pseudocode → ≤3-line snippet.
   Go up one rung at a time.
4. **Open each lesson by explaining, then asking.** Tiny examples that are
   *not* plotq code. One or two of the lesson's questions before code.
5. **Review like a kind senior engineer:** what's good, at most 2–3 issues,
   as questions where possible, checked against "Watch for".
6. **Explain-back** at the end of each lesson. Correct gently and precisely;
   in Step 2 the explain-backs were where the real misunderstandings surfaced.
7. **Update only the Progress log** in this file. One entry per lesson, newest
   last, with what Jess got right, what needed correcting, and decisions made.

### Things to know about Jess

- Comfortable now with: `?` placeholders, `.get/.all/.run`, `changes`,
  `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`, idempotence, `withLock` as a queue of
  callers, "await is the gap", validate-first, errors with `status`.
- New in this step: `child_process.spawn`, process groups and signals, event
  emitters (`'exit'`, `'error'`), timers and a loop that must stop cleanly,
  writing a file descriptor into `spawn`'s `stdio`, testing asynchronous
  behaviour with polling helpers.
- Slips to expect: forgetting `await` on a promise-returning call; `return`
  inside a callback thinking it returns from the outer function; mixing up
  the child's `exit` code with an `error` event (command not found); leaving a
  `setInterval` running so the test process never exits.

---

## Context

plotq is one Node process on **plotpi**: pages, API and worker together.
`store.js` (Step 2) holds the queue in SQLite; files live under `DATA_DIR`.
The kiosk on **plotscreen** polls `/queue.json` and sends control POSTs.

The worker is the only code that:
- moves a job from `pending` to `active` and starts a plot;
- moves an `active` job to `done` or `failed`;
- sets `hold` after each job, so the checklist on the kiosk runs before the
  next plot starts (Jess's decision, Step 2).

It does **not** reimplement serial streaming: it spawns the existing
`plot_task.sh` (or `bin/plot`) on plotpi. On a laptop it spawns a fake script.

**Still unverified on plotpi** (from the brief's pre-step checklist): the exact
arguments and exit codes of `~/plotter-web/plot_task.sh` and `~/plotnet/bin/plot`,
and whether anything else (plotter-web's websocket on 8181) can be driving the
plotter at the same time. None of that blocks laptop development; all of it
blocks the first real plot. Lesson W6 is where it gets checked.

---

## What Step 3 must produce

### New store functions (in `store.js`)

```
takeNext()                → job | null
    inside BEGIN IMMEDIATE:
      if the hold flag is set            → null
      if any job is active               → null
      pick the pending job with the lowest seq (none → null)
      UPDATE it: state='active', started=now
      return the updated row

finishJob(id, { exitCode, reason })  → void
    UPDATE jobs SET state = (exitCode === 0 ? 'done' : 'failed'),
                    finished = now, exitCode = ?, reason = ?
    WHERE id = ? AND state = 'active'
    changes === 0 → 404 (not active)

recoverInterrupted()      → number of jobs recovered
    UPDATE jobs SET state='failed', finished=now, reason='interrupted'
    WHERE state='active'

plotPath(job)             → absolute path of the job's plot.hpgl
    p('users', job.user, 'prints', job.printID, 'plot.hpgl')
```

`takeNext` is the one place where "is hold set?", "is anything active?" and
"claim the first pending" must not interleave, which is why it is one
transaction and `IMMEDIATE`.

### `config.js` additions (from environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PLOT_CMD` | `~/plotter-web/plot_task.sh` | Command that plots one HPGL file |
| `PLOT_ARGS` | `{file}` | Space-separated args; `{file}` → absolute path of `plot.hpgl` |
| `CANCEL_CMD` | empty | Run after killing a plot (Step 6) |

### `worker.js`

```js
export function createWorker(store, { plotCmd, plotArgs, logDir, tickMs = 1000 })
  → { start(), stop(), wake(), current() }
```

- `start()`: run `recoverInterrupted()`, then tick every `tickMs`.
- `wake()`: run a tick now (the API calls this right after `enqueue`, Step 4).
- `tick()`: if a plot is already running, do nothing; else
  `takeNext()`; if a job came back, spawn the plot for it.
- Spawn: `spawn(plotCmd, args, { detached: true, stdio: ['ignore', log, log] })`
  where `log` is an open file descriptor for `logs/<job-id>.log`.
  `detached: true` gives the child its own process group, so Step 6 can
  pause or kill the whole group with `process.kill(-pid, signal)`.
- On `'exit'` (code, signal): `finishJob(id, { exitCode: code ?? 1, reason })`,
  then `setFlag('hold')`, then `pruneFinished()`, then clear the "running"
  state and tick again.
- On `'error'` (spawn itself failed, e.g. command not found): treat as a
  failed job with `reason: err.message`.
- `stop()`: clear the interval. Does **not** kill a running plot (the paper
  state would be unknown); Step 6 adds explicit cancel.
- `current()`: `{ id, pid, startedAt } | null`, for Step 6 and for tests.

Every store call the worker makes that spans an `await` goes inside
`store.withLock`. The synchronous ones (`takeNext`, `finishJob`) don't need it
on their own, but the *sequence* "finishJob → setFlag → prune" is safer as one
locked unit, because an API handler could otherwise interleave a
`clearFlag('hold')` between the finish and the set.

### `test/fake-plot.sh`

```sh
#!/bin/sh
# Pretends to plot: prints the file name, sleeps, exits with FAKE_PLOT_EXIT.
echo "plotting $1"
sleep "${FAKE_PLOT_SECONDS:-5}"
exit "${FAKE_PLOT_EXIT:-0}"
```

Tests use `FAKE_PLOT_SECONDS=0.2` so the suite stays fast.

### Logs

`logs/<job-id>.log` under `DATA_DIR` (add `'logs'` to `FOLDERS`). `pruneFinished`
may delete the matching log files later; not required in this step.

### Done when

With `PLOT_CMD=test/fake-plot.sh`: three queued prints plot **in order**, each
ending in `done`; a job with `FAKE_PLOT_EXIT=1` ends in `failed` with
`exitCode: 1`; after each job `hold` is set and nothing starts until it is
cleared; a job left `active` in the database when the worker starts is
`failed` with `reason: 'interrupted'`; `npm test` passes.

---

## Design decisions already made (explain the "why" to Jess)

- **Hold after every job.** The kiosk checklist (pen, paper, lid) runs before
  each plot. The worker sets `hold`; the kiosk's Release button clears it.
- **One running plot, tracked in memory.** The worker keeps `{ id, pid }` for
  the running child. It's the only process that spawns, so memory is the
  truth; the `active` row is the durable copy for the kiosk and for recovery.
- **Exit code decides done/failed.** `0` → done. Anything else, or a signal,
  → failed. Step 6 adds `cancelled` for jobs Jess stops on purpose.
- **Interrupted jobs are never restarted automatically.** Paper state unknown.
- **`detached: true` now, even though signals are Step 6.** Changing spawn
  options later would mean re-testing the whole worker.
- **Policy lives in the worker, mechanism in the store.** `takeNext` checks
  hold because that check must be atomic with the claim; but *setting* hold
  after a job is a policy decision and belongs in `worker.js`.

## Decisions to let Jess make

- Where logs live (`logs/<job-id>.log` is the proposal) and whether prune
  removes them.
- What `reason` says on a non-zero exit (`'exit 1'`? the last line of the log?).
- `tickMs` (1 s is the brief's number; the `wake()` path makes it matter less).
- Whether `finishJob` on an unknown/non-active id should throw (404) or be a
  no-op. The worker is the only caller, so either is defensible; say why.

---

## Lessons

### Lesson W0: Orientation (no code)

- **Explain:** what the worker is, with a non-plotq example: a print spooler,
  or a kitchen with one oven and a ticket rail. One cook (the worker) takes
  the lowest ticket, cooks it, hangs a "clean the oven" sign (hold), and
  waits for someone to take the sign down.
- **Ask Jess:**
  1. Which three things must the worker check *together* before starting a
     plot, and what goes wrong if they're checked one at a time?
  2. Why does the worker, not the API handler for `POST /jobs`, start the plot?
  3. If plotpi reboots mid-plot, what should the kiosk show a minute later?
- **Preview:** the function list above. Jess sketches `tick()` in plain
  English before any code.

### Lesson W1: `takeNext`, `finishJob`, `recoverInterrupted`, `plotPath`

- **Explain:** read-then-write in one transaction (already known from
  `enqueue`); `UPDATE ... RETURNING *` as a way to update and read in one
  statement (SQLite ≥ 3.35; Node 22 bundles a newer one); `LIMIT 1` with
  `ORDER BY seq`.
- **Ask:** "`takeNext` needs the lowest-seq pending job. You have
  `listPending()[0]`. Why might a dedicated query be better here?" (one row,
  and it runs inside the transaction).
- **Tutor writes tests first:**
  - `takeNext` returns null on an empty queue, with hold set, and when a job
    is already active; otherwise returns the lowest-seq job with
    `state: 'active'` and a `started` timestamp, and the row matches.
  - Two jobs: `takeNext()` twice → second call is null (one active at a time).
  - `finishJob(id, { exitCode: 0 })` → done; `{ exitCode: 1, reason: 'exit 1' }`
    → failed; on a pending id → 404 (or no-op, per Jess's decision).
  - `recoverInterrupted` → marks the active job failed/interrupted and returns 1;
    0 on a clean store.
  - `plotPath(job)` ends with `users/Dan/prints/<printID>/plot.hpgl` and the
    file exists.
- **Watch for:** checking hold *outside* the transaction; `BEGIN` instead of
  `BEGIN IMMEDIATE`; forgetting `ROLLBACK` in the catch; returning the
  pre-update row (no `started`) instead of re-reading or using `RETURNING`.

### Lesson W2: `spawn`, a child's lifecycle, and the fake plot script

- **Explain:** `child_process.spawn(cmd, args, opts)` returns a `ChildProcess`
  (an event emitter); `'exit'` gives `(code, signal)`, one of them null;
  `'error'` fires when the process couldn't start at all; `stdio` can take a
  file descriptor so output goes straight to a file; `detached: true` and
  process groups; `unref()` is *not* wanted here (we want to wait).
  Tiny example: spawn `sh -c 'exit 3'` and log the code.
- **Ask:** "What's the difference between a command that exits 1 and a command
  that doesn't exist? Which event tells you which?"
- **Build:** `test/fake-plot.sh` (tutor writes it; it's shell plumbing) and a
  10-line scratch script that spawns it and prints the exit code. Jess runs it
  with `FAKE_PLOT_EXIT=0` and `=1`, and with a wrong command name.
- **Checkpoint:** Jess can say, from the output, which event fired and why.
- **Watch for:** `exec` instead of `spawn` (buffers output, shell-quotes args);
  passing args as one string; forgetting `chmod +x`.

### Lesson W3: `worker.js`, the loop

- **Explain:** `setInterval` and why `stop()` must `clearInterval`
  (otherwise `node --test` hangs); re-entrancy: a tick that starts while the
  previous one is still awaiting (guard with a `running` flag or do the whole
  tick inside `withLock`); `wake()` as "tick now".
- **Ask:** "Two ticks run at once because `takeNext` happened to be slow.
  What's the worst thing that can happen? What stops it?" (In-process:
  `withLock`. Across processes: `BEGIN IMMEDIATE` in `takeNext`.)
- **Tutor writes tests first** (`test/worker.test.js`, with a `until(fn, ms)`
  polling helper and `FAKE_PLOT_SECONDS=0.2`):
  - three queued jobs → all `done`, in seq order, `started` of job 2 ≥
    `finished` of job 1.
  - `FAKE_PLOT_EXIT=1` → `failed`, `exitCode: 1`.
  - a nonexistent `plotCmd` → `failed` with a reason, and the worker keeps
    ticking (next job still runs with a good command).
  - `logs/<id>.log` contains `plotting <path>`.
  - `stop()` lets the test process exit (the test runner will tell you).
- **Build:** `createWorker` with `start/stop/wake/current` and `tick()`.
  Leave hold out of this lesson: tests here call `clearFlag('hold')` in the
  `until` loop, or the worker is built with hold-setting switched off until W4.
- **Watch for:** `spawn` outside the lock while `takeNext` is inside (fine,
  but Jess should be able to say why); `finishJob` called with `code` when
  the child was killed by a signal (`code` is null → use `?? 1`); closing the
  log fd in the wrong place (close after `'exit'`, not after spawn returns).

### Lesson W4: hold after each job, and startup recovery

- **Explain:** policy vs mechanism; why `setFlag('hold')` goes right after
  `finishJob` *inside the same locked unit*; why recovery runs before the
  first tick.
- **Ask:** "The kiosk's Release is pressed while a plot is still running
  (someone is impatient). What should happen? Does the current design do it?"
  (Hold is cleared; nothing starts because a job is active; the worker sets
  hold again when the job finishes. That's correct, and worth noticing that it
  falls out of the design rather than needing code.)
- **Tutor writes tests first:**
  - after job 1 finishes, `hold` is set and job 2 is still pending 3 ticks
    later; `clearFlag('hold')` → job 2 starts.
  - a store with a hand-made `active` row → after `start()`, it is `failed`
    with `reason: 'interrupted'`, and the next pending job runs.
- **Watch for:** setting hold *before* `finishJob` (kiosk would briefly show
  hold with an active job: harmless but confusing); recovery after the first
  tick (the tick would see "something active" and never start).

### Lesson W5: wiring and the "done when" run

- **Build:** `config.js` gains `PLOT_CMD`, `PLOT_ARGS`, `CANCEL_CMD` (with
  `{file}` substitution done in one small function; tutor may write the
  split/replace). `app.js`/`server.js` create the worker and call `start()`
  on boot and `stop()` on `SIGINT`/`SIGTERM`. `FOLDERS` gains `'logs'`.
- **Checkpoint:** the "Done when" list above, run by hand with
  `PLOT_CMD=test/fake-plot.sh npm start` and a scratch script that calls
  `createPrint` + `enqueue` three times (there's no upload route yet; that's
  Step 7). Jess watches `readQueue()` change and the hold banner logic in the
  database.
- **Watch for:** the worker started twice (once in app.js, once in a test
  import); `process.on('SIGINT')` that calls `stop()` but never `process.exit`.

### Lesson W6: plotpi reality check (read-only, no code)

Before the first real plot. Jess runs these on plotpi and reports back; the
tutor helps interpret:

- `cat ~/plotter-web/plot_task.sh` and `~/plotnet/bin/plot`: arguments,
  exit codes, serial device, whether they print progress.
- Does anything else talk to the serial port while plotq is plotting
  (plotter-web's websocket on 8181)? If yes, decide with Jess how the two
  avoid each other. Options: plotq's worker is the only starter and the
  websocket program checks `/queue.json` for `active` before it sends; or
  a file lock on the serial device; or plotter-web is retired. This decision
  is **not** the tutor's to make.
- `node -v` (must be ≥ 22.13), `free -h`.
- Confirm `cloudflared` does not route to 3001.

Then set `PLOT_CMD`/`PLOT_ARGS` for real, plot one tiny HPGL with hold set so
nothing else can follow, and watch the log.

### Lesson W7: Wrap-up

1. `npm test` green; read `worker.js` top to bottom together.
2. Jess explains, without looking:
   - what `takeNext` guarantees and how (`IMMEDIATE`, one statement per check);
   - the life of one job from `enqueue` to `done`, naming which code runs
     each transition;
   - why `stop()` doesn't kill the plot.
3. Preview Step 4 (routes): every control route is `withLock(() => store.x())`
   plus `worker.wake()` after enqueue; Step 6 adds pause/cancel using
   `worker.current().pid` and `process.kill(-pid, ...)`.
4. Commit: `Add worker that runs plots from the queue (step 3)`.

---

## Progress log

Tutor: add one line per completed lesson. Newest last.

- 2026-11-12: guide drafted after Step 2 wrap-up, reconciled with the SQLite,
  Node 22, HPGL-only and `preview: null` decisions. Not started.
- 2026-11-12, Lesson W0: done. Jess's answers: (1) right principle (independent requests can change between checks); tutor supplied the two concrete races (double claim; hold tapped between check and claim). (2) said "needs the frontend"; corrected to ownership: handler can't know the plotter is busy, jobs queued mid-plot need something to start them later, boot recovery has no request. (3) described the stuck-active bug; corrected to recoverInterrupted → failed/interrupted. **Decision (Jess): recovery also sets `hold`** so the checklist runs before anything starts after a crash; the interrupted job is not re-queued (re-plot from the library, Step 7). tick() sketch: good order (takeNext→spawn, finishJob→prune) but had setFlag after spawn and treated "after the print completes" as the next line; introduced the tick()/onExit() split (spawn returns immediately; finish lives in the 'exit' handler) — reinforce in W2/W3. The "is the websocket inactive?" check she proposed is the W6 arbitration question.
- 2026-11-12, Lesson W1: done, 38/38. Tutor wrote 6 tests; Jess wrote takeNext (BEGIN IMMEDIATE; hold + active + `LIMIT 1` + `UPDATE ... RETURNING *` inside; single COMMIT via a `result` variable), finishJob (ternary state, `reason ?? null`, `changes === 0 → 404`; Jess kept the 404 option), recoverInterrupted (`SET state='failed', finished, reason='interrupted' WHERE state='active'`), plotPath. Fixes on the way: prepared statements not assigned; `.run` argument order (`exitCode`/`reason` swapped — "placeholders know order, not names"); null-prototype row vs plain object in deepStrictEqual → `{ ...row }` at the store boundary (explained why node:sqlite does that); recoverInterrupted first had `reason='interrupted'` in WHERE and set state to `pending` (corrected: SET, and failed per W0). Explain-back came as Jess's own Obsidian notes (accurate; tutor formatted them). Note: `takeNext`'s "lowest pending" uses a dedicated `LIMIT 1` query inside the transaction rather than `listPending()[0]`.
- 2026-11-13, Lesson W2: done. Tutor wrote test/fake-plot.sh. Jess asked "what if the plotter powers off" → distinguished plotpi off (W0 recovery) from plotter off (child errors out → failed, or *hangs* on serial flow control → stuck active; neither event fires). **Open decision for Jess: a per-plot timeout** (kill the group, reason 'timeout'), natural home is Step 6 with cancel; W6 should check what bin/plot does when the plotter stops responding. Jess understood exit-vs-error without the exercise, so the tutor ran the 7-line spawn demo (exit 0, exit 1, ENOENT with pid undefined) and she read the output.
- 2026-11-13, Lesson W3: done, 43/43. Jess felt lost at the start ("far off from writing the code myself"); tutor re-scaffolded into four milestones (tiny functions → tick → onExit → read-through) with the file as a 6-function map, which worked. Jess wrote worker.js: tick inside withLock (claim → remember `running` before the first await → open log 'a' → spawn detached with fd stdio → handlers), onExit (result from err/code/signal → close log → locked finishJob/setFlag('hold')/prune/running=null → tick), start (recover → hold if any → mkdir logs → tick → setInterval), stop/wake/current. Fixes: `.log` outside the template string (twice), `plotPath.job()`, spawned with `plotArgs` not `args`, `stop(timer)` parameter shadowing then `clearInterval()` with no arg (hung the runner), err result overwritten (missing else), withLock not awaited in onExit, stray `node:console` import. Concepts: lock covers claim→spawn (ms), not the plot; tick/onExit are two halves separated by the event loop ("tick looks around, the plotter rings a bell"); memory vs DB agreement is what the lock protects (Step 6 cancel reads current()). Test 5 originally ended mid-plot → "asynchronous activity after the test ended… readonly database"; tutor fixed the test to wait for the plot. Hold-after-job and hold-after-recovery were built in W3 already.
- 2026-11-13, Lesson W4: done, 45/45. Both tests (hold set after each job and nothing starts until cleared; active-at-start → failed/interrupted + hold, next job runs after release) passed first run, since Jess built both behaviours in W3. Next: W5 wiring (config.js PLOT_CMD/PLOT_ARGS/CANCEL_CMD; server.js creates store + worker, start() on boot, stop() on SIGINT/SIGTERM; FOLDERS gains 'logs' or worker's mkdir stays), then W6 plotpi check, W7 wrap-up.
