import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ts': 'text/javascript; charset=utf-8'
};

export function createApp({ store, worker }) {
  async function handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.on('finish', () => console.log(req.method, req.url, res.statusCode))

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      return res.end();
  }

    const { pathname, searchParams } = new URL(req.url, 'http://localhost');

    const parts = pathname.split('/');

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/queue.json') {
      return sendJson(res, 200, store.readQueue())
    }
    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }

    if (req.method === "POST" && pathname === '/queue/hold' ) {
      await store.withLock(() => store.setFlag('hold'));
      return sendJson(res, 200, {ok: true})
    }
    if (req.method === "POST" && pathname === '/queue/release') {
      await store.withLock(() => store.clearFlag('hold'))
      worker.wake()
      return sendJson(res, 200, {ok: true})
    }
    if (req.method === "POST" && pathname === '/queue/pause') {
      await worker.pause()
      return sendJson(res, 200, {ok: true})
    }
    if (req.method === "POST" && pathname === '/queue/resume') {
      await worker.resume()
      return sendJson(res, 200, {ok: true})
    }

    // /jobs/<id>/action
    if (req.method === 'POST' && parts.length === 4 && parts[1] === 'jobs') {
      const [, , id, action] = parts;
      if (action === 'move') {
        await store.withLock(() => store.moveJob(id, searchParams.get('to')))
        return sendJson(res, 200, {ok: true})
      } else if (action === 'cancel') {
        if (worker.current()?.id === id) {
          await worker.cancel(id)
        } else {
          await store.withLock(() => store.cancelPending(id))
        }
        return sendJson(res, 200, {ok: true})
      }
    }
    if (req.method === "POST" && pathname === '/jobs') {
      const body = await readJson(req)
      const print = await store.createPrint({ name: body.name, user:body.user, sourceType: 'hpgl',source: body.hpgl, hpgl: body.hpgl })
      const job = await store.withLock(() => store.enqueue(body.user, print.id))
      worker.wake()
      return sendJson(res, 201, {id: job.id, printId: print.id})
    }
    
    sendJson(res, 404, { error: 'not found' });
  }
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (Number(err.status)) {
        return sendJson(res, err.status, {error: err.message})
      } else {
        console.error(err)
        return sendJson(res, 500, {error: 'internal error'})
      }
    })

  })
}


async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad path' });
  }
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  let body;
  try {
    body = await readFile(file);
  } catch (err) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(err.code)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    throw err;
  }
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  if (path.extname(file) === '.ts') {
    body = stripTypeScriptTypes(body.toString('utf8'))
  }
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
}

async function readJson(req, limit = 5 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
