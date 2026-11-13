import type { DcClient } from './client';

export interface Handoff {
  url: string;
  statusUrl: string;
  expires: number;
}

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

/** Uploads the encrypted backup; the key only goes into the returned URL's fragment. */
export async function createHandoff(base: string, client: DcClient): Promise<Handoff> {
  const { blob } = await client.exportBackup();
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer()));
  const body = new Uint8Array(iv.length + sealed.length);
  body.set(iv);
  body.set(sealed, iv.length);

  const { addr, password } = client.config;
  const auth = btoa(String.fromCharCode(...new TextEncoder().encode(`${addr}:${password}`)));
  const res = await fetch(new URL('handoff', base), {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) throw new Error(`handoff failed: HTTP ${res.status}`);
  const { id, expires } = await res.json();
  return {
    url: `${new URL(`h/${id}`, base).href}#${base64Url(rawKey)}`,
    statusUrl: new URL(`handoff/${id}`, base).href,
    expires,
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
