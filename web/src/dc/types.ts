import type { AttachmentData } from '../wasm';

/** A further relay of the profile, like a row of core's `transports` table. */
export interface Relay {
  addr: string;
  password: string;
  host: string;
  /** Seconds, like core's add_timestamp, which removals from other devices are compared with. */
  addedAt: number;
  uidValidity: number;
  lastUid: number;
  /** Core's login parameters as received, for backups. */
  entered?: unknown;
  configured?: unknown;
}

/** Where a mail lies on the server; `relay` is unset for the profile's own address. */
export interface ServerUid {
  uid: number;
  validity: number;
  relay?: string;
}

export interface Config {
  addr: string;
  password: string;
  imapHost: string;
  smtpHost: string;
  displayName: string;
  /** Data URL of the own avatar, like core's selfavatar, and when it last changed. */
  avatar?: string;
  avatarChangedAt?: number;
  secretKey: string;
  publicKey: string;
  fingerprint: string;
  inviteNumber: string;
  uidValidity: number;
  lastUid: number;
  bridgeUrl: string;
  /** Another device uses this profile: copy sent messages to self, as core's bcc_self does. */
  bccSelf?: boolean;
  /** Request and send read receipts, on unless turned off, like core's mdns_enabled. */
  readReceipts?: boolean;
  /** Pins received before Kitepost knew them were applied from the mail still on the server. */
  pinsRepaired?: boolean;
  /** What notifications show, like Delta Chat's setting; everything when unset. */
  notifyDetails?: 'sender' | 'none';
  /** A backup was downloaded or another device has the profile, so losing the browser loses nothing. */
  secured?: boolean;
  /** Last time a message from the own address came with another key, and when the warning was hidden. */
  foreignKeyAt?: number;
  foreignKeyHiddenAt?: number;
  /** When the own address was added as a relay, in seconds; see `Relay.addedAt`. */
  addedAt?: number;
  relays?: Relay[];
  /** Like core's removed_transports: address and removal time in seconds. */
  removedRelays?: { addr: string; at: number }[];
}

export interface Contact {
  fingerprint: string;
  addr: string;
  /** The name the contact chose (core's authname); outgoing mail uses only this one. */
  name: string;
  /** Set on this profile and synced to the own devices, like core's name. */
  nickname?: string;
  publicKey: string;
  relays: string[];
  /** Connected via SecureJoin in Kitepost; current core no longer records this, so imports lack it. */
  verified: boolean;
  blocked: boolean;
  /** Deleted while still in a chat, like core's Origin::Hidden; not in the contact list. */
  hidden?: boolean;
  /** Data URL of the contact's own avatar, and the Date of the message that set it (core's AvatarTimestamp). */
  avatar?: string;
  avatarAt?: number;
  /** When the own avatar last went to the contact, like core's selfavatar_sent. */
  avatarSentAt?: number;
  /** Date of the newest message from the contact, like core's last_seen. */
  lastSeen?: number;
}

export function contactName(c: Contact | undefined): string {
  return c ? c.nickname || c.name || c.addr : '';
}

export type ChatType = 'single' | 'group' | 'self';

/** Id of "Saved messages", core's self-talk chat. */
export const SELF_CHAT = 'self';

export interface Chat {
  id: string;
  type: ChatType;
  name: string;
  /** Contact fingerprint for single chats. */
  contact?: string;
  grpid?: string;
  /** Member fingerprints, excluding self. */
  members: string[];
  isRequest: boolean;
  left: boolean;
  lastActivity: number;
  unread: number;
  /** Like core's ChatVisibility; normal when unset. */
  visibility?: 'archived' | 'pinned';
  /** Disappearing messages in seconds, and the Date of the message that set it (core's EphemeralSettingsTimestamp). */
  ephemeralTimer?: number;
  ephemeralSetAt?: number;
  /** Group image as data URL and the Date of the message that set it, like the contact's. */
  avatar?: string;
  avatarAt?: number;
  /** A group no member knows about yet, like core's Param::Unpromoted. */
  unpromoted?: boolean;
}

export type MessageState = 'pending' | 'sent' | 'failed' | 'received' | 'read';

export interface Message {
  id: string;
  chatId: string;
  /** Sender fingerprint, or `self`. */
  from: string;
  text: string;
  timestamp: number;
  state: MessageState;
  info?: boolean;
  error?: string;
  edited?: boolean;
  /** Quoted text of a reply and the Message-ID it replies to (In-Reply-To). */
  quote?: string;
  replyTo?: string;
  /** Local time the message was first stored, the tie-breaker like core's row id. */
  addedAt?: number;
  /** Read receipts of own messages: contact fingerprint to time, like core's msgs_mdns. */
  readBy?: Record<string, number>;
  attachments: AttachmentData[];
  reactions: Record<string, string>;
  pinned?: boolean;
  /** Like core's msgs.ephemeral_timer (seconds) and ephemeral_timestamp (here ms), set once the message was read. */
  ephemeralTimer?: number;
  ephemeralAt?: number;
  /** INBOX UID of a disappearing message, to delete it on the server too. */
  serverUid?: ServerUid;
  /** A copy in "Saved messages": the Message-ID of the original, like core's `starred` column. */
  savedFrom?: string;
  /** INBOX UID while `\Seen` still has to be set on the server. */
  unseenUid?: ServerUid;
  /** The sender asked for a read receipt (Chat-Disposition-Notification-To). */
  wantsMdn?: boolean;
}

export interface AuthToken {
  token: string;
  grpid: string;
  created: number;
  /** Set for tokens another device created; Kitepost's own share `Config.inviteNumber`. */
  invitenumber?: string;
}

export interface BobState {
  id: string;
  invite: import('./invite').Invite;
  chatId: string;
  /** `pubkey` while waiting for vc-pubkey, `confirm` after vc-request-with-auth was sent. */
  stage: 'pubkey' | 'confirm';
  created: number;
}

/** Order in a chat like core: whole seconds, because Date headers carry no more, then arrival. */
export function byChatOrder(a: Message, b: Message): number {
  return Math.floor(a.timestamp / 1000) - Math.floor(b.timestamp / 1000) || (a.addedAt ?? a.timestamp) - (b.addedAt ?? b.timestamp);
}
