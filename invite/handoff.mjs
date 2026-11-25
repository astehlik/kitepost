// Short-lived, end-to-end encrypted backups that move a new profile from the web client to a phone.
// The key stays in the URL fragment, so this service only ever holds ciphertext.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha512crypt } from './sha512crypt.mjs';

const TTL = 15 * 60_000;
const TAG = 16;
const MiB = 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

/**
 * Backups are uploaded in chunks of `chunkSize` plaintext bytes, each sealed separately, and kept
 * in `dir` until they are fetched or expire.
 */
export function handoffs({ mailDomain, mailboxesDir, dir, chunkSize = 8 * MiB, maxSize = 512 * MiB, maxTotal = 2048 * MiB }) {
  const store = new Map();
  const ready = rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true }));

  const remove = id => {
    store.delete(id);
    return rm(join(dir, id), { recursive: true, force: true });
  };
  const sweep = () => {
    for (const [id, h] of store) if (h.expires < Date.now()) void remove(id);
  };
  setInterval(sweep, 60_000).unref();

  async function checkPassword(addr, password) {
    if (!new RegExp(`^[a-z0-9._-]+@${mailDomain.replace(/[.]/g, '\\.')}$`).test(addr)) return false;
    let stored;
    try {
      stored = (await readFile(join(mailboxesDir, addr, 'password'), 'utf8')).trim().replace(/^\{SHA512-CRYPT\}/, '');
    } catch {
      return false;
    }
    const m = /^\$6\$(?:rounds=(\d+)\$)?([^$]{0,16})\$/.exec(stored);
    if (!m) return false;
    const actual = Buffer.from(sha512crypt(password, m[2], m[1] ? Number(m[1]) : undefined));
    const expected = Buffer.from(stored);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  function credentials(req) {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.authorization ?? '');
    if (!m) return undefined;
    const text = Buffer.from(m[1], 'base64').toString('utf8');
    const i = text.indexOf(':');
    return i > 0 ? { addr: text.slice(0, i).toLowerCase(), password: text.slice(i + 1) } : undefined;
  }

  const sameSecret = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
    res.end(JSON.stringify(body));
  };

  const chunksFor = size => Math.max(1, Math.ceil(size / chunkSize));

  async function create(req, res) {
    const login = credentials(req);
    if (!login || !(await checkPassword(login.addr, login.password))) return json(res, 403, { error: 'forbidden' });
    const body = await readBody(req, 1024);
    let size;
    try {
      size = JSON.parse(body?.toString('utf8') ?? '').size;
    } catch {}
    if (!Number.isSafeInteger(size) || size < 1) return json(res, 400, { error: 'size' });
    if (size > maxSize) return json(res, 413, { error: 'too large', max: maxSize });
    sweep();
    for (const [id, h] of store) if (h.addr === login.addr) await remove(id);
    const reserved = [...store.values()].reduce((n, h) => n + h.size, 0);
    if (reserved + size > maxTotal) return json(res, 503, { error: 'busy' });
    await ready;
    const id = randomBytes(16).toString('base64url');
    const token = randomBytes(18).toString('base64url');
    await mkdir(join(dir, id));
    store.set(id, { addr: login.addr, token, size, chunks: chunksFor(size), received: 0, bytes: 0, expires: Date.now() + TTL, fetched: false });
    json(res, 201, { id, token, chunkSize });
  }

  async function upload(req, res, id, n) {
    const h = store.get(id);
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!h || !m || !sameSecret(m[1], h.token)) return json(res, 403, { error: 'forbidden' });
    if (n !== h.received || h.received === h.chunks) return json(res, 409, { error: 'order' });
    const last = n === h.chunks - 1;
    const expected = (last ? h.size - n * chunkSize : chunkSize) + TAG;
    const data = await readBody(req, expected);
    if (!data || data.length !== expected) return json(res, 400, { error: 'size' });
    if (store.get(id) !== h || h.received !== n) return json(res, 409, { error: 'order' });
    await writeFile(join(dir, id, String(n)), data);
    h.received += 1;
    h.bytes += data.length;
    if (last) h.expires = Date.now() + TTL;
    res.writeHead(204, CORS);
    res.end();
  }

  /** Handles `handoff`, `handoff/<id>` and `handoff/<id>/<chunk>`; returns false for other paths. */
  async function api(req, res, path) {
    const m = /^handoff(?:\/([A-Za-z0-9_-]{22})(?:\/(\d{1,6}))?)?$/.exec(path);
    if (!m) return false;
    const [, id, chunk] = m;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
    } else if (!id && req.method === 'GET') {
      json(res, 200, { domain: mailDomain });
    } else if (!id && req.method === 'POST') {
      await create(req, res);
    } else if (chunk && req.method === 'PUT') {
      await upload(req, res, id, Number(chunk));
    } else if (id && !chunk && req.method === 'GET') {
      const h = store.get(id);
      json(res, h ? 200 : 404, h ? { fetched: h.fetched } : { error: 'gone' });
    } else {
      json(res, 405, { error: 'method' });
    }
    return true;
  }

  /** The completely uploaded handoff for the phone page, or undefined. */
  const peek = id => {
    const h = store.get(id);
    return h && h.expires > Date.now() && !h.fetched && h.received === h.chunks ? h : undefined;
  };

  /** Streams the sealed chunks, each prefixed with its 4-byte length, only once; false if gone. */
  async function download(id, res, headers) {
    const h = peek(id);
    if (!h) return false;
    h.fetched = true;
    res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': h.bytes + 4 * h.chunks });
    try {
      for (let n = 0; n < h.chunks; n++) {
        const data = await readFile(join(dir, id, String(n)));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        res.write(length);
        if (!res.write(data)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
        if (res.destroyed) break;
      }
      await rm(join(dir, id), { recursive: true, force: true });
      res.end();
    } catch (e) {
      console.error(e);
      res.destroy();
      await rm(join(dir, id), { recursive: true, force: true });
    } finally {
      h.size = 0;
    }
    return true;
  }

  const forget = async addr => {
    for (const [id, h] of store) if (h.addr === addr) await remove(id);
  };

  return { api, peek, download, forget };
}
