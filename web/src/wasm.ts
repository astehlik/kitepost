import init, * as core from './wasm/kitepost_core.js';

export { TlsClient } from './wasm/kitepost_core.js';

let ready: Promise<unknown> | undefined;
export function initCore(): Promise<unknown> {
  ready ??= init();
  return ready;
}

export interface KeyPair {
  secret: string;
  public: string;
  fingerprint: string;
}

export interface KeyInfo {
  addr: string;
  key: string;
  fingerprint: string;
  relays: string[] | null;
  can_encrypt: boolean;
}

export interface Addr {
  name: string;
  addr: string;
}

export interface AttachmentData {
  filename: string;
  mime: string;
  data_b64: string;
  size?: number;
}

export interface ParsedMessage {
  encrypted: boolean;
  decryption_error: string | null;
  signature: string | null;
  intended_recipients: string[];
  symmetric_secret_id: string | null;
  from: Addr;
  recipients: Addr[];
  past_members: Addr[];
  headers: Record<string, string>;
  autocrypt: KeyInfo | null;
  gossip: KeyInfo[];
  text: string;
  is_reaction: boolean;
  attachments: AttachmentData[];
  mdn_for: string[];
  is_sync: boolean;
  sync_json: string | null;
}

export interface ParseContext {
  self_addrs: string[];
  self_secret_key: string;
  self_public_key: string;
  symmetric_secrets: { id: string; secret: string; expected_signer: string | null }[];
  known_keys: Record<string, string>;
}

export type HeaderKind = 'raw' | 'text' | 'messageid' | 'address';

export interface OutgoingMessage {
  rfc724_mid: string;
  from_addr: string;
  from_name: string;
  self_secret_key: string;
  self_public_key: string;
  to: Addr[];
  subject: string;
  text: string;
  content_disposition?: string;
  headers: { name: string; value: string; kind: HeaderKind }[];
  gossip: { addr: string; key: string }[];
  encryption: { kind: 'none' } | { kind: 'asymmetric'; keys: string[] } | { kind: 'symmetric'; secret: string };
  attach_pubkey: boolean;
  sign: boolean;
  compress: boolean;
  wrap_multipart_mixed?: boolean;
  attachment?: AttachmentData;
  mdn_for?: string[];
  timestamp: number;
}

export function generateKeypair(addr: string, relays: string[]): KeyPair {
  return JSON.parse(core.generate_keypair(addr, relays.join(','), Math.floor(Date.now() / 1000)));
}

export function importKeypair(secretB64: string, addr: string, relays: string[]): KeyPair {
  return JSON.parse(core.import_keypair(secretB64, addr, relays.join(','), Math.floor(Date.now() / 1000)));
}

export function publicKeyInfo(addr: string, key: string): KeyInfo {
  return JSON.parse(core.public_key_info(addr, key));
}

export function normalizeFingerprint(fp: string): string {
  return core.normalize_fingerprint(fp);
}

export function renderMessage(msg: OutgoingMessage): { raw: string; rfc724_mid: string } {
  return JSON.parse(core.render_message(JSON.stringify(msg)));
}

export function parseMessage(raw: Uint8Array, ctx: ParseContext): ParsedMessage {
  return JSON.parse(core.parse_message(raw, JSON.stringify(ctx)));
}

export function qrSvg(text: string): string {
  return core.qr_svg(text);
}
