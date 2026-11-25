import { databaseUrl } from './database-url.mjs';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { cardExists, handleDbError } from './cards.mjs';

const MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ff', 'hex');
const riff = Buffer.from('RIFF');
const webp = Buffer.from('WEBP');

function sniff(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.subarray(0, 8).equals(png)) return 'image/png';
  if (bytes.subarray(0, 3).equals(jpeg)) return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(riff) && bytes.subarray(8, 12).equals(webp)) return 'image/webp';
  return null;
}

function fileName(header, type) {
  if (header === undefined) return type === 'image/jpeg' ? 'image.jpg' : `image.${type.slice(6)}`;
  let name;
  try { name = decodeURIComponent(header).normalize('NFC').trim(); } catch { return null; }
  return name && Buffer.byteLength(name) <= 255 && !/[\x00-\x1f\x7f/\\]/u.test(name) && name !== '.' && name !== '..' ? name : null;
}

function parseCaption(raw, decodeUri = false) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, value: null };
  let text = raw;
  if (decodeUri) {
    try { text = decodeURIComponent(raw); } catch { return { ok: false, value: null }; }
  }
  if (text.includes('\0') || !text.isWellFormed()) return { ok: false, value: null };
  text = text.normalize('NFC').trim();
  if (!text) return { ok: true, value: null };
  if ([...text].length > 500) return { ok: false, value: null };
  return { ok: true, value: text };
}

function publicImage(cardId, { id, name, caption, content_type, size, created_at }) {
  return {
    id, name, caption: caption ?? null, contentType: content_type, size, createdAt: created_at,
    url: `/api/cards/${encodeURIComponent(cardId)}/images/${id}`,
  };
}

