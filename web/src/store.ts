import { t } from './i18n';
// Encrypted key-value store on IndexedDB. Every record is AES-256-GCM encrypted with a
// non-extractable key derived from the user's passphrase, so profile data at rest is
// unreadable without it.

const DB_NAME = 'kitepost';
const PBKDF2_ITERATIONS = 600_000;
const VERIFIER = 'kitepost-verifier-v1';

interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('meta');
    r.result.createObjectStore('records');
  };
  return req(r);
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, data);
  return { iv, ct };
}

async function unseal<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv as BufferSource, additionalData: new TextEncoder().encode(aad) },
    key,
    sealed.ct,
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export class Store {
  private constructor(private db: IDBDatabase, private key: CryptoKey) {}

  static async exists(): Promise<boolean> {
    const db = await openDb();
    try {
      const salt = await req(db.transaction('meta').objectStore('meta').get('salt'));
      return salt !== undefined;
    } finally {
      db.close();
    }
  }

  static async create(passphrase: string): Promise<Store> {
    const db = await openDb();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passphrase, salt);
    const verifier = await seal(key, VERIFIER, 'verifier');
    const tx = db.transaction(['meta', 'records'], 'readwrite');
    tx.objectStore('records').clear();
    tx.objectStore('meta').put(salt, 'salt');
    tx.objectStore('meta').put(verifier, 'verifier');
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return new Store(db, key);
  }

  static async unlock(passphrase: string): Promise<Store> {
    const db = await openDb();
    const meta = db.transaction('meta').objectStore('meta');
    const salt = await req(meta.get('salt'));
    const verifier = await req(meta.get('verifier'));
    const key = await deriveKey(passphrase, salt);
    try {
      if ((await unseal(key, verifier, 'verifier')) !== VERIFIER) throw new Error();
    } catch {
      db.close();
      throw new Error(t('unlock.wrong'));
    }
    return new Store(db, key);
  }

  static async destroy() {
    await req(indexedDB.deleteDatabase(DB_NAME));
  }

  async put(id: string, value: unknown) {
    const sealed = await seal(this.key, value, id);
    await req(this.db.transaction('records', 'readwrite').objectStore('records').put(sealed, id));
  }

  async delete(id: string) {
    await req(this.db.transaction('records', 'readwrite').objectStore('records').delete(id));
  }

  /** Returns all records whose id starts with `prefix`. */
  async list<T>(prefix: string): Promise<{ id: string; value: T }[]> {
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const store = this.db.transaction('records').objectStore('records');
    const [ids, values] = await Promise.all([req(store.getAllKeys(range)), req(store.getAll(range))]);
    return Promise.all(
      ids.map(async (id, i) => ({ id: String(id), value: await unseal<T>(this.key, values[i], String(id)) })),
    );
  }

  async get<T>(id: string): Promise<T | undefined> {
    const sealed = await req(this.db.transaction('records').objectStore('records').get(id));
    return sealed === undefined ? undefined : unseal<T>(this.key, sealed, id);
  }

  close() {
    this.db.close();
  }
}
