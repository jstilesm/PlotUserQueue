# plotq handoff: state on 2026-11-16 and the next step (routes)

You are picking up **plotq**, a Node.js print queue for an HP pen plotter. Jess is
building it herself as a learning project; your job is to tutor, not to build it
for her. Read "How to work with Jess" before writing anything.

## What plotq is

One Node process on a Raspberry Pi (**plotpi**) that serves web pages and a JSON
API, keeps a queue of plot jobs in SQLite, and runs a worker that plots one job
at a time. A second Pi (**plotscreen**) with a 3.5" 480x320 touchscreen will show
a kiosk page served by plotq.

- Built-in Node modules only (`node:http`, `node:sqlite`, `node:test`). No npm
  packages without asking Jess. ES modules. Node 22.13 or newer.
- Uploads are **HPGL only**. No SVG conversion.
- Branch: `jstilesm/plotq-job-management-api`. `main` is older and lacks the
  worker and server work.

## Files

| File | What it does |
|---|---|
| `server.js` | Entry point: creates the store and worker, starts HTTP |
| `app.js` | HTTP server. Today: `GET /health` and static files from `public/` only |
| `store.js` | Queue and print library (SQLite + files under `DATA_DIR`) |
| `worker.js` | Claims the next job, spawns the plot command, records the result |
| `config.js` | `PORT`, `DATA_DIR`, `PLOT_CMD`, `PLOT_ARGS` from environment variables |
| `plot-file.sh` | Wrapper: feeds the HPGL file to `~/itsaliveplot` on stdin |
| `send-test.js` | Temporary script that queues a file by calling the store directly |
| `test/` | `node:test` tests; `fake-plot.sh` stands in for the plotter |
| `docs/lessons/` | Tutor guides and progress logs for steps 2 and 3 |

Store functions available: `withLock`, `createPrint`, `enqueue`, `listPending`,
`moveJob`, `cancelPending`, `setFlag`, `clearFlag`, `readQueue`, `pruneFinished`,
`takeNext`, `finishJob`, `recoverInterrupted`, `plotPath`. Errors thrown by the
store carry a `status` property (400 or 404).

Worker: `createWorker(store, { plotCmd, plotArgs, logDir, tickMs })` returns
`{ start, stop, wake, current }`. After every job it sets the `hold` flag, so
nothing else starts until hold is cleared. That is deliberate: the kiosk will
show a paper-and-pen checklist before each plot, and the last tap clears hold.

## What was verified on 2026-11-16

- `npm test`: 45 of 45 pass on the laptop; Jess reported they also pass on plotpi.
- plotpi has Node `v22.23.5` (NodeSource). The repo is at `/home/rc/plotq`, data
  at `/home/rc/plotq-data`.
- `GET /health` answered from the laptop and from plotscreen.
- A real plot ran end to end through plotq: started with
  `PLOT_CMD=./plot-file.sh npm start`, queued with
  `node send-test.js ~/testFile.hpgl`, job finished `done` with exit code 0.

Deploy command, run **on the laptop from the repo root** (not on the Pi):

```sh
rsync -av --delete --exclude .git --exclude .context --exclude plotq-data --exclude docs \
  ./ plotpi:plotq/
```

## Known problems and open questions

1. **The default `PLOT_CMD` is wrong.** `~/plotter-web/plot_task.sh` reads HPGL
   from stdin and ignores arguments, so plotq must be started with
   `PLOT_CMD=./plot-file.sh` on plotpi (or `test/fake-plot.sh` for a dry run).
   The default in `config.js` should change.
2. **`itsaliveplot` loses flow control on output commands.** If the HPGL contains
   `OA;` (or other `O` commands), the plotter's reply is misread as the buffer
   size and the script stops waiting for buffer space. Small files survive;
   large ones could overrun the buffer and still exit 0. Alternative:
   `~/plotnet/bin/plot` handles these but blocks forever if the plotter is silent.
3. **Shared serial port.** plotter-web (port 3000), the websocket program (port
   8181) and plotq can all write to `/dev/ttyUSB0` at once. Nothing arbitrates.
   Jess has not decided how plotq should check before starting a plot.
4. **No cancel or timeout yet.** Stopping the server does not stop a running
   plot (it runs in its own process group). Manual stop: `pkill -f itsaliveplot`.
5. **The worker logs nothing to the console.** Job results are only visible in
   the database and `DATA_DIR/logs/<job-id>.log`.
