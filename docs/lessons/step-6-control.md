# Step 6 tutor guide: cancel, pause/resume and a per-plot timeout

> **For Claude, reading this file:** you are Jess's tutor for this step, not
> the builder. Jess writes the worker and store changes and the routes by hand.
> Read "How to tutor" in `step-3-worker.md`, then the "Progress log" at the
> bottom of this file. Step 5 (the kiosk page) was deliberately skipped in
> favour of this step, because the plotter is live and the only way to stop a
> plot is `pkill` from a shell.

---

## How to tutor

Same rules as Steps 2–4: tests first (already written, see below), Jess types
the code, hint ladder, explain-back, update only the Progress log here.

### Things to know about Jess

- Comfortable now with: the whole store API, `withLock` and why `wake()` is
  called outside it, tick/onExit, `spawn` with `detached: true`, errors with
  `status` flowing out of `handle` into one catch, request bodies as streams.
- New in this step: Unix signals (`SIGTERM`, `SIGKILL`, `SIGSTOP`, `SIGCONT`),
  process groups and the negative pid, `setTimeout`/`clearTimeout` racing an
  `'exit'` event, the difference between "I sent the signal" and "the process
  is gone", and what a stopped process does with signals it receives.
- Slips to expect: `process.kill(pid)` instead of `process.kill(-pid)` (kills
  `sh` but not the `sleep` or the serial feeder it started); `SIGTERM` to a
  stopped process (nothing happens until `SIGCONT`); forgetting to
  `clearTimeout` in `onExit` (a done job gets "killed" later, or the test
  runner hangs); deciding state from `signal` in `onExit` instead of from what
  the worker *asked for* (a timeout and a cancel both arrive as `SIGTERM`).

---

## Context

Today a running plot can only be stopped from a shell. The worker started it
in its own process group (`detached: true`) precisely so that this step can
signal the whole group with one call:

```js
process.kill(-pid, 'SIGTERM');   // minus sign: the group, not just the shell script
```

On plotpi the group is `plot-file.sh` → `itsaliveplot` → whatever it forks.
Killing the feed stops new commands reaching the plotter, but the plotter
keeps drawing what is already in its buffer and may stop with the pen down.
`CANCEL_CMD` exists for that: a program plotq runs *after* the feed is dead,
to put the plotter in a safe state (pen up, buffer cleared). What it should
send is Jess's decision (see below); the worker only runs it and logs it.

Pause is `SIGSTOP` to the group: the feeder freezes mid-stream, the plotter
drains its buffer and stops. Resume is `SIGCONT`. Nothing is re-sent, so the
drawing continues where it was.

The timeout is a clock started at spawn: if the plot is still running when
it fires, the worker kills it exactly like a cancel, but records `failed`
with reason `timeout`.

---

## What Step 6 must produce

### Store (one change)

- `finishJob(id, { exitCode, reason, state })`: `state` is optional; when
  given it is stored as-is (`'cancelled'`), otherwise derived from `exitCode`
  as today. `exitCode` may be `null`.

### Worker

`createWorker(store, { plotCmd, plotArgs, logDir, tickMs, cancelCmd, plotTimeoutMs })`

- `cancelCmd`: `''`/undefined = none. Otherwise a program run with no
  arguments after the plot process has exited, stdout/stderr appended to the
  same job log, awaited before `finishJob`.
- `plotTimeoutMs`: `0`/undefined = no timeout.

New functions, all returning promises, all taking the lock:

- `cancel(id)`: 404 unless `id` is the running job. Marks the running job as
  cancelled in memory, sends `SIGCONT` then `SIGTERM` to the group, resolves
  once the signals are sent (not when the job is gone; the kiosk polls). If
  the process is still alive 2 s later, `SIGKILL`. `onExit` then records
  `state: 'cancelled', reason: 'cancelled'`, runs `cancelCmd`, sets hold,
  clears `pause`.
- `pause()`: 409 (`nothing plotting`) if nothing is running. `SIGSTOP` the
  group, `running.paused = true`, `setFlag('pause')`, stop the timeout clock.
