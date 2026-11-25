import type { DcClient } from './client';

export interface Handoff {
  url: string;
  statusUrl: string;
  expires: number;
}

/** The service refused a backup of `size` bytes, it accepts at most `max`. */
export class HandoffTooLarge extends Error {
  constructor(readonly size: number, readonly max: number) {
    super('handoff too large');
  }
}

const TTL = 15 * 60_000;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether the handoff service at `base` serves the relay of `addr`. */
export async function handoffAvailable(base: string, addr: string): Promise<boolean> {
  if (!base) return false;
  try {
    const res = await fetch(new URL('handoff', base), { cache: 'no-store' });
    if (!res.ok) return false;
    const { domain } = await res.json();
    return typeof domain === 'string' && addr.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
  } catch {
    return false;
  }
}

// The chunk index in the IV and the flag on the last chunk stop reordering and truncation.
function chunkParams(index: number, last: boolean): AesGcmParams {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return { name: 'AES-GCM', iv, additionalData: new Uint8Array([last ? 1 : 0]) };
}

/**
 * Uploads the backup in separately encrypted chunks; the key only goes into the returned URL's
 * fragment. `progress` gets the uploaded share from 0 to 1.
 */
export async function createHandoff(base: string, client: DcClient, progress: (share: number) => void = () => {}): Promise<Handoff> {
  const { blob } = await client.exportBackup();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);

  const { addr, password } = client.config;
  const auth = btoa(String.fromCharCode(...new TextEncoder().encode(`${addr}:${password}`)));
  const created = await fetch(new URL('handoff', base), {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: blob.size }),
  });
  if (created.status === 413) throw new HandoffTooLarge(blob.size, (await created.json()).max);
  if (!created.ok) throw new Error(`handoff failed: HTTP ${created.status}`);
  const { id, token, chunkSize } = await created.json();

  const count = Math.max(1, Math.ceil(blob.size / chunkSize));
  for (let n = 0; n < count; n++) {
    const plain = await blob.slice(n * chunkSize, (n + 1) * chunkSize).arrayBuffer();
    const sealed = await crypto.subtle.encrypt(chunkParams(n, n === count - 1), key, plain);
    const res = await fetch(new URL(`handoff/${id}/${n}`, base), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: sealed,
    });
    if (!res.ok) throw new Error(`handoff failed: HTTP ${res.status}`);
    progress((n + 1) / count);
  }
  return {
    url: `${new URL(`h/${id}`, base).href}#${base64Url(rawKey)}`,
    statusUrl: new URL(`handoff/${id}`, base).href,
    expires: Date.now() + TTL,
  };
}

export type HandoffState = 'waiting' | 'fetched' | 'expired';

export async function handoffState(h: Handoff): Promise<HandoffState> {
  if (Date.now() > h.expires) return 'expired';
  const res = await fetch(h.statusUrl, { cache: 'no-store' });
  if (res.status === 404) return 'expired';
  if (!res.ok) return 'waiting';
  return (await res.json()).fetched ? 'fetched' : 'waiting';
}
