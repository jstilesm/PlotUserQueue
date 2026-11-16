# plotq

A print queue for the pen plotter on plotpi. One Node.js process serves the
kiosk page (for the touchscreen), the upload page, the JSON API, and runs the
worker that plots jobs one at a time.

No dependencies: built-in Node modules only (including `node:sqlite`). Needs Node 22.13 or newer.

## Run it

```sh
npm start                                  # http://localhost:3001
PORT=3002 npm start                        # another port
DATA_DIR=./plotq-data npm start            # keep queue data inside the repo (gitignored)
PLOT_CMD=test/fake-plot.sh npm start       # pretend to plot (laptop)
```

On plotpi:

```sh
cd ~/plotq && PLOT_CMD=./plot-file.sh npm start
```

After every plot the queue goes on **hold** until someone releases it, so the
paper and pen can be checked between jobs.

## Test

```sh
npm test
```

## API

All responses are JSON. Errors look like `{ "error": "..." }`.

| Route | What it does |
|---|---|
| `GET /queue.json` | The queue: `hold`, `active`, `pending`, `recent` |
| `POST /jobs` | Upload and queue. Body: `{ "user", "name", "hpgl" }`. Returns `{ "id", "printId" }` |
| `POST /jobs/<id>/move?to=up\|down\|top` | Reorder a pending job |
| `POST /jobs/<id>/cancel` | Remove a pending job |
| `POST /queue/hold` | Stop starting new jobs |
| `POST /queue/release` | Start the next job |

Example, from the machine running plotq:

```sh
curl -s -X POST localhost:3001/jobs -H 'Content-Type: application/json' \
  -d '{"user":"Jess","name":"square.hpgl","hpgl":"IN;SP1;PU0,0;PD1000,0,1000,1000,0,1000,0,0;PU;SP0;"}'
curl -s localhost:3001/queue.json
curl -s -X POST localhost:3001/queue/release
```

There is no cancel for a running plot yet. To stop one on plotpi:

```sh
pkill -f itsaliveplot
```

## Files

| File | What it does |
|---|---|
| `server.js` | Entry point: creates the store and worker, starts the HTTP server |
| `app.js` | Routes, static files from `public/`, CORS |
| `store.js` | Queue and print library: SQLite plus files under `DATA_DIR` |
| `worker.js` | Takes the next job, runs the plot command, records the result |
| `config.js` | Settings from environment variables |
| `plot-file.sh` | Feeds the HPGL file to the plotter program on plotpi |
| `public/` | Pages and assets served as-is |
| `test/` | `node:test` tests; `fake-plot.sh` stands in for the plotter |
| `docs/lessons/` | Build guides and progress logs |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `DATA_DIR` | `~/plotq-data` | Where prints, the database and plot logs live |
| `PLOT_CMD` | `~/plotter-web/plot_task.sh` | Program that plots one file (use `./plot-file.sh` on plotpi) |
| `PLOT_ARGS` | `{file}` | Arguments for it, space-separated; `{file}` becomes the HPGL path |
| `CANCEL_CMD` | (none) | Not used yet |

Plot output goes to `DATA_DIR/logs/<job-id>.log`.

## Copy to plotpi

From the repo on your laptop:

```sh
rsync -av --delete --exclude .git --exclude .context --exclude plotq-data --exclude docs \
  ./ plotpi:plotq/
```
