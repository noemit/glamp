import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';

// initStore() is a singleton. Use one fresh store per suite; each case seeds
// its own cards and makes no assumptions about list ordering or prior cases.
describe('cards HTTP contract', { concurrency: false }, () => {
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  const app = express();
  const envKeys = ['GLAMP_DATA_DIR', 'NODE_ENV', 'VERCEL', 'DATABASE_URL'];
  const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  let dir, server, base, cardExists;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'glamp-cards-contract-'));
    process.env.GLAMP_DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL;
    delete process.env.DATABASE_URL;
    const cards = await import('../server/cards.mjs');
    await cards.initStore();
    cardExists = cards.cardExists;
    app.locals.notifyReview = async () => {};
    app.use('/api/cards', cards.cardsRouter);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/cards`;
  });

  after(async () => {
    try {
      if (server?.listening) await new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
        server.closeAllConnections();
      });
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  // Accept raw JSON text so malformed-body cases use the same HTTP path.
  async function request(method, path, status, body, label = '') {
    const response = await fetch(base + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
    });
    const text = await response.text();
    const where = `${method} ${path} ${label}`.trimEnd();
    assert.equal(response.status, status, `${where}: HTTP ${response.status}, ${text.slice(0, 180)}`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, where);
    const result = JSON.parse(text);
    const collection = method === 'GET' && (path === '' || path.startsWith('?'));
    const key = status >= 400 ? 'error' : collection ? 'cards' : 'card';
    assert.deepEqual(Object.keys(result), [key], where);
    if (key === 'error') {
      assert.equal(typeof result.error, 'string', where);
      assert.notEqual(result.error.trim(), '', where);
    } else if (collection) assert.ok(Array.isArray(result.cards), where);
    else assert.match(result.card.id, uuid, where);
    return result[key];
  }
  const create = fields => request('POST', '', 201, JSON.stringify(fields));
  const get = id => request('GET', `/${id}`, 200);
  const patch = (id, fields) => request('PATCH', `/${id}`, 200, JSON.stringify(fields));
  const list = q => request('GET', q === undefined ? '' : `?${new URLSearchParams({ q })}`, 200);
  const ids = cards => cards.map(card => card.id).sort();

  it('creates with defaults, reads, lists and updates without replacing omitted fields', async () => {
    const first = await create({ title: '  Plan a trip\t' });
    assert.equal(first.title, 'Plan a trip');
    assert.equal(first.body, '');
    assert.equal(first.isTask, false);
    assert.equal(first.startingDate, null);
    assert.equal(first.endingDate, null);
    assert.equal(first.status, 'open');
    assert.deepEqual(Object.keys(first).sort(), ['id', 'title', 'body', 'isTask', 'status', 'startingDate', 'endingDate', 'createdAt', 'updatedAt'].sort());
    for (const stamp of [first.createdAt, first.updatedAt]) assert.equal(new Date(stamp).toISOString(), stamp);
    assert.equal(await cardExists(first.id), true);
    assert.deepEqual(await get(first.id), first);

    const second = await create({ title: 'Plan a trip' });
    assert.notEqual(first.id, second.id);
    const fields = { title: '  Route & gear  ', body: 'Map\n"north" → 🏕️', isTask: true,
      status: 'review', startingDate: '2028-02-29', endingDate: '2028-02-29' };
    const edited = await patch(first.id, fields);
    for (const [key, value] of Object.entries({ ...fields, title: fields.title.trim() })) {
      assert.equal(edited[key], value, key);
    }
    assert.equal(edited.id, first.id);
    assert.equal(edited.createdAt, first.createdAt);
    const done = await patch(first.id, { status: 'done', startingDate: null });
    assert.deepEqual(done, { ...edited, status: 'done', startingDate: null, updatedAt: done.updatedAt });
    assert.deepEqual(await get(first.id), done);
    const cards = await list();
    assert.deepEqual(cards.filter(c => c.id === first.id), [done]);
    assert.deepEqual(cards.filter(c => c.id === second.id), [second]);
  });

  it('searches inside title and body, ignoring case but treating punctuation literally', async () => {
    const term = "Café 50%_O'Brien [x].* &+#";
    const byTitle = await create({ title: `prefix ${term} suffix` });
    const byBody = await create({ title: 'Field notes', body: `before\n${term.toUpperCase()}\nafter` });
    // Decoys distinguish literal %, _ and regex characters from patterns.
    await create({ title: term.replace('%', 'percent') });
    await create({ title: term.replace('_', 'X') });
    await create({ title: term.replace('[x].*', 'xxx') });
    assert.deepEqual(ids(await list(term.toLowerCase())), [byTitle.id, byBody.id].sort());
    assert.deepEqual(await list('no such phrase ' + randomUUID()), []);
  });

  it('accepts title, body and query at the limits, rejects one character over', async () => {
    const title = 'Z'.repeat(200), body = 'b'.repeat(20000);
    const card = await create({ title, body });
    assert.equal(card.title, title);
    assert.equal(card.body, body);
    assert.deepEqual(await list(title.toLowerCase()), [card]);
    for (const [field, value] of [['title', title + 'z'], ['body', body + 'b']]) {
      await request('POST', '', 400, JSON.stringify({ title: 'Too long', [field]: value }), field);
      await request('PATCH', `/${card.id}`, 400, JSON.stringify({ [field]: value }), field);
    }
    await request('GET', `?q=${title}z`, 400);
    assert.deepEqual(await get(card.id), card);
  });

  it('rejects invalid fields on create and edit rather than dropping or coercing them', async () => {
    const existing = await create({ title: 'Untouched' });
    const beforeIds = ids(await list());
    for (const fields of [{}, { body: 'no title supplied' }]) {
      await request('POST', '', 400, JSON.stringify(fields), 'missing title');
    }
    for (const fields of [
      { title: ' \n ' }, { title: 42 }, { body: null }, { isTask: 'false' }, { status: 'closed' },
      { startingDate: '2023-02-29' }, { endingDate: '2024-04-31' }, { startingDate: '2024-2-01' },
      { endingDate: '2024-02-29T00:00:00Z' }, { startingDate: '2025-01-02', endingDate: '2025-01-01' },
      { extra: 'unknown' }, { id: randomUUID() }, { createdAt: '2024-01-01T00:00:00Z' },
      { updatedAt: '2024-01-01T00:00:00Z' },
    ]) {
      const body = JSON.stringify({ title: 'Do not save', ...fields });
      await request('POST', '', 400, body, JSON.stringify(fields));
      await request('PATCH', `/${existing.id}`, 400, body, JSON.stringify(fields));
    }
    assert.deepEqual(await get(existing.id), existing);
    assert.deepEqual(ids(await list()), beforeIds);
  });

  it('rejects malformed, empty and non-object PATCH bodies', async () => {
    const card = await create({ title: 'Keep me' });
    for (const raw of [undefined, '', '{"title":', '{}', '[]', 'null', '"text"']) {
      await request('PATCH', `/${card.id}`, 400, raw, `body: ${String(raw)}`);
    }
    assert.deepEqual(await get(card.id), card);
  });

  it('checks a PATCH against the stored date at the other end, with no partial writes or notices', async t => {
    const notify = t.mock.method(app.locals, 'notifyReview', async () => {});
    const card = await create({ title: 'Original', startingDate: '2028-04-10', endingDate: '2028-04-20' });
    for (const dateEdit of [{ startingDate: '2028-04-21' }, { endingDate: '2028-04-09' }]) {
      await request('PATCH', `/${card.id}`, 400, JSON.stringify({
        ...dateEdit, title: 'Do not commit', body: 'nor this', isTask: true, status: 'review',
      }));
      assert.deepEqual(await get(card.id), card);
      assert.equal(notify.mock.callCount(), 0);
    }
    // Both dates may move past the old range together if the merged result is valid.
    const moved = await patch(card.id, { startingDate: '2028-05-01', endingDate: '2028-05-02' });
    assert.equal(moved.startingDate, '2028-05-01');
    assert.equal(moved.endingDate, '2028-05-02');
    assert.equal((await patch(card.id, { endingDate: null })).endingDate, null);
  });

  it('persists in GLAMP_DATA_DIR across process restarts', async () => {
    const card = await create({ title: 'Durable note' });
    const url = new URL('../server/cards.mjs', import.meta.url).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { cardExists } from ${JSON.stringify(url)}; console.log(await cardExists(process.argv[1]));`, card.id],
    { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.trim(), 'true');
  });

  it('refuses SQLite on deployed workspaces without a DATABASE_URL', async () => {
    const url = new URL('../server/cards.mjs', import.meta.url).href;
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'development', VERCEL: '1' }]) {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { initStore } from ${JSON.stringify(url)};
        import assert from 'node:assert/strict';
        await assert.rejects(initStore(), { status: 503 });
      `], { env: { ...process.env, ...env }, timeout: 10000, stdio: 'pipe' });
    }
  });

  it('does not switch to the local store on a Neon outage', async () => {
    const local = await create({ title: 'Do not fall back to this database' });
    const url = new URL('../server/cards.mjs', import.meta.url).href;
    const neon = import.meta.resolve('@neondatabase/serverless');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { neonConfig } from ${JSON.stringify(neon)};
      import { cardExists } from ${JSON.stringify(url)};
      let attempts = 0;
      neonConfig.fetchFunction = () => { attempts++; throw new Error('Simulated offline'); };
      await assert.rejects(cardExists(process.argv[1]));
      assert.ok(attempts > 0);
    `, local.id], { env: { ...process.env, DATABASE_URL: 'postgresql://fake:fake@db.invalid/workspace' },
      timeout: 10000, stdio: 'pipe' });
  });

  it('concurrent edits preserve both changes and notify just once', async t => {
    const notify = t.mock.method(app.locals, 'notifyReview', async () => {});
    const original = await create({ title: 'Concurrent changes' });
    await Promise.all([patch(original.id, { title: 'New title', status: 'review' }),
      patch(original.id, { body: 'New body', status: 'review' })]);
    const saved = await get(original.id);
    assert.equal(saved.title, 'New title');
    assert.equal(saved.body, 'New body');
    assert.equal(saved.status, 'review');
    assert.equal(notify.mock.callCount(), 1);
  });

  it('distinguishes a malformed id from an absent UUID', async () => {
    for (const [id, status] of [['not-a-uuid', 400], [randomUUID(), 404]]) {
      assert.equal(await cardExists(id), false);
      await request('GET', `/${id}`, status);
      await request('PATCH', `/${id}`, status, JSON.stringify({ title: 'No such card' }));
    }
  });

  it('notifies once per entry into review, including creation but not edits within review', async t => {
    const calls = [];
    t.mock.method(app.locals, 'notifyReview', async card => { calls.push([card.id, card.status]); });
    const open = await create({ title: 'Open card' });
    assert.deepEqual(calls, []);
    const review = await create({ title: 'Already in review', status: 'review' });
    const expected = [[review.id, 'review']];
    assert.deepEqual(calls, expected);
    await patch(open.id, { status: 'review' });
    expected.push([open.id, 'review']);
    assert.deepEqual(calls, expected);
    await patch(review.id, { title: 'New title' });
    await patch(open.id, { status: 'review', body: 'More notes' });
    await patch(open.id, { status: 'done' });
    assert.deepEqual(calls, expected);
    await patch(open.id, { status: 'review' });
    assert.deepEqual(calls, [...expected, [open.id, 'review']]);
  });

  it('keeps writes successful and readable when the review notifier rejects', async t => {
    const notify = t.mock.method(app.locals, 'notifyReview', async () => { throw new Error('offline'); });
    const created = await create({ title: 'Review on create', status: 'review' });
    assert.equal(created.status, 'review');
    assert.deepEqual(await get(created.id), created);
    const open = await create({ title: 'Review on edit' });
    const edited = await patch(open.id, { status: 'review', body: 'Saved despite rejection' });
    assert.equal(edited.status, 'review');
    assert.equal(edited.body, 'Saved despite rejection');
    assert.deepEqual(await get(open.id), edited);
    assert.equal(notify.mock.callCount(), 2);
  });
});