- `resume()`: 409 if nothing is running; no-op if not paused. `SIGCONT`,
  `running.paused = false`, `clearFlag('pause')`, restart the timeout clock
  with a fresh budget.
- `current()` gains `paused: boolean`.
- `start()` clears a stale `pause` flag (the process it referred to is gone).
- Timeout: timer set at spawn when `plotTimeoutMs > 0`; on fire, the same
  kill sequence as cancel but `onExit` records `failed` / `timeout`.
- `stop()` also clears any timeout timer (or `node --test` never exits).

The worker decides the final state from **what it asked for** (`running.ending
= 'cancelled' | 'timeout' | null`), not from the signal the child reports,
because both arrive as `SIGTERM`.

### Routes

| Route | Does | Success |
|---|---|---|
| `POST /jobs/<id>/cancel` | if `worker.current()?.id === id` → `worker.cancel(id)`; else `withLock(cancelPending(id))` | 200 |
| `POST /queue/pause` | `worker.pause()` | 200 |
| `POST /queue/resume` | `worker.resume()` | 200 |

The worker's 404/409 errors carry `status`, so the existing catch maps them.

### Config

- `CANCEL_CMD` (exists, default `''`) → `cancelCmd`.
- `PLOT_TIMEOUT_MIN` (new, default `30`) → `plotTimeoutMs`; `0` disables.

### Tests (written up front)

- `test/store.test.js`: +1 (explicit `state: 'cancelled'`).
- `test/worker.test.js`: +8 (cancel ends the job with hold and logs
  `cancelCmd` output, worker continues; cancel of a non-running id → 404;
  pause freezes the log and resume continues to done, flag and `current()`
  agree; pause with nothing running → 409, resume when not paused is a no-op;
  cancel while paused works and clears `pause`; timeout → failed/timeout/hold;
  the timeout clock stops while paused; `start()` clears a stale pause flag).
  `test/fake-plot.sh` now writes a tick every 0.1 s so "stopped" is visible as
  a log that stops growing; `test/fake-reset.sh` stands in for `CANCEL_CMD`.
