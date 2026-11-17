import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitLinks } from '../src/ui/links.ts';

const links = (text: string) => splitLinks(text).filter(p => p.href).map(p => p.text);

test('finds links with a scheme', () => {
  assert.deepEqual(splitLinks('see https://example.org/a?b=1#c now'), [
    { text: 'see ' }, { text: 'https://example.org/a?b=1#c', href: 'https://example.org/a?b=1#c' }, { text: ' now' },
  ]);
  assert.deepEqual(links('HTTP://Example.org and http://x.test'), ['HTTP://Example.org', 'http://x.test']);
  assert.deepEqual(links('www.example.org example.org mailto:a@b.c ftp://x.test'), []);
});

test('never links other schemes', () => {
  assert.deepEqual(links('javascript:alert(1) data:text/html,x vbscript:x'), []);
  const nested = splitLinks('javascript://https://x.test').filter(p => p.href);
  assert.deepEqual(nested.map(p => [p.text, p.href]), [['https://x.test', 'https://x.test/']]);
  assert.deepEqual(links('xhttps://example.org'), []);
});

test('leaves out trailing punctuation and unbalanced brackets', () => {
  assert.deepEqual(links('Look: https://example.org.'), ['https://example.org']);
  assert.deepEqual(links('(see https://example.org/a)'), ['https://example.org/a']);
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Mars_(planet), ok?'), ['https://en.wikipedia.org/wiki/Mars_(planet)']);
  assert.deepEqual(links('"https://example.org/x"!'), ['https://example.org/x']);
});

test('ends links at whitespace, controls and invisible formatting', () => {
  assert.deepEqual(links('https://example.org/a\nhttps://example.org/b'), ['https://example.org/a', 'https://example.org/b']);
  assert.deepEqual(links('https://example.org/‮gpj.exe'), ['https://example.org/']);
  assert.deepEqual(links('https://example.org​.evil.test'), ['https://example.org']);
});

test('keeps the text around links', () => {
  const text = 'a https://x.test b https://y.test';
  assert.equal(splitLinks(text).map(p => p.text).join(''), text);
  assert.deepEqual(splitLinks('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(splitLinks('https://'), [{ text: 'https://' }]);
});

test('marks addresses that can imitate others', () => {
  const [idn] = splitLinks('https://аррӏе.com/login');
  assert.equal(idn.href, 'https://xn--80ak6aa92e.com/login');
  assert.equal(idn.suspicious, true);
  assert.equal(splitLinks('https://xn--80ak6aa92e.com')[0].suspicious, true);
  const [user] = splitLinks('https://bank.example@evil.test/');
  assert.equal(user.suspicious, true);
  assert.equal(new URL(user.href!).hostname, 'evil.test');
  assert.equal(splitLinks('https://example.org')[0].suspicious, undefined);
});
