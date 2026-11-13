// "Add second device" receiver; the iroh module is large, so it is only loaded when needed.

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
