import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVcard, makeVcard, parseVcard } from '../src/dc/vcard.ts';

test('reads back what it writes, like core', () => {
  const card = makeVcard([{ addr: 'bob@example.org', name: 'Bob; the, builder', key: 'AAAA', photo: '/9j/' }], new Date(Date.UTC(2026, 10, 18, 9, 30, 5)));
  assert.match(card, /^BEGIN:VCARD\r\nVERSION:4\.0\r\nEMAIL:bob@example\.org\r\nFN:Bob\\; the\\, builder\r\nKEY:data:application\/pgp-keys;base64\\,AAAA\r\n/);
  assert.match(card, /\r\nREV:20261118T093005Z\r\nEND:VCARD$/);
  assert.deepEqual(parseVcard(card), [{ addr: 'bob@example.org', name: 'Bob; the, builder', key: 'AAAA', photo: '/9j/' }]);
});

test('reads other formats and folded lines', () => {
  const card = 'BEGIN:VCARD\nVERSION:3.0\nFN:Alice\nitem1.EMAIL;TYPE=work:alice@example.org\nKEY;TYPE=PGP;ENCODING=b:AB\n CD\nFNX:not a name\nEND:VCARD\nBEGIN:VCARD\nFN:No address\nEND:VCARD';
  assert.deepEqual(parseVcard(card), [{ addr: 'alice@example.org', name: 'Alice', key: 'ABCD', photo: undefined }]);
});

test('recognises vCard attachments', () => {
  assert.ok(isVcard({ filename: 'vcard.vcf', mime: 'application/octet-stream' }));
  assert.ok(isVcard({ filename: 'contact', mime: 'text/vcard' }));
  assert.ok(!isVcard({ filename: 'notes.txt', mime: 'text/plain' }));
});
