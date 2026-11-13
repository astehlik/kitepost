import { t } from '../i18n';
import { normalizeFingerprint } from '../wasm';

export interface Invite {
  fingerprint: string;
  addrs: string[];
  name: string;
  invitenumber: string;
  auth: string;
  v3: boolean;
  group?: { grpid: string; name: string };
}

const MAX_RELAYS = 5;
const VALID_ID = /^[A-Za-z0-9_-]+$/;

function decodeName(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const name = decodeURIComponent(v.replace(/\+/g, '%20'));
  return name.endsWith('_') ? `${name.slice(0, -1)}…` : name;
}

function normalizeAddr(a: string): string {
  const addr = decodeURIComponent(a).trim().toLowerCase();
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(addr)) throw new Error(t('error.badInviteAddr'));
  return addr;
}

// Same formats as core's `decode_ideltachat` / `decode_openpgp`.
export function parseInvite(link: string): Invite {
  const text = link.trim();
  let payload: string;
  if (/^https:\/\/i\.delta\.chat\/?#/.test(text)) {
    payload = text.slice(text.indexOf('#') + 1);
    payload = payload.replace('&', '#');
  } else if (/^OPENPGP4FPR:/i.test(text)) {
    payload = text.slice('OPENPGP4FPR:'.length).replace('%23', '#');
  } else {
    throw new Error(t('error.notInvite'));
  }
  const [fpPart, fragment = ''] = payload.split('#', 2);
  const fingerprint = normalizeFingerprint(fpPart);
  const params = new Map<string, string>();
  for (const kv of fragment.split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) params.set(kv.slice(0, i), kv.slice(i + 1));
  }
  const addrs: string[] = [];
  if (params.has('a')) addrs.push(normalizeAddr(params.get('a')!));
  for (const r of (params.get('r') ?? '').split(',').filter(Boolean).slice(0, MAX_RELAYS - addrs.length)) {
    addrs.push(normalizeAddr(r));
  }
  const valid = (v: string | undefined) => (v !== undefined && VALID_ID.test(v) ? v : undefined);
  let invitenumber = valid(params.get('i') ?? params.get('j'));
  const auth = valid(params.get('s'));
  let v3 = params.get('v') === '3';
  if (auth && invitenumber === undefined) {
    v3 = true;
    invitenumber = '';
  }
  if (!addrs.length || invitenumber === undefined || !auth) throw new Error(t('error.inviteIncomplete'));
  if (params.has('b')) throw new Error(t('error.channelInvite'));

  const grpid = valid(params.get('x'));
  const grpname = decodeName(params.get('g'));
  return {
    fingerprint,
    addrs,
    name: decodeName(params.get('n')) ?? '',
    invitenumber,
    auth,
    v3,
    group: grpid && grpname !== undefined ? { grpid, name: grpname } : undefined,
  };
}

const DISALLOWED = /[^A-Za-z0-9._]/g;

function encodeComponent(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map(b => {
      const c = String.fromCharCode(b);
      return c.replace(DISALLOWED, '') === c ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function shorten(name: string, length: number): string {
  const chars = Array.from(name);
  return chars.length > length ? `${chars.slice(0, length - 1).join('')}_` : name;
}

export function buildContactInvite(fingerprint: string, addr: string, name: string, invitenumber: string, auth: string): string {
  const n = encodeComponent(shorten(name, 25)).replace(/%20/g, '+');
  return `https://i.delta.chat/#${fingerprint}&v=3&i=${invitenumber}&s=${auth}&a=${encodeComponent(addr)}&n=${n}`;
}

export function buildGroupInvite(
  fingerprint: string, addr: string, name: string, invitenumber: string, auth: string, grpid: string, groupName: string,
): string {
  const n = encodeComponent(shorten(name, 16)).replace(/%20/g, '+');
  const g = encodeComponent(shorten(groupName, 25)).replace(/%20/g, '+');
  return `https://i.delta.chat/#${fingerprint}&v=3&x=${grpid}&i=${invitenumber}&s=${auth}&a=${encodeComponent(addr)}&n=${n}&g=${g}`;
}
