import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseUrl } from '../server/database-url.mjs';

test('accepts the default Vercel Neon URL names, preferring pooled URLs over direct ones', () => {
  const env = {};
  assert.equal(databaseUrl(env), undefined);
  for (const key of ['POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL', 'DATABASE_URL']) {
    env[key] = 'postgres://example.invalid/' + key;
    assert.equal(databaseUrl(env), env[key]);
  }
  env.DATABASE_URL = '   ';
  assert.equal(databaseUrl(env), env.POSTGRES_URL);
});
