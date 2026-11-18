import { getLanguage, t, type Key } from '../i18n';
import { ImapClient } from '../net/imap';
import { SmtpClient, SmtpError } from '../net/smtp';
import type { Store } from '../store';
import type { BackupProfile } from './backup';
import { backupFileName, buildBackup } from './backup-export';
import {
  generateKeypair, parseMessage, publicKeyInfo, renderMessage,
  type AttachmentData, type OutgoingMessage, type ParsedMessage,
} from '../wasm';
import { avatarBase64, avatarDataUrl, avatarHeader, parseAvatarHeader } from './avatar';
import { buildContactInvite, buildGroupInvite, parseInvite, type Invite } from './invite';
import { makeVcard, type VcardContact } from './vcard';
import { byChatOrder, contactName, SELF_CHAT, type AuthToken, type BobState, type Chat, type Config, type Contact, type Message } from './types';

const RESEND_AVATAR_MS = 14 * 86_400_000;

export function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

function createMid(): string {
  return `${crypto.randomUUID()}@localhost`;
}

// Core puts this before edited text for other mail clients and removes it on receipt.
const EDITED_PREFIX = '✏️';

function stripMid(v: string | undefined): string {
  return (v ?? '').trim().replace(/^<|>$/g, '');
}

function cleanName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100);
}

/** Like core's save_copy_in_self_talk(), which refuses copies; notes to self already are in "Saved messages". */
export function savable(m: Message): boolean {
  return !m.info && !m.savedFrom && m.chatId !== SELF_CHAT && m.id.includes('@');
}

/** Like Android's handleDeleteMessages(): own sent messages in a chat that can send, but not in "Saved messages". */
export function canDeleteForAll(chat: Chat, msgs: Message[]): boolean {
  return !chat.left && !chat.isRequest && chat.type !== 'self' && msgs.every(m => m.from === 'self' && !m.info && m.id.includes('@'));
}

/** Like core's resend_msgs(): own messages that are not info messages, in a chat that can send. */
export function canResend(chat: Chat, msgs: Message[]): boolean {
  return !chat.left && !chat.isRequest && msgs.length > 0 && msgs.every(m => m.from === 'self' && !m.info);
}

/** Like core's is_pinnable(): a failed message did not reach everyone, pinning it raises wrong expectations. */
export function pinnable(m: Message): boolean {
  return !m.info && m.state !== 'failed' && m.state !== 'pending' && m.id.includes('@');
}

function ephemeralTimer(p: ParsedMessage): number {
  const v = Number(p.headers['ephemeral-timer']);
  return Number.isInteger(v) && v > 0 && v < 2 ** 32 ? v : 0;
}

/** "5 minutes", "1 week" … in the UI language, in the largest unit that fits exactly. */
export function formatDuration(seconds: number): string {
  const units: [Intl.NumberFormatOptions['unit'], number][] = [['year', 31_536_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, s]) => seconds % s === 0) ?? ['second', 1];
  return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size);
}

function addrEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const SMTP_RETRY_DELAYS = [5_000, 15_000, 30_000, 60_000];

type HandshakeResult = 'done' | 'ignore' | 'propagate';

export interface SetupParams {
  addr: string;
  password: string;
  displayName: string;
  bridgeUrl: string;
}

export class DcClient extends EventTarget {
  contacts = new Map<string, Contact>();
  chats = new Map<string, Chat>();
  messages = new Map<string, Message[]>();
  private tokens = new Map<string, AuthToken>();
  private bob = new Map<string, BobState>();
  private seen = new Set<string>();
  private seenQueue = new Set<number>();
  private deleteQueue = new Set<number>();
  private ephemeralTimeout: ReturnType<typeof setTimeout> | undefined;
  private currentUid: number | undefined;
  private abort: AbortController | undefined;
  private wakeImap: (() => void) | undefined;
  status = 'offline';

  private constructor(private store: Store, public config: Config) {
    super();
  }

  static async setup(store: Store, p: SetupParams): Promise<DcClient> {
    const addr = p.addr.trim().toLowerCase();
    const domain = addr.split('@')[1];
    const imap = await ImapClient.connect(p.bridgeUrl, domain);
    try {
      // On chatmail relays the first login creates the account.
      await imap.login(addr, p.password);
    } finally {
      imap.close();
    }
    const keys = generateKeypair(addr, [addr]);
    const config: Config = {
      addr, password: p.password, imapHost: domain, smtpHost: domain,
      displayName: cleanName(p.displayName), secretKey: keys.secret, publicKey: keys.public,
      fingerprint: keys.fingerprint, inviteNumber: createId(), uidValidity: 0, lastUid: 0, bridgeUrl: p.bridgeUrl,
    };
    await store.put('config', config);
    const client = new DcClient(store, config);
    await client.selfChat();
    return client;
  }

  static async importBackup(store: Store, b: BackupProfile, bridgeUrl: string): Promise<DcClient> {
    const imap = await ImapClient.connect(bridgeUrl, b.host);
    try {
      await imap.login(b.addr, b.password);
    } finally {
      imap.close();
    }
    const config: Config = {
      addr: b.addr, password: b.password, imapHost: b.host, smtpHost: b.host, displayName: cleanName(b.displayName), avatar: b.avatar,
      secretKey: b.secretKey, publicKey: b.publicKey, fingerprint: b.fingerprint,
      inviteNumber: b.inviteNumber ?? createId(), uidValidity: b.uidValidity, lastUid: b.lastUid, bridgeUrl, bccSelf: true, secured: true,
    };
    for (const c of b.contacts) await store.put(`contact/${c.fingerprint}`, c);
    for (const c of b.chats) await store.put(`chat/${c.id}`, c);
    for (const m of b.messages) await store.put(`msg/${m.chatId}/${m.id}`, m);
    for (const t of b.tokens) await store.put(`token/${t.token}`, t);
    await store.put('seen', b.seen);
    await store.put('config', config);
    return (await DcClient.load(store))!;
  }

  static async load(store: Store): Promise<DcClient | undefined> {
    const config = await store.get<Config>('config');
    if (!config) return undefined;
    const c = new DcClient(store, config);
    for (const { value } of await store.list<Contact>('contact/')) c.contacts.set(value.fingerprint, value);
    for (const { value } of await store.list<Chat>('chat/')) c.chats.set(value.id, value);
    for (const { value } of await store.list<AuthToken>('token/')) c.tokens.set(value.token, value);
    for (const { value } of await store.list<BobState>('bob/')) c.bob.set(value.id, value);
    for (const { value } of await store.list<Message>('msg/')) {
      const list = c.messages.get(value.chatId) ?? [];
      list.push(value);
      c.messages.set(value.chatId, list);
      c.seen.add(value.id);
    }
    for (const list of c.messages.values()) list.sort(byChatOrder);
    for (const id of (await store.get<string[]>('seen')) ?? []) c.seen.add(id);
    for (const uid of (await store.get<number[]>('seenQueue')) ?? []) c.seenQueue.add(uid);
    for (const uid of (await store.get<number[]>('deleteQueue')) ?? []) c.deleteQueue.add(uid);
    // Kitepost has no contact list to start a chat with oneself, so "Saved messages" always exists.
    await c.selfChat();
    return c;
  }

  private changed(what: string) {
    this.dispatchEvent(new CustomEvent('change', { detail: what }));
  }

  private setStatus(s: string) {
    this.status = s;
    this.changed('status');
  }

  // ---------------------------------------------------------------- persistence

  private async saveContact(c: Contact) {
    this.contacts.set(c.fingerprint, c);
    await this.store.put(`contact/${c.fingerprint}`, c);
  }

  private async saveChat(c: Chat) {
    this.chats.set(c.id, c);
    await this.store.put(`chat/${c.id}`, c);
    this.changed('chats');
  }

  private async saveMessage(m: Message) {
    const list = this.messages.get(m.chatId) ?? [];
    const idx = list.findIndex(x => x.id === m.id);
    if (idx >= 0) list[idx] = m;
    else {
      m = { ...m, addedAt: m.addedAt ?? Date.now() };
      list.push(m);
      list.sort(byChatOrder);
    }
    this.messages.set(m.chatId, list);
    this.seen.add(m.id);
    await this.store.put(`msg/${m.chatId}/${m.id}`, m);
    this.changed(`messages:${m.chatId}`);
    if (m.ephemeralAt) this.scheduleEphemeral();
  }

  private ephemeralFields(p: ParsedMessage, own: boolean): Partial<Message> {
    const timer = ephemeralTimer(p);
    if (!timer) return {};
    return {
      ephemeralTimer: timer,
      // Own messages from other devices count as seen, like core's OutDelivered.
      ephemeralAt: own ? Date.now() + timer * 1000 : undefined,
      serverUid: this.currentUid ? { uid: this.currentUid, validity: this.config.uidValidity } : undefined,
    };
  }

  private async markSeen(mid: string) {
    this.seen.add(mid);
    const extra = [...this.seen].filter(id => !this.messageById(id)).slice(-2000);
    await this.store.put('seen', extra);
  }

  private async saveConfig() {
    await this.store.put('config', this.config);
  }

  private messageById(id: string): Message | undefined {
    for (const list of this.messages.values()) {
      const m = list.find(x => x.id === id);
      if (m) return m;
    }
    return undefined;
  }

  private async addInfo(chatId: string, text: string) {
    await this.saveMessage({
      id: `info-${createId()}`, chatId, from: 'self', text, timestamp: Date.now(),
      state: 'received', info: true, attachments: [], reactions: {},
    });
  }

  // ---------------------------------------------------------------- contacts & chats

  contactName(fp: string): string {
    if (fp === 'self') return this.config.displayName || t('me');
    const c = this.contacts.get(fp);
    return c ? contactName(c) : fp.slice(0, 8);
  }

  /** An empty nickname shows the contact's own name again, like core's Contact::set_name(). */
  async setNickname(fp: string, nickname: string) {
    const c = this.contacts.get(fp);
    if (!c) throw new Error('unknown contact');
    const name = cleanName(nickname);
    if (name === (c.nickname ?? '')) return;
    await this.saveContact({ ...c, nickname: name || undefined });
    this.changed('contacts');
    if (this.config.bccSelf) await this.sendSync({ AlterChat: { id: { ContactFingerprint: fp }, action: { Rename: name } } });
  }

  private async upsertContact(fp: string, addr: string, key: string, name?: string): Promise<Contact> {
    const existing = this.contacts.get(fp);
    const info = publicKeyInfo(addr, key);
    if (info.fingerprint !== fp) throw new Error('fingerprint mismatch');
    const contact: Contact = {
      ...existing,
      fingerprint: fp,
      addr: addr.toLowerCase(),
      name: name !== undefined && cleanName(name) ? cleanName(name) : existing?.name ?? '',
      publicKey: info.key,
      relays: info.relays?.length ? info.relays : [addr.toLowerCase()],
      verified: existing?.verified ?? false,
      blocked: existing?.blocked ?? false,
    };
    await this.saveContact(contact);
    return contact;
  }

