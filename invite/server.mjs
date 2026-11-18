// One-time invite links that create chatmail accounts while open registration is disabled.
// Accounts are created exactly like chatmaild's User.set_password(): <mailboxes>/<addr>/password.

import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import { LANGUAGES, requestLanguage, translator } from './i18n.mjs';
import { hashPassword } from './sha512crypt.mjs';
import { handoffs } from './handoff.mjs';
import { setupLinks } from './setup-links.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN ?? '').toLowerCase();
const MAILBOXES_DIR = process.env.MAILBOXES_DIR ?? '/mailboxes';
const DATA_FILE = process.env.DATA_FILE ?? '/data/invites.json';
const SETUP_FILE = process.env.SETUP_FILE ?? join(dirname(DATA_FILE), 'setup-links.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const APP_URL = process.env.APP_URL ?? '../app/';
const USERNAME_LENGTH = Number(process.env.USERNAME_LENGTH ?? 9);
const SELF_SIGNED = MAIL_DOMAIN.startsWith('_');
const SITE_NAME = process.env.SITE_NAME ?? MAIL_DOMAIN;
// Absolute base for QR codes; the default matches the documented /join/ location.
const PUBLIC_URL = process.env.PUBLIC_URL;
const PLAY_URL = 'https://play.google.com/store/apps/details?id=chat.delta';
const FDROID_URL = 'https://f-droid.org/packages/com.b44t.messenger/';
const DOWNLOAD_URL = 'https://get.delta.chat';

if (!MAIL_DOMAIN) throw new Error('MAIL_DOMAIN is required');
if (ADMIN_TOKEN && ADMIN_TOKEN.length < 24) throw new Error('ADMIN_TOKEN must be at least 24 characters');

const handoff = handoffs({ mailDomain: MAIL_DOMAIN, mailboxesDir: MAILBOXES_DIR });
const setup = setupLinks({ file: SETUP_FILE, mailboxesDir: MAILBOXES_DIR });

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

// Removing the password first stops logins and deliveries even if Dovecot still writes into the Maildir.
async function deleteAccount(addr) {
  const dir = join(MAILBOXES_DIR, addr);
  await rm(join(dir, 'password'), { force: true });
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  handoff.forget(addr);
}

function dclogin(addr, password) {
  const params = new URLSearchParams({ p: password, v: '1' });
  if (SELF_SIGNED) params.set('ic', '3');
  return `dclogin:${encodeURIComponent(addr).replace('%40', '@')}?${params}`;
}

// ------------------------------------------------------------------ HTML

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** `switchLanguage` adds links to the other languages, for pages that can safely be reloaded. */
/** `root` leads from the page's path back to the service root. */
function page(lang, title, body, { script, switchLanguage = false, root = '' } = {}) {
  const others = switchLanguage
    ? `<p class="lang-switch">${Object.entries(LANGUAGES).filter(([code]) => code !== lang)
      .map(([code, m]) => `<a href="?lang=${code}" hreflang="${code}" lang="${code}">${m.langName}</a>`).join(' · ')}</p>`
    : '';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)}</title><link rel="stylesheet" href="${root}style.css"></head>
<body><main class="card">${body}${others}</main>${script ? `<script src="${root}${script}" type="module"></script>` : ''}</body></html>`;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
};

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function invalidPage(lang) {
  const T = translator(lang);
  return page(lang, T('invalidTitle'), `<h1>${T('invalidHeading')}</h1>
<p>${T('invalidText')}</p>`, { switchLanguage: true });
}

function invitePage(lang, inv) {
  const T = translator(lang);
  return page(lang, T('inviteTitle', { site: SITE_NAME }), `<h1>${T('inviteHeading', { site: esc(SITE_NAME) })}</h1>
<p>${T('inviteText', { domain: esc(MAIL_DOMAIN) })}</p>
${inv.note ? `<p class="note">${esc(inv.note)}</p>` : ''}
<form method="post"><button class="primary" type="submit">${T('inviteButton')}</button></form>
<p class="small">${T('inviteOnce')}</p>`, { script: 'submit.js', switchLanguage: true });
}

function publicUrl(req, path) {
  return new URL(path, PUBLIC_URL ?? `https://${req.headers.host}/join/`).href;
}

const qrCode = text => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 320 });

