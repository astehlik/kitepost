import { t } from '../i18n';
import { ImapClient } from '../net/imap';
import { SmtpClient, SmtpError } from '../net/smtp';
import type { Store } from '../store';
import type { BackupProfile } from './backup';
import { backupFileName, buildBackup } from './backup-export';
import {
  generateKeypair, parseMessage, publicKeyInfo, renderMessage,
  type AttachmentData, type OutgoingMessage, type ParsedMessage,
} from '../wasm';
import { buildContactInvite, buildGroupInvite, parseInvite, type Invite } from './invite';
import { SELF_CHAT, type AuthToken, type BobState, type Chat, type Config, type Contact, type Message } from './types';

export function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

function createMid(): string {
  return `${crypto.randomUUID()}@localhost`;
}

function stripMid(v: string | undefined): string {
  return (v ?? '').trim().replace(/^<|>$/g, '');
}

function cleanName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100);
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
    return new DcClient(store, config);
  }

  static async importBackup(store: Store, b: BackupProfile, bridgeUrl: string): Promise<DcClient> {
    const imap = await ImapClient.connect(bridgeUrl, b.host);
    try {
      await imap.login(b.addr, b.password);
    } finally {
      imap.close();
    }
    const config: Config = {
      addr: b.addr, password: b.password, imapHost: b.host, smtpHost: b.host, displayName: cleanName(b.displayName),
      secretKey: b.secretKey, publicKey: b.publicKey, fingerprint: b.fingerprint,
      inviteNumber: b.inviteNumber ?? createId(), uidValidity: b.uidValidity, lastUid: b.lastUid, bridgeUrl, bccSelf: true,
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
    for (const list of c.messages.values()) list.sort((a, b) => a.timestamp - b.timestamp);
    for (const id of (await store.get<string[]>('seen')) ?? []) c.seen.add(id);
    for (const uid of (await store.get<number[]>('seenQueue')) ?? []) c.seenQueue.add(uid);
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
      list.push(m);
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    this.messages.set(m.chatId, list);
    this.seen.add(m.id);
    await this.store.put(`msg/${m.chatId}/${m.id}`, m);
    this.changed(`messages:${m.chatId}`);
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
    return c ? c.name || c.addr : fp.slice(0, 8);
  }

  private async upsertContact(fp: string, addr: string, key: string, name?: string): Promise<Contact> {
    const existing = this.contacts.get(fp);
    const info = publicKeyInfo(addr, key);
    if (info.fingerprint !== fp) throw new Error('fingerprint mismatch');
    const contact: Contact = {
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

  private groupByGrpid(grpid: string): Chat | undefined {
    return [...this.chats.values()].find(c => c.grpid === grpid);
  }

  chatTitle(chat: Chat): string {
    if (chat.type === 'self') return t('chat.saved');
    return chat.type === 'single' && chat.contact ? this.contactName(chat.contact) : chat.name;
  }

  sortedChats(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async acceptChat(chatId: string) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.isRequest = false;
    await this.saveChat(chat);
  }

  async blockChat(chatId: string) {
    const chat = this.chats.get(chatId);
    if (chat?.contact) {
      const c = this.contacts.get(chat.contact);
      if (c) await this.saveContact({ ...c, blocked: true });
    }
    await this.deleteChat(chatId);
  }

  async deleteChat(chatId: string) {
    for (const m of this.messages.get(chatId) ?? []) await this.store.delete(`msg/${chatId}/${m.id}`);
    this.messages.delete(chatId);
    this.chats.delete(chatId);
    await this.store.delete(`chat/${chatId}`);
    this.changed('chats');
  }

  async markRead(chatId: string) {
    const chat = this.chats.get(chatId);
    if (chat && chat.unread) {
      chat.unread = 0;
      await this.saveChat(chat);
    }
    const read: string[] = [];
    for (const m of this.messages.get(chatId) ?? []) {
      if (!m.unseenUid) continue;
      if (m.unseenUid.validity === this.config.uidValidity) this.seenQueue.add(m.unseenUid.uid);
      await this.saveMessage({ ...m, unseenUid: undefined });
      read.push(m.id);
    }
    if (!read.length) return;
    await this.store.put('seenQueue', [...this.seenQueue]);
    this.poke();
    // Other devices learn about read messages from a receipt to self, not from IMAP flags.
    if (this.config.bccSelf) await this.sendSelfMdn(read).catch(e => console.warn('self MDN failed', e));
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

  async setDisplayName(name: string) {
    this.config.displayName = cleanName(name);
    await this.saveConfig();
    this.changed('config');
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
    await this.send({
      to: [{ name: alice.name, addr: alice.addr }], subject: 'Secure-Join', text: 'Secure-Join: vc-request-with-auth',
      headers, gossip: [{ addr: alice.addr, key: alice.publicKey }],
      encryption: { kind: 'asymmetric', keys: [alice.publicKey] }, attach_pubkey: true, sign: true, compress: false,
    }, alice.relays);
  }

  private async sendHandshake(contact: Contact, step: string, extra: OutgoingMessage['headers'] = []) {
    await this.send({
      to: [{ name: contact.name, addr: contact.addr }], subject: 'Secure-Join', text: `Secure-Join: ${step}`,
      headers: [
        { name: 'Chat-Version', value: '1.0', kind: 'raw' },
        { name: 'Secure-Join', value: step, kind: 'raw' },
        ...extra,
      ],
      gossip: [{ addr: contact.addr, key: contact.publicKey }],
      encryption: { kind: 'asymmetric', keys: [contact.publicKey] }, attach_pubkey: true, sign: true, compress: false,
    }, contact.relays);
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

  private groupHeaders(chat: Chat, members: Contact[]): OutgoingMessage['headers'] {
    return [
      { name: 'Chat-Group-ID', value: chat.grpid!, kind: 'raw' },
      { name: 'Chat-Group-Name', value: chat.name, kind: 'text' },
      { name: 'Chat-Group-Member-Fpr', value: members.map(m => m.fingerprint).join(' '), kind: 'raw' },
    ];
  }

  async sendText(chatId: string, text: string, attachment?: AttachmentData) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('unknown chat');
    if (chat.left) throw new Error(t('error.notMember'));
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (!self && !members.length) throw new Error(t('error.noKey'));

    const msgs = this.messages.get(chatId) ?? [];
    const last = [...msgs].reverse().find(m => !m.info && m.state !== 'failed');
    const headers: OutgoingMessage['headers'] = [{ name: 'Chat-Version', value: '1.0', kind: 'raw' }];
    if (last) headers.push({ name: 'In-Reply-To', value: last.id, kind: 'messageid' });
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));

    const local: Message = {
      id: `pending-${createId()}`, chatId, from: 'self', text, timestamp: Date.now(), state: 'pending',
      attachments: attachment ? [attachment] : [], reactions: {},
    };
    await this.saveMessage(local);
    if (chat.isRequest) await this.acceptChat(chatId);
    try {
      // Like core, notes to self only go to the server when another device needs them.
      const mid = self && !this.config.bccSelf ? createMid() : await this.send({
        to: self ? [{ name: '', addr: this.config.addr }] : members.map(m => ({ name: m.name, addr: m.addr })),
        subject: chat.type === 'group' ? chat.name : `Message from ${this.config.displayName || this.config.addr}`,
        text, headers, attachment,
        gossip: members.length > 1 ? members.map(m => ({ addr: m.addr, key: m.publicKey })) : [],
        encryption: { kind: 'asymmetric', keys: members.map(m => m.publicKey) },
        attach_pubkey: true, sign: true, compress: true,
      }, members.flatMap(m => m.relays), true);
      await this.store.delete(`msg/${chatId}/${local.id}`);
      this.messages.set(chatId, (this.messages.get(chatId) ?? []).filter(m => m.id !== local.id));
      await this.saveMessage({ ...local, id: mid, state: 'sent' });
    } catch (e) {
      await this.saveMessage({ ...local, state: 'failed', error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    chat.lastActivity = Date.now();
    await this.saveChat(chat);
  }

  /** Sets or, with an empty string, removes the own reaction, like core's send_reaction(). */
  async sendReaction(chatId: string, msgId: string, reaction: string) {
    const chat = this.chats.get(chatId);
    const target = this.messages.get(chatId)?.find(m => m.id === msgId);
    if (!chat || !target || target.info || !msgId.includes('@')) throw new Error('unknown message');
    const self = chat.type === 'self';
    const members = self ? [] : this.memberContacts(chat);
    if (!self && !members.length) throw new Error(t('error.noKey'));
    const headers: OutgoingMessage['headers'] = [
      { name: 'Chat-Version', value: '1.0', kind: 'raw' },
      { name: 'In-Reply-To', value: msgId, kind: 'messageid' },
    ];
    if (chat.type === 'group') headers.push(...this.groupHeaders(chat, members));
    if (!self || this.config.bccSelf) {
      await this.send({
        to: self ? [{ name: '', addr: this.config.addr }] : members.map(m => ({ name: m.name, addr: m.addr })),
        subject: chat.type === 'group' ? chat.name : `Message from ${this.config.displayName || this.config.addr}`,
        text: reaction, content_disposition: 'reaction', headers,
        encryption: { kind: 'asymmetric', keys: members.map(m => m.publicKey) },
        attach_pubkey: true, sign: true, compress: true,
      }, members.flatMap(m => m.relays), true);
    }
    const reactions = { ...target.reactions };
    if (reaction) reactions.self = reaction;
    else delete reactions.self;
    await this.saveMessage({ ...target, reactions });
  }

    async createGroup(name: string, memberFps: string[]): Promise<string> {
    const chat: Chat = {
      id: `g-${createId()}`, type: 'group', name: cleanName(name) || t('group.default'), grpid: createId(),
      members: memberFps.filter(fp => this.contacts.get(fp)?.publicKey), isRequest: false, left: false,
      lastActivity: Date.now(), unread: 0,
    };
    await this.saveChat(chat);
    await this.addInfo(chat.id, t('info.groupCreated'));
    return chat.id;
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
    if (!sender || sender.blocked) return false;

    for (const g of p.gossip) {
      if (g.fingerprint !== this.config.fingerprint && g.can_encrypt && !this.contacts.get(g.fingerprint)?.publicKey) {
        await this.upsertContact(g.fingerprint, g.addr, g.key).catch(() => undefined);
      }
    }

    if (p.mdn_for.length) {
      for (const id of p.mdn_for) {
        const m = this.messageById(id);
        if (m && m.from === 'self' && m.state === 'sent') await this.saveMessage({ ...m, state: 'read' });
      }
      return false;
    }
    await this.handleChatMessage(p, mid, sender);
    return false;
  }

  /** Messages sent by another device of this profile, like core's receive_imf for outgoing messages. */
  private async receiveOwn(p: ParsedMessage, mid: string) {
    if (!p.encrypted || p.signature !== this.config.fingerprint) return;
    if (!this.config.bccSelf) {
      this.config.bccSelf = true;
      await this.saveConfig();
    }
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
      const members = this.recipientFingerprints(p).filter(fp => fp !== this.config.fingerprint && this.contacts.has(fp));
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
      const save = data?.SaveMessage as { src?: string; dest?: string } | undefined;
      const del = data?.DeleteMessages as { msgs?: string[] } | undefined;
      if (save?.src && save.dest && !this.messageById(save.dest)) {
        const orig = this.messageById(save.src);
        if (!orig || orig.info) continue;
        const chat = await this.selfChat();
        await this.saveMessage({ ...orig, id: save.dest, chatId: chat.id, reactions: {}, unseenUid: undefined, edited: undefined });
        chat.lastActivity = Date.now();
        await this.saveChat(chat);
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
    const edit = stripMid(p.headers['chat-edit']);
    const del = p.headers['chat-delete'];
    if (edit) {
      const orig = this.messageById(edit);
      if (orig && orig.from === from) await this.saveMessage({ ...orig, text: p.text, edited: true });
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
      }
      return;
    }
    if (!p.text && !p.attachments.length) return;

    const own = from === 'self';
    await this.saveMessage({
      id: mid, chatId: chat.id, from, text: p.text, timestamp: this.timestamp(p),
      state: own ? 'sent' : 'received', attachments: p.attachments, reactions: {},
      unseenUid: !own && this.currentUid ? { uid: this.currentUid, validity: this.config.uidValidity } : undefined,
    });
    chat.lastActivity = Date.now();
    if (!own) chat.unread += 1;
    await this.saveChat(chat);
    if (!own) this.dispatchEvent(new CustomEvent('incoming', { detail: { chatId: chat.id, from } }));
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
          await this.addInfo(chat.id, t('info.removed', { addr: removed, name: this.contactName(sender.fingerprint) }));
        }
      }
      if (added) {
        if (addrEq(added, this.config.addr)) chat.left = false;
        else await this.addInfo(chat.id, t('info.added', { addr: added, name: this.contactName(sender.fingerprint) }));
      }
      chat.members = [...members];
      const name = cleanName(p.headers['chat-group-name'] ?? '');
      if (name && name !== chat.name) chat.name = name;
    }
    await this.saveChat(chat);
    return chat;
  }

  // ---------------------------------------------------------------- securejoin (see core src/securejoin.rs)

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
              ...this.groupHeaders(chat, members),
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
  }

  stop() {
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Interrupts IDLE so new messages are fetched immediately. */
  poke() {
    this.wakeImap?.();
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
        while (!signal.aborted) {
          const toDelete: number[] = [];
          await this.flushSeen(imap);
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
