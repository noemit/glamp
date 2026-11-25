import { databaseUrlKeys } from '../server/database-url.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the assembled app; never use a developer's cloud database or push keys.
test('private workspace: agent submits a plan; owner reviews it; agent sees Done', async t => {
  for (const key of [...databaseUrlKeys,'VERCEL','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT']) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.GLAMP_DATA_DIR = await mkdtemp(join(tmpdir(), 'glamp-workspace-'));
  t.after(() => rm(process.env.GLAMP_DATA_DIR, { recursive:true, force:true }));
  const agent = randomBytes(32).toString('hex'), owner = randomBytes(12).toString('base64url').slice(0, 15);
  process.env.GLAMP_OWNER_TOKEN = owner;
  process.env.GLAMP_AGENT_TOKEN_HASHES = createHash('sha256').update(agent).digest('hex');
  const {default: app} = await import('../index.mjs');
  const reviews = [];
  app.locals.notifyReview = async card => { reviews.push(card.id); };
  const server = await new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (url, method = 'GET', data, headers = {}) => fetch(base + url, {method, headers:{...(data && {'content-type':'application/json'}), ...headers}, body:data && JSON.stringify(data)});
  const auth = {authorization:`Bearer ${agent}`};
  assert.equal((await req('/api/cards')).status, 401);
  assert.equal((await req('/api/session', 'POST', { token:agent })).status, 401);
  assert.equal((await req('/api/session', 'POST', { token:owner }, {origin:'https://unrelated.example'})).status, 403);
  for (const length of [13, 14]) {
    const short = owner.slice(0, length);
    process.env.GLAMP_OWNER_TOKEN = short;
    assert.equal((await req('/api/session', 'POST', {token:short})).status, 503);
  }
  process.env.GLAMP_OWNER_TOKEN = owner;
  const session = await req('/api/session', 'POST', {token:owner});
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'), /httponly/i);
  assert.deepEqual(await (await req('/api/session','GET',undefined,{cookie})).json(), {authenticated:true,owner:true});
  assert.equal((await req('/api/push/anything','GET',undefined,auth)).status, 403);
  const created = await req('/api/cards','POST',{title:'Review my plan',body:'A shared Markdown note.',isTask:true,startingDate:'2027-01-18',status:'review'},auth);
  assert.equal(created.status,201);
  const {card} = await created.json();
  assert.deepEqual(reviews,[card.id]);
  const url = '/api/cards/' + card.id;
  assert.equal((await req(url,'PATCH',{status:'done'},{cookie,'sec-fetch-site':'cross-site'})).status,403);
  const complete = await req(url,'PATCH',{status:'done'},{cookie});
  assert.equal(complete.status,200);
  assert.equal((await (await req(url,'GET',undefined,auth)).json()).card.status,'done');
  assert.equal((await req(url+'/images')).status,401);
  assert.match(complete.headers.get('cache-control'),/no-store/);
  process.env.GLAMP_AGENT_TOKEN_HASHES = '';
  assert.equal((await req(url,'GET',undefined,auth)).status,401);
  process.env.GLAMP_OWNER_TOKEN = randomBytes(32).toString('hex');
  assert.equal((await req(url,'GET',undefined,{cookie})).status,401);
});
