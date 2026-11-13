import type { Database, SqlValue } from 'sql.js';
import type { AttachmentData } from '../wasm';
import type { AuthToken, Chat, Contact, Message, MessageState } from './types';

// Reads an unencrypted Delta Chat backup (`delta-chat-backup-*.tar`, see core src/imex.rs).

const DB_NAME = 'dc_database_backup.sqlite';
const MAX_BACKUP_VERSION = 5;
const MAX_BLOB = 10 * 1024 * 1024;
const MAX_MESSAGES_PER_CHAT = 2000;

const CONTACT_SELF = 1;
const CONTACT_INFO = 2;
const CONTACT_DEVICE = 5;
const CHAT_SINGLE = 100;
const CHAT_GROUP = 120;
const BLOCKED_YES = 1;
const BLOCKED_REQUEST = 2;
const STATE_IN_FRESH = 10;
const STATE_OUT_DRAFT = 19;

export interface BackupProfile {
  addr: string;
  password: string;
  host: string;
  displayName: string;
  secretKey: string;
  publicKey: string;
  fingerprint: string;
  relays: string[];
  inviteNumber?: string;
  uidValidity: number;
  lastUid: number;
  contacts: Contact[];
  chats: Chat[];
  messages: Message[];
  tokens: AuthToken[];
  seen: string[];
}

export type Progress = (text: string) => void;

interface TarEntry {
  offset: number;
  size: number;
}

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>;

function cstr(b: Uint8Array): string {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
}

function octal(b: Uint8Array): number {
  if (b[0] & 0x80) {
    let n = 0;
    for (const x of b.subarray(1)) n = n * 256 + x;
    return n;
  }
  return parseInt(cstr(b).trim() || '0', 8);
}

