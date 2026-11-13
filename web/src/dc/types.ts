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
}

export interface Contact {
  fingerprint: string;
  addr: string;
  name: string;
  publicKey: string;
  relays: string[];
  verified: boolean;
  blocked: boolean;
}

export type ChatType = 'single' | 'group';

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
  attachments: AttachmentData[];
  reactions: Record<string, string>;
  /** INBOX UID while `\Seen` still has to be set on the server. */
  unseenUid?: { uid: number; validity: number };
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
