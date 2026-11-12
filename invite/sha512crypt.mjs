// SHA-512-crypt ("$6$") as specified in https://www.akkadia.org/drepper/SHA-crypt.txt,
// the scheme chatmaild stores for Dovecot as {SHA512-CRYPT}.
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const sha512 = (...parts) => {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
};

function repeatTo(src, len) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += src.length) src.copy(out, i, 0, Math.min(src.length, len - i));
  return out;
}

const ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

function encode(digest) {
  let out = '';
  const b64 = (b2, b1, b0, n) => {
    let w = (b2 << 16) | (b1 << 8) | b0;
    for (let i = 0; i < n; i++, w >>= 6) out += ALPHABET[w & 0x3f];
  };
  for (const [a, b, c] of ORDER) b64(digest[a], digest[b], digest[c], 4);
  b64(0, 0, digest[63], 2);
  return out;
}

export function sha512crypt(password, salt, rounds) {
  const pw = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 16), 'utf8');

  const b = sha512(pw, s, pw);
  const aCtx = createHash('sha512').update(pw).update(s).update(repeatTo(b, pw.length));
  for (let n = pw.length; n > 0; n >>= 1) aCtx.update(n & 1 ? b : pw);
  const a = aCtx.digest();

  const dpCtx = createHash('sha512');
  for (let i = 0; i < pw.length; i++) dpCtx.update(pw);
  const p = repeatTo(dpCtx.digest(), pw.length);

  const dsCtx = createHash('sha512');
  for (let i = 0; i < 16 + a[0]; i++) dsCtx.update(s);
  const sb = repeatTo(dsCtx.digest(), s.length);

  const r = rounds ?? 5000;
  let c = a;
  for (let i = 0; i < r; i++) {
    const h = createHash('sha512');
    h.update(i & 1 ? p : c);
    if (i % 3) h.update(sb);
    if (i % 7) h.update(p);
    h.update(i & 1 ? c : p);
    c = h.digest();
  }
  const prefix = rounds === undefined ? `$6$${s}` : `$6$rounds=${r}$${s}`;
  return `${prefix}$${encode(c)}`;
}

export function hashPassword(password) {
  const salt = Array.from(randomBytes(16), x => ALPHABET[x & 0x3f]).join('');
  return sha512crypt(password, salt);
}
