// One-time invite links that create chatmail accounts while open registration is disabled.
// Accounts are created exactly like chatmaild's User.set_password(): <mailboxes>/<addr>/password.

import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { hashPassword } from './sha512crypt.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN ?? '').toLowerCase();
const MAILBOXES_DIR = process.env.MAILBOXES_DIR ?? '/mailboxes';
const DATA_FILE = process.env.DATA_FILE ?? '/data/invites.json';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const APP_URL = process.env.APP_URL ?? '../app/';
const USERNAME_LENGTH = Number(process.env.USERNAME_LENGTH ?? 9);
const SELF_SIGNED = MAIL_DOMAIN.startsWith('_');
const SITE_NAME = process.env.SITE_NAME ?? MAIL_DOMAIN;

if (!MAIL_DOMAIN) throw new Error('MAIL_DOMAIN is required');
if (ADMIN_TOKEN && ADMIN_TOKEN.length < 24) throw new Error('ADMIN_TOKEN must be at least 24 characters');

const sha256 = s => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ storage

let invites = [];
let writing = Promise.resolve();

async function load() {
  try {
    invites = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

function persist() {
  writing = writing.then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(invites, null, 1), { mode: 0o600 });
    await rename(tmp, DATA_FILE);
  });
  return writing;
}

function isActive(inv, now = Date.now()) {
  return !inv.revoked && inv.usesLeft > 0 && (!inv.expires || inv.expires > now);
}

// ------------------------------------------------------------------ accounts

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PW_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomString = (alphabet, n) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

async function createAccount() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const addr = `${randomString(ALNUM, USERNAME_LENGTH)}@${MAIL_DOMAIN}`;
    const dir = join(MAILBOXES_DIR, addr);
    try {
      await stat(join(dir, 'password'));
      continue;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const password = randomString(PW_ALPHABET, 22);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `password.tmp-${randomInt(10_000_000)}`);
    await writeFile(tmp, `{SHA512-CRYPT}${hashPassword(password)}`, { mode: 0o600 });
    await rename(tmp, join(dir, 'password'));
    await writeFile(join(dir, 'enforceE2EEincoming'), '', { mode: 0o600 });
    return { addr, password };
  }
  throw new Error('could not find a free address');
}

function dclogin(addr, password) {
  const params = new URLSearchParams({ p: password, v: '1' });
  if (SELF_SIGNED) params.set('ic', '3');
  return `dclogin:${encodeURIComponent(addr).replace('%40', '@')}?${params}`;
}

// ------------------------------------------------------------------ HTML

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, { script = false } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)}</title><link rel="stylesheet" href="style.css"></head>
<body><main class="card">${body}</main>${script ? '<script src="admin.js" type="module"></script>' : ''}</body></html>`;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
};

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function invalidPage() {
  return page('Invite not valid', `<h1>This invite is no longer valid</h1>
<p>It may have been used already or expired. Ask the person who sent it for a new one.</p>`);
}

function invitePage(inv) {
  return page(`Invitation to ${SITE_NAME}`, `<h1>You're invited to ${esc(SITE_NAME)}</h1>
<p>Accept to get a new chat address on <strong>${esc(MAIL_DOMAIN)}</strong>. Use it with the Delta Chat app on your phone or computer, or right here in the browser.</p>
${inv.note ? `<p class="note">${esc(inv.note)}</p>` : ''}
<form method="post"><button class="primary" type="submit">Create my account</button></form>
<p class="small">The link works only once. Nothing is created until you press the button.</p>`);
}

async function successPage(account) {
  const login = dclogin(account.addr, account.password);
  const qr = await QRCode.toDataURL(login, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  const web = `${APP_URL}#login=${encodeURIComponent(login)}`;
  return page('Your account is ready', `<h1>Your account is ready</h1>
<p>Your address: <strong>${esc(account.addr)}</strong></p>
<ol class="choices">
  <li><h2>Delta Chat app</h2>
    <p>Install <a href="https://delta.chat/download" rel="noopener noreferrer">Delta Chat</a>. Then scan this code under <em>Add as second device</em> → <em>Scan QR code</em> (or "Log into your server" on the welcome screen), or tap the button on this device.</p>
    <img class="qr" src="${qr}" alt="Login QR code" width="320" height="320">
    <p><a class="button primary" href="${esc(login)}">Open in Delta Chat</a></p></li>
  <li><h2>In the browser</h2>
    <p>Use the web client without installing anything.</p>
    <p><a class="button" href="${esc(web)}">Open the web client</a></p></li>
</ol>
<p class="warn">Save this now: the page cannot be shown again. The QR code contains your password, so don't share it.</p>`);
}

