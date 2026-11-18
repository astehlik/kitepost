export interface VcardContact {
  addr: string;
  name: string;
  /** Base64 of the binary public key, like Autocrypt's keydata. */
  key?: string;
  /** Base64 of the profile picture, unchecked. */
  photo?: string;
}

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');

function unescape(s: string): string {
  return s.replace(/\\([\\,;nN])/g, (_, c: string) => c === 'n' || c === 'N' ? '\n' : c);
}

export function isVcard(a: { filename: string; mime: string }): boolean {
  return /^text\/(x-)?vcard$/i.test(a.mime) || /\.(vcf|vcard)$/i.test(a.filename);
}

/** Like core's contact_tools::make_vcard(); REV is the current time so that it reveals no last-seen time. */
export function makeVcard(contacts: VcardContact[], now = new Date()): string {
  const rev = now.toISOString().replace(/[-:]|\.\d+/g, '');
  return contacts.map(c => [
    'BEGIN:VCARD', 'VERSION:4.0', `EMAIL:${escape(c.addr)}`, `FN:${escape(c.name || c.addr)}`,
    ...c.key ? [`KEY:data:application/pgp-keys;base64\\,${c.key}`] : [],
    ...c.photo ? [`PHOTO:data:image/jpeg;base64\\,${c.photo}`] : [],
    `REV:${rev}`, 'END:VCARD',
  ].join('\r\n')).join('\r\n');
}

/** Like core's contact_tools::parse_vcard(), for the properties Kitepost uses. */
export function parseVcard(text: string): VcardContact[] {
  const lines = text.replace(/\r?\n[\t ]/g, '').split(/\r?\n/);
  const property = (line: string, name: string): [string, string] | undefined => {
    if (line.slice(0, name.length).toLowerCase() !== name) return undefined;
    const rest = line.slice(name.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return undefined;
    let params = rest.slice(0, colon);
    if (params && !/^[!-/:-@[-^`{-~]/.test(params)) return undefined;
    params = params.replace(/^;/, '').replace(/^PREF=1/i, '');
    return [params, rest.slice(colon + 1)];
  };
  const data = (line: string, name: string, types: string[], prefix: string) => {
    const p = property(line, name);
    if (!p) return undefined;
    if (types.includes(p[0].toLowerCase())) return p[1];
    for (const pre of [`${prefix};base64\\,`, `${prefix};base64,`]) {
      if (p[1].toLowerCase().startsWith(pre)) return p[1].slice(pre.length);
    }
    return undefined;
  };
  const contacts: VcardContact[] = [];
  let card: { addr?: string; name?: string; key?: string; photo?: string } | undefined;
  for (let line of lines) {
    if (line.toLowerCase() === 'begin:vcard') {
      card = {};
      continue;
    }
    if (!card) continue;
    if (line.toLowerCase().startsWith('item1.')) line = line.slice(6);
    const email = property(line, 'email');
    const fn = email ? undefined : property(line, 'fn');
    if (email) card.addr ??= unescape(email[1]).trim();
    else if (fn) card.name ??= unescape(fn[1]).trim();
    else if (line.toLowerCase() === 'end:vcard') {
      if (card.addr && /^[^@\s]+@[^@\s]+$/.test(card.addr)) {
        contacts.push({ addr: card.addr, name: card.name ?? '', key: card.key, photo: card.photo });
      }
      card = undefined;
    } else {
      card.key ??= data(line, 'key', ['pgp;encoding=base64', 'type=pgp;encoding=b'], 'data:application/pgp-keys');
      card.photo ??= data(line, 'photo', ['jpeg;encoding=base64', 'encoding=base64;jpeg', 'type=jpeg;encoding=b', 'encoding=b;type=jpeg', 'encoding=base64;type=jpeg', 'type=jpeg;encoding=base64'], 'data:image/jpeg');
    }
  }
  return contacts;
}
