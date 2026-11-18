import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarExtension, avatarHeader, imageMime, parseAvatarHeader } from '../src/dc/avatar.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==';

test('reads the avatar header like core', () => {
  assert.equal(parseAvatarHeader('0'), null);
  const folded = `base64:${PNG.slice(0, 40)} ${PNG.slice(40)}`;
  assert.equal(parseAvatarHeader(folded), `data:image/png;base64,${PNG}`);
  assert.equal(parseAvatarHeader('avatar.jpg'), undefined);
  assert.equal(parseAvatarHeader('base64:!!!'), undefined);
});

test('accepts only raster images by their bytes', () => {
  const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(parseAvatarHeader(`base64:${svg}`), undefined);
  assert.equal(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageMime(new TextEncoder().encode('GIF89a')), 'image/gif');
});

test('writes a header that reads back', () => {
  const long = `data:image/png;base64,${btoa(atob(PNG) + 'x'.repeat(300))}`;
  const header = avatarHeader(long);
  assert.ok(header.split(' ').every(part => part.length <= 83));
  assert.equal(parseAvatarHeader(header), long);
  assert.equal(avatarHeader(undefined), '0');
  assert.equal(avatarExtension(long), 'png');
});
