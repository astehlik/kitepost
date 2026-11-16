import type { AttachmentData } from '../wasm';

export interface Config {
  addr: string;
  password: string;
  imapHost: string;
  smtpHost: string;
  displayName: string;
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
  /** A backup was downloaded or another device has the profile, so losing the browser loses nothing. */
  secured?: boolean;
  /** Last time a message from the own address came with another key, and when the warning was hidden. */
  foreignKeyAt?: number;
  foreignKeyHiddenAt?: number;
}

export interface Contact {
  fingerprint: string;
  addr: string;
  name: string;
  publicKey: string;
  relays: string[];
  /** Connected via SecureJoin in Kitepost; current core no longer records this, so imports lack it. */
  verified: boolean;
  blocked: boolean;
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
  /** A copy in "Saved messages": the Message-ID of the original, like core's `starred` column. */
  savedFrom?: string;
  /** INBOX UID while `\Seen` still has to be set on the server. */
  unseenUid?: { uid: number; validity: number };
  /** The sender asked for a read receipt (Chat-Disposition-Notification-To). */
  wantsMdn?: boolean;
}

export interface AuthToken {
  token: string;
  grpid: string;
  created: number;
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
