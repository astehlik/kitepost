import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionQuery } from '../src/ui/emoji-text.ts';

test('completes after whitespace or an emoji', () => {
  assert.equal(completionQuery(':thumbsu'), 'thumbsu');
  assert.equal(completionQuery('Emoji test :ro'), 'ro');
  assert.equal(completionQuery('Emoji test 👍:ro'), 'ro');
  assert.equal(completionQuery('❤️:ro'), 'ro');
  assert.equal(completionQuery('👍🏽:ro'), 'ro');
  assert.equal(completionQuery('🇩🇪:ro'), 'ro');
});

test('does not complete times, URLs or a single letter', () => {
  assert.equal(completionQuery('at 10:30'), undefined);
  assert.equal(completionQuery('https://x.test:8080'), undefined);
  assert.equal(completionQuery('word:ab'), undefined);
  assert.equal(completionQuery(':a'), undefined);
});
