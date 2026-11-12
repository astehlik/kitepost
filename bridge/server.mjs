// WebSocket -> TCP bridge for the Kitepost web client.
// TLS is terminated in the browser, so this process only relays ciphertext.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const STATIC_DIR = process.env.STATIC_DIR === '' ? '' : resolve(process.env.STATIC_DIR ?? new URL('../web/dist', import.meta.url).pathname);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ALLOWED_PORTS = new Set((process.env.ALLOWED_PORTS ?? '993,465').split(',').map(Number));
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CONNECTIONS_PER_IP = Number(process.env.MAX_CONNECTIONS_PER_IP ?? 16);
const MAX_BUFFERED = 8 * 1024 * 1024;
// Operator-defined name=ip pairs; these may point at private addresses, e.g. a relay on the same host.
const HOST_MAP = new Map((process.env.HOST_MAP ?? '').split(',').map(s => s.trim()).filter(Boolean)
  .map(pair => pair.split('=').map(s => s.trim().toLowerCase())));

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(net, prefix, 'ipv6');

function hostAllowed(host) {
  if (!/^[a-z0-9._-]{1,253}$/.test(host) || isIP(host)) return false;
  if (ALLOWED_HOSTS.length === 0) return true;
  return ALLOWED_HOSTS.some(a => a.startsWith('*.') ? host.endsWith(a.slice(1)) : host === a);
}

// Resolve once and connect only to checked addresses, so DNS rebinding cannot reach internal hosts.
// BlockList matches IPv4 rules against IPv4-mapped IPv6 too, so those must not be listed as an
// IPv6 range (it would block every IPv4 address); mapped addresses are checked as IPv4 instead.
function isBlocked(address, family) {
  const mapped = family === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function resolvePublic(host) {
  if (HOST_MAP.has(host)) return [HOST_MAP.get(host)];
  const addrs = await lookup(host, { all: true, verbatim: true });
  const ok = addrs.filter(a => !isBlocked(a.address, a.family)).map(a => a.address);
  if (!ok.length) throw new Error('no public address');
  return ok;
}

// Tries each address in turn, e.g. falling back to IPv4 where IPv6 is unreachable.
function connectFirst(addresses, port) {
  return new Promise((resolve, reject) => {
    const attempt = i => {
      if (i >= addresses.length) return reject(new Error('connect failed'));
      const sock = connect({ host: addresses[i], port, timeout: 10_000 });
      const fail = () => { sock.destroy(); attempt(i + 1); };
      sock.once('error', fail);
      sock.once('timeout', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        sock.removeListener('timeout', fail);
        sock.setTimeout(30 * 60 * 1000);
        resolve(sock);
      });
    };
    attempt(0);
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('ok');
      return;
    }
    if (!STATIC_DIR) throw new Error('static serving disabled');
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = join(STATIC_DIR, path);
    if (!file.startsWith(STATIC_DIR + '/')) throw new Error('bad path');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    res.end('not found');
  }
});

const perIp = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin ?? '';
  const host = TRUST_PROXY ? req.headers['x-forwarded-host'] ?? req.headers.host : req.headers.host;
  const sameOrigin = origin === `http://${host}` || origin === `https://${host}`;
  if (!(sameOrigin || ALLOWED_ORIGINS.includes(origin))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => relay(ws, req, url));
});

async function relay(ws, req, url) {
  // The proxy appends the address it saw, so the rightmost entry is the trustworthy one.
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : '';
  const ip = forwarded || req.socket.remoteAddress;
  const count = perIp.get(ip) ?? 0;
  const host = (url.searchParams.get('host') ?? '').toLowerCase();
  const port = Number(url.searchParams.get('port'));
  if (count >= MAX_CONNECTIONS_PER_IP || !ALLOWED_PORTS.has(port) || !hostAllowed(host)) {
    ws.close(1008, 'not allowed');
    return;
  }
  perIp.set(ip, count + 1);
  const release = () => {
    const n = (perIp.get(ip) ?? 1) - 1;
    n > 0 ? perIp.set(ip, n) : perIp.delete(ip);
  };

  // Handlers must exist before the first await, or data sent right after the
  // WebSocket opens (the TLS ClientHello) is dropped while DNS resolves.
  let tcp;
  let wsClosed = false;
  let pendingBytes = 0;
  const pending = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return ws.close(1003, 'binary only');
    if (tcp && !tcp.connecting) return tcp.write(data);
    pendingBytes += data.length;
    if (pendingBytes > MAX_BUFFERED) return ws.close(1009, 'too much data before connect');
    pending.push(data);
  });
  ws.on('close', () => { wsClosed = true; tcp?.destroy(); });
  ws.on('error', () => tcp?.destroy());

  let sock;
  try {
    sock = await connectFirst(await resolvePublic(host), port);
  } catch {
    release();
    ws.close(1011, 'connect failed');
    return;
  }
  if (wsClosed) {
    sock.destroy();
    release();
    return;
  }

  tcp = sock;
  for (const chunk of pending) tcp.write(chunk);
  pending.length = 0;
  tcp.on('data', data => {
    if (ws.bufferedAmount > MAX_BUFFERED) tcp.pause();
    ws.send(data, () => { if (ws.bufferedAmount < MAX_BUFFERED) tcp.resume(); });
  });
  tcp.on('timeout', () => tcp.destroy());
  tcp.on('close', () => { release(); ws.close(); });
  tcp.on('error', () => ws.close(1011, 'tcp error'));
}

server.listen(PORT, HOST, () => {
  console.log(`kitepost bridge listening on http://${HOST}:${PORT}${STATIC_DIR ? ` (static: ${STATIC_DIR})` : ''}`);
});
