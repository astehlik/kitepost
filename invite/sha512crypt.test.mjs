import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha512crypt } from './sha512crypt.mjs';

// Test vectors from the specification.
test('spec vectors', () => {
  assert.equal(sha512crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.equal(sha512crypt('Hello world!', 'saltstringsaltstring', 10000),
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.');
});