async function successPage(lang, account, req) {
  const T = translator(lang);
  const login = dclogin(account.addr, account.password);
  const installQr = await qrCode(publicUrl(req, 'install'));
  const loginQr = await qrCode(login);
  const setupUrl = publicUrl(req, await setup.create(account.addr, login));
  const setupQr = await qrCode(setupUrl);
  const web = `${APP_URL}#login=${encodeURIComponent(login)}`;
  return page(lang, T('readyTitle'), `<h1>${T('readyTitle')}</h1>
<p>${T('readyAddress', { addr: esc(account.addr) })}</p>
<p class="warn">${T('readyWarn')}</p>
<section class="way"><h2>${T('readyWebHeading')}</h2>
  <p>${T('readyWebText')}</p>
  <p><a class="button primary" href="${esc(web)}">${T('readyWebButton')}</a></p></section>
<section class="way"><h2>${T('readyPhoneOnlyHeading')}</h2>
  <ol class="steps">
    <li><h3>${T('readyInstallHeading')}</h3>
      <p>${T('readyInstallText')}</p>
      <img class="qr" src="${installQr}" alt="${T('readyInstallQrAlt')}" width="320" height="320">
      <p><a class="button" href="install">${T('readyInstallButton')}</a></p></li>
    <li><h3>${T('readyAppHeading')}</h3>
      <p>${T('readyAppText')}</p>
      <img class="qr" src="${loginQr}" alt="${T('readyQrAlt')}" width="320" height="320">
      <p><a class="button" href="${esc(login)}">${T('readyAppButton')}</a></p>
      <p class="warn">${T('readyAppOnce')}</p></li>
  </ol>
  <p class="small">${T('readyPhoneOnlyLater')}</p></section>
<section class="way save"><h2>${T('saveHeading')}</h2>
  <p>${T('saveText')}</p>
  <img class="qr" src="${setupQr}" alt="${T('saveQrAlt')}" width="320" height="320">
  <p><input type="text" readonly value="${esc(setupUrl)}" aria-label="${T('saveLinkLabel')}"></p>
  <p class="buttons"><button type="button" data-copy data-copied="${T('saveCopied')}">${T('saveCopy')}</button>
    <button type="button" data-print>${T('savePrint')}</button></p></section>`, { script: 'result.js' });
}

// Relative links of pages under s/ lead one level up; an absolute APP_URL stays as it is.
const appUrlFrom = root => (/^[a-z][a-z0-9+.-]*:/i.test(APP_URL) ? APP_URL : root + APP_URL);

function setupPage(lang, link) {
  const T = translator(lang);
  if (!link.sealed) {
    return page(lang, T('setupUsedHeading'), `<h1>${T('setupUsedHeading')}</h1>
<p>${T('setupUsedText', { addr: esc(link.addr) })}</p>`, { root: '../' });
  }
  return page(lang, T('setupTitle'), `<h1>${T('setupTitle')}</h1>
<p>${T('readyAddress', { addr: esc(link.addr) })}</p>
<div id="setup" data-sealed="${esc(link.sealed)}" data-app="${esc(appUrlFrom('../'))}" data-failed="${esc(T('setupFailed'))}">
  <p class="status">${T('setupLoading')}</p>
  <div class="ready" hidden>
    <p>${T('setupText')}</p>
    <p class="buttons"><a class="button primary" data-web>${T('readyWebButton')}</a>
      <a class="button" data-app>${T('readyAppButton')}</a></p>
    <p class="warn">${T('readyAppOnce')}</p>
  </div>
</div>`, { script: 'setup.js', root: '../' });
}

function setupGonePage(lang) {
  const T = translator(lang);
  return page(lang, T('setupGoneHeading'), `<h1>${T('setupGoneHeading')}</h1>
<p>${T('setupGoneText')}</p>`, { root: '../' });
}

function installPage(lang) {
  const T = translator(lang);
  return page(lang, T('installTitle'), `<h1>${T('installTitle')}</h1>
<p>${T('installText')}</p>
<h2>Android</h2>
<p class="buttons"><a class="button primary" href="${PLAY_URL}" rel="noopener noreferrer">Google Play</a>
  <a class="button" href="${FDROID_URL}" rel="noopener noreferrer">F-Droid</a></p>
<p class="small">${T('installApk', { url: DOWNLOAD_URL })}</p>
<h2>${T('installOtherHeading')}</h2>
<p>${T('installOther', { url: DOWNLOAD_URL })}</p>
<p class="note">${T('installNext')}</p>`, { switchLanguage: true });
}

const plain = html => html.replace(/<[^>]+>/g, '');

function handoffPage(lang, id) {
  const T = translator(lang);
  const { addr } = handoff.peek(id);
  const filename = `delta-chat-backup-${new Date().toISOString().slice(0, 10)}-${addr.split('@')[0]}.tar`;
  // Relative to h/<id>, so the page also works behind a path prefix.
  return page(lang, T('handoffTitle'), `<h1>${T('handoffTitle')}</h1>
<p>${T('handoffText', { addr: esc(addr) })}</p>
<ol class="steps">
  <li><h2>${T('handoffInstallHeading')}</h2>
    <p class="buttons"><a class="button" href="${PLAY_URL}" rel="noopener noreferrer">Google Play</a>
      <a class="button" href="${FDROID_URL}" rel="noopener noreferrer">F-Droid</a></p>
    <p class="small">${T('handoffInstallOther', { url: DOWNLOAD_URL })}</p></li>
  <li><h2>${T('handoffSaveHeading')}</h2>
    <div id="handoff" data-src="${esc(id)}/data" data-filename="${esc(filename)}"
      data-gone="${esc(plain(T('handoffGone')))}" data-failed="${esc(T('handoffFailed'))}">
      <p class="status" hidden>${T('handoffLoading')}</p>
      <p><button class="primary" type="button">${T('handoffSave')}</button></p>
    </div>
    <p class="small">${T('handoffSaveHint')}</p></li>
  <li><h2>${T('handoffRestoreHeading')}</h2>
    <p>${T('handoffRestoreText')}</p></li>
</ol>
<p class="warn">${T('handoffWarn')}</p>`, { script: 'handoff.js', root: '../' });
}