  /** "Saved messages", core's self-talk chat. */
  private async selfChat(): Promise<Chat> {
    const existing = this.chats.get(SELF_CHAT);
    if (existing) return existing;
    const chat: Chat = {
      id: SELF_CHAT, type: 'self', name: '', members: [], isRequest: false, left: false, lastActivity: Date.now(), unread: 0,
    };
    await this.saveChat(chat);
    return chat;
  }

  /** Like core, messages from contacts with an accepted chat are not contact requests. */
  private isAccepted(c: Contact): boolean {
    const chat = this.chats.get(`c-${c.fingerprint}`);
    return c.verified || (!!chat && !chat.isRequest);
  }

  private async singleChat(fp: string, isRequest: boolean): Promise<Chat> {
    const id = `c-${fp}`;
    const existing = this.chats.get(id);
    if (existing) return existing;
    const chat: Chat = {
      id, type: 'single', name: '', contact: fp, members: [fp], isRequest, left: false,
      lastActivity: Date.now(), unread: 0,
    };
    await this.saveChat(chat);
    return chat;
  }

  /** Like core's ChatId::create_for_contact(). */
  async chatWith(fp: string): Promise<string> {
    await this.unhide(fp);
    const chat = await this.singleChat(fp, false);
    if (chat.isRequest) await this.acceptChat(chat.id);
    return chat.id;
  }

  /** Sends a contact like core's make_vcard(): with the name it chose, its key and its profile picture. */
  async shareContact(chatId: string, fp: string) {
    const c = this.contacts.get(fp);
    if (!c?.publicKey) throw new Error('unknown contact');
    const card = makeVcard([{ addr: c.addr, name: c.name, key: c.publicKey, photo: c.avatar && avatarBase64(c.avatar) }]);
    let bin = '';
    for (const b of new TextEncoder().encode(card)) bin += String.fromCharCode(b);
    await this.sendText(chatId, '', { filename: 'vcard.vcf', mime: 'text/vcard', data_b64: btoa(bin) });
  }

  /**
   * Like core's import_vcard_contact(): returns the contact's fingerprint, or undefined for the own card.
   * A key that is known already keeps its contact unchanged, so a card cannot rename or readdress it.
   */
  async importVcardContact(card: VcardContact): Promise<string | undefined> {
    let info: ReturnType<typeof publicKeyInfo> | undefined;
    try {
      info = card.key ? publicKeyInfo(card.addr, card.key) : undefined;
    } catch {
      info = undefined;
    }
    if (!info?.can_encrypt) throw new Error(t('contact.cardNoKey'));
    if (info.fingerprint === this.config.fingerprint) return undefined;
    if (this.contacts.get(info.fingerprint)?.publicKey) return info.fingerprint;
    const c = await this.upsertContact(info.fingerprint, card.addr, card.key!, card.name);
    const avatar = card.photo ? avatarDataUrl(card.photo) : undefined;
    if (avatar) await this.saveContact({ ...c, avatar });
    this.changed('contacts');
    return info.fingerprint;
  }

  /** Like core's Contact::get_all(): contacts with an accepted chat first, then by last seen. */
  knownContacts(query = ''): Contact[] {
    const q = query.trim().toLowerCase();
    const hasChat = (c: Contact) => this.chats.get(`c-${c.fingerprint}`)?.isRequest === false ? 1 : 0;
    return [...this.contacts.values()]
      .filter(c => c.publicKey && !c.blocked && !c.hidden && c.fingerprint !== this.config.fingerprint)
      .filter(c => !q || contactName(c).toLowerCase().includes(q) || c.addr.includes(q))
      .sort((a, b) => hasChat(b) - hasChat(a) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }

  /** Like core's Contact::delete(): only on this device, and a contact that is still in a chat is hidden instead. */
  async deleteContact(fp: string) {
    const c = this.contacts.get(fp);
    if (!c) return;
    const inUse = [...this.chats.values()].some(ch => ch.members.includes(fp))
      || [...this.messages.values()].some(msgs => msgs.some(m => m.from === fp));
    if (inUse) {
      await this.saveContact({ ...c, hidden: true });
    } else {
      this.contacts.delete(fp);
      await this.store.delete(`contact/${fp}`);
    }
    this.changed('contacts');
  }

  private async unhide(fp: string) {
    const c = this.contacts.get(fp);
    if (c?.hidden) await this.saveContact({ ...c, hidden: undefined });
  }

  private groupByGrpid(grpid: string): Chat | undefined {
    return [...this.chats.values()].find(c => c.grpid === grpid);
  }

  chatTitle(chat: Chat): string {
    if (chat.type === 'self') return t('chat.saved');
    return chat.type === 'single' && chat.contact ? this.contactName(chat.contact) : chat.name;
  }

  /** Like core's set_profile_image(), unless the message is older than the one that set the current avatar. */
  private async applyAvatar(fp: string, header: string, ts: number) {
    const c = this.contacts.get(fp);
    const avatar = parseAvatarHeader(header);
    if (!c || avatar === undefined || ts < (c.avatarAt ?? 0)) return;
    await this.saveContact({ ...c, avatar: avatar ?? undefined, avatarAt: ts });
    this.changed('contacts');
  }

  private async updateLastSeen(c: Contact, ts: number) {
    if (ts <= (c.lastSeen ?? 0)) return;
    await this.saveContact({ ...this.contacts.get(c.fingerprint) ?? c, lastSeen: ts });
    this.changed('contacts');
  }

  /** Like core's Contact::get_freshness(). */
  freshness(c: Contact): 'recent' | 'normal' | 'old' {
    if (!c.publicKey || c.blocked) return 'normal';
    const age = Date.now() - (c.lastSeen ?? 0);
    if (!c.lastSeen || age > 60 * 86_400_000) return 'old';
    return age <= 600_000 ? 'recent' : 'normal';
  }

  /** Pinned chats first, like core's chatlist; chats with blocked contacts stay hidden. */
  sortedChats(): Chat[] {
    const pinned = (c: Chat) => c.visibility === 'pinned' ? 1 : 0;
    return [...this.chats.values()].filter(c => !this.isBlockedChat(c)).sort((a, b) => pinned(b) - pinned(a) || b.lastActivity - a.lastActivity);
  }

  /** Archives, pins or resets a chat and tells the own other devices, like core's set_visibility(). */
  async setVisibility(chatId: string, visibility: Chat['visibility']) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('unknown chat');
    await this.applyVisibility(chat, visibility);
    const id = this.syncId(chat);
    if (this.config.bccSelf && id) {
      await this.sendSync({ AlterChat: { id, action: { SetVisibility: visibility === 'archived' ? 'Archived' : visibility === 'pinned' ? 'Pinned' : 'Normal' } } });
    }
  }

  private async applyVisibility(chat: Chat, visibility: Chat['visibility']) {
    chat.visibility = visibility;
    // Like core, archiving marks fresh messages as noticed, without read receipts.
    if (visibility === 'archived') chat.unread = 0;
    await this.saveChat(chat);
    if (visibility === 'archived') await this.startTimers(this.messages.get(chat.id) ?? []);
  }

  private contactByFingerprint(fp: string): Contact | undefined {
    return this.contacts.get(fp) ?? [...this.contacts.values()].find(c => c.fingerprint.toUpperCase() === fp.toUpperCase());
  }

  /** Like core's Chat::get_sync_id(). */
  private syncId(chat: Chat): Record<string, string> | undefined {
    if (chat.type === 'self') return { ContactFingerprint: this.config.fingerprint };
    if (chat.type === 'single' && chat.contact) return { ContactFingerprint: chat.contact };
    if (chat.grpid) return { Grpid: chat.grpid };
    return undefined;
  }

  private chatBySyncId(id: Record<string, unknown> | undefined): Chat | undefined {
    const fp = typeof id?.ContactFingerprint === 'string' ? id.ContactFingerprint.toUpperCase() : undefined;
    if (fp) return fp === this.config.fingerprint.toUpperCase() ? this.chats.get(SELF_CHAT) : [...this.chats.values()].find(c => c.type === 'single' && c.contact?.toUpperCase() === fp);
    return typeof id?.Grpid === 'string' ? this.groupByGrpid(id.Grpid) : undefined;
  }

  /** Like core's unarchive_if_not_muted(); Kitepost has no muting. */
  private unarchive(chat: Chat) {
    if (chat.visibility === 'archived') chat.visibility = undefined;
  }

