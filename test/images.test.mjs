import { databaseUrlKeys } from '../server/database-url.mjs';
import { neonConfig } from '@neondatabase/serverless';
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
  const post = (path, bytes = png, type = 'image/png', name, caption) => fetch(origin + path, { method: 'POST',
    headers: {
      ...auth,
      'content-type': type,
      ...(name === undefined ? {} : { 'x-filename': name }),
      ...(caption === undefined ? {} : { 'x-caption': caption }),
    }, body: bytes });

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

  await t.test('stores and serves image blobs directly in Neon Postgres when only POSTGRES_URL is set', async () => {
    const savedFetch = neonConfig.fetchFunction;
    const stored = new Map();
    const cardId = randomUUID();
    neonConfig.fetchFunction = async (_url, req) => {
      const { query, params } = JSON.parse(req.body);
      if (query.includes('INSERT INTO glamp.card_images')) {
        stored.set(params[0], {
          id: params[0], card_id: params[1], name: params[3], caption: params[4],
          content_type: params[5], size: params[6], data: params[7], created_at: params[8],
        });
        return Response.json({ command: 'INSERT', rowCount: 1, rows: [], fields: [] });
      }
      if (query.includes('SELECT id, name, caption, content_type, size, created_at FROM glamp.card_images')) {
        const rows = [...stored.values()].filter(r => r.card_id === params[0]).map(r => [r.id, r.name, r.caption, r.content_type, String(r.size), r.created_at]);
        return Response.json({
          command: 'SELECT', rowCount: rows.length, rows,
          fields: [
            { name: 'id', dataTypeID: 2950 }, { name: 'name', dataTypeID: 25 }, { name: 'caption', dataTypeID: 25 },
            { name: 'content_type', dataTypeID: 25 }, { name: 'size', dataTypeID: 23 }, { name: 'created_at', dataTypeID: 25 },
          ],
        });
      }
      if (query.includes('UPDATE glamp.card_images SET caption')) {
        const hit = stored.get(params[2]);
        if (hit && hit.card_id === params[1]) {
          hit.caption = params[0];
          return Response.json({
            command: 'UPDATE', rowCount: 1,
            rows: [[hit.id, hit.name, hit.caption, hit.content_type, String(hit.size), hit.created_at]],
            fields: [
              { name: 'id', dataTypeID: 2950 }, { name: 'name', dataTypeID: 25 }, { name: 'caption', dataTypeID: 25 },
              { name: 'content_type', dataTypeID: 25 }, { name: 'size', dataTypeID: 23 }, { name: 'created_at', dataTypeID: 25 },
            ],
          });
        }
        return Response.json({ command: 'UPDATE', rowCount: 0, rows: [], fields: [] });
      }
      if (query.includes('DELETE FROM glamp.card_images')) {
        const hit = stored.get(params[1]);
        if (hit && hit.card_id === params[0]) {
          stored.delete(params[1]);
          return Response.json({
            command: 'DELETE', rowCount: 1, rows: [[hit.id]],
            fields: [{ name: 'id', dataTypeID: 2950 }],
          });
        }
        return Response.json({ command: 'DELETE', rowCount: 0, rows: [], fields: [] });
      }
      if (query.includes('SELECT content_type, size, data FROM glamp.card_images')) {
        const hit = stored.get(params[1]);
        const rows = hit && hit.card_id === params[0] ? [[hit.content_type, String(hit.size), hit.data]] : [];
        return Response.json({
          command: 'SELECT', rowCount: rows.length, rows,
          fields: [{ name: 'content_type', dataTypeID: 25 }, { name: 'size', dataTypeID: 23 }, { name: 'data', dataTypeID: 17 }],
        });
      }
      return Response.json({ command: 'SELECT', rowCount: 0, rows: [], fields: [] });
    };
    process.env.POSTGRES_URL = 'postgres://test:test@ep-demo.aws.neon.tech/neondb?sslmode=require';
    try {
      // cardExists still uses the local SQLite store initialized in before(), so use an existing card ID from local store
      const existingCardId = a.split('/')[3];
      const upload = await post(
        `/api/cards/${existingCardId}/images`, png, 'image/png', 'neon-blob.png',
        encodeURIComponent('Initial onboarding funnel snapshot'),
      );
      assert.equal(upload.status, 201);
      const { image } = await upload.json();
      assert.equal(image.name, 'neon-blob.png');
      assert.equal(image.caption, 'Initial onboarding funnel snapshot');
      const patched = await fetch(origin + image.url, {
        method: 'PATCH',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ caption: 'Updated funnel chart' }),
      });
      assert.equal(patched.status, 200);
      assert.equal((await patched.json()).image.caption, 'Updated funnel chart');
      const listed = await (await get(`/api/cards/${existingCardId}/images`)).json();
      assert.equal(listed.images.length, 1);
      assert.equal(listed.images[0].id, image.id);
      assert.equal(listed.images[0].caption, 'Updated funnel chart');
      const dl = await get(image.url);
      assert.equal(dl.status, 200);
      assert.deepEqual(Buffer.from(await dl.arrayBuffer()), png);
      // Delete image from Neon blob store
      const del = await fetch(origin + image.url, { method: 'DELETE', headers: auth });
      assert.equal(del.status, 204);
      assert.equal((await fetch(origin + image.url, { method: 'DELETE', headers: auth })).status, 404);
      assert.deepEqual(await (await get(`/api/cards/${existingCardId}/images`)).json(), { images: [] });
      // Reject over-length captions (> 500 chars)
      assert.equal((await post(`/api/cards/${existingCardId}/images`, png, 'image/png', 'too-long.png', 'a'.repeat(501))).status, 400);
    } finally {
      neonConfig.fetchFunction = savedFetch;
      for (const k of cloudKeys) delete process.env[k];
    }
  });

  await t.test('deletes images from local store scoped to card and requires auth', async () => {
    const upload = await post(b, png, 'image/png', 'remove-me.png');
    assert.equal(upload.status, 201);
    const { image } = await upload.json();
    assert.equal((await fetch(origin + image.url, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(origin + a + '/' + image.id, { method: 'DELETE', headers: auth })).status, 404);
    assert.equal((await fetch(origin + b + '/not-a-uuid', { method: 'DELETE', headers: auth })).status, 404);
    assert.equal((await fetch(origin + image.url, { method: 'DELETE', headers: auth })).status, 204);
    assert.equal((await get(image.url)).status, 404);
    assert.equal((await fetch(origin + image.url, { method: 'DELETE', headers: auth })).status, 404);
  });
});