- `test/app.test.js`: +4 (cancel of the running id goes to the worker and
  leaves pending alone; cancel of a pending id goes to the store even while
  something runs; pause/resume call the worker; worker's 409 passes through).
  The stub worker gained `current/cancel/pause/resume`.

### Done when

- `npm test` green (81 tests).
- Laptop run against `test/fake-plot.sh` with `FAKE_PLOT_SECONDS=20`
  `CANCEL_CMD=test/fake-reset.sh`: pause, see `active.paused: true` in
  `/queue.json`, resume, cancel; the job ends `cancelled`, the log ends with
  `reset plotter`, hold is set.
- plotpi: a real plot cancelled from curl; the pen lifts (via `CANCEL_CMD`)
  and the next job waits on hold.

---

## Design decisions already made (explain the "why")

- **Signal the group, not the pid.** The plot is a shell script that starts
  the real feeder; killing only the script orphans the feeder, which keeps
  writing to the serial port.
- **`SIGCONT` before `SIGTERM`.** A stopped process queues `SIGTERM` and
  acts on it only when continued. Without the `SIGCONT`, cancel-while-paused
  hangs forever.
- **Cancel resolves when the signal is sent.** The route answers in ms; the
  job's state changes when `'exit'` fires. Same shape as `wake()`.
- **The worker owns the `pause` flag.** It sets and clears it under its own
  lock next to `running.paused`, so memory and DB can't disagree, and clears
  it on exit and on start. Routes never touch it.
- **A fresh timeout budget after resume**, rather than tracking elapsed
  time. Simpler, and a long pause to fix paper never counts against the plot.
- **`cancelCmd` runs after exit, before `finishJob`.** The serial port must be
  free before anything else writes to it; and `recent` should show the job
  only once the plotter is safe.
- **Timeout is `failed`, cancel is `cancelled`.** One was the machine's
  decision, the other a person's; the kiosk may show them differently.

## Decisions to let Jess make

- **What `CANCEL_CMD` sends on plotpi.** Options: nothing (pen stays where it
  is, person lifts it); a tiny script writing `PU;SP0;` to `/dev/ttyUSB0`;
  the HP device-control abort `ESC.K` followed by `PU;SP0;IN;`. *Recommend:
  start with `PU;SP0;` via a 3-line script, test by hand before wiring it.*
- **Grace period before `SIGKILL`**: 2 s is the suggestion.
- **Default `PLOT_TIMEOUT_MIN`**: what's the longest plot she expects? Pick
  roughly double.
- **`stop()` on SIGTERM/Ctrl-C** still leaves the plot running (Step 3
  decision). With cancel available, should shutdown cancel it? *Recommend: no;
  a restart of plotq shouldn't ruin a plot. Recovery marks it interrupted.*

---

## Plumbing the tutor provides

```js
// Signal the whole process group; ESRCH means it's already gone, which is fine.
function signal(pid, sig) {
  try { process.kill(-pid, sig); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}
```

Running the cancel command into the same log and waiting for it:

```js
await new Promise((resolve) => {
  const c = spawn(cancelCmd, [], { stdio: ['ignore', log.fd, log.fd] });
  c.on('exit', resolve);
  c.on('error', resolve);      // a missing CANCEL_CMD must not block the queue
});
```

---

## Lessons

### Lesson C0: Orientation (no code)

- **Explain:** signals as one-word messages the kernel delivers; `TERM`
  (please stop; catchable), `KILL` (gone; not catchable), `STOP`/`CONT`
  (freeze/unfreeze; not catchable); process groups and why `detached: true`
  in Step 3 was preparation for this; what a stopped process does with a
  `TERM` (holds it until `CONT`).
  Tiny demo in a scratch file: spawn `sh -c 'sleep 30'` detached, `kill -STOP`
  the group, `ps -o stat` shows `T`, `kill -CONT`, then `kill -TERM`, and
  read `code`/`signal` in `'exit'`.
- **Ask:**
  - "Cancel and timeout both send `SIGTERM`. In `onExit` you get
    `(code, signal)`. How do you tell them apart?" (You can't from the child;
    remember what you asked for.)
  - "The plot is paused and someone taps Cancel. Walk through what the kernel
    does with your `SIGTERM`."
  - "The route answers 200 to cancel. What is true at that moment, and what
    isn't yet?"
- **Checkpoint:** Jess can say what each of the four signals does to the
  fake plot's `sh` + `sleep` pair.

### Lesson C1: `finishJob` takes a state; `running` remembers an intent

- **Build:** the `state` parameter in `finishJob`; in the worker, `running`
  gains `paused: false` and `ending: null`; `onExit` computes the result from
  `ending` first (`'cancelled'` → state cancelled; `'timeout'` → failed with
  reason timeout), then falls back to today's code/signal logic.
- **Checkpoint:** the store test passes; worker tests unchanged.

### Lesson C2: `cancel(id)` and `cancelCmd`

- **Build:** `cancel(id)`: under the lock, check `running?.id === id` (else
  404), set `ending = 'cancelled'`, `signal(pid, 'SIGCONT')`,
  `signal(pid, 'SIGTERM')`, arm a 2 s `SIGKILL` fallback that `onExit` clears.
  In `onExit`, after `log` would normally be closed: if `cancelCmd`, run it
  into the log first (plumbing above), then close, then the locked unit, which
  now also `clearFlag('pause')`.
- **Ask:** "Why is the 404 check inside the lock and not in the route?"
  (Between the route's `current()` and the worker's lock, the job can finish
  and the next one start; the worker must check against its own state.)
- **Watch for:** `process.kill(pid)` without the minus; the `SIGKILL` timer
  not cleared on normal exit; `cancelCmd` run before the child has exited.

### Lesson C3: `pause()` and `resume()`

- **Build:** both under the lock; 409 when nothing runs; `SIGSTOP`/`SIGCONT`;
  `running.paused`; `setFlag`/`clearFlag('pause')`; `start()` clears the flag.
- **Ask:** "`pause` sets a DB flag *and* a memory field. Why both, and what
  keeps them equal?" (Kiosk reads the DB through `readQueue`; the worker
  reads memory; both change inside the same locked unit.)