  async acceptChat(chatId: string) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.isRequest = false;
    await this.saveChat(chat);
  }

  isBlockedChat(chat: Chat): boolean {
    return chat.type === 'single' && !!chat.contact && !!this.contacts.get(chat.contact)?.blocked;
  }

  async blockChat(chatId: string) {
    const fp = this.chats.get(chatId)?.contact;
    if (fp) await this.setBlocked(fp, true);
  }

  blockedContacts(): Contact[] {
    return [...this.contacts.values()].filter(c => c.blocked).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }

  /** Like core's contact::set_blocked(): the chat with the contact is hidden, not deleted, so unblocking brings it back. */
  async setBlocked(fp: string, blocked: boolean, sync = true) {
    const c = this.contactByFingerprint(fp);
    if (!c || c.blocked === blocked) return;
    await this.saveContact({ ...c, blocked });
    const chat = this.chats.get(`c-${c.fingerprint}`);
    if (chat && !blocked && chat.isRequest) await this.acceptChat(chat.id);
    this.changed('contacts');
    this.changed('chats');
    if (sync && this.config.bccSelf) {
      await this.sendSync({ AlterChat: { id: { ContactFingerprint: c.fingerprint }, action: blocked ? 'Block' : 'Unblock' } });
    }
  }

  /** Like core's ChatId::delete(): here and, through a sync message, on the own other devices. */
  async deleteChat(chatId: string) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.type === 'self') return;
    const id = this.syncId(chat);
    await this.removeChat(chatId);
    if (this.config.bccSelf && id) await this.sendSync({ AlterChat: { id, action: 'Delete' } });
  }

  private async removeChat(chatId: string) {
    for (const m of this.messages.get(chatId) ?? []) await this.store.delete(`msg/${chatId}/${m.id}`);
    this.messages.delete(chatId);
    this.chats.delete(chatId);
    await this.store.delete(`chat/${chatId}`);
    this.changed('chats');
  }

  async markRead(chatId: string) {
    await this.startTimers(this.messages.get(chatId) ?? []);
    const chat = this.chats.get(chatId);
    if (chat && chat.unread) {
      chat.unread = 0;
      await this.saveChat(chat);
    }
    const read: Message[] = [];
    for (const m of this.messages.get(chatId) ?? []) {
      if (!m.unseenUid) continue;
      if (m.unseenUid.validity === this.config.uidValidity) this.seenQueue.add(m.unseenUid.uid);
      await this.saveMessage({ ...m, unseenUid: undefined, wantsMdn: undefined });
      read.push(m);
    }
    if (!read.length) return;
    await this.store.put('seenQueue', [...this.seenQueue]);
    this.poke();

    // Like core's markseen_msgs(): a receipt to each sender who asked for one, copied to the own
    // devices, and for the rest a receipt to self only, because other devices learn about read
    // messages from receipts, not from IMAP flags.
    const bySender = new Map<Contact, string[]>();
    const rest: string[] = [];
    for (const m of read) {
      const sender = this.contacts.get(m.from);
      if (this.readReceipts && m.wantsMdn && !chat?.isRequest && sender?.publicKey && !sender.blocked) {
        bySender.set(sender, [...(bySender.get(sender) ?? []), m.id]);
      } else {
        rest.push(m.id);
      }
    }
    for (const [sender, mids] of bySender) await this.sendMdn(sender, mids).catch(e => console.warn('MDN failed', e));
    if (this.config.bccSelf && rest.length) await this.sendSelfMdn(rest).catch(e => console.warn('self MDN failed', e));
  }

  get readReceipts(): boolean {
    return this.config.readReceipts !== false;
  }

  get notifyDetails(): 'all' | 'sender' | 'none' {
    return this.config.notifyDetails ?? 'all';
  }

  async setNotifyDetails(v: 'all' | 'sender' | 'none') {
    this.config.notifyDetails = v === 'all' ? undefined : v;
    await this.saveConfig();
  }

  async setReadReceipts(on: boolean) {
    this.config.readReceipts = on;
    await this.saveConfig();
  }

  private async sendMdn(to: Contact, mids: string[]) {
    await this.send({
      to: [{ name: to.name, addr: to.addr }], subject: 'Receipt Notification', text: '', mdn_for: mids,
      headers: [
        { name: 'Auto-Submitted', value: 'auto-replied', kind: 'raw' },
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      ],
      encryption: { kind: 'asymmetric', keys: [to.publicKey] }, attach_pubkey: false, sign: true, compress: true, from_name: '',
    }, to.relays, true);
  }

  /** Another device read these messages and already set `\Seen` on the server. */
  private async readElsewhere(mids: string[]) {
    const ids = new Set(mids);
    for (const [chatId, list] of this.messages) {
      const lastRead = list.findLastIndex(m => ids.has(m.id));
      if (lastRead < 0) continue;
      for (const m of list.slice(0, lastRead + 1)) {
        if (m.unseenUid) await this.saveMessage({ ...m, unseenUid: undefined });
      }
      await this.startTimers(list.slice(0, lastRead + 1));
      const chat = this.chats.get(chatId);
      const unread = list.slice(lastRead + 1).filter(m => m.from !== 'self' && !m.info).length;
      if (chat && chat.unread !== unread) await this.saveChat({ ...chat, unread });
    }
  }

  private async sendSelfMdn(mids: string[]) {
    await this.send({
      to: [{ name: '', addr: this.config.addr }], subject: 'Receipt Notification', text: '', mdn_for: mids,
      headers: [
        { name: 'Auto-Submitted', value: 'auto-replied', kind: 'raw' },
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      ],
      encryption: { kind: 'asymmetric', keys: [] }, attach_pubkey: false, sign: true, compress: true, from_name: '',
    }, [], true);
  }

  isRemembered(): Promise<boolean> {
    return this.store.isRemembered();
  }

  /** Keeps the storage key in this browser so the next start skips the passphrase. */
  async setRemembered(on: boolean) {
    if (on) await this.store.remember();
    else await this.store.forget();
  }

  /** Exports the profile for Delta Chat's "Restore from backup"; from then on both devices use it. */
  async exportBackup(): Promise<{ blob: Blob; filename: string }> {
    const blob = await buildBackup({
      config: this.config,
      contacts: [...this.contacts.values()],
      chats: [...this.chats.values()],
      messages: [...this.messages.values()].flat().filter(m => !m.id.startsWith('pending-')),
      tokens: [...this.tokens.values()],
    });
    if (!this.config.bccSelf) {
      this.config.bccSelf = true;
      await this.saveConfig();
    }
    return { blob, filename: backupFileName(this.config.fingerprint) };
  }

  get foreignKeyWarning(): boolean {
    return (this.config.foreignKeyAt ?? 0) > (this.config.foreignKeyHiddenAt ?? 0);
  }

  async hideForeignKeyWarning() {
    this.config.foreignKeyHiddenAt = Date.now();
    await this.saveConfig();
    this.changed('config');
  }

  async markSecured() {
    if (this.config.secured) return;
    this.config.secured = true;
    await this.saveConfig();
    this.changed('config');
  }

  /** Like core's set_config(Displayname): here and, through a sync message, on the own other devices. */
  async setDisplayName(name: string, sync = true) {
    const clean = cleanName(name);
    if (clean === this.config.displayName) return;
    this.config.displayName = clean;
    await this.saveConfig();
    this.changed('config');
    if (sync && this.config.bccSelf) await this.sendSync({ Config: { key: 'Displayname', val: clean } });
  }

  /** Like core's set_config(Selfavatar): here and, through a sync message, on the own other devices. */
  async setAvatar(dataUrl: string | undefined, sync = true) {
    if (dataUrl === this.config.avatar) return;
    this.config.avatar = dataUrl;
    this.config.avatarChangedAt = Date.now();
    await this.saveConfig();
    this.changed('config');
    if (sync && this.config.bccSelf) await this.sendSync({ Config: { key: 'Selfavatar', val: dataUrl ? avatarBase64(dataUrl) : '' } });
  }

  /** Like core's shall_attach_selfavatar(): after a change, and to every contact again after 14 days. */
  private avatarHeaders(contacts: Contact[]): OutgoingMessage['headers'] {
    const due = Math.max(this.config.avatarChangedAt ?? 0, Date.now() - RESEND_AVATAR_MS);
    if (!contacts.some(c => (this.contacts.get(c.fingerprint)?.avatarSentAt ?? 0) < due)) return [];
    return [{ name: 'Chat-User-Avatar', value: avatarHeader(this.config.avatar), kind: 'raw' }];
  }

  private async markAvatarSent(contacts: Contact[]) {
    const now = Date.now();
    for (const { fingerprint } of contacts) {
      const c = this.contacts.get(fingerprint);
      if (c) await this.saveContact({ ...c, avatarSentAt: now });
    }
  }

  // ---------------------------------------------------------------- invites

  async inviteLink(chatId?: string): Promise<string> {
    const chat = chatId ? this.chats.get(chatId) : undefined;
    const grpid = chat?.type === 'group' && chat.grpid ? chat.grpid : '';
    const token = createId();
    const t: AuthToken = { token, grpid, created: Date.now() };
    this.tokens.set(token, t);
    await this.store.put(`token/${token}`, t);
    const { fingerprint, addr, displayName, inviteNumber } = this.config;
    return grpid
      ? buildGroupInvite(fingerprint, addr, displayName, inviteNumber, token, grpid, chat!.name)
      : buildContactInvite(fingerprint, addr, displayName, inviteNumber, token);
  }

  async joinInvite(link: string): Promise<string> {
    const invite = parseInvite(link);
    if (invite.fingerprint === this.config.fingerprint) throw new Error(t('error.ownInvite'));
    const known = this.contacts.get(invite.fingerprint);
    await this.unhide(invite.fingerprint);
    if (!known) {
      await this.saveContact({
        fingerprint: invite.fingerprint, addr: invite.addrs[0], name: cleanName(invite.name), publicKey: '',
        relays: invite.addrs, verified: false, blocked: false,
      });
    }
    let chat: Chat;
    if (invite.group) {
      const existing = this.groupByGrpid(invite.group.grpid);
      if (existing && !existing.left) return existing.id;
      chat = existing ?? {
        id: `g-${createId()}`, type: 'group', name: cleanName(invite.group.name), grpid: invite.group.grpid,
        members: [invite.fingerprint], isRequest: false, left: false, lastActivity: Date.now(), unread: 0,
      };
      await this.saveChat(chat);
    } else {
      chat = await this.singleChat(invite.fingerprint, false);
      if (chat.isRequest) await this.acceptChat(chat.id);
    }

    const state: BobState = { id: createId(), invite, chatId: chat.id, stage: 'pubkey', created: Date.now() };
    if (known?.publicKey && invite.addrs.every(a => known.relays.includes(a))) {
      await this.sendRequestWithAuth(invite, known);
      state.stage = 'confirm';
    } else if (invite.v3) {
      await this.send({
        to: [], subject: 'Secure-Join', text: 'Secure-Join',
        headers: [
          { name: 'Secure-Join', value: 'vc-request-pubkey', kind: 'raw' },
          { name: 'Secure-Join-Auth', value: invite.auth, kind: 'text' },
        ],
        encryption: { kind: 'symmetric', secret: `securejoin/${invite.fingerprint}/${invite.auth}` },
        attach_pubkey: false, sign: false, compress: false, from_name: '',
      }, invite.addrs);
    } else {
      await this.send({
        to: [{ name: '', addr: invite.addrs[0] }], subject: 'Message from Delta Chat', text: 'Secure-Join: vc-request',
        headers: [
          { name: 'Chat-Version', value: '1.0', kind: 'raw' },
          { name: 'Secure-Join', value: 'vc-request', kind: 'raw' },
          { name: 'Secure-Join-Invitenumber', value: invite.invitenumber, kind: 'text' },
        ],
        encryption: { kind: 'none' }, attach_pubkey: true, sign: false, compress: false,
        wrap_multipart_mixed: true, from_name: '',
      }, invite.addrs);
    }
    this.bob.set(state.id, state);
    await this.store.put(`bob/${state.id}`, state);
    await this.addInfo(chat.id, t('info.connecting', { name: invite.name || invite.addrs[0] }));
    return chat.id;
  }

  private async sendRequestWithAuth(invite: Invite, alice: Contact) {
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'Secure-Join', value: 'vc-request-with-auth', kind: 'raw' },
      { name: 'Secure-Join-Auth', value: invite.auth, kind: 'text' },
      { name: 'Secure-Join-Fingerprint', value: this.config.fingerprint, kind: 'raw' },
    ];
    if (invite.group) headers.push({ name: 'Secure-Join-Group', value: invite.group.grpid, kind: 'text' });
    const avatar = this.avatarHeaders([alice]);
    await this.send({
      to: [{ name: alice.name, addr: alice.addr }], subject: 'Secure-Join', text: 'Secure-Join: vc-request-with-auth',
      headers: [...headers, ...avatar], gossip: [{ addr: alice.addr, key: alice.publicKey }],
      encryption: { kind: 'asymmetric', keys: [alice.publicKey] }, attach_pubkey: true, sign: true, compress: false,
    }, alice.relays);
    if (avatar.length) await this.markAvatarSent([alice]);
  }

  private async sendHandshake(contact: Contact, step: string, extra: OutgoingMessage['headers'] = []) {
    // Like core's should_attach_profile_data(): not before the contact has proven the invite.
    const avatar = step === 'vc-contact-confirm' ? this.avatarHeaders([contact]) : [];
    await this.send({
      to: [{ name: contact.name, addr: contact.addr }], subject: 'Secure-Join', text: `Secure-Join: ${step}`,
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        { name: 'Secure-Join', value: step, kind: 'raw' },
        ...extra,
        ...avatar,
      ],
      gossip: [{ addr: contact.addr, key: contact.publicKey }],
      encryption: { kind: 'asymmetric', keys: [contact.publicKey] }, attach_pubkey: true, sign: true, compress: false,
    }, contact.relays);
    if (avatar.length) await this.markAvatarSent([contact]);
  }

  // ---------------------------------------------------------------- sending

  private async send(
    msg: Partial<OutgoingMessage> & Pick<OutgoingMessage, 'to' | 'subject' | 'text' | 'headers' | 'encryption' | 'attach_pubkey' | 'sign' | 'compress'>,
    recipients: string[],
    bccSelf = false,
  ): Promise<string> {
    const { config } = this;
    if (bccSelf && config.bccSelf) recipients = [...recipients, config.addr];
    const rendered = renderMessage({
      rfc724_mid: createMid(),
      from_addr: config.addr,
      from_name: config.displayName,
      self_secret_key: config.secretKey,
      self_public_key: config.publicKey,
      gossip: [],
      timestamp: Math.floor(Date.now() / 1000),
      ...msg,
    });
    // 4xx is temporary, e.g. chatmail's rate limit; like core, try again later with the same message.
    for (let attempt = 0; ; attempt++) {
      try {
        const smtp = await SmtpClient.connect(config.bridgeUrl, config.smtpHost);
        try {
          await smtp.login(config.addr, config.password);
          await smtp.send(config.addr, [...new Set(recipients)], rendered.raw);
        } finally {
          await smtp.quit();
        }
        break;
      } catch (e) {
        const temporary = e instanceof SmtpError && e.code >= 400 && e.code < 500;
        if (!temporary || attempt >= SMTP_RETRY_DELAYS.length) throw e;
        await sleep(SMTP_RETRY_DELAYS[attempt]);
      }
    }
    this.seen.add(rendered.rfc724_mid);
    return rendered.rfc724_mid;
  }

  private memberContacts(chat: Chat): Contact[] {
    return chat.members
      .map(fp => this.contacts.get(fp))
      .filter((c): c is Contact => !!c && !!c.publicKey);
  }

  private groupHeaders(chat: Chat, members: Contact[], avatar = false): OutgoingMessage['headers'] {
    return [
      { name: 'Chat-Group-ID', value: chat.grpid!, kind: 'raw' },
      { name: 'Chat-Group-Name', value: chat.name, kind: 'text' },
      { name: 'Chat-Group-Member-Fpr', value: members.map(m => m.fingerprint).join(' '), kind: 'raw' },
      ...avatar ? [{ name: 'Chat-Group-Avatar', value: avatarHeader(chat.avatar), kind: 'raw' as const }] : [],
    ];
  }

  async sendText(chatId: string, text: string, attachment?: AttachmentData, quoted?: Message) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('unknown chat');
    if (chat.left) throw new Error(t('error.notMember'));
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));

    const msgs = this.messages.get(chatId) ?? [];
    const last = [...msgs].reverse().find(m => !m.info && m.state !== 'failed');
    const headers = this.chatHeaders(chat, members, quoted?.id ?? last?.id);
    // Like core's set_quote(): a message without text is quoted by its attachment's name.
    const quote = quoted ? quoted.text || quoted.attachments[0]?.filename || '' : undefined;

    const local: Message = {
      id: `pending-${createId()}`, chatId, from: 'self', text, timestamp: Date.now(), addedAt: Date.now(), state: 'pending',
      quote, replyTo: quoted?.id, attachments: attachment ? [attachment] : [], reactions: {}, ephemeralTimer: chat.ephemeralTimer,
    };
    await this.saveMessage(local);
    if (chat.isRequest) await this.acceptChat(chatId);
    try {
      const mid = await this.sendToChat(chat, members, {
        text, quote, headers, attachment,
        gossip: members.length > 1 ? members.map(m => ({ addr: m.addr, key: m.publicKey })) : [],
      });
      await this.store.delete(`msg/${chatId}/${local.id}`);
      this.messages.set(chatId, (this.messages.get(chatId) ?? []).filter(m => m.id !== local.id));
      await this.saveMessage({ ...local, id: mid, state: 'sent', ephemeralAt: local.ephemeralTimer && Date.now() + local.ephemeralTimer * 1000 });
    } catch (e) {
      await this.saveMessage({ ...local, state: 'failed', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    chat.lastActivity = Date.now();
    this.unarchive(chat);
    await this.saveChat(chat);
  }

  private chatHeaders(chat: Chat, members: Contact[], replyTo?: string): OutgoingMessage['headers'] {
    const headers: OutgoingMessage['headers'] = [{ name: 'Chat-Version', value: '1.0', kind: 'raw' }];
    if (replyTo) headers.push({ name: 'In-Reply-To', value: replyTo, kind: 'messageid' });
    if (chat.type !== 'self' && this.readReceipts) headers.push({ name: 'Chat-Disposition-Notification-To', value: this.config.addr, kind: 'raw' });
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members, !!(chat.unpromoted && chat.avatar)));
    return headers;
  }

  /**
   * Sends own messages again, like core's resend_msgs(): with their Message-ID and date, so that
   * recipients that have them already drop the copy. A failed message gets its first Message-ID here.
   */
  async resend(chatId: string, msgIds: string[]) {
    const chat = this.chats.get(chatId);
    const msgs = msgIds.map(id => this.messages.get(chatId)?.find(m => m.id === id));
    if (!chat || msgs.some(m => !m) || !canResend(chat, msgs as Message[])) throw new Error('cannot resend');
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
    for (const m of msgs as Message[]) {
      await this.saveMessage({ ...m, state: 'pending', error: undefined });
      try {
        const mid = await this.sendToChat(chat, members, {
          rfc724_mid: m.id.includes('@') ? m.id : createMid(),
          timestamp: Math.floor(m.timestamp / 1000),
          text: m.text, quote: m.quote, headers: this.chatHeaders(chat, members, m.replyTo), attachment: m.attachments[0],
          gossip: members.length > 1 ? members.map(c => ({ addr: c.addr, key: c.publicKey })) : [],
        });
        const state = m.state === 'read' ? 'read' : 'sent';
        if (mid !== m.id) {
          await this.store.delete(`msg/${chatId}/${m.id}`);
          this.messages.set(chatId, (this.messages.get(chatId) ?? []).filter(x => x.id !== m.id));
        }
        await this.saveMessage({ ...m, id: mid, state, error: undefined, ephemeralAt: m.ephemeralAt ?? (m.ephemeralTimer && Date.now() + m.ephemeralTimer * 1000) });
      } catch (e) {
        await this.saveMessage({ ...m, state: 'failed', error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
  }

  /** Sends to the chat's members and returns the Message-ID. */
  private async sendToChat(chat: Chat, members: Contact[], msg: Partial<OutgoingMessage> & Pick<OutgoingMessage, 'text' | 'headers'>): Promise<string> {
    // Like core, a chat without other members only goes to the server when another own device needs it.
    const self = chat.type === 'self' || !members.length;
    if (chat.ephemeralTimer) msg = { ...msg, headers: [...msg.headers, { name: 'Ephemeral-Timer', value: String(chat.ephemeralTimer), kind: 'raw' }] };
    if (self && !this.config.bccSelf) return msg.rfc724_mid ?? createMid();
    const avatar = self ? [] : this.avatarHeaders(members);
    const mid = await this.send({
      to: self ? [{ name: '', addr: this.config.addr }] : members.map(m => ({ name: m.name, addr: m.addr })),
      subject: chat.type === 'group' ? chat.name : `Message from ${this.config.displayName || this.config.addr}`,
      encryption: { kind: 'asymmetric', keys: members.map(m => m.publicKey) },
      attach_pubkey: true, sign: true, compress: true,
      ...msg,
      headers: [...msg.headers, ...avatar],
    }, members.flatMap(m => m.relays), true);
    if (avatar.length) await this.markAvatarSent(members);
    if (chat.unpromoted) {
      delete chat.unpromoted;
      await this.saveChat(chat);
    }
    return mid;
  }

  /** Replaces the text of an own message, like core's send_edit_request(). */
  async sendEdit(chatId: string, msgId: string, text: string) {
    const chat = this.chats.get(chatId);
    const original = this.messages.get(chatId)?.find(m => m.id === msgId);
    if (!chat || !original || original.from !== 'self' || original.info || !original.text || !msgId.includes('@')) throw new Error('unknown message');
    if (!text.trim() || text === original.text) return;
    if (chat.left) throw new Error(t('error.notMember'));
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'In-Reply-To', value: msgId, kind: 'messageid' },
      { name: 'Chat-Edit', value: msgId, kind: 'messageid' },
    ];
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
    await this.sendToChat(chat, members, { text: EDITED_PREFIX + text, quote: original.text, headers });
    await this.saveMessage({ ...original, text, edited: true });
  }

  /** Like Delta Chat's "Clear chat": every message deleted for me, which syncs to the own other devices. */
  async clearChat(chatId: string) {
    const ids = (this.messages.get(chatId) ?? []).map(m => m.id);
    if (ids.length) await this.deleteMessages(chatId, ids, false);
  }

  /**
   * Deletes a message like core's delete_msgs_ext(): for everyone only own sent messages, otherwise
   * here and, through a sync message, on the own other devices.
   */
  async deleteMessages(chatId: string, msgIds: string[], forAll: boolean) {
    const chat = this.chats.get(chatId);
    const msgs = msgIds.map(id => this.messages.get(chatId)?.find(x => x.id === id));
    if (!chat || !msgs.length || msgs.some(m => !m)) throw new Error('unknown message');
    const wire = msgIds.filter(id => id.includes('@'));
    if (forAll) {
      if (chat.left) throw new Error(t('error.notMember'));
      if (!canDeleteForAll(chat, msgs as Message[])) throw new Error('unknown message');
      const self = chat.type === 'self';
      const members = self ? [] : this.memberContacts(chat);
      if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
      const headers: OutgoingMessage['headers'] = [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        { name: 'Chat-Delete', value: msgIds.join(' '), kind: 'messageid' },
      ];
      if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
      await this.sendToChat(chat, members, { text: '🚮', headers });
    } else if (this.config.bccSelf && wire.length) {
      await this.sendSync({ DeleteMessages: { msgs: wire } });
    }
    for (const id of msgIds) await this.deleteLocally(id);
  }

  /** The copy of `m` in "Saved messages", like core's get_saved_msg_id(). */
  savedCopy(m: Message): Message | undefined {
    return this.messages.get(SELF_CHAT)?.find(x => x.savedFrom === m.id);
  }

  /** The original of a copy in "Saved messages" while it exists, like core's get_original_msg_id(). */
  originalOf(m: Message): Message | undefined {
    return m.savedFrom ? this.messageById(m.savedFrom) : undefined;
  }

  /** Copies a message to "Saved messages" and tells the own other devices, like core's save_msgs(). */
  async saveToSelf(chatId: string, msgId: string) {
    const orig = this.messages.get(chatId)?.find(m => m.id === msgId);
    if (!orig || !savable(orig) || this.savedCopy(orig)) throw new Error('unknown message');
    const dest = createMid();
    await this.copyToSelf(orig, dest);
    if (this.config.bccSelf) await this.sendSync({ SaveMessage: { src: orig.id, dest } });
  }

  /** Like core's save_copy_in_self_talk(): sorted by the time of saving. */
  private async copyToSelf(orig: Message, id: string) {
    const chat = await this.selfChat();
    const now = Date.now();
    await this.saveMessage({
      ...orig, id, chatId: chat.id, savedFrom: orig.id, timestamp: now, addedAt: now,
      state: orig.from === 'self' ? 'sent' : 'received', reactions: {},
      unseenUid: undefined, wantsMdn: undefined, edited: undefined, pinned: undefined, readBy: undefined, error: undefined,
    });
    chat.lastActivity = now;
    await this.saveChat(chat);
    this.changed(`messages:${orig.chatId}`);
  }

  /** Sends sync items to the own other devices, like core's send_sync_msg(). */
  private async sendSync(...data: Record<string, unknown>[]) {
    const timestamp = Math.floor(Date.now() / 1000);
    await this.send({
      to: [{ name: '', addr: this.config.addr }], subject: 'Multi-device synchronization',
      text: 'This message is used to synchronize data between your devices.',
      sync_json: JSON.stringify({ items: data.map(d => ({ timestamp, data: d })) }),
      headers: [{ name: 'Chat-Version', value: '1.0', kind: 'raw' }],
      encryption: { kind: 'asymmetric', keys: [] }, attach_pubkey: false, sign: true, compress: true, from_name: '',
    }, [], true);
  }

  /** Pins or unpins a message for everyone in the chat, like core's set_pinned_state(). */
  async setPinned(chatId: string, msgId: string, pinned: boolean) {
    const chat = this.chats.get(chatId);
    const target = this.messages.get(chatId)?.find(m => m.id === msgId);
    if (!chat || !target || !pinnable(target)) throw new Error('unknown message');
    if (!!target.pinned === pinned) return;
    if (chat.left) throw new Error(t('error.notMember'));
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'In-Reply-To', value: msgId, kind: 'messageid' },
      { name: 'Chat-Content', value: pinned ? 'message-pinned' : 'message-unpinned', kind: 'raw' },
    ];
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
    const text = t(pinned ? 'info.youPinned' : 'info.youUnpinned');
    const mid = await this.sendToChat(chat, members, { text, headers });
    await this.saveMessage({
      id: mid, chatId, from: 'self', text, timestamp: Date.now(), addedAt: Date.now(),
      state: 'sent', info: true, attachments: [], reactions: {}, replyTo: msgId,
    });
    await this.saveMessage({ ...target, pinned: pinned || undefined });
  }

  /** Sets or, with an empty string, removes the own reaction, like core's send_reaction(). */
  async sendReaction(chatId: string, msgId: string, reaction: string) {
    const chat = this.chats.get(chatId);
    const target = this.messages.get(chatId)?.find(m => m.id === msgId);
    if (!chat || !target || target.info || !msgId.includes('@')) throw new Error('unknown message');
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'In-Reply-To', value: msgId, kind: 'messageid' },
    ];
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
    await this.sendToChat(chat, members, { text: reaction, content_disposition: 'reaction', headers });
    const reactions = { ...target.reactions };
    if (reaction) reactions.self = reaction;
    else delete reactions.self;
    await this.saveMessage({ ...target, reactions });
  }

    async createGroup(name: string, memberFps: string[], avatar?: string): Promise<string> {
    const chat: Chat = {
      id: `g-${createId()}`, type: 'group', name: cleanName(name) || t('group.default'), grpid: createId(),
      members: memberFps.filter(fp => this.contacts.get(fp)?.publicKey), isRequest: false, left: false,
      lastActivity: Date.now(), unread: 0, unpromoted: true, avatar, avatarAt: avatar ? Math.floor(Date.now() / 1000) * 1000 : undefined,
    };
    await this.saveChat(chat);
    await this.addInfo(chat.id, t('info.groupCreated'));
    return chat.id;
  }

  /** Adds a member like core's add_contact_to_chat(): one message per member, with the keys for the newcomer. */
  async addMember(chatId: string, fp: string) {
    const chat = this.chats.get(chatId);
    const c = this.contacts.get(fp);
    if (!chat || chat.type !== 'group' || !c?.publicKey) throw new Error('unknown contact');
    if (chat.left) throw new Error(t('error.notMember'));
    if (chat.members.includes(fp)) return;
    chat.members = [...chat.members, fp];
    await this.saveChat(chat);
    const members = this.memberContacts(chat);
    const mid = await this.sendToChat(chat, members, {
      text: `Member ${c.addr} added.`,
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        ...this.groupHeaders(chat, members, !!chat.avatar),
        { name: 'Chat-Group-Member-Added', value: c.addr, kind: 'raw' },
        { name: 'Chat-Group-Member-Added-Fpr', value: fp, kind: 'raw' },
      ],
      gossip: members.map(m => ({ addr: m.addr, key: m.publicKey })),
    });
    await this.addOwnInfo(chat, mid, t('info.youAdded', { addr: this.contactName(fp) }));
  }

  /** Like core's set_chat_profile_image(): a group nobody knows yet gets the image with its first message. */
  async setGroupAvatar(chatId: string, dataUrl: string | undefined) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.type !== 'group') throw new Error('unknown chat');
    if (chat.left) throw new Error(t('error.notMember'));
    if (dataUrl === chat.avatar) return;
    chat.avatar = dataUrl;
    chat.avatarAt = Math.floor(Date.now() / 1000) * 1000;
    await this.saveChat(chat);
    if (chat.unpromoted) return;
    const members = this.memberContacts(chat);
    const mid = await this.sendToChat(chat, members, {
      text: 'Chat image changed.',
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        ...this.groupHeaders(chat, members, true),
        { name: 'Chat-Content', value: 'group-avatar-changed', kind: 'raw' },
      ],
    });
    await this.addOwnInfo(chat, mid, t(dataUrl ? 'info.youGroupImage' : 'info.youGroupImageDeleted'));
  }

  /** Like receive_imf's apply_group_changes(): only the newest message decides. */
  private applyGroupAvatar(chat: Chat, p: ParsedMessage) {
    const header = p.headers['chat-group-avatar'];
    const avatar = header === undefined ? undefined : parseAvatarHeader(header);
    const ts = this.timestamp(p);
    if (avatar === undefined || ts < (chat.avatarAt ?? 0)) return;
    chat.avatar = avatar ?? undefined;
    chat.avatarAt = ts;
  }

  /** Removes a member like core's remove_contact_from_chat(); the removed member is told too. */
  async removeMember(chatId: string, fp: string) {
    const chat = this.chats.get(chatId);
    const c = this.contacts.get(fp);
    if (!chat || chat.type !== 'group' || !c) throw new Error('unknown contact');
    if (chat.left) throw new Error(t('error.notMember'));
    if (!chat.members.includes(fp)) return;
    const before = this.memberContacts(chat);
    chat.members = chat.members.filter(x => x !== fp);
    await this.saveChat(chat);
    const mid = await this.sendToChat(chat, before, {
      text: `Member ${c.addr} was removed.`,
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        ...this.groupHeaders(chat, this.memberContacts(chat)),
        { name: 'Chat-Group-Member-Removed', value: c.addr, kind: 'raw' },
        { name: 'Chat-Group-Member-Removed-Fpr', value: fp, kind: 'raw' },
      ],
    });
    await this.addOwnInfo(chat, mid, t('info.youRemoved', { addr: this.contactName(fp) }));
  }

  /** Leaves a group like core's remove_contact_from_chat() with oneself; the chat and its messages stay. */
  async leaveGroup(chatId: string) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.type !== 'group') throw new Error('unknown chat');
    if (chat.left) return;
    const members = this.memberContacts(chat);
    const mid = await this.sendToChat(chat, members, {
      text: `Member ${this.config.addr} was removed.`,
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        ...this.groupHeaders(chat, members),
        { name: 'Chat-Group-Member-Removed', value: this.config.addr, kind: 'raw' },
        { name: 'Chat-Group-Member-Removed-Fpr', value: this.config.fingerprint, kind: 'raw' },
      ],
    });
    chat.left = true;
    await this.addOwnInfo(chat, mid, t('info.youLeft'));
  }

  private async addOwnInfo(chat: Chat, id: string, text: string) {
    await this.saveMessage({ id, chatId: chat.id, from: 'self', text, timestamp: Date.now(), state: 'sent', info: true, attachments: [], reactions: {} });
    chat.lastActivity = Date.now();
    await this.saveChat(chat);
  }

  // ---------------------------------------------------------------- receiving

  private parseContext() {
    const known: Record<string, string> = {};
    for (const c of this.contacts.values()) if (c.publicKey) known[c.fingerprint] = c.publicKey;
    const secrets = [
      ...[...this.bob.values()].map(b => ({
        id: `bob:${b.id}`, secret: `securejoin/${b.invite.fingerprint}/${b.invite.auth}`,
        expected_signer: b.invite.fingerprint,
      })),
      ...[...this.tokens.values()]
        .sort((a, b) => b.created - a.created)
        .map(t => ({ id: `auth:${t.token}`, secret: `securejoin/${this.config.fingerprint}/${t.token}`, expected_signer: null })),
    ];
    return {
      self_addrs: [this.config.addr],
      self_secret_key: this.config.secretKey,
      self_public_key: this.config.publicKey,
      symmetric_secrets: secrets,
      known_keys: known,
    };
  }

  /** Processes one raw message. Returns true if it should be deleted from the server. */
  async receive(raw: Uint8Array): Promise<boolean> {
    let p: ParsedMessage;
    try {
      p = parseMessage(raw, this.parseContext());
    } catch (e) {
      console.warn('dropping unparsable message', e);
      return false;
    }
    const mid = stripMid(p.headers['message-id']);
    if (mid && this.seen.has(mid)) {
      // The copy of an own disappearing message, which has to go from the server as well.
      const own = this.messageById(mid);
      if (own?.ephemeralTimer && !own.serverUid && this.currentUid) await this.saveMessage({ ...own, serverUid: { uid: this.currentUid, validity: this.config.uidValidity } });
    }
    if (!mid || this.seen.has(mid)) return false;
    await this.markSeen(mid);
    if (addrEq(p.from.addr, this.config.addr)) {
      await this.receiveOwn(p, mid);
      return false;
    }
    if (p.decryption_error) console.warn('decryption failed', mid, p.decryption_error);

    if (p.headers['secure-join-invitenumber'] || p.headers['secure-join']) {
      const res = await this.handleSecureJoin(p);
      if (res !== 'propagate') return res === 'done';
    }
    if (!p.encrypted || !p.signature) return false;

    const sender = await this.senderContact(p);
    if (!sender) return false;
    // Like core, blocked contacts cannot start chats but still write in existing groups.
    const grpid = p.headers['chat-group-id'];
    if (sender.blocked && !(grpid && this.groupByGrpid(grpid))) return false;
    // Like core, a read receipt that names no message does not count as a sign of life.
    if (p.mdn_for.length || !/report-type="?disposition-notification/i.test(p.headers['content-type'] ?? '')) {
      await this.updateLastSeen(sender, this.timestamp(p));
    }
    const avatar = p.headers['chat-user-avatar'];
    if (avatar !== undefined) await this.applyAvatar(sender.fingerprint, avatar, this.timestamp(p));

    for (const g of p.gossip) {
      if (g.fingerprint !== this.config.fingerprint && g.can_encrypt && !this.contacts.get(g.fingerprint)?.publicKey) {
        await this.upsertContact(g.fingerprint, g.addr, g.key).catch(() => undefined);
      }
    }

    if (p.mdn_for.length) {
      for (const id of p.mdn_for) {
        const m = this.messageById(id);
        if (m && m.from === 'self' && !m.readBy?.[sender.fingerprint]) {
          const readBy = { ...m.readBy, [sender.fingerprint]: this.timestamp(p) };
          await this.saveMessage({ ...m, state: m.state === 'sent' ? 'read' : m.state, readBy });
        }
      }
      return false;
    }
    await this.handleChatMessage(p, mid, sender);
    return false;
  }

  /** Messages sent by another device of this profile, like core's receive_imf for outgoing messages. */
  private async receiveOwn(p: ParsedMessage, mid: string) {
    // A device that logged in with the same credentials made its own key and encrypts its copies to it.
    if (p.decryption_error || (p.signature && p.signature !== this.config.fingerprint)) {
      this.config.foreignKeyAt = Date.now();
      await this.saveConfig();
      this.changed('config');
      return;
    }
    if (!p.encrypted || p.signature !== this.config.fingerprint) return;
    if (!this.config.bccSelf) {
      this.config.bccSelf = true;
      await this.saveConfig();
    }
    await this.markSecured();
    if (p.mdn_for.length) return this.readElsewhere(p.mdn_for);
    if (p.is_sync) return this.applySync(p.sync_json);
    if (p.headers['secure-join'] || p.headers['secure-join-invitenumber']) return;
    for (const g of p.gossip) {
      if (g.fingerprint !== this.config.fingerprint && g.can_encrypt && !this.contacts.get(g.fingerprint)?.publicKey) {
        await this.upsertContact(g.fingerprint, g.addr, g.key).catch(() => undefined);
      }
    }
    const grpid = p.headers['chat-group-id'];
    let chat: Chat | undefined;
    if (grpid) {
      chat = this.groupByGrpid(grpid);
      const removed = p.headers['chat-group-member-removed'] ?? '';
      // A removal also goes to the removed member.
      const members = this.recipientFingerprints(p)
        .filter(fp => fp !== this.config.fingerprint && this.contacts.has(fp) && !addrEq(this.contacts.get(fp)!.addr, removed));
      if (!chat) {
        if (!p.headers['chat-group-name']) return;
        chat = {
          id: `g-${createId()}`, type: 'group', name: cleanName(p.headers['chat-group-name']) || t('group.default'), grpid,
          members, isRequest: false, left: false, lastActivity: Date.now(), unread: 0,
        };
      } else if (members.length) {
        chat.members = members;
      }
      const name = cleanName(p.headers['chat-group-name'] ?? '');
      if (name) chat.name = name;
      if (p.headers['chat-group-member-removed'] && addrEq(p.headers['chat-group-member-removed'], this.config.addr)) chat.left = true;
      this.applyGroupAvatar(chat, p);
      await this.saveChat(chat);
    } else {
      const toSelf = p.recipients.length > 0 && p.recipients.every(r => addrEq(r.addr, this.config.addr));
      const fp = p.intended_recipients.find(f => f !== this.config.fingerprint && this.contacts.get(f)?.publicKey)
        ?? this.recipientFingerprints(p).find(f => f !== this.config.fingerprint);
      if (toSelf) chat = await this.selfChat();
      else if (fp) chat = await this.singleChat(fp, false);
      else return;
      if (chat.isRequest) await this.acceptChat(chat.id);
    }
    await this.applyMessage(p, mid, chat, 'self');
  }

  /** The sync items Kitepost can apply, see core src/sync.rs. */
  private async applySync(json: string | null) {
    let items: { data?: Record<string, unknown> }[] = [];
    try {
      items = JSON.parse(json ?? '{}').items ?? [];
    } catch {
      return;
    }
    for (const { data } of items) {
      const config = data?.Config as { key?: unknown; val?: unknown } | undefined;
      if (config?.key === 'Displayname' && typeof config.val === 'string') await this.setDisplayName(config.val, false);
      if (config?.key === 'Selfavatar' && typeof config.val === 'string') {
        const avatar = config.val ? avatarDataUrl(config.val) : undefined;
        if (avatar || !config.val) await this.setAvatar(avatar, false);
      }
      const alter = data?.AlterChat as { id?: Record<string, unknown>; action?: string | { SetVisibility?: string; Rename?: unknown } } | undefined;
      const contactFp = typeof alter?.id?.ContactFingerprint === 'string' ? alter.id.ContactFingerprint : undefined;
      if (contactFp && (alter?.action === 'Block' || alter?.action === 'Unblock')) await this.setBlocked(contactFp, alter.action === 'Block', false);
      const deleted = alter?.action === 'Delete' && this.chatBySyncId(alter.id);
      if (deleted) {
        await this.removeChat(deleted.id);
        if (deleted.type === 'self') await this.selfChat();
      }
      const action = typeof alter?.action === 'object' ? alter.action : undefined;
      const visibility = action?.SetVisibility;
      const target = visibility && this.chatBySyncId(alter?.id);
      if (target) await this.applyVisibility(target, visibility === 'Archived' ? 'archived' : visibility === 'Pinned' ? 'pinned' : undefined);
      const rename = action?.Rename;
      const renamed = typeof rename === 'string' && typeof alter?.id?.ContactFingerprint === 'string' ? this.contactByFingerprint(alter.id.ContactFingerprint) : undefined;
      if (renamed && typeof rename === 'string') {
        await this.saveContact({ ...renamed, nickname: cleanName(rename) || undefined });
        this.changed('contacts');
      }
      const save = data?.SaveMessage as { src?: string; dest?: string } | undefined;
      const del = data?.DeleteMessages as { msgs?: string[] } | undefined;
      if (save?.src && save.dest && !this.messageById(save.dest)) {
        const orig = this.messageById(save.src);
        if (orig && savable(orig) && !this.savedCopy(orig)) await this.copyToSelf(orig, save.dest);
      }
      for (const id of del?.msgs ?? []) await this.deleteLocally(id);
    }
  }

  private async deleteLocally(id: string) {
    const m = this.messageById(id);
    if (!m) return;
    this.messages.set(m.chatId, (this.messages.get(m.chatId) ?? []).filter(x => x.id !== id));
    await this.store.delete(`msg/${m.chatId}/${id}`);
    this.changed(`messages:${m.chatId}`);
    const orig = this.originalOf(m);
    if (orig) this.changed(`messages:${orig.chatId}`);
    if (this.savedCopy(m)) this.changed(`messages:${SELF_CHAT}`);
  }

  private async senderContact(p: ParsedMessage): Promise<Contact | undefined> {
    const fp = p.signature!;
    if (p.autocrypt && p.autocrypt.fingerprint === fp) {
      return this.upsertContact(fp, p.from.addr, p.autocrypt.key, p.from.name);
    }
    const c = this.contacts.get(fp);
    if (c && p.from.name && cleanName(p.from.name) !== c.name) {
      await this.saveContact({ ...c, name: cleanName(p.from.name) });
    }
    return this.contacts.get(fp);
  }

  private timestamp(p: ParsedMessage): number {
    const t = Date.parse(p.headers['date'] ?? '');
    return Number.isFinite(t) ? Math.min(t, Date.now()) : Date.now();
  }

  private async handleChatMessage(p: ParsedMessage, mid: string, sender: Contact) {
    const grpid = p.headers['chat-group-id'];
    let chat: Chat;
    if (grpid) {
      const found = await this.groupChat(p, grpid, sender);
      if (!found) return;
      chat = found;
    } else {
      chat = await this.singleChat(sender.fingerprint, !this.isAccepted(sender));
    }
    await this.applyMessage(p, mid, chat, sender.fingerprint);
  }

  private async applyMessage(p: ParsedMessage, mid: string, chat: Chat, from: string) {
    await this.applyTimer(p, chat, from);
    const edit = stripMid(p.headers['chat-edit']);
    const del = p.headers['chat-delete'];
    if (edit) {
      const orig = this.messageById(edit);
      if (orig && orig.from === from) await this.saveMessage({ ...orig, text: p.text.startsWith(EDITED_PREFIX) ? p.text.slice(EDITED_PREFIX.length) : p.text, edited: true });
      return;
    }
    if (del) {
      for (const id of del.split(/\s+/).map(stripMid)) {
        const orig = this.messageById(id);
        if (orig && orig.from === from) {
          this.messages.set(orig.chatId, (this.messages.get(orig.chatId) ?? []).filter(m => m.id !== id));
          await this.store.delete(`msg/${orig.chatId}/${id}`);
          this.changed(`messages:${orig.chatId}`);
        }
      }
      return;
    }
    if (p.is_reaction) {
      const target = this.messageById(stripMid(p.headers['in-reply-to']));
      if (target) {
        const reactions = { ...target.reactions };
        const r = p.text.trim().slice(0, 32);
        if (r) reactions[from] = r;
        else delete reactions[from];
        await this.saveMessage({ ...target, reactions });
        // Like core's IncomingReaction: only reactions to own messages notify.
        if (r && target.from === 'self' && from !== 'self') {
          this.dispatchEvent(new CustomEvent('incoming', { detail: { chatId: target.chatId, from, msgId: target.id, reaction: r } }));
        }
      }
      return;
    }
    const own = from === 'self';
    const info = this.systemInfo(p, from);
    if (info !== undefined) {
      if (info === null) return;
      const content = p.headers['chat-content'];
      const pin = content === 'message-pinned' || content === 'message-unpinned' ? this.messageById(stripMid(p.headers['in-reply-to'])) : undefined;
      if (pin && pin.chatId === chat.id) await this.applyPin(p, pin, chat, from);
      await this.saveMessage({
        id: mid, chatId: chat.id, from, text: info, timestamp: this.timestamp(p),
        state: 'received', info: true, attachments: [], reactions: {}, replyTo: pin?.id,
      });
      if (p.headers['chat-content'] !== 'message-unpinned') {
        chat.lastActivity = Date.now();
        this.unarchive(chat);
        await this.saveChat(chat);
      }
      return;
    }
    if (!p.text && !p.attachments.length) return;

    await this.saveMessage({
      id: mid, chatId: chat.id, from, text: p.text, timestamp: this.timestamp(p),
      quote: p.quote ?? undefined, replyTo: p.quote !== null ? stripMid(p.headers['in-reply-to']) || undefined : undefined,
      state: own ? 'sent' : 'received', attachments: p.attachments, reactions: {},
      unseenUid: !own && this.currentUid ? { uid: this.currentUid, validity: this.config.uidValidity } : undefined,
      wantsMdn: !own && p.encrypted && !!p.headers['chat-disposition-notification-to'] || undefined,
      ...this.ephemeralFields(p, own),
    });
    chat.lastActivity = Date.now();
    if (!own) chat.unread += 1;
    this.unarchive(chat);
    await this.saveChat(chat);
    if (!own) this.dispatchEvent(new CustomEvent('incoming', { detail: { chatId: chat.id, from, msgId: mid } }));
  }

  /** Like core's parse_system_message_headers(); undefined: not a system message, null: nothing to show. */
  private systemInfo(p: ParsedMessage, from: string): string | null | undefined {
    const own = from === 'self';
    const name = this.contactName(from);
    const say = (other: Key, mine: Key, vars: Record<string, string> = {}) => t(own ? mine : other, { name, ...vars });
    const content = p.headers['chat-content'];
    if (content) {
      switch (content) {
        case 'message-pinned': return say('info.pinned', 'info.youPinned');
        case 'message-unpinned': return say('info.unpinned', 'info.youUnpinned');
        case 'group-avatar-changed': return p.headers['chat-group-avatar']?.trim() === '0'
          ? say('info.groupImageDeleted', 'info.youGroupImageDeleted') : say('info.groupImage', 'info.youGroupImage');
        case 'ephemeral-timer-changed': return this.timerInfo(ephemeralTimer(p), from);
        case 'location-streaming-enabled': return say('info.location', 'info.youLocation');
        case 'protection-enabled': case 'protection-disabled': case 'call-accepted': case 'call-ended': return null;
        default: return undefined;
      }
    }
    const removed = p.headers['chat-group-member-removed'];
    const added = p.headers['chat-group-member-added'];
    // groupChat() reports changes made by others.
    if (removed) return own ? t(addrEq(removed, this.config.addr) ? 'info.youLeft' : 'info.youRemoved', { addr: removed }) : null;
    if (added) return own ? t('info.youAdded', { addr: added }) : null;
    const oldName = p.headers['chat-group-name-changed'];
    if (oldName !== undefined) return say('info.groupName', 'info.youGroupName', { old: cleanName(oldName), new: cleanName(p.headers['chat-group-name'] ?? '') });
    if (p.headers['chat-group-description-changed'] !== undefined) return say('info.groupDescription', 'info.youGroupDescription');
    return undefined;
  }

  /** Resolves recipients to member fingerprints like core's receive_imf does. */
  private recipientFingerprints(p: ParsedMessage): string[] {
    const fprs = (p.headers['chat-group-member-fpr'] ?? '').split(/\s+/).filter(Boolean);
    if (fprs.length >= p.recipients.length && fprs.length > 0) return fprs.slice(0, p.recipients.length);
    return p.recipients
      .map(r => [...this.contacts.values()].find(c => addrEq(c.addr, r.addr) && c.publicKey)?.fingerprint)
      .filter((fp): fp is string => !!fp);
  }

  private async groupChat(p: ParsedMessage, grpid: string, sender: Contact): Promise<Chat | undefined> {
    const self = this.config.fingerprint;
    const removed = p.headers['chat-group-member-removed'];
    const added = p.headers['chat-group-member-added'];
    let chat = this.groupByGrpid(grpid);
    if (!chat) {
      if (removed && addrEq(removed, this.config.addr)) return undefined;
      chat = {
        id: `g-${createId()}`, type: 'group', name: cleanName(p.headers['chat-group-name'] ?? '') || t('group.default'), grpid,
        members: [], isRequest: !this.isAccepted(sender), left: false, lastActivity: Date.now(), unread: 0,
      };
    }
    const isNew = !this.chats.has(chat.id);
    const senderIsMember = chat.members.includes(sender.fingerprint);
    if (isNew || senderIsMember || (added && addrEq(added, this.config.addr))) {
      const members = new Set(this.recipientFingerprints(p).filter(fp => fp !== self && this.contacts.has(fp)));
      members.add(sender.fingerprint);
      if (removed) {
        if (addrEq(removed, this.config.addr)) {
          chat.left = true;
          await this.addInfo(chat.id, t('info.removedYou', { name: this.contactName(sender.fingerprint) }));
        } else {
          for (const fp of members) if (addrEq(this.contacts.get(fp)?.addr ?? '', removed)) members.delete(fp);
          const name = this.contactName(sender.fingerprint);
          await this.addInfo(chat.id, addrEq(removed, sender.addr) ? t('info.left', { name }) : t('info.removed', { addr: removed, name }));
        }
      }
      if (added) {
        if (addrEq(added, this.config.addr)) {
          chat.left = false;
          if (!p.headers['secure-join']) await this.addInfo(chat.id, t('info.addedYou', { name: this.contactName(sender.fingerprint) }));
        } else await this.addInfo(chat.id, t('info.added', { addr: added, name: this.contactName(sender.fingerprint) }));
      }
      chat.members = [...members];
      const name = cleanName(p.headers['chat-group-name'] ?? '');
      if (name && name !== chat.name) chat.name = name;
      this.applyGroupAvatar(chat, p);
    }
    await this.saveChat(chat);
    return chat;
  }

  // ---------------------------------------------------------------- securejoin (see core src/securejoin.rs)

  /** Core attaches the own avatar to vc-request-with-auth and vc-contact-confirm. */
  private async handshakeAvatar(p: ParsedMessage) {
    const avatar = p.headers['chat-user-avatar'];
    if (avatar !== undefined && p.signature) await this.applyAvatar(p.signature, avatar, this.timestamp(p));
  }

  private async handleSecureJoin(p: ParsedMessage): Promise<HandshakeResult> {
    const self = this.config.fingerprint;
    const step = p.headers['secure-join-invitenumber'] ? 'vc-request' : p.headers['secure-join'];

    if (!['vc-request', 'vc-request-pubkey', 'vc-pubkey'].includes(step)) {
      // Protect against surreptitious forwarding: the message must gossip our own key.
      if (!p.gossip.some(g => g.fingerprint === self)) return 'ignore';
    }

    switch (step) {
      case 'vc-request': {
        if (p.headers['secure-join-invitenumber'] !== this.config.inviteNumber || !p.autocrypt) return 'ignore';
        const c = await this.upsertContact(p.autocrypt.fingerprint, p.from.addr, p.autocrypt.key);
        if (c.blocked) return 'ignore';
        await this.sendHandshake(c, 'vc-auth-required');
        return 'done';
      }
      case 'vc-request-pubkey': {
        const auth = p.headers['secure-join-auth'];
        if (!auth || p.symmetric_secret_id !== `auth:${auth}` || !this.tokens.has(auth)) return 'ignore';
        if ([...this.contacts.values()].some(c => c.blocked && addrEq(c.addr, p.from.addr))) return 'ignore';
        await this.send({
          to: [], subject: 'Secure-Join', text: 'Secure-Join',
          headers: [
            { name: 'Secure-Join', value: 'vc-pubkey', kind: 'raw' },
            { name: 'Secure-Join-Auth', value: auth, kind: 'text' },
          ],
          encryption: { kind: 'symmetric', secret: `securejoin/${self}/${auth}` },
          attach_pubkey: true, sign: true, compress: false, from_name: '',
        }, [p.from.addr]);
        return 'done';
      }
      case 'vc-pubkey':
      case 'vc-auth-required':
      case 'vg-auth-required': {
        let handled = false;
        for (const b of this.bob.values()) {
          if (b.stage !== 'pubkey' || !p.encrypted || p.signature !== b.invite.fingerprint) continue;
          if (p.symmetric_secret_id && p.symmetric_secret_id !== `bob:${b.id}`) continue;
          const key = p.autocrypt?.fingerprint === b.invite.fingerprint ? p.autocrypt.key : this.contacts.get(b.invite.fingerprint)?.publicKey;
          if (!key) continue;
          const alice = await this.upsertContact(b.invite.fingerprint, b.invite.addrs[0], key, b.invite.name);
          await this.sendRequestWithAuth(b.invite, alice);
          b.stage = 'confirm';
          await this.store.put(`bob/${b.id}`, b);
          handled = true;
        }
        return handled ? 'done' : 'ignore';
      }
      case 'vc-request-with-auth':
      case 'vg-request-with-auth': {
        if (!p.encrypted || !p.signature) return 'ignore';
        const fp = (p.headers['secure-join-fingerprint'] ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
        if (fp !== p.signature) return 'ignore';
        const token = this.tokens.get(p.headers['secure-join-auth'] ?? '');
        if (!token) return 'ignore';
        const bobContact = await this.senderContact(p);
        if (!bobContact || bobContact.fingerprint !== fp || bobContact.blocked) return 'ignore';
        await this.saveContact({ ...bobContact, verified: true });
        await this.handshakeAvatar(p);
        const bob = this.contacts.get(fp)!;
        if (token.grpid) {
          const chat = this.groupByGrpid(token.grpid);
          if (!chat || chat.left) return 'ignore';
          if (!chat.members.includes(fp)) chat.members.push(fp);
          await this.saveChat(chat);
          const members = this.memberContacts(chat);
          const mid = await this.send({
            to: members.map(m => ({ name: m.name, addr: m.addr })),
            subject: chat.name, text: `Member ${bob.addr} added.`,
            headers: [
              { name: 'Chat-Version', value: '1.0', kind: 'raw' },
              ...this.groupHeaders(chat, members, !!chat.avatar),
              { name: 'Chat-Group-Member-Added', value: bob.addr, kind: 'raw' },
              { name: 'Secure-Join', value: 'vg-member-added', kind: 'raw' },
            ],
            gossip: members.map(m => ({ addr: m.addr, key: m.publicKey })),
            encryption: { kind: 'asymmetric', keys: members.map(m => m.publicKey) },
            attach_pubkey: true, sign: true, compress: false,
          }, members.flatMap(m => m.relays), true);
          await this.saveMessage({
            id: mid, chatId: chat.id, from: 'self', text: t('info.joinedGroup', { name: this.contactName(fp) }),
            timestamp: Date.now(), state: 'sent', info: true, attachments: [], reactions: {},
          });
          return 'done';
        }
        const chat = await this.singleChat(fp, false);
        if (chat.isRequest) await this.acceptChat(chat.id);
        await this.sendHandshake(bob, 'vc-contact-confirm');
        await this.addInfo(chat.id, t('info.joinedInvite', { name: this.contactName(fp) }));
        return 'ignore';
      }
      case 'vc-contact-confirm': {
        for (const b of [...this.bob.values()]) {
          if (b.stage !== 'confirm' || b.invite.group || p.signature !== b.invite.fingerprint) continue;
          await this.handshakeAvatar(p);
          await this.finishBob(b, t('info.connected'));
        }
        return 'ignore';
      }
      case 'vg-member-added': {
        const added = p.headers['chat-group-member-added'] ?? '';
        if (addrEq(added, this.config.addr)) {
          for (const b of [...this.bob.values()]) {
            if (b.stage === 'confirm' && b.invite.group?.grpid === p.headers['chat-group-id'] && p.signature === b.invite.fingerprint) {
              await this.finishBob(b, t('info.youJoined'));
            }
          }
        }
        return 'propagate';
      }
      case 'vg-member-added-received':
      case 'vc-contact-confirm-received':
        return 'done';
      default:
        return 'ignore';
    }
  }

  private async finishBob(b: BobState, info: string) {
    const c = this.contacts.get(b.invite.fingerprint);
    if (c) await this.saveContact({ ...c, verified: true });
    this.bob.delete(b.id);
    await this.store.delete(`bob/${b.id}`);
    await this.addInfo(b.chatId, info);
  }

  // ---------------------------------------------------------------- IMAP loop

  start() {
    if (this.abort) return;
    this.abort = new AbortController();
    void this.run(this.abort.signal);
    this.scheduleEphemeral();
  }

  stop() {
    this.abort?.abort();
    this.abort = undefined;
    clearTimeout(this.ephemeralTimeout);
  }

  /** Interrupts IDLE so new messages are fetched immediately. */
  poke() {
    this.wakeImap?.();
  }

  private async flushDeletes(imap: ImapClient) {
    if (!this.deleteQueue.size) return;
    const uids = [...this.deleteQueue].sort((a, b) => a - b);
    await imap.deleteUids(uids);
    for (const uid of uids) this.deleteQueue.delete(uid);
    await this.store.put('deleteQueue', [...this.deleteQueue]);
  }

  /** Like core's ephemeral_loop: wakes up for the next message that expires. */
  private scheduleEphemeral() {
    clearTimeout(this.ephemeralTimeout);
    if (!this.abort) return;
    let next = Infinity;
    for (const list of this.messages.values()) for (const m of list) if (m.ephemeralAt && m.ephemeralAt < next) next = m.ephemeralAt;
    if (next === Infinity) return;
    // setTimeout overflows above 2^31 ms; a timer of a year just wakes up earlier and reschedules.
    this.ephemeralTimeout = setTimeout(() => void this.deleteExpired(), Math.min(Math.max(0, next - Date.now()), 2 ** 31 - 1));
  }

  /** Like core's delete_expired_messages(): here and, for messages still on the server, there. */
  private async deleteExpired() {
    const now = Date.now();
    const expired = [...this.messages.values()].flat().filter(m => m.ephemeralAt && m.ephemeralAt <= now);
    for (const m of expired) {
      if (m.serverUid?.validity === this.config.uidValidity) this.deleteQueue.add(m.serverUid.uid);
      await this.deleteLocally(m.id);
    }
    if (expired.some(m => m.serverUid)) {
      await this.store.put('deleteQueue', [...this.deleteQueue]);
      this.poke();
    }
    this.scheduleEphemeral();
  }

  /** Like core's start_ephemeral_timer(): the countdown starts once a message was seen. */
  private async startTimers(msgs: Message[]) {
    const now = Date.now();
    for (const m of msgs) if (m.ephemeralTimer && !m.ephemeralAt) await this.saveMessage({ ...m, ephemeralAt: now + m.ephemeralTimer * 1000 });
  }

  /** Like core's receive_imf(): only members change pins; Kitepost also keeps them to their chat. */
  private async applyPin(p: ParsedMessage, target: Message, chat: Chat, from: string) {
    const member = from === 'self' || chat.left || chat.type !== 'group' || chat.members.includes(from);
    if (member && pinnable(target)) await this.saveMessage({ ...target, pinned: p.headers['chat-content'] === 'message-pinned' || undefined });
  }

  /**
   * Kitepost before pinning stored pin messages without their target and does not fetch mail
   * twice, so this applies them once from the copies still on the server.
   */
  private async repairPins(imap: ImapClient) {
    const found: { p: ParsedMessage; mid: string; from: string }[] = [];
    // Pin messages carry no attachment; this leaves out the large mails.
    await imap.fetchUids(await imap.searchSmall(65_536), async m => {
      let p: ParsedMessage;
      try {
        p = parseMessage(m.body, this.parseContext());
      } catch {
        return;
      }
      const content = p.headers['chat-content'];
      const mid = stripMid(p.headers['message-id']);
      if ((content !== 'message-pinned' && content !== 'message-unpinned') || !mid || !p.encrypted || !p.signature) return;
      const own = addrEq(p.from.addr, this.config.addr);
      if (own ? p.signature !== this.config.fingerprint : !this.contacts.get(p.signature)) return;
      found.push({ p, mid, from: own ? 'self' : p.signature });
    });
    found.sort((a, b) => this.timestamp(a.p) - this.timestamp(b.p));
    for (const { p, mid, from } of found) {
      const target = this.messageById(stripMid(p.headers['in-reply-to']));
      const chat = target && this.chats.get(target.chatId);
      if (!target || !chat) continue;
      await this.applyPin(p, target, chat, from);
      const stored = this.messageById(mid);
      if (stored && stored.chatId === chat.id) {
        await this.saveMessage({ ...stored, info: true, text: this.systemInfo(p, from) ?? stored.text, replyTo: target.id, quote: undefined, attachments: [] });
      }
    }
    this.config.pinsRepaired = true;
    await this.saveConfig();
  }

  /** Sets disappearing messages for everyone in the chat, like core's set_ephemeral_timer(). */
  async setEphemeralTimer(chatId: string, seconds: number) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('unknown chat');
    if ((chat.ephemeralTimer ?? 0) === seconds) return;
    if (chat.left) throw new Error(t('error.notMember'));
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (chat.type === 'single' && !members.length) throw new Error(t('error.noKey'));
    // Set first, so that the system message carries the new Ephemeral-Timer header.
    chat.ephemeralTimer = seconds || undefined;
    chat.ephemeralSetAt = Date.now();
    await this.saveChat(chat);
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'Chat-Content', value: 'ephemeral-timer-changed', kind: 'raw' },
    ];
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
    const text = this.timerInfo(seconds, 'self');
    const mid = await this.sendToChat(chat, members, { text, headers });
    await this.saveMessage({
      id: mid, chatId, from: 'self', text, timestamp: Date.now(), addedAt: Date.now(), state: 'sent', info: true, attachments: [], reactions: {},
    });
  }

  /** Like core's stock_ephemeral_timer_changed(). */
  private timerInfo(seconds: number, from: string): string {
    const own = from === 'self';
    if (!seconds) return t(own ? 'info.youTimerOff' : 'info.timerOff', { name: this.contactName(from) });
    return t(own ? 'info.youTimer' : 'info.timer', { name: this.contactName(from), duration: formatDuration(seconds) });
  }

  /**
   * Applies the Ephemeral-Timer of a received message to its chat, like core's receive_imf(): only
   * from members and only if newer than the last change. Core's check against the sender's
   * previous message, which prevents rollbacks by senders who missed a change, needs References
   * and is left out.
   */
  private async applyTimer(p: ParsedMessage, chat: Chat, from: string) {
    const timer = ephemeralTimer(p);
    const visible = p.text || p.attachments.length || p.is_reaction || p.headers['chat-content'];
    if (!visible || (chat.ephemeralTimer ?? 0) === timer) return;
    const member = from === 'self' || chat.left || chat.type !== 'group' || chat.members.includes(from);
    const ts = this.timestamp(p);
    if (!member || ts < (chat.ephemeralSetAt ?? 0)) return;
    chat.ephemeralTimer = timer || undefined;
    chat.ephemeralSetAt = ts;
    await this.saveChat(chat);
    if (p.headers['chat-content'] !== 'ephemeral-timer-changed') {
      await this.saveMessage({
        id: `timer-${createId()}`, chatId: chat.id, from, text: this.timerInfo(timer, from), timestamp: ts,
        state: 'received', info: true, attachments: [], reactions: {},
      });
    }
  }

  private async flushSeen(imap: ImapClient) {
    if (!this.seenQueue.size) return;
    const uids = [...this.seenQueue].sort((a, b) => a - b);
    await imap.markSeen(uids);
    for (const uid of uids) this.seenQueue.delete(uid);
    await this.store.put('seenQueue', [...this.seenQueue]);
  }

  private async run(signal: AbortSignal) {
    let backoff = 2000;
    while (!signal.aborted) {
      let imap: ImapClient | undefined;
      try {
        this.setStatus('connecting');
        imap = await ImapClient.connect(this.config.bridgeUrl, this.config.imapHost);
        await imap.login(this.config.addr, this.config.password);
        const sel = await imap.select('INBOX');
        if (sel.uidValidity !== this.config.uidValidity) {
          this.config.uidValidity = sel.uidValidity;
          this.config.lastUid = 0;
          this.seenQueue.clear();
          await this.saveConfig();
        }
        this.setStatus('connected');
        backoff = 2000;
        if (!this.config.pinsRepaired) await this.repairPins(imap);
        while (!signal.aborted) {
          const toDelete: number[] = [];
          await this.flushSeen(imap);
          await this.flushDeletes(imap);
          await imap.fetchNewer(this.config.lastUid, async m => {
            this.currentUid = m.uid;
            try {
              if (await this.receive(m.body)) toDelete.push(m.uid);
            } finally {
              this.currentUid = undefined;
            }
            this.config.lastUid = Math.max(this.config.lastUid, m.uid);
            await this.saveConfig();
          });
          await imap.deleteUids(toDelete);
          const idleAbort = new AbortController();
          const onAbort = () => idleAbort.abort();
          signal.addEventListener('abort', onAbort, { once: true });
          this.wakeImap = onAbort;
          try {
            await imap.idle(idleAbort.signal);
          } finally {
            signal.removeEventListener('abort', onAbort);
            this.wakeImap = undefined;
          }
        }
        await imap.logout();
      } catch (e) {
        imap?.close();
        if (signal.aborted) break;
        console.warn('IMAP error', e);
        this.setStatus(`offline: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    this.setStatus('offline');
  }
}
