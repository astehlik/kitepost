import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const sheets = ['../web/src/style.css', './public/style.css', '../site/style.css']
  .map(path => [path, readFileSync(new URL(path, import.meta.url), 'utf8')]);

const emojiFontFace = css => css.match(/@font-face\s*{[^}]*"Color Emoji"[^}]*}/)?.[0];

test('every stylesheet has the same emoji font alias', () => {
  const [[, web]] = sheets;
  for (const [path, css] of sheets) {
    assert.ok(emojiFontFace(css), `${path} has no "Color Emoji" @font-face`);
    assert.equal(emojiFontFace(css), emojiFontFace(web), `${path} differs from web/src/style.css`);
  }
});

test('every body font stack starts with the emoji font alias', () => {
  for (const [path, css] of sheets) {
    assert.match(css, /body\s*{[^}]*font:[^;]*?\s"Color Emoji",/, path);
  }
});