- **Watch for:** the log-growth test needs the fake's ticks to actually stop:
  if it fails, the signal went to the script but not the `sleep` (pid vs -pid).

### Lesson C4: the timeout

- **Build:** arm `setTimeout` at spawn when `plotTimeoutMs > 0`, keep the
  handle on `running`; on fire: `ending = 'timeout'` and the same signals as
  cancel; `clearTimeout` in `onExit`, in `pause()`, and in `stop()`; re-arm
  in `resume()`.
- **Ask:** "The timer fires in the same millisecond that `'exit'` fires
  normally. What's the worst case, and does the lock cover it?" (Timer
  callback runs `signal()` on a pid that's gone → `ESRCH` swallowed; `onExit`
  sees `ending === null` because the timer must set `ending` *inside* the lock
  and check `running` is still the same job.)

### Lesson C5: routes, config, wiring, the live runs

- **Build:** the three routes; `PLOT_TIMEOUT_MIN` in config; `server.js`
  passes `cancelCmd` and `plotTimeoutMs`. Laptop run with a 20 s fake plot:
  pause, resume, cancel from curl. Then plotpi with a real file and the
  `CANCEL_CMD` Jess chose.
- **Watch for:** `POST /jobs/<id>/cancel` calling `worker.cancel` inside
  `withLock` (deadlock: the worker takes the lock itself).

### Lesson C6: Wrap-up

- Explain-back: what each of the four signals does; why cancel-while-paused
  needs two signals; why state comes from `ending` and not from `signal`.
- README: add pause/resume/cancel rows and the two config vars; remove the
  `pkill` instruction.
- Commit: `Add cancel, pause/resume and plot timeout (step 6)`.
- Carry to Step 5 (kiosk): buttons Pause/Resume/Cancel act on `active.id`;
  disable Release while `active` is non-null.

---

## Progress log

- 2026-11-16, setup: tutor wrote this guide and 13 tests (1 store, 8 worker,
  4 app; 81 total, 69 passing before any Step 6 code). `test/fake-plot.sh`
  now ticks every 0.1 s; `test/fake-reset.sh` added. Found while surveying:
  config.js's `PLOT_CMD` default is `path.join(os.homedir(), fileURLToPath(...))`,
  which doubles the home directory into the path; the `fileURLToPath(...)`
  alone is the whole default. Next: C0.
- 2026-11-17, CANCEL_CMD research: Jess confirmed the plotter supports
  `ESC.K` (manual ch. 12, plot.recurse.com/static/doc/ch12-device-control.html).
  `ESC.K` discards buffered HP-GL and resets the parser, but lets the
  instruction already executing finish, and says nothing about the pen, so a
  `PU;SP0;` must follow. `ESC.J` clears pending output requests (relevant
  because `itsaliveplot` queries buffer space and may be killed mid-query).
  Proposed reset sequence: `ESC.J` `ESC.K` `PU;SP0;`. Still needed: the serial
  settings (`stty` line) from `~/itsaliveplot` before the tutor writes the
  reset script.
- 2026-11-17: `~/itsaliveplot` sets the port with `stty -F $DEV 9600 raw -echo`.
  Tutor wrote `plotter-reset.sh` (repo root, like `plot-file.sh`): same stty
  line, then `ESC.J ESC.K PU;SP0;`; device defaults to `/dev/ttyUSB0`,
  overridable with `PLOTTER_DEV`. To test by hand on plotpi before wiring it
  in as `CANCEL_CMD`.
- 2026-11-17, hand test on plotpi: `pkill -f itsaliveplot` + `plotter-reset.sh`
  stopped the drawing at once but the pen did not park. Likely cause: the
  feeder's flow control is broken (`\r` in the buffer reply, see the job log),
  so the plotter's buffer was full and `PU;SP0;`, sent in the same burst as
  `ESC.K`, was dropped. Tutor split the script: `ESC.J ESC.K`, `sleep 1`, then
  `PU;SP0;`. To retest, plus a by-hand `printf 'PU;SP0;'` after a kill to
  separate "bytes dropped" from "command ignored".