/** Lists tar entries by reading only the 512-byte headers (ustar, GNU long names, pax). */
export async function listTar(readAt: ReadAt, total: number): Promise<Map<string, TarEntry>> {
  const entries = new Map<string, TarEntry>();
  let pos = 0;
  let longName: string | undefined;
  while (pos + 512 <= total) {
    const hdr = await readAt(pos, 512);
    if (hdr.every(b => b === 0)) break;
    const size = octal(hdr.subarray(124, 136));
    const type = String.fromCharCode(hdr[156] || 48);
    const data = pos + 512;
    pos = data + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cstr(await readAt(data, size));
      continue;
    }
    if (type === 'x') {
      const pax = new TextDecoder().decode(await readAt(data, size));
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax)?.[1] ?? longName;
      continue;
    }
    const prefix = cstr(hdr.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/` : '') + cstr(hdr.subarray(0, 100));
    longName = undefined;
    if (type === '0' || type === '\0') entries.set(name, { offset: data, size });
  }
  return entries;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function rows(db: Database, sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out: Record<string, SqlValue>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function params(raw: SqlValue): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of String(raw ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

const str = (v: SqlValue) => (v == null ? '' : String(v));
const num = (v: SqlValue) => Number(v ?? 0);
const isIp = (host: string) => /^[\d.]+$|:/.test(host);

function messageState(state: number, incoming: boolean): MessageState {
  if (incoming) return 'received';
  if (state === 28) return 'read';
  if (state === 26) return 'sent';
  return 'failed';
}

async function openDatabase(bytes: Uint8Array): Promise<Database> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm-browser.wasm?url'),
  ]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  return new SQL.Database(bytes);
}

export async function readBackup(
  readAt: ReadAt,
  total: number,
  importKey: (secretB64: string, addr: string, relays: string[]) => { secret: string; public: string; fingerprint: string },
  keyInfo: (addr: string, keyB64: string) => { fingerprint: string; key: string; relays: string[] | null; can_encrypt: boolean },
  progress: Progress,
): Promise<BackupProfile> {
  progress('Reading backup…');
  const entries = await listTar(readAt, total);
  const dbEntry = entries.get(DB_NAME);
  if (!dbEntry) throw new Error('This is not a Delta Chat backup');
  const header = await readAt(dbEntry.offset, 16);
  if (cstr(header) !== 'SQLite format 3') throw new Error('Encrypted backups are not supported. Export the backup without a passphrase.');

  progress('Opening database…');
  const db = await openDatabase(await readAt(dbEntry.offset, dbEntry.size));
  try {
    const config = new Map(rows(db, 'SELECT keyname, value FROM config').map(r => [str(r.keyname), str(r.value)]));
    if (num(config.get('backup_version') ?? null) > MAX_BACKUP_VERSION) {
      throw new Error('This backup is from a newer Delta Chat version than Kitepost supports');
    }
    const addr = (config.get('configured_addr') ?? '').toLowerCase();
    if (!addr || config.get('configured') !== '1') throw new Error('The profile in this backup is not configured');

    const transports = rows(db, 'SELECT id, addr, configured_param, is_published FROM transports');
    const transport = transports.find(t => str(t.addr).toLowerCase() === addr);
    if (!transport) throw new Error(`No login data for ${addr} in the backup`);
    const login = JSON.parse(str(transport.configured_param));
    const password = String(login.imap_password ?? '');
    const imapHost = String(login.imap?.[0]?.connection?.host ?? '');
    const host = imapHost && !isIp(imapHost) ? imapHost : addr.split('@')[1];
    const relays = transports.filter(t => num(t.is_published)).map(t => str(t.addr).toLowerCase());

    const keyRow = rows(db, 'SELECT private_key FROM keypairs WHERE id = ?', [num(config.get('key_id') ?? null)])[0];
    if (!keyRow) throw new Error('No secret key in the backup');
    const secretKey = toBase64(keyRow.private_key as Uint8Array);
    const self = importKey(secretKey, addr, relays.length ? relays : [addr]);

    const sync = rows(db, 'SELECT uidvalidity, uid_next FROM imap_sync WHERE transport_id = ? AND folder = ?', [num(transport.id), 'INBOX'])[0];

    progress('Importing contacts…');
    const fpById = new Map<number, string>([[CONTACT_SELF, 'self']]);
    const contacts: Contact[] = [];
    const contactRows = rows(db, `SELECT c.id, c.name, c.authname, c.addr, c.blocked, c.verifier, k.public_key
      FROM contacts c JOIN public_keys k ON k.fingerprint = c.fingerprint
      WHERE c.id > 9 AND c.fingerprint != ''`);
    for (const r of contactRows) {
      try {
        const info = keyInfo(str(r.addr), toBase64(r.public_key as Uint8Array));
        if (!info.can_encrypt || info.fingerprint === self.fingerprint) continue;
        fpById.set(num(r.id), info.fingerprint);
        contacts.push({
          fingerprint: info.fingerprint, addr: str(r.addr).toLowerCase(), name: str(r.name) || str(r.authname),
          publicKey: info.key, relays: info.relays?.length ? info.relays : [str(r.addr).toLowerCase()],
          verified: num(r.verifier) !== 0, blocked: num(r.blocked) === BLOCKED_YES,
        });
      } catch (e) {
        console.warn('skipping contact with unusable key', r.addr, e);
      }
    }

    progress('Importing chats…');
    const chats: Chat[] = [];
    const chatIdMap = new Map<number, string>();
    const members = new Map<number, number[]>();
    for (const r of rows(db, 'SELECT chat_id, contact_id FROM chats_contacts WHERE add_timestamp >= remove_timestamp')) {
      members.set(num(r.chat_id), [...(members.get(num(r.chat_id)) ?? []), num(r.contact_id)]);
    }
    const chatRows = rows(db, 'SELECT id, type, name, grpid, blocked FROM chats WHERE id > 9 AND type IN (?, ?) AND blocked != ?', [CHAT_SINGLE, CHAT_GROUP, BLOCKED_YES]);
    for (const r of chatRows) {
      const ids = members.get(num(r.id)) ?? [];
      const fps = ids.map(id => fpById.get(id)).filter((fp): fp is string => !!fp && fp !== 'self');
      const base = { name: str(r.name), isRequest: num(r.blocked) === BLOCKED_REQUEST, lastActivity: 0, unread: 0 };
      if (num(r.type) === CHAT_SINGLE) {
        if (ids.includes(CONTACT_DEVICE) || fps.length !== 1) continue;
        chats.push({ ...base, id: `c-${fps[0]}`, type: 'single', name: '', contact: fps[0], members: fps, left: false });
        chatIdMap.set(num(r.id), `c-${fps[0]}`);
      } else {
        if (!str(r.grpid)) continue;
        const id = `g-${str(r.grpid)}`;
        chats.push({ ...base, id, type: 'group', grpid: str(r.grpid), members: fps, left: !ids.includes(CONTACT_SELF) });
        chatIdMap.set(num(r.id), id);
      }
    }

    progress('Importing messages…');
    const reactions = new Map<number, Record<string, string>>();
    for (const r of rows(db, 'SELECT msg_id, contact_id, reaction FROM reactions')) {
      const fp = fpById.get(num(r.contact_id));
      if (fp && str(r.reaction)) reactions.set(num(r.msg_id), { ...reactions.get(num(r.msg_id)), [fp]: str(r.reaction) });
    }
    const blobs = new Map<string, TarEntry>();
    for (const [name, e] of entries) if (name.startsWith('blobs_backup/')) blobs.set(name.split('/').pop()!, e);

    const messages: Message[] = [];
    const chatById = new Map(chats.map(c => [c.id, c]));
    for (const [dcId, chatId] of chatIdMap) {
      const chat = chatById.get(chatId)!;
      const msgRows = rows(db, `SELECT id, rfc724_mid, from_id, timestamp, state, txt, param FROM msgs
        WHERE chat_id = ? AND hidden = 0 AND state != ? ORDER BY timestamp DESC, id DESC LIMIT ?`, [dcId, STATE_OUT_DRAFT, MAX_MESSAGES_PER_CHAT]);
      for (const r of msgRows.reverse()) {
        const fromId = num(r.from_id);
        const from = fromId === CONTACT_INFO ? 'self' : fpById.get(fromId);
        if (!from) continue;
        const p = params(r.param);
        const info = fromId === CONTACT_INFO || (p.has('S') && p.get('S') !== '0');
        const attachments: AttachmentData[] = [];
        const file = p.get('f');
        const blob = file ? blobs.get(file.split('/').pop()!) : undefined;
        if (blob && blob.size <= MAX_BLOB) {
          attachments.push({
            filename: p.get('v') || file!.split('/').pop()!, mime: p.get('m') || 'application/octet-stream',
            data_b64: toBase64(await readAt(blob.offset, blob.size)), size: blob.size,
          });
        }
        const text = str(r.txt) || (file && !blob ? `📎 ${p.get('v') ?? 'attachment'} (not imported)` : '');
        if (!text && !attachments.length) continue;
        const timestamp = num(r.timestamp) * 1000;
        const incoming = from !== 'self';
        messages.push({
          id: str(r.rfc724_mid) || `backup-${num(r.id)}`, chatId, from, text, timestamp,
          state: info ? 'received' : messageState(num(r.state), incoming),
          info: info || undefined, attachments, reactions: reactions.get(num(r.id)) ?? {},
        });
        chat.lastActivity = Math.max(chat.lastActivity, timestamp);
        if (incoming && !info && num(r.state) === STATE_IN_FRESH) chat.unread += 1;
      }
      if (!chat.lastActivity) chat.lastActivity = Date.now();
    }

    const tokens = rows(db, 'SELECT namespc, foreign_key, token, timestamp FROM tokens ORDER BY timestamp');
    return {
      addr, password, host, displayName: config.get('displayname') ?? '', secretKey: self.secret, publicKey: self.public,
      fingerprint: self.fingerprint, relays,
      inviteNumber: tokens.filter(t => num(t.namespc) === 100 && !str(t.foreign_key)).pop()?.token as string | undefined,
      uidValidity: num(sync?.uidvalidity),
      lastUid: Math.max(0, num(sync?.uid_next) - 1),
      contacts, chats, messages,
      tokens: tokens.filter(t => num(t.namespc) === 110).map(t => ({ token: str(t.token), grpid: str(t.foreign_key), created: num(t.timestamp) * 1000 })),
      seen: rows(db, "SELECT rfc724_mid FROM msgs WHERE rfc724_mid != '' ORDER BY id DESC LIMIT 2000").map(r => str(r.rfc724_mid)),
    };
  } finally {
    db.close();
  }
}

export function fileReader(file: Blob): ReadAt {
  return async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}