// ------------------------------------------------------------------ admin API

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m) return false;
  return timingSafeEqual(Buffer.from(sha256(m[1])), Buffer.from(sha256(ADMIN_TOKEN)));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}

function publicInvite(inv) {
  const { hash: _hash, ...rest } = inv;
  return { ...rest, active: isActive(inv) };
}

async function admin(req, res, path) {
  if (!isAdmin(req)) return send(res, 401, JSON.stringify({ error: 'unauthorized' }), 'application/json');
  if (req.method === 'GET' && path === 'api/invites') {
    return send(res, 200, JSON.stringify(invites.map(publicInvite).reverse()), 'application/json');
  }
  if (req.method === 'POST' && path === 'api/invites') {
    const body = await readJson(req);
    const token = randomBytes(18).toString('base64url');
    const days = Math.min(Math.max(Number(body.expiresDays ?? 7), 0), 365);
    const inv = {
      id: randomBytes(6).toString('hex'),
      hash: sha256(token),
      note: String(body.note ?? '').slice(0, 200),
      created: Date.now(),
      expires: days ? Date.now() + days * 86_400_000 : 0,
      usesLeft: Math.min(Math.max(Math.floor(Number(body.uses ?? 1)), 1), 100),
      redeemed: [],
      revoked: false,
    };
    invites.push(inv);
    await persist();
    // The token is only returned here; storage keeps its hash.
    return send(res, 201, JSON.stringify({ ...publicInvite(inv), token }), 'application/json');
  }
  const m = /^api\/invites\/([0-9a-f]{12})$/.exec(path);
  if (req.method === 'DELETE' && m) {
    const inv = invites.find(i => i.id === m[1]);
    if (!inv) return send(res, 404, '{}', 'application/json');
    inv.revoked = true;
    await persist();
    return send(res, 200, JSON.stringify(publicInvite(inv)), 'application/json');
  }
  return send(res, 404, '{}', 'application/json');
}

// ------------------------------------------------------------------ server

const STATIC = {
  'style.css': ['text/css; charset=utf-8', new URL('./public/style.css', import.meta.url)],
  'admin.js': ['text/javascript; charset=utf-8', new URL('./public/admin.js', import.meta.url)],
};

// Redeeming is serialised so two clicks on one link cannot both create an account.
let redeeming = Promise.resolve();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/+/, '');
    if (path === 'healthz') return send(res, 200, 'ok', 'text/plain');
    if (STATIC[path]) {
      const [type, file] = STATIC[path];
      res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'max-age=3600' });
      return res.end(await readFile(file));
    }
    if (path === 'admin') {
      if (!ADMIN_TOKEN) return send(res, 404, page('Not found', '<h1>Not found</h1>'));
      return send(res, 200, page('Invites', '<div id="admin"></div>', { script: true }));
    }
    if (path.startsWith('api/')) return admin(req, res, path);

    if (!/^[A-Za-z0-9_-]{24}$/.test(path)) return send(res, 404, invalidPage());
    const hash = sha256(path);
    const inv = invites.find(i => i.hash === hash);
    if (req.method === 'GET') return send(res, inv && isActive(inv) ? 200 : 410, inv && isActive(inv) ? invitePage(inv) : invalidPage());
    if (req.method !== 'POST') return send(res, 405, '');

    let account;
    const job = redeeming.then(async () => {
      if (!inv || !isActive(inv)) return;
      account = await createAccount();
      inv.usesLeft -= 1;
      inv.redeemed.push({ addr: account.addr, at: Date.now() });
      await persist();
    });
    redeeming = job.catch(() => {});
    await job;
    if (!account) return send(res, 410, invalidPage());
    console.log(`invite ${inv.id} redeemed: ${account.addr}`);
    return send(res, 200, await successPage(account));
  } catch (e) {
    console.error(e);
    send(res, 500, page('Error', '<h1>Something went wrong</h1><p>Please try again later.</p>'));
  }
});

await load();
await mkdir(MAILBOXES_DIR, { recursive: true });
server.listen(PORT, HOST, () => console.log(`invite service for ${MAIL_DOMAIN} on http://${HOST}:${PORT}${ADMIN_TOKEN ? '' : ' (admin disabled: no ADMIN_TOKEN)'}`));