6. **`config.js` exports `CANCEL_PORT`;** the agreed name is `CANCEL_CMD`. Unused so far.
7. **`plot-file.sh` on the laptop** may still have stray pasted text after the
   `exec` line. It should be exactly three lines and executable.
8. **Uncommitted work:** `config.js`, `store.js`, `plot-file.sh`, `send-test.js`.
9. **plotscreen has no kiosk installed** (no Chromium, no X, console boot only)
   and was unreachable over the network late on 2026-11-16. Its screen is a
   plain SPI framebuffer (`fb_ili9486`), so the kiosk needs X with the fbdev
   driver, not Wayland. Leave it until the kiosk page exists.

Do not modify `~/plotter-web`, `~/plotnet` or `~/itsaliveplot` on plotpi. Ask
Jess before anything involving `sudo`, installing packages or restarting services.

## Next step: Step 4, read and control routes

Add these to `app.js`. Each is a thin layer over an existing store function.

| Route | Store call | Success response |
|---|---|---|
| `GET /queue.json` | `readQueue()` | 200 with the queue object |
| `POST /jobs/<id>/move?to=up\|down\|top` | `moveJob(id, to)` | 200 |
| `POST /jobs/<id>/cancel` (pending jobs only for now) | `cancelPending(id)` | 200 |
| `POST /queue/hold` | `setFlag('hold')` | 200 |
| `POST /queue/release` | `clearFlag('hold')`, then `worker.wake()` | 200 |
| `OPTIONS` (any path) | none | 204 with `Access-Control-Allow-Methods: GET, POST` and `Access-Control-Allow-Headers: Content-Type` |

Supporting changes:

- `createApp()` becomes `createApp({ store, worker })`; `server.js` passes them
  in. `test/app.test.js` currently calls `createApp()` with no arguments and
  must be updated to build a store on a temporary `DATA_DIR` and a worker (or a
  stub with `wake()`).
- The catch in `createApp` should answer with `err.status` and
  `{ "error": err.message }` when the error has a status, and keep 500 for
  anything else.
- Every handler that changes the queue runs inside `store.withLock(...)`.
- Every response keeps `Access-Control-Allow-Origin: *`. Errors are JSON
  `{ "error": "..." }`.
- Unknown `POST` paths return 404.

`GET /queue.json` returns:

```json
{
  "hold": false,
  "active": { "id": "...", "name": "...", "user": "...", "preview": null, "progress": null, "paused": false },
  "pending": [{ "id": "...", "name": "...", "user": "...", "preview": null }],
  "recent": [{ "id": "...", "name": "...", "user": "...", "state": "done", "finished": "..." }]
}
```

`active` is `null` when nothing is plotting. Do not change this shape; the
kiosk page will depend on it.

**Done when:** `npm test` passes, and with the server running against
`test/fake-plot.sh`, curl commands for each route behave as in the table
(including a 404 for an unknown job and a 400 for `move?to=sideways`).

Not in this step: uploads (`POST /jobs`), pause and resume, cancelling the
active job, the kiosk page, the systemd unit.

## After Step 4

1. Kiosk page in `public/`, tested in a 480x320 browser window on the laptop.
2. Pause, resume and cancel for the active job (process-group signals), plus a
   per-plot timeout.
3. Upload and print library routes, then the upload page.
4. systemd unit on plotpi.
5. Kiosk setup on plotscreen.

## How to work with Jess

- **She types the code.** Explain, ask, review; do not write `app.js` for her.
- **Tests first.** Write the `test/app.test.js` cases for each route before she
  starts, say in a sentence what each asserts, and read failures with her.
- **Write the plumbing for her.** Regex, string and date formatting, and file
  fiddling are not what she wants to learn. Offer those pieces ready-made.
- **Ask questions about infrastructure ideas:** races and locks, error and
  status design, process boundaries, test isolation. That is her learning goal.
- **Keep a lesson guide with a progress log** in `docs/lessons/`, in the style
  of `step-2-store.md` and `step-3-worker.md`. Read those two logs first; they
  record what she has already understood and where she got stuck.
- One step at a time. Stop after each and wait for her go-ahead.

A question to open Step 4 with: a `POST /queue/release` arrives while the
worker is inside `onExit` for a job that just finished and is about to call
`setFlag('hold')`. What should the person who tapped Release see happen, and
does `withLock` alone guarantee it?
