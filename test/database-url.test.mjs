import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseUrl } from '../server/database-url.mjs';

test('accepts the default Vercel Neon URL names, preferring pooled URLs over direct ones', () => {
  const env = {};
  assert.equal(databaseUrl(env), undefined);
  for (const key of ['POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL', 'DATABASE_URL']) {
    env[key] = 'postgres://example.invalid/' + key;
    assert.equal(databaseUrl(env), env[key]);
  }
  env.DATABASE_URL = '   ';
  assert.equal(databaseUrl(env), env.POSTGRES_URL);
});

test('strips accidental surrounding quotes, removes Prisma pgbouncer param, and ignores NO_SSL', () => {
  assert.equal(
    databaseUrl({ POSTGRES_URL: ' "postgresql://user:pass@ep-demo.aws.neon.tech/neondb?sslmode=require" ' }),
    'postgresql://user:pass@ep-demo.aws.neon.tech/neondb?sslmode=require',
  );
  assert.equal(
    databaseUrl({ POSTGRES_PRISMA_URL: 'postgresql://user:pass@ep-demo.aws.neon.tech/neondb?pgbouncer=true&sslmode=require' }),
    'postgresql://user:pass@ep-demo.aws.neon.tech/neondb?sslmode=require',
  );
  assert.equal(databaseUrl({ POSTGRES_URL_NO_SSL: 'postgresql://user:pass@ep-demo.aws.neon.tech/neondb' }), undefined);
});

test('assembles a TLS connection URL from PG*/POSTGRES_* parts when no URL variable is set', () => {
  assert.equal(
    databaseUrl({
      PGHOST: 'ep-demo-pooler.us-east-2.aws.neon.tech',
      PGUSER: 'neondb_owner',
      PGPASSWORD: 'p@ss/word',
      PGDATABASE: 'neondb',
    }),
    'postgresql://neondb_owner:p%40ss%2Fword@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
  );
  assert.equal(
    databaseUrl({
      POSTGRES_HOST: 'ep-demo-pooler.us-east-2.aws.neon.tech',
      PGUSER: 'neondb_owner',
      POSTGRES_PASSWORD: 'secret',
      POSTGRES_DATABASE: 'neondb',
    }),
    'postgresql://neondb_owner:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
  );
});
