import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionQuery, trailingSmiley } from '../src/ui/emoji-text.ts';

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

test('finds a trailing smiley', () => {
  assert.deepEqual(trailingSmiley('Hi :)'), { from: 3, emoji: '🙂' });
  assert.deepEqual(trailingSmiley(';-)'), { from: 0, emoji: '😉' });
  assert.deepEqual(trailingSmiley('a\n:D'), { from: 2, emoji: '😃' });
  assert.deepEqual(trailingSmiley('I </3'), { from: 2, emoji: '💔' });
  assert.deepEqual(trailingSmiley("so sad :'("), { from: 7, emoji: '😢' });
});

test('ignores smileys inside words', () => {
  assert.equal(trailingSmiley('http:/'), undefined);
  assert.equal(trailingSmiley('f(x:)'), undefined);
  assert.equal(trailingSmiley('mixD'), undefined);
  assert.equal(trailingSmiley('Hi :))'), undefined);
});