function handoffGonePage(lang) {
  const T = translator(lang);
  return page(lang, T('handoffTitle'), `<h1>${T('handoffGoneHeading')}</h1>
<p>${T('handoffGone')}</p>`, { root: '../' });
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
  // Only addresses from `redeemed` reach the file system, which rules out path traversal.
  const a = /^api\/accounts\/([^/]+)$/.exec(path);
  if (req.method === 'DELETE' && a) {
    const addr = decodeURIComponent(a[1]);
    const account = invites.flatMap(i => i.redeemed).find(r => r.addr === addr && !r.deleted);
    if (!account) return send(res, 404, '{}', 'application/json');
    await deleteAccount(account.addr);
    account.deleted = Date.now();
    await persist();
    console.log(`account deleted: ${account.addr}`);
    return send(res, 200, JSON.stringify(account), 'application/json');
  }
  return send(res, 404, '{}', 'application/json');
}

// ------------------------------------------------------------------ server

const STATIC = {
  'style.css': ['text/css; charset=utf-8', new URL('./public/style.css', import.meta.url)],
  'admin.js': ['text/javascript; charset=utf-8', new URL('./public/admin.js', import.meta.url)],
  'handoff.js': ['text/javascript; charset=utf-8', new URL('./public/handoff.js', import.meta.url)],
  'submit.js': ['text/javascript; charset=utf-8', new URL('./public/submit.js', import.meta.url)],
  'result.js': ['text/javascript; charset=utf-8', new URL('./public/result.js', import.meta.url)],
  'setup.js': ['text/javascript; charset=utf-8', new URL('./public/setup.js', import.meta.url)],
};

// Redeeming is serialised so two clicks on one link cannot both create an account.
let redeeming = Promise.resolve();

const server = createServer(async (req, res) => {
  let lang = 'en';
  let setCookie;
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/+/, '');
    ({ lang, setCookie } = requestLanguage(req, url));
    const html = (status, body) => send(res, status, body, undefined, { Vary: 'Accept-Language, Cookie', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
    if (path === 'healthz') return send(res, 200, 'ok', 'text/plain');
    if (STATIC[path]) {
      const [type, file] = STATIC[path];
      res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS, 'Cache-Control': 'max-age=3600' });
      return res.end(await readFile(file));
    }
    if (path === 'admin') {
      const T = translator(lang);
      if (!ADMIN_TOKEN) return html(404, page(lang, T('notFound'), `<h1>${T('notFound')}</h1>`));
      return html(200, page(lang, T('adminTitle'), '<div id="admin"></div>', { script: 'admin.js', switchLanguage: true }));
    }
    if (path.startsWith('api/')) return admin(req, res, path);
    if (path === 'install') return html(200, installPage(lang));
    if (await handoff.api(req, res, path)) return;
    const h = /^h\/([A-Za-z0-9_-]{22})(\/data)?$/.exec(path);
    if (h && !h[2] && req.method === 'GET') return handoff.peek(h[1]) ? html(200, handoffPage(lang, h[1])) : html(410, handoffGonePage(lang));
    // The data can be fetched only once, so link previews and prefetching must not reach it with a GET.
    if (h && h[2]) {
      if (req.method !== 'POST') return send(res, 405, '', 'text/plain', { Allow: 'POST' });
      const data = handoff.take(h[1]);
      return data ? send(res, 200, data, 'application/octet-stream') : send(res, 410, '', 'text/plain');
    }
    const s = /^s\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (s && req.method === 'GET') {
      const link = await setup.get(s[1]);
      return link ? html(200, setupPage(lang, link)) : html(410, setupGonePage(lang));
    }

    if (!/^[A-Za-z0-9_-]{24}$/.test(path)) return html(404, invalidPage(lang));
    const hash = sha256(path);
    const inv = invites.find(i => i.hash === hash);
    if (req.method === 'GET') return html(inv && isActive(inv) ? 200 : 410, inv && isActive(inv) ? invitePage(lang, inv) : invalidPage(lang));
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
    if (!account) return html(410, invalidPage(lang));
    console.log(`invite ${inv.id} redeemed: ${account.addr}`);
    return html(200, await successPage(lang, account, req));
  } catch (e) {
    console.error(e);
    const T = translator(lang);
    send(res, 500, page(lang, T('errorTitle'), `<h1>${T('errorHeading')}</h1><p>${T('errorText')}</p>`));
  }
});

await load();
await setup.load();
await mkdir(MAILBOXES_DIR, { recursive: true });
server.listen(PORT, HOST, () => console.log(`invite service for ${MAIL_DOMAIN} on http://${HOST}:${PORT}${ADMIN_TOKEN ? '' : ' (admin disabled: no ADMIN_TOKEN)'}`));

// As PID 1 in a container, Node ignores SIGTERM without a handler and is killed after the stop timeout.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
