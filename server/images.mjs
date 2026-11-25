import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { cardExists } from './cards.mjs';

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

function publicImage(cardId, { id, name, content_type, size, created_at }) {
  return { id, name, contentType: content_type, size, createdAt: created_at,
    url: `/api/cards/${encodeURIComponent(cardId)}/images/${id}` };
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
  };
}

// Provision the private bucket and run sql/images.sql out of band. Use the
// *branch* S3 endpoint and storage credential (token_id / s3_secret_access_key),
// not an AWS account, Neon management API token, or a public/presigned URL.
let cloud;
function storeFor(cardId) {
  const env = process.env;
  const { NODE_ENV, VERCEL, GLAMP_DATA_DIR, DATABASE_URL, NEON_STORAGE_BUCKET: Bucket } = env;
  // The GLAMP names override the AWS-standard names emitted by `neon env pull`,
  // so Vercel's own runtime region/credentials can remain untouched.
  const endpoint = env.GLAMP_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3;
  const region = env.GLAMP_S3_REGION ?? env.AWS_REGION;
  const accessKeyId = env.GLAMP_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.GLAMP_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  const storageConfigured = Bucket || endpoint || env.GLAMP_S3_REGION || env.GLAMP_S3_ACCESS_KEY_ID || env.GLAMP_S3_SECRET_ACCESS_KEY;
  if (NODE_ENV !== 'production' && !VERCEL && !DATABASE_URL && !storageConfigured) {
    return localStore(GLAMP_DATA_DIR || '.glamp', cardId);
  }
  if (![DATABASE_URL, Bucket, endpoint, region, accessKeyId, secretAccessKey].every(Boolean) || !/^https:\/\//i.test(endpoint)) {
    throw Object.assign(new Error('Image storage not configured'), { status: 503 });
  }
  cloud ??= { sql: neon(DATABASE_URL), s3: new S3Client({ endpoint, region, forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED' }) };
  const { sql, s3 } = cloud;
  return {
    list() {
      return sql`SELECT id, name, content_type, size, created_at FROM glamp.card_images
                 WHERE card_id = ${cardId} ORDER BY created_at, id`;
    },
    async put(row, bytes) {
      const Key = `card-images/${row.id}`; // Never interpolate user input into an object key.
      await s3.send(new PutObjectCommand({ Bucket, Key, ContentType: row.content_type, Body: bytes }));
      try {
        await sql`INSERT INTO glamp.card_images (id, card_id, object_key, name, content_type, size, created_at)
                  VALUES (${row.id}, ${cardId}, ${Key}, ${row.name}, ${row.content_type}, ${row.size}, ${row.created_at})`;
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
  const row = { id: randomUUID(), name, content_type: type, size: req.body.length, created_at: new Date().toISOString() };
  await res.locals.imageStore.put(row, req.body);
  const image = publicImage(req.params.id, row);
  res.location(image.url).status(201).json({ image });
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