- 2026-11-17, retest with `testFile2.hpgl` (commands run separately this
  time; the earlier attempt's `pkill` line was garbled so the reset never ran):
  kill + `plotter-reset.sh` with the 1 s pause stops the drawing and the pen
  is returned to the carousel. Then the carriage travels to the centre of the
  page. Unknown whether that's the plotter's own post-`SP0` behaviour or extra
  bytes arriving; next test is `PU;SP0;` by hand on an idle plotter. The pen is
  stored before the move, so it can't mark the paper.
- 2026-11-17: by-hand `SP1;PU;SP0;` on an idle plotter also sends the carriage
  to the centre, so that's the plotter's own post-`SP0` behaviour, not a
  cancel bug. `plotter-reset.sh` accepted as `CANCEL_CMD` for plotpi.
  Back to C1.
- 2026-11-17, Lessons C1–C4: worker side done, 78/81 (the 3 failing are C5's
  app routes). Jess wrote `finishJob`'s `state ?? status`, `ending`/`paused`/
  `killTimer`/`timeoutTimer` on `running`, `onExit` as one `if/else if` chain
  with the double-call guard, `endPlot(reason)` shared by cancel and timeout,
  `pause`/`resume` with 409s and the flag, `start()` clearing stale pause,
  `armTimeout()`. Tutor wrote `signal()` and `runCancelCmd()` plumbing and a
  scratch STOP/CONT/TERM demo. Bugs: `result` used before `let`; separate
  `if`s overwriting the cancel result; `'./store'`/`'./config'` imports without
  `.js` (also broke plotpi after an rsync mid-step; restored with
  `git show HEAD:worker.js | ssh plotpi ...`); `{ killTimer }` shorthand;
  SIGKILL timer reading `running.pid` 2 s later; `clearFlag('pause')` only in
  the cancelCmd branch; timeout cleared after the awaits; resume re-arming
  when not paused. Still open: `onTimeout` re-arms a timer inside itself and
  has no `running?.id === id && !running.ending` check (the id capture belongs
  in `armTimeout`). Next: fix that, then C5.

---

## Lesson C4b (Jess's decision, 2026-11-17): stall timeout instead of a wall clock

Jess pointed out that a wall-clock timeout caps how long a person's plot can
run. What it was meant to catch is a *stuck* plot. Options discussed: generous
wall clock, off by default, stall timeout, per-job estimate from the HPGL.
Jess chose the stall timeout.

- **Rule:** kill the plot only if its log has not grown for `stallMs`.
  `itsaliveplot` writes a line per chunk, so a healthy plot keeps growing its
  log; a feeder stuck on a silent plotter doesn't. Reason recorded:
  `'stalled'` (was `'timeout'`); state `failed`, hold set, `CANCEL_CMD` runs.
- **Option renamed:** `plotTimeoutMs` → `stallMs`. Config `PLOT_TIMEOUT_MIN` →
  `PLOT_STALL_MIN` (default 5; `0` disables). Must exceed the longest silence
  of a healthy feed (the feeder waiting for buffer space while the plotter
  draws a full buffer).
- **Mechanism:** replace the one-shot `setTimeout` with a `setInterval` check
  (every `Math.min(1000, stallMs / 4)` ms). Each check `stat`s the log *path*
  (not the FileHandle, which `onExit` may have closed), compares with
  `running.lastSize`, and either records growth (`lastSize`, `lastGrowth =
  Date.now()`) or, if `Date.now() - lastGrowth > stallMs`, ends the plot
  under the lock with the same `running?.id === id && !running.ending` check.
  Pause clears the interval; resume re-arms it with `lastGrowth = Date.now()`.
- **Tests (tutor):** `fake-plot.sh` gains `FAKE_PLOT_STALL_AFTER=n` (n ticks,
  then silent). The two wall-clock tests were replaced by five: silent plot →
  failed/stalled/hold; long plot that keeps writing is never killed; a long
  pause is not a stall; the window restarts on resume; no `stallMs` → no watch.
