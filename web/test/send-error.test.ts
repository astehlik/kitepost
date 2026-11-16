import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendErrorKind } from '../src/ui/send-error.ts';

test('sorts transport and SMTP errors', () => {
  const cases: [string, string | undefined][] = [
    ['connection closed', 'offline'],
    ['connection closed: upstream ended', 'offline'],
    ['bridge connection to mail.example:465 failed', 'offline'],
    ['connection to mail.example:465 timed out', 'offline'],
    ['socket closed', 'offline'],
    ['SMTP 535: 5.7.8 Error: authentication failed', 'login'],
    ['SMTP 552: 5.3.4 Message size exceeds fixed limit', 'tooLarge'],
    ['SMTP 450: 4.7.1 Too much mail', 'later'],
    ['SMTP 554: 5.7.1 Recipient address rejected', 'rejected'],
    ['SMTP 552: 5.2.2 Mailbox full', 'rejected'],
    ['invalid address foo', undefined],
    ['No encryption key for this chat yet', undefined],
  ];
  for (const [raw, kind] of cases) assert.equal(sendErrorKind(raw), kind, raw);
});
