// Saved setup links: the login code is encrypted with a key that only the link's fragment holds.
// A link works until a device has logged in, so later devices take over the profile instead.

import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TTL = 30 * 86_400_000;

export function setupLinks({ file, mailboxesDir }) {
  let links = [];
  let writing = Promise.resolve();

  const persist = () => {
    links = links.filter(l => l.expires > Date.now());
    writing = writing.then(async () => {
      await writeFile(`${file}.tmp`, JSON.stringify(links), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    return writing;
  };

  // chatmail sets the password file's mtime to the start of the day on every login.
  const mtime = async addr => (await stat(join(mailboxesDir, addr, 'password'))).mtimeMs;

  return {
    async load() {
      try {
        links = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },

    /** Returns `s/<id>#<key>`, relative to the service root. */
    async create(addr, login) {
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([iv, cipher.update(login, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      const link = { id: randomBytes(16).toString('base64url'), addr, sealed: sealed.toString('base64'), written: await mtime(addr), expires: Date.now() + TTL };
      links.push(link);
      await persist();
      return `s/${link.id}#${key.toString('base64url')}`;
    },

    /** The link's state; after the first login only the address is kept. */
    async get(id) {
      const link = links.find(l => l.id === id && l.expires > Date.now());
      if (!link) return undefined;
      if (link.sealed) {
        let used;
        try {
          used = (await mtime(link.addr)) !== link.written;
        } catch {
          return undefined;
        }
        if (used) {
          delete link.sealed;
          await persist();
        }
      }
      return { addr: link.addr, sealed: link.sealed };
    },
  };
}
