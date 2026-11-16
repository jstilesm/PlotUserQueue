# plotq

A print queue for the pen plotter on plotpi. One Node.js process serves the
kiosk page (for dancer's touchscreen), the upload page, the JSON API, and runs
the worker that plots jobs one at a time.

No dependencies: built-in Node modules only (including `node:sqlite`). Needs Node 22.13 or newer.

## Run it

```sh
npm start                      # http://localhost:3001
PORT=3002 npm start            # another port
DATA_DIR=./plotq-data npm start  # keep queue data inside the repo (gitignored)
```

```sh
curl -i localhost:3001/health
```

## Test

```sh
npm test
```

## Files

| File | What it does |
|---|---|
| `server.js` | Entry point: starts the HTTP server |
| `app.js` | Routes, static files from `public/`, CORS |
| `config.js` | Settings from environment variables |
| `public/` | Pages and assets served as-is |
| `test/` | `node:test` tests |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `DATA_DIR` | `~/plotq-data` | Where prints and the queue live |

## Copy to plotpi

From the repo on your laptop:

```sh
rsync -av --delete --exclude .git --exclude .context --exclude plotq-data \
  ./ rc@10.100.11.73:plotq/
```
