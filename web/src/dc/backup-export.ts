import type { SqlValue } from 'sql.js';
import schema from './backup-schema.sql?raw';
import { openDatabase } from './backup';
import { avatarBase64, avatarExtension } from './avatar';
import { byChatOrder, contactName, SELF_CHAT, type AuthToken, type Chat, type Config, type Contact, type Message, type Relay } from './types';

// Writes a backup that Delta Chat imports with "Restore from backup" (see core src/imex.rs).
// The schema is a fresh profile of core; core migrates it to its own version on import.

const DB_NAME = 'dc_database_backup.sqlite';
const BACKUP_VERSION = 5;

const CONTACT_SELF = 1;
const CONTACT_INFO = 2;
const FIRST_ID = 10;
const ORIGIN_HIDDEN = 0x8;
const ORIGIN_OUTGOING_TO = 0x4000;
const CHAT_SINGLE = 100;
const CHAT_GROUP = 120;
const BLOCKED_YES = 1;
const BLOCKED_REQUEST = 2;
const NAMESPACE_INVITE_NUMBER = 100;
const NAMESPACE_AUTH = 110;
const STATE = { fresh: 10, seen: 16, failed: 24, delivered: 26, read: 28 };

export interface BackupSource {
  config: Config;
  contacts: Contact[];
  chats: Chat[];
  messages: Message[];
  tokens: AuthToken[];
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function viewtype(mime: string): number {
  if (mime === 'image/gif') return 21;
  if (mime.startsWith('image/')) return 20;
  if (mime.startsWith('audio/')) return 40;
  if (mime.startsWith('video/')) return 50;
  return 60;
}

function params(entries: [string, string | number | undefined][]): string {
  return entries.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${String(v).replaceAll('\n', '\n\n')}`).join('\n');
}

function loginParams(addr: string, password: string, host: string) {
  const server = (port: number) => ({ connection: { host, port, security: 'Tls' }, user: addr });
  return {
    entered: {
      addr, oauth2: false, certificate_checks: 'Automatic',
      imap: { server: host, port: 993, folder: '', security: 'Ssl', user: '', password },
      smtp: { server: host, port: 465, security: 'Ssl', user: '', password: '' },
    },
    configured: {
      addr, oauth2: false, certificate_checks: 'Strict',
      imap: [server(993)], imap_user: '', imap_password: password,
      smtp: [server(465)], smtp_user: '', smtp_password: password,
    },
  };
}

async function blobName(data: Uint8Array, filename: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  const hex = [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  return ext ? `${hex}.${ext}` : hex;
}

function tarHeader(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(new TextEncoder().encode(s), off);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(mtime, 12), 136);
  put('        ', 148);
  put('0', 156);
  put('ustar\x0000', 257);
  const sum = h.reduce((a, b) => a + b, 0);
  put(octal(sum, 7) + ' ', 148);
  return h;
}

function tar(files: { name: string; data: Uint8Array }[]): Blob {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: BlobPart[] = [];
  for (const f of files) {
    parts.push(tarHeader(f.name, f.data.length, mtime) as BlobPart, f.data as BlobPart);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}

export function backupFileName(fingerprint: string): string {
  return `delta-chat-backup-${new Date().toISOString().slice(0, 10)}-00-${fingerprint}.tar`;
}

export async function buildBackup(src: BackupSource): Promise<Blob> {
  const { config } = src;
  const now = Math.floor(Date.now() / 1000);
  const db = await openDatabase();
  try {
    db.exec(schema);
    const run = (sql: string, values: SqlValue[]) => db.run(sql, values);

    const files: { name: string; data: Uint8Array }[] = [];
    const blobs = new Set<string>();
    const addBlob = async (data: Uint8Array, filename: string) => {
      const file = await blobName(data, filename);
      if (!blobs.has(file)) {
        blobs.add(file);
        files.push({ name: `blobs_backup/${file}`, data });
      }
      return file;
    };

    const settings: [string, string][] = [
      ['configured_addr', config.addr], ['configured', '1'], ['configured_timestamp', String(now)],
      ['displayname', config.displayName], ['key_id', '1'], ['bcc_self', '1'],
      ['backup_version', String(BACKUP_VERSION)],
    ];
    if (config.avatar) settings.push(['selfavatar', `$BLOBDIR/${await addBlob(fromBase64(avatarBase64(config.avatar)), `avatar.${avatarExtension(config.avatar)}`)}`]);
    for (const [k, v] of settings) {
      run('DELETE FROM config WHERE keyname = ?', [k]);
      run('INSERT INTO config (keyname, value) VALUES (?, ?)', [k, v]);
    }
    run('INSERT INTO keypairs (id, private_key, public_key, addr, is_default, created) VALUES (1, ?, ?, ?, 1, ?)',
      [fromBase64(config.secretKey), fromBase64(config.publicKey), config.addr, now]);
    const relays: Relay[] = [
      { addr: config.addr, password: config.password, host: config.imapHost, addedAt: config.addedAt ?? now, uidValidity: config.uidValidity, lastUid: config.lastUid },
      ...config.relays ?? [],
    ];
    relays.forEach((r, i) => {
      const login = loginParams(r.addr, r.password, r.host);
      run('INSERT INTO transports (id, addr, entered_param, configured_param, add_timestamp, is_published) VALUES (?, ?, ?, ?, ?, 1)',
        [i + 1, r.addr, JSON.stringify(r.entered ?? login.entered), JSON.stringify(r.configured ?? login.configured), r.addedAt || now]);
      if (r.uidValidity) {
        run('INSERT INTO imap_sync (transport_id, folder, uidvalidity, uid_next, modseq) VALUES (?, ?, ?, ?, 0)',
          [i + 1, 'INBOX', r.uidValidity, r.lastUid + 1]);
      }
    });
    for (const r of config.removedRelays ?? []) run('INSERT INTO removed_transports (addr, remove_timestamp) VALUES (?, ?)', [r.addr, r.at]);

    const contactIds = new Map<string, number>([['self', CONTACT_SELF]]);
    let nextId = FIRST_ID;
    for (const c of src.contacts) {
      if (!c.publicKey) continue;
      const id = nextId++;
      contactIds.set(c.fingerprint, id);
      const avatar = c.avatar && await addBlob(fromBase64(avatarBase64(c.avatar)), `avatar.${avatarExtension(c.avatar)}`);
      run(`INSERT INTO contacts (id, name, addr, origin, blocked, authname, fingerprint, verifier, last_seen, param)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.nickname ?? '', c.addr, c.hidden ? ORIGIN_HIDDEN : ORIGIN_OUTGOING_TO, c.blocked ? 1 : 0, c.name, c.fingerprint, c.verified ? CONTACT_SELF : 0, Math.floor((c.lastSeen ?? 0) / 1000),
        params([['i', avatar && `$BLOBDIR/${avatar}`], ['J', c.avatarAt && Math.floor(c.avatarAt / 1000)]])]);
      run('INSERT OR IGNORE INTO public_keys (fingerprint, public_key) VALUES (?, ?)', [c.fingerprint, fromBase64(c.publicKey)]);
    }

    const tokens: [number, string, string, number][] = [[NAMESPACE_INVITE_NUMBER, '', config.inviteNumber, now]];
    for (const t of src.tokens) tokens.push([NAMESPACE_AUTH, t.grpid, t.token, Math.floor(t.created / 1000)]);
    for (const t of tokens) run('INSERT OR IGNORE INTO tokens (namespc, foreign_key, token, timestamp) VALUES (?, ?, ?, ?)', t);

    const messagesByChat = new Map<string, Message[]>();
    for (const m of src.messages) messagesByChat.set(m.chatId, [...(messagesByChat.get(m.chatId) ?? []), m]);

    const chatParams = async (chat: Chat) => {
      const image = chat.avatar && await addBlob(fromBase64(avatarBase64(chat.avatar)), `group-avatar.${avatarExtension(chat.avatar)}`);
      return params([['i', image && `$BLOBDIR/${image}`], ['J', chat.avatarAt && Math.floor(chat.avatarAt / 1000)], ['U', chat.unpromoted ? 1 : undefined]]);
    };

    nextId = FIRST_ID;
    let msgId = FIRST_ID;
    for (const chat of src.chats) {
      const single = chat.type === 'single' ? contactIds.get(chat.contact ?? '') : undefined;
      if (chat.type === 'single' && !single) continue;
      const chatId = nextId++;
      const msgs = (messagesByChat.get(chat.id) ?? []).sort(byChatOrder);
      const created = Math.floor((msgs[0]?.timestamp ?? Date.now()) / 1000);
      const name = chat.type === 'self' ? 'Saved messages'
        : single ? contactName(src.contacts.find(c => c.fingerprint === chat.contact))
        : chat.name;
      run(`INSERT INTO chats (id, type, name, blocked, grpid, param, created_timestamp, archived, ephemeral_timer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [chatId, chat.type === 'group' ? CHAT_GROUP : CHAT_SINGLE, name, src.contacts.find(c => c.fingerprint === chat.contact)?.blocked ? BLOCKED_YES : chat.isRequest ? BLOCKED_REQUEST : 0,
        chat.grpid ?? '', chat.id === SELF_CHAT ? 'K=1' : await chatParams(chat), created, chat.visibility === 'archived' ? 1 : chat.visibility === 'pinned' ? 2 : 0, chat.ephemeralTimer ?? 0]);
      const members: [number, number, number][] = chat.type === 'self' ? [[CONTACT_SELF, created, 0]]
        : single ? [[single, created, 0]]
        : [
          ...chat.members.map(fp => contactIds.get(fp)).filter((id): id is number => !!id).map(id => [id, created, 0] as [number, number, number]),
          chat.left ? [CONTACT_SELF, created, now] : [CONTACT_SELF, created, 0],
        ];
      for (const [id, added, removed] of members) {
        run('INSERT INTO chats_contacts (chat_id, contact_id, add_timestamp, remove_timestamp) VALUES (?, ?, ?, ?)', [chatId, id, added, removed]);
      }

      const incoming = msgs.filter(m => m.from !== 'self' && !m.info);
      const fresh = new Set(incoming.slice(Math.max(0, incoming.length - chat.unread)).map(m => m.id));
      for (const m of msgs) {
        const from = m.info ? CONTACT_INFO : contactIds.get(m.from);
        if (!from) continue;
        const out = from === CONTACT_SELF;
        const att = m.attachments[0];
        let file: string | undefined;
        if (att) {
          file = await addBlob(fromBase64(att.data_b64), att.filename);
        }
        const state = m.info ? STATE.seen
          : !out ? (fresh.has(m.id) ? STATE.fresh : STATE.seen)
          : m.state === 'read' ? STATE.read : m.state === 'sent' ? STATE.delivered : STATE.failed;
        const ts = Math.floor(m.timestamp / 1000);
        const id = msgId++;
        run(`INSERT INTO msgs (id, rfc724_mid, chat_id, from_id, to_id, timestamp, type, state, msgrmsg, bytes, txt, param,
            timestamp_sent, timestamp_rcvd, hidden, error, mime_headers, mime_in_reply_to, mime_references, subject, hop_info, pinned,
            ephemeral_timer, ephemeral_timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, '', ?, '', '', '', ?, ?, ?)`,
        [id, m.id.includes('@') ? m.id : `${crypto.randomUUID()}@localhost`, chatId, from,
          m.info ? CONTACT_INFO : out ? (single ?? (chat.type === 'self' ? CONTACT_SELF : 0)) : CONTACT_SELF,
          ts, att ? viewtype(att.mime) : 10, state, att ? att.data_b64.length * 3 / 4 : m.text.length, m.text,
          params([['f', file && `$BLOBDIR/${file}`], ['m', att?.mime], ['v', att?.filename], ['c', m.info ? undefined : 1],
            ['q', m.quote]]),
          ts, !out && m.addedAt ? Math.floor(m.addedAt / 1000) : ts, m.error ?? '', m.replyTo ? `<${m.replyTo}>` : '', m.pinned ? 1 : 0,
          m.ephemeralTimer ?? 0, m.ephemeralAt ? Math.ceil(m.ephemeralAt / 1000) : 0]);
        for (const [fp, readAt] of Object.entries(m.readBy ?? {})) {
          const contact = contactIds.get(fp);
          if (contact) run('INSERT INTO msgs_mdns (msg_id, contact_id, timestamp_sent) VALUES (?, ?, ?)', [id, contact, Math.floor(readAt / 1000)]);
        }
        for (const [fp, reaction] of Object.entries(m.reactions)) {
          const contact = contactIds.get(fp);
          if (contact) run('INSERT OR IGNORE INTO reactions (msg_id, contact_id, reaction) VALUES (?, ?, ?)', [id, contact, reaction]);
        }
      }
    }
    // Core links a saved copy to the row of its original.
    for (const m of src.messages) {
      if (m.savedFrom) run('UPDATE msgs SET starred = (SELECT id FROM msgs WHERE rfc724_mid = ?) WHERE rfc724_mid = ?', [m.savedFrom, m.id]);
    }

    return tar([{ name: DB_NAME, data: db.export() }, ...files]);
  } finally {
    db.close();
  }
}
