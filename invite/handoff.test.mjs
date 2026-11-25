import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoffs } from './handoff.mjs';
import { hashPassword } from './sha512crypt.mjs';

const ADDR = 'alice@example.org';
const PASSWORD = 'secret';
const AUTH = `Basic ${Buffer.from(`${ADDR}:${PASSWORD}`).toString('base64')}`;

let root, dir, base, server;

before(async () => {
  const work = fileURLToPath(new URL('../work/', import.meta.url));
  await mkdir(work, { recursive: true });
  root = await mkdtemp(join(work, 'handoff-test-'));
  dir = join(root, 'handoff');
  await mkdir(join(root, 'mail', ADDR), { recursive: true });
  await writeFile(join(root, 'mail', ADDR, 'password'), hashPassword(PASSWORD));
  const handoff = handoffs({ mailDomain: 'example.org', mailboxesDir: join(root, 'mail'), dir, chunkSize: 10, maxSize: 100, maxTotal: 150 });
  server = createServer(async (req, res) => {
    const path = req.url.slice(1);
    if (await handoff.api(req, res, path)) return;
    const m = /^h\/([A-Za-z0-9_-]{22})\/data$/.exec(path);
    if (m && !(await handoff.download(m[1], res, {}))) res.writeHead(410).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const create = (size, auth = AUTH) => fetch(`${base}handoff`, { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify({ size }) });
const put = (id, token, n, bytes) => fetch(`${base}handoff/${id}/${n}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) });

function frames(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const length = data.readUInt32BE(i);
    out.push(data.subarray(i + 4, i + 4 + length));
    i += 4 + length;
  }
  return out;
}

test('stores the chunks and releases them once', async () => {
  const res = await create(25);
  assert.equal(res.status, 201);
  const { id, token, chunkSize } = await res.json();
  assert.equal(chunkSize, 10);
  assert.equal((await fetch(`${base}h/${id}/data`, { method: 'POST' })).status, 410, 'incomplete');
  assert.equal((await put(id, token, 0, 26)).status, 204);
  assert.equal((await put(id, token, 0, 26)).status, 409, 'repeated chunk');
  assert.equal((await put(id, token, 1, 25)).status, 400, 'wrong size');
  assert.equal((await put(id, 'wrong', 1, 26)).status, 403);
  assert.equal((await put(id, token, 1, 26)).status, 204);
  assert.equal((await put(id, token, 2, 21)).status, 204);
  assert.deepEqual(await (await fetch(`${base}handoff/${id}`)).json(), { fetched: false });

  const download = await fetch(`${base}h/${id}/data`, { method: 'POST' });
  assert.equal(download.status, 200);
  assert.deepEqual(frames(Buffer.from(await download.arrayBuffer())).map(f => f.length), [26, 26, 21]);
  assert.deepEqual(await (await fetch(`${base}handoff/${id}`)).json(), { fetched: true });
  assert.equal((await fetch(`${base}h/${id}/data`, { method: 'POST' })).status, 410);
  assert.deepEqual(await readdir(dir), []);
});

test('rejects wrong passwords and oversized backups', async () => {
  assert.equal((await create(10, `Basic ${Buffer.from(`${ADDR}:wrong`).toString('base64')}`)).status, 403);
  const res = await create(101);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'too large', max: 100 });
});

test('a new handoff replaces the previous one of the account', async () => {
  const first = await (await create(5)).json();
  const second = await (await create(5)).json();
  assert.equal((await fetch(`${base}handoff/${first.id}`)).status, 404);
  assert.equal((await put(second.id, second.token, 0, 21)).status, 204);
  assert.deepEqual(await readdir(dir), [second.id]);
});
