import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { neonConfig } from '@neondatabase/serverless';
import { databaseUrlKeys } from '../server/database-url.mjs';

test('list and create report actionable Neon setup errors without leaking the driver message', async t => {
  for (const k of databaseUrlKeys) delete process.env[k];
  process.env.POSTGRES_URL = 'postgresql://fixture:fixture@db.example.invalid/test';
  const token = randomUUID();
  process.env.GLAMP_AGENT_TOKEN_HASHES = createHash('sha256').update(token).digest('hex');
  const { default: app } = await import('../index.mjs');
  let sqlstate = '42P01';
  const calls = [];
  const originalFetch = neonConfig.fetchFunction;
  t.after(() => { neonConfig.fetchFunction = originalFetch; });
  neonConfig.fetchFunction = async (_url, req) => {
    calls.push(JSON.parse(req.body).query);
    return Response.json({ code: sqlstate, message: 'private-driver-detail' }, { status: 400 });
  };
  const s = await new Promise(resolve => { const server = app.listen(0,'127.0.0.1',() => resolve(server)); });
  t.after(() => new Promise(resolve => s.close(resolve)));
  const log = t.mock.method(console, 'error', () => {});
  for (const [code, expected] of [['42P01',/sql\/schema\.sql/], ['42501',/permission/i]]) {
    sqlstate = code;
    for (const method of ['GET','POST']) {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/api/cards`, {method, headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, body:method === 'POST' ? JSON.stringify({title:'Fixture'}) : undefined});
      const body = await r.json();
      assert.match(body.error, expected);
      assert.doesNotMatch(body.error, /private-driver-detail|fixture:fixture/);
      assert.equal(r.status, 503);
    }
  }
  assert.ok(calls.some(sql=>sql.includes('SELECT') && sql.includes('glamp.cards')));
  assert.ok(calls.some(sql=>sql.includes('INSERT INTO glamp.cards')));
  assert.doesNotMatch(JSON.stringify(log.mock.calls.map(c => c.arguments)), /private-driver-detail|fixture:fixture/);
});
