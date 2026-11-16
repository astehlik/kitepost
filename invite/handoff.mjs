// Short-lived, end-to-end encrypted backups that move a new profile from the web client to a phone.
// The key stays in the URL fragment, so this service only ever holds ciphertext.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha512crypt } from './sha512crypt.mjs';

const TTL = 15 * 60_000;
const MAX_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
};

export function handoffs({ mailDomain, mailboxesDir }) {
  const store = new Map();

  const sweep = () => {
    for (const [id, h] of store) if (h.expires < Date.now()) store.delete(id);
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

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_SIZE) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
    res.end(JSON.stringify(body));
  };

  /** Handles `handoff` and `handoff/<id>`; returns false for other paths. */
  async function api(req, res, path) {
    const m = /^handoff(?:\/([A-Za-z0-9_-]{22}))?$/.exec(path);
    if (!m) return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
    } else if (!m[1] && req.method === 'GET') {
      json(res, 200, { domain: mailDomain });
    } else if (!m[1] && req.method === 'POST') {
      const login = credentials(req);
      if (!login || !(await checkPassword(login.addr, login.password))) return json(res, 403, { error: 'forbidden' }), true;
      sweep();
      const data = await readBody(req);
      if (!data || data.length < 29) return json(res, 413, { error: 'too large' }), true;
      for (const [id, h] of store) if (h.addr === login.addr) store.delete(id);
      const total = [...store.values()].reduce((n, h) => n + h.data.length, 0);
      if (total + data.length > MAX_TOTAL) return json(res, 503, { error: 'busy' }), true;
      const id = randomBytes(16).toString('base64url');
      store.set(id, { addr: login.addr, data, expires: Date.now() + TTL, fetched: false });
      json(res, 201, { id, expires: Date.now() + TTL });
    } else if (m[1] && req.method === 'GET') {
      const h = store.get(m[1]);
      json(res, h ? 200 : 404, h ? { fetched: h.fetched } : { error: 'gone' });
    } else {
      json(res, 405, { error: 'method' });
    }
    return true;
  }

  /** The handoff entry for the phone page, or undefined if it expired. */
  const peek = id => {
    const h = store.get(id);
    return h && h.expires > Date.now() && !h.fetched ? h : undefined;
  };

  /** The ciphertext, released only once. */
  function take(id) {
    const h = peek(id);
    if (!h) return undefined;
    h.fetched = true;
    const { data } = h;
    h.data = Buffer.alloc(0);
    return data;
  }

  const forget = addr => {
    for (const [id, h] of store) if (h.addr === addr) store.delete(id);
  };

  return { api, peek, take, forget };
}
