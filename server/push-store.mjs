import { databaseUrl } from './database-url.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const idFor = endpoint => createHash('sha256').update(endpoint).digest('hex');
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

export async function subscriptionStore() {
  const url = databaseUrl();
  if (url) {
    const sql = neon(url);
    return {
      async put(sub) {
        await sql`INSERT INTO glamp.push_subscriptions (id, subscription)
          VALUES (${idFor(sub.endpoint)}, ${JSON.stringify(sub)}::jsonb)
          ON CONFLICT (id) DO UPDATE SET subscription = EXCLUDED.subscription`;
      },
      async remove(endpoint) {
        await sql`DELETE FROM glamp.push_subscriptions WHERE id = ${idFor(endpoint)}`;
      },
      async all() {
        const rows = await sql`SELECT subscription FROM glamp.push_subscriptions`;
        return rows.map(row => row.subscription);
      }
    };
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error('Private database required.'); // Never silently fall back in production.
  }

  const dir = resolve(process.env.GLAMP_DATA_DIR || '.glamp', 'push_subscriptions');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const [actual, publicRoot] = await Promise.all([realpath(dir), realpath(publicDir)]);
  if (actual === publicRoot || actual.startsWith(publicRoot + sep)) {
    throw new Error('GLAMP_DATA_DIR must be outside the public tree.');
  }
  const file = endpoint => join(actual, idFor(endpoint) + '.json');
  return {
    async put(sub) {
      // One atomically replaced file per capability: concurrent opt-ins don't overwrite each other.
      const temp = join(actual, '.' + randomUUID() + '.tmp');
      try {
        await writeFile(temp, JSON.stringify(sub), { flag: 'wx', mode: 0o600 });
        await rename(temp, file(sub.endpoint));
      } finally {
        await rm(temp, { force: true });
      }
    },
    async remove(endpoint) {
      await rm(file(endpoint), { force: true });
    },
    async all() {
      const result = [];
      for (const entry of await readdir(actual, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        try { result.push(JSON.parse(await readFile(join(actual, entry.name), 'utf8'))); }
        catch (err) { if (err.code !== 'ENOENT') throw err; } // Concurrent opt-out.
      }
      return result;
    }
  };
}
