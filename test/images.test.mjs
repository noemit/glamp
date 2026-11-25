import { databaseUrlKeys } from '../server/database-url.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Real 1x1 images; no decoder or remote fixture needed.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=', 'base64');

test('private card image API', async t => {
  // Explicitly isolate the assembled app from cloud creds and real dev state.
  const cloudKeys = [...databaseUrlKeys, 'VERCEL', 'NEON_STORAGE_BUCKET', 'GLAMP_S3_ENDPOINT', 'GLAMP_S3_REGION',
    'GLAMP_S3_ACCESS_KEY_ID', 'GLAMP_S3_SECRET_ACCESS_KEY', 'AWS_ENDPOINT_URL_S3', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  for (const k of cloudKeys) delete process.env[k];
  const root = await mkdtemp(join(tmpdir(), 'glamp-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.GLAMP_DATA_DIR = root;
  process.env.NODE_ENV = 'test';
  const token = randomUUID();
  process.env.GLAMP_AGENT_TOKEN_HASHES = createHash('sha256').update(token).digest('hex');
  const auth = { authorization: `Bearer ${token}` };
  const { default: app } = await import('../index.mjs');
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(origin + path, { headers: auth });
  const create = async () => {
    const res = await fetch(origin + '/api/cards', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Reference pictures' }) });
    assert.equal(res.status, 201);
    return (await res.json()).card.id;
  };
  const a = `/api/cards/${await create()}/images`, b = `/api/cards/${await create()}/images`;
  const post = (path, bytes = png, type = 'image/png', name) => fetch(origin + path, { method: 'POST',
    headers: { ...auth, 'content-type': type, ...(name === undefined ? {} : { 'x-filename': name }) }, body: bytes });

  await t.test('auth before list/upload/download; returned URLs stay same-origin and scoped to the card', async () => {
    assert.equal((await fetch(origin + a)).status, 401);
    assert.equal((await fetch(origin + a, { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })).status, 401);
    assert.deepEqual(await (await get(a)).json(), { images: [] });
    const filename = 'détail #1.png';
    const results = await Promise.all([[png, 'image/png', filename], [jpeg, 'image/jpeg', 'image.jpg'], [webp, 'image/webp', 'image.webp']].map(async ([bytes, type, expectedName]) => {
      const upload = await post(a, bytes, type, bytes === png ? encodeURIComponent(filename) : undefined);
      assert.equal(upload.status, 201);
      const { image } = await upload.json();
      assert.equal(image.name, expectedName);
      assert.equal(image.size, bytes.length);
      assert.equal(image.contentType, type);
      assert.equal(image.url, a + '/' + image.id);
      assert.equal(upload.headers.get('location'), image.url);
      assert.equal((await fetch(origin + image.url)).status, 401);
      assert.equal((await get(b + '/' + image.id)).status, 404);
      const download = await get(image.url);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), type);
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('cache-control'), /no-store/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      return image;
    }));
    const { images } = await (await get(a)).json();
    const byId = (x, y) => x.id.localeCompare(y.id);
    assert.deepEqual(images.sort(byId), results.sort(byId));
    assert.deepEqual(await (await get(b)).json(), { images: [] });
    assert.ok((await readdir(join(root, 'images'))).length > 0);
  });

  await t.test('rejects unsupported types, wrong magic, invalid filenames, and missing cards', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    for (const [body, type] of [[svg, 'image/svg+xml'], [svg, 'image/png'], [png, 'image/jpeg'], [webp, 'application/octet-stream'], [png.subarray(0, 3), 'image/png'], [Buffer.from('RIFF0000WAVE'), 'image/webp']]) {
      assert.equal((await post(b, body, type)).status, 415);
    }
    for (const name of ['%zz', '..%2Fnotes', 'bad%00name.png', 'x'.repeat(256)]) assert.equal((await post(b, png, 'image/png', name)).status, 400);
    assert.deepEqual(await (await get(b)).json(), { images: [] });
    assert.equal((await get(a + '/not-an-image-id')).status, 404);
    const unknown = `/api/cards/${randomUUID()}/images`;
    assert.equal((await get(unknown)).status, 404);
    assert.equal((await post(unknown)).status, 404);
  });

  await t.test('enforces a 3 MiB raw body limit', async () => {
    const limit = 3 * 1024 * 1024;
    const bytes = Buffer.alloc(limit + 1);
    png.copy(bytes);
    assert.equal((await post(b, bytes)).status, 413);
    assert.deepEqual(await (await get(b)).json(), { images: [] });
    assert.equal((await post(b, bytes.subarray(0, limit))).status, 201);
  });

  await t.test('production, Vercel, and partial cloud configurations never use the local copy', async () => {
    for (const [k, v] of [['NODE_ENV', 'production'], ['VERCEL', '1'], ['DATABASE_URL', 'postgres://unconfigured.invalid/db'], ['NEON_STORAGE_BUCKET', 'no-credentials'], ['GLAMP_S3_REGION', 'us-east-2']]) {
      const before = process.env[k];
      process.env[k] = v;
      try {
        assert.equal((await get(a)).status, 503);
        assert.equal((await post(b)).status, 503);
      } finally {
        if (before === undefined) delete process.env[k]; else process.env[k] = before;
      }
    }
    assert.equal((await (await get(b)).json()).images.length, 1);
  });

  await t.test('prefixed deployment settings work without overriding runtime AWS variables', async () => {
    Object.assign(process.env, {
      POSTGRES_URL: 'postgres://test:test@database.invalid/test', NEON_STORAGE_BUCKET: 'private',
      GLAMP_S3_REGION: 'us-east-2', GLAMP_S3_ENDPOINT: 'https://storage.invalid',
      GLAMP_S3_ACCESS_KEY_ID: 'fake-id', GLAMP_S3_SECRET_ACCESS_KEY: 'fake-secret',
      AWS_ENDPOINT_URL_S3: 'http://unrelated.invalid',
    });
    try {
      // Invalid card UUID stops before any network I/O, *after* config validation.
      const res = await get('/api/cards/invalid-uuid/images');
      assert.equal(res.status, 404);
      delete process.env.GLAMP_S3_ENDPOINT;
      assert.equal((await get('/api/cards/invalid-uuid/images')).status, 503);
    } finally { for (const k of cloudKeys) delete process.env[k]; }
  });
});
