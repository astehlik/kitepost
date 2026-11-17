import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pastedFiles } from '../src/ui/paste.ts';

const png = (name = 'image.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const names = (files: File[] | undefined) => files?.map(f => [f.name, f.type]);

test('pastes text when there are no files or the text is more than file paths', () => {
  assert.equal(pastedFiles([], 'hello'), undefined);
  assert.equal(pastedFiles([png()], 'Quarterly report'), undefined);
  assert.equal(pastedFiles([png()], 'see /tmp/x.png'), undefined);
});

test('attaches files without text', () => {
  assert.deepEqual(names(pastedFiles([png()], '')), [['image.png', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png('a.png'), png('b.png')], '')), [['a.png', 'image/png'], ['b.png', 'image/png']]);
});

test('names a pasted image after the copied file', () => {
  assert.deepEqual(names(pastedFiles([png()], '', 'file:///home/me/Holiday%20photo.png\r\n')), [['Holiday photo.png', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png()], '/home/me/scan.PNG')), [['scan.PNG', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png()], 'C:\\Users\\me\\scan.png')), [['scan.png', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png()], '', '# comment\nfile:///x/y/z.png')), [['z.png', 'image/png']]);
});

test('keeps the extension true to the pasted data', () => {
  assert.deepEqual(names(pastedFiles([png()], '', 'file:///home/me/photo.jpg')), [['photo.png', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png()], '', 'file:///home/me/notes')), [['notes.png', 'image/png']]);
  const jpeg = new File([new Uint8Array([1])], 'image.jpg', { type: 'image/jpeg' });
  assert.deepEqual(names(pastedFiles([jpeg], '', 'file:///home/me/photo.jpeg')), [['photo.jpeg', 'image/jpeg']]);
});

test('keeps real names and files of several copied files', () => {
  const docs = [new File(['a'], 'a.pdf', { type: 'application/pdf' }), png('b.png')];
  assert.deepEqual(names(pastedFiles(docs, '', 'file:///x/a.pdf\nfile:///x/b.png')), [['a.pdf', 'application/pdf'], ['b.png', 'image/png']]);
  assert.deepEqual(names(pastedFiles([png('shot.png')], '', 'file:///x/other.png')), [['shot.png', 'image/png']]);
});
