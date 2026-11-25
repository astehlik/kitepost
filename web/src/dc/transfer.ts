// Delta Chat's "Add second device" over the relay's iroh relay; the iroh module is large, so it is only loaded when needed.

import { BACKUP_VERSION } from './backup-export';

type TransferModule = typeof import('../wasm/kitepost_transfer.js');
let mod: Promise<TransferModule> | undefined;

function load(): Promise<TransferModule> {
  mod ??= import('../wasm/kitepost_transfer.js').then(async m => {
    await m.default();
    return m;
  });
  return mod;
}

export function looksLikeBackupQr(text: string): boolean {
  return /^\s*DCBACKUP\d+:/i.test(text);
}

/**
 * Downloads the backup offered by the QR code and passes it to `importBackup`. The other
 * device only reports success if the import succeeded.
 */
export async function receiveBackup(
  qr: string,
  progress: (received: number, total: number) => void,
  importBackup: (backup: Blob) => Promise<void>,
): Promise<void> {
  const m = await load();
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  await m.receive_backup(
    qr,
    (chunk: Uint8Array, received: number, total: number) => {
      chunks.push(chunk);
      progress(received, total);
    },
    async () => {
      try {
        await importBackup(new Blob(chunks as BlobPart[]));
        return true;
      } catch (e) {
        failure = e;
        return false;
      }
    },
  );
  if (failure) throw failure;
}

/**
 * Offers `backup` to Delta Chat's "Add as second device" through the iroh relay at `relayUrl`.
 * `onQr` gets the code for the other device; resolves once it confirmed the transfer.
 */
export async function provideBackup(
  relayUrl: string,
  backup: Blob,
  onQr: (qr: string) => void,
  progress: (sent: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const m = await load();
  const cancel = new Promise<void>(resolve => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await m.provide_backup(relayUrl, BACKUP_VERSION, backup.size, onQr,
    async (offset: number, length: number) => new Uint8Array(await backup.slice(offset, offset + length).arrayBuffer()),
    progress, cancel);
}