// Local-only: a private directory per card, one immutable pair of files per upload.
// Publishing by rename means list/read never observe a partially written pair.
function localStore(root, cardId) {
  const dir = path.join(root, 'images', createHash('sha256').update(cardId.toLowerCase()).digest('hex'));
  async function metadata(id) {
    return JSON.parse(await readFile(path.join(dir, id, 'metadata.json'), 'utf8'));
  }
  return {
    async list() {
      let entries;
      try { entries = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const items = await Promise.all(entries.filter(id => IMAGE_ID.test(id)).map(metadata));
      return items.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    },
    async put(row, bytes) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = await mkdtemp(path.join(dir, '.pending-'));
      try {
        await writeFile(path.join(tmp, 'bytes'), bytes, { mode: 0o600 });
        await writeFile(path.join(tmp, 'metadata.json'), JSON.stringify(row), { mode: 0o600 });
        await rename(tmp, path.join(dir, row.id));
      } catch (e) { await rm(tmp, { recursive: true, force: true }); throw e; }
    },
    async get(id) {
      let row;
      try { row = await metadata(id); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      return { row, bytes: await readFile(path.join(dir, id, 'bytes')) };
    },
    async setCaption(id, caption) {
      let row;
      try { row = await metadata(id); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const updated = { ...row, caption };
      const tmp = path.join(dir, id, `.meta-${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(updated), { mode: 0o600 });
      await rename(tmp, path.join(dir, id, 'metadata.json'));
      return updated;
    },
    async remove(id) {
      try { await metadata(id); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      await rm(path.join(dir, id), { recursive: true, force: true });
      return true;
    },
  };
}

let cachedSql = { url: null, sql: null };
let cachedS3 = { key: null, s3: null };
function neonClient(url) {
  if (cachedSql.url !== url) cachedSql = { url, sql: neon(url) };
  return cachedSql.sql;
}
function s3Client(endpoint, region, accessKeyId, secretAccessKey) {
  const key = `${endpoint}|${region}|${accessKeyId}`;
  if (cachedS3.key !== key) {
    cachedS3 = {
      key,
      s3: new S3Client({
        endpoint, region, forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        requestChecksumCalculation: 'WHEN_REQUIRED',
      }),
    };
  }
  return cachedS3.s3;
}

// Store private card images in Neon Postgres (bytea in glamp.card_images.data) by default
// when connected to Neon, or in an external S3-compatible bucket when explicitly configured.
function storeFor(cardId) {
  const env = process.env;
  const { NODE_ENV, VERCEL, GLAMP_DATA_DIR, NEON_STORAGE_BUCKET: Bucket } = env;
  const url = databaseUrl(env);
  const endpoint = env.GLAMP_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3;
  const region = env.GLAMP_S3_REGION ?? env.AWS_REGION;
  const accessKeyId = env.GLAMP_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.GLAMP_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  const storageConfigured = Boolean(
    Bucket || endpoint || env.GLAMP_S3_REGION || env.GLAMP_S3_ACCESS_KEY_ID || env.GLAMP_S3_SECRET_ACCESS_KEY,
  );
  if (NODE_ENV !== 'production' && !VERCEL && !url && !storageConfigured) {
    return localStore(GLAMP_DATA_DIR || '.glamp', cardId);
  }
  if (!url) {
    throw Object.assign(new Error('Image storage not configured'), { status: 503, publicMessage: 'Image storage is not configured.' });
  }
  const sql = neonClient(url);
  if (!storageConfigured) {
    return {
      list() {
        return sql`SELECT id, name, caption, content_type, size, created_at FROM glamp.card_images
                   WHERE card_id = ${cardId} ORDER BY created_at, id`;
      },
      async put(row, bytes) {
        const Key = `card-images/${row.id}`;
        await sql`INSERT INTO glamp.card_images (id, card_id, object_key, name, caption, content_type, size, data, created_at)
                  VALUES (${row.id}, ${cardId}, ${Key}, ${row.name}, ${row.caption}, ${row.content_type}, ${row.size}, ${bytes}, ${row.created_at})`;
      },
      async get(id) {
        const [row] = await sql`SELECT content_type, size, data FROM glamp.card_images
                                WHERE card_id = ${cardId} AND id = ${id}`;
        if (!row || !row.data) return null;
        const bytes = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
        if (bytes.length !== row.size || bytes.length > MAX_BYTES) {
          throw new Error('Stored image size mismatch');
        }
        return { row, bytes };
      },
      async setCaption(id, caption) {
        const [row] = await sql`UPDATE glamp.card_images SET caption = ${caption}
                                WHERE card_id = ${cardId} AND id = ${id}
                                RETURNING id, name, caption, content_type, size, created_at`;
        return row || null;
      },
      async remove(id) {
        const [row] = await sql`DELETE FROM glamp.card_images
                                WHERE card_id = ${cardId} AND id = ${id}
                                RETURNING id`;
        return Boolean(row);
      },
    };
  }
  if (![Bucket, endpoint, region, accessKeyId, secretAccessKey].every(Boolean) || !/^https:\/\//i.test(endpoint)) {
    throw Object.assign(new Error('Image storage not configured'), { status: 503, publicMessage: 'Image storage is not configured.' });
  }
  const s3 = s3Client(endpoint, region, accessKeyId, secretAccessKey);
  return {
    list() {
      return sql`SELECT id, name, caption, content_type, size, created_at FROM glamp.card_images
                 WHERE card_id = ${cardId} ORDER BY created_at, id`;
    },
    async put(row, bytes) {
      const Key = `card-images/${row.id}`; // Never interpolate user input into an object key.
      await s3.send(new PutObjectCommand({ Bucket, Key, ContentType: row.content_type, Body: bytes }));
      try {
        await sql`INSERT INTO glamp.card_images (id, card_id, object_key, name, caption, content_type, size, created_at)
                  VALUES (${row.id}, ${cardId}, ${Key}, ${row.name}, ${row.caption}, ${row.content_type}, ${row.size}, ${row.created_at})`;
      } catch (e) {
        // Definite constraint rejection (e.g. card deleted concurrently). If the
        // commit outcome is unknown, keep the private object rather than break a live row.
        if (e.code?.startsWith('23')) await s3.send(new DeleteObjectCommand({ Bucket, Key }));
        throw e;
      }
    },
    async get(id) {
      const [row] = await sql`SELECT object_key, content_type, size FROM glamp.card_images
                              WHERE card_id = ${cardId} AND id = ${id}`;
      if (!row) return null;
      const { Body, ContentLength } = await s3.send(new GetObjectCommand({ Bucket, Key: row.object_key }));
      if (!Body || ContentLength !== row.size || ContentLength > MAX_BYTES) {
        Body?.destroy();
        throw new Error('Stored image size mismatch');
      }
      return { row, bytes: Buffer.from(await Body.transformToByteArray()) };
    },
    async setCaption(id, caption) {
      const [row] = await sql`UPDATE glamp.card_images SET caption = ${caption}
                              WHERE card_id = ${cardId} AND id = ${id}
                              RETURNING id, name, caption, content_type, size, created_at`;
      return row || null;
    },
    async remove(id) {
      const [row] = await sql`DELETE FROM glamp.card_images
                              WHERE card_id = ${cardId} AND id = ${id}
                              RETURNING object_key`;
      if (!row) return false;
      await s3.send(new DeleteObjectCommand({ Bucket, Key: row.object_key }));
      return true;
    },
  };
}

// index.mjs mounts this behind /api auth and before the JSON parser/cards router.
export const imagesRouter = express.Router();
imagesRouter.param('id', async (_req, res, next, cardId) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
  res.locals.imageStore = storeFor(cardId);
  if (!await cardExists(cardId)) return res.status(404).json({ error: 'Card not found.' });
  next();
});

imagesRouter.get('/:id/images', async (req, res) => {
  const rows = await res.locals.imageStore.list();
  res.json({ images: rows.map(row => publicImage(req.params.id, row)) });
});

imagesRouter.post('/:id/images', (req, res, next) => {
  if (!req.is(['image/jpeg', 'image/png', 'image/webp'])) {
    return res.status(415).json({ error: 'Send a raw JPEG, PNG, or WebP image.' });
  }
  next();
}, express.raw({ type: () => true, limit: MAX_BYTES, inflate: false }), async (req, res) => {
  if (req.body?.length > MAX_BYTES) return res.status(413).json({ error: 'Image exceeds 3 MiB.' });
  const type = sniff(req.body);
  if (!type || !req.is(type)) return res.status(415).json({ error: 'Image signature does not match its content type.' });
  const name = fileName(req.get('x-filename'), type);
  if (!name) return res.status(400).json({ error: 'Invalid image filename.' });
  const cap = parseCaption(req.get('x-caption'), true);
  if (!cap.ok) return res.status(400).json({ error: 'Caption must be valid text of at most 500 characters.' });
  const row = {
    id: randomUUID(), name, caption: cap.value, content_type: type,
    size: req.body.length, created_at: new Date().toISOString(),
  };
  await res.locals.imageStore.put(row, req.body);
  const image = publicImage(req.params.id, row);
  res.location(image.url).status(201).json({ image });
});

imagesRouter.patch('/:id/images/:imageId', express.json({ limit: '16kb' }), async (req, res) => {
  const { imageId } = req.params;
  if (!IMAGE_ID.test(imageId)) return res.status(404).json({ error: 'Image not found.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || !Object.hasOwn(req.body, 'caption')) {
    return res.status(400).json({ error: 'Expected a JSON object with caption.' });
  }
  const cap = parseCaption(req.body.caption, false);
  if (!cap.ok) return res.status(400).json({ error: 'Caption must be valid text of at most 500 characters.' });
  const row = await res.locals.imageStore.setCaption(imageId, cap.value);
  if (!row) return res.status(404).json({ error: 'Image not found.' });
  res.json({ image: publicImage(req.params.id, row) });
});

imagesRouter.delete('/:id/images/:imageId', async (req, res) => {
  const { imageId } = req.params;
  if (!IMAGE_ID.test(imageId)) return res.status(404).json({ error: 'Image not found.' });
  const deleted = await res.locals.imageStore.remove(imageId);
  if (!deleted) return res.status(404).json({ error: 'Image not found.' });
  res.status(204).end();
});

imagesRouter.get('/:id/images/:imageId', async (req, res) => {
  const { imageId } = req.params;
  const result = IMAGE_ID.test(imageId) && await res.locals.imageStore.get(imageId);
  if (!result) return res.status(404).json({ error: 'Image not found.' });
  if (result.bytes.length !== result.row.size || sniff(result.bytes) !== result.row.content_type) {
    throw new Error('Stored image does not match its metadata');
  }
  res.type(result.row.content_type).send(result.bytes);
});
imagesRouter.use(handleDbError);
