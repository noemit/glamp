import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/glamp.mjs', import.meta.url));
const token = 'only-for-cli-tests-67c4d2';
const id = '550e8400-e29b-41d4-a716-446655440000';
const cardPath = `/api/cards/${id}`;
const markdown = '# Field notes\n\nGlamp café — **ready**.\n';
const file = 'field notes.md';
const card = {
  id, title: 'Field notebook', body: markdown, status: 'open', isTask: false,
  startingDate: null, endingDate: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};
const image = { id: '147c55ad-ad35-46e0-9bad-a1d86663da81', name: 'sunset.png', contentType: 'image/png' };
let cwd;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'glamp-cli-'));
  await writeFile(join(cwd, file), markdown);
});
after(async () => { if (cwd) await rm(cwd, { recursive: true, force: true }); });

// Start a fresh process in the fixture workspace, with no inherited tokens, proxies,
// .env file, or Node preload hooks. Nonzero exit is data; timeouts/signals are not.
async function run(args, env = {}) {
  const result = await new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], {
      cwd, env: { PATH: process.env.PATH, ...env }, timeout: 8000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err && !Number.isInteger(err.code)) return reject(err);
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'CLI disclosed GLAMP_TOKEN');
  return result;
}

// Capture what actually crossed the wire; assertions live in the tests, not
// the HTTP callback, so a failed assertion never leaves a child waiting on I/O.
async function service(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(request);
    const { status = 200, json, text, headers } = respond(request);
    res.writeHead(status, { 'content-type': json === undefined ? 'text/plain' : 'application/json', ...headers });
    res.end(json === undefined ? text : JSON.stringify(json));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, env: { GLAMP_URL: url, GLAMP_TOKEN: token }, requests };
}

async function exchange(t, args, method, pathname, envelope, query) {
  const api = await service(t, () => ({ status: method === 'POST' ? 201 : 200, json: envelope }));
  const result = await run(args, api.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.length, 1);
  const [req] = api.requests;
  assert.equal(req.method, method);
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.ok(!req.url.includes(token), 'GLAMP_TOKEN must not be sent in the URL');
  const url = new URL(req.url, api.url);
  assert.equal(url.pathname, pathname);
  if (query !== undefined) {
    assert.deepEqual(url.searchParams.getAll('q'), [query]);
  } else {
    assert.ok(!url.searchParams.has('q') || url.searchParams.get('q') === '');
  }
  if (args.includes('--json')) assert.deepEqual(JSON.parse(result.stdout), envelope);
  return { req, stdout: result.stdout };
}

function jsonBody(req) {
  assert.match(req.headers['content-type'] ?? '', /^application\/json\b/i);
  return JSON.parse(req.body.toString('utf8'));
}

function failed(result, json = true) {
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), '');
  assert.ok(result.stderr.trim(), 'expected a diagnostic on stderr');
  if (json) {
    const detail = JSON.parse(result.stderr);
    assert.ok(detail && !Array.isArray(detail) && typeof detail === 'object');
    assert.ok(detail.error || detail.message || detail.code, 'expected a structured diagnostic');
  }
}

test('help and schema work offline, without credentials or an API call', async t => {
  const api = await service(t, () => ({ status: 503 }));
  for (const env of [{}, api.env]) {
    const help = await run(['help'], env);
    assert.equal(help.code, 0, help.stderr);
    for (const command of ['list', 'search', 'read', 'put', 'update', 'status', 'attach', 'images']) {
      assert.ok(help.stdout.includes(command), `help should mention ${command}`);
    }
    const schema = await run(['--json', 'schema'], env);
    assert.equal(schema.code, 0, schema.stderr);
    const model = JSON.parse(schema.stdout);
    assert.equal(model.type, 'object');
    assert.equal(model.properties.title.maxLength, 200);
    assert.equal(model.properties.body.maxLength, 20_000);
    for (const key of Object.keys(card)) {
      assert.ok(Object.hasOwn(model.properties, key), `no schema for ${key}`);
      assert.ok(model.required.includes(key), `schema does not require ${key}`);
    }
    assert.deepEqual(new Set(model.properties.status.enum), new Set(['open', 'review', 'done']));
    for (const key of ['startingDate', 'endingDate']) {
      const date = model.properties[key];
      const variants = date.anyOf ?? date.oneOf ?? [date];
      assert.ok(variants.some(v => [v.type].flat().includes('string') && (v.format ?? date.format) === 'date'));
      assert.ok(variants.some(v => [v.type].flat().includes('null')), `${key} must be nullable`);
    }
  }
  assert.equal(api.requests.length, 0);
});

test('list (human output)', async t => {
  const { stdout } = await exchange(t, ['list'], 'GET', '/api/cards', { cards: [card] });
  assert.ok(stdout.includes(card.title));
});

test('list --json keeps the envelope even when empty', async t => {
  await exchange(t, ['list', '--json'], 'GET', '/api/cards', { cards: [] });
});

test('search joins words into one URL-encoded q parameter', async t => {
  const words = ['café', 'R&D', '#2+'];
  await exchange(t, ['--json', 'search', ...words], 'GET', '/api/cards', { cards: [card] }, words.join(' '));
});

test('read by UUID', async t => {
  await exchange(t, ['read', id, '--json'], 'GET', cardPath, { card });
});

const fields = { title: 'After the rain', status: 'review', isTask: true, startingDate: '2028-02-29', endingDate: '2028-03-02' };
const flags = ['--title', fields.title, '--status', fields.status, '--task', '--start', fields.startingDate, '--end', fields.endingDate];

test('put defaults the title to the first Markdown heading', async t => {
  const { req } = await exchange(t, ['--json', 'put', file], 'POST', '/api/cards', { card });
  const body = jsonBody(req);
  assert.equal(body.body, markdown);
  assert.equal(body.title, 'Field notes');
});

test('put falls back to the file stem without a heading', async t => {
  const filename = 'no heading.md';
  await writeFile(join(cwd, filename), 'A plain paragraph.\n');
  const { req } = await exchange(t, ['put', filename, '--json'], 'POST', '/api/cards', { card });
  assert.equal(jsonBody(req).title, 'no heading');
});

for (const command of ['put', 'update']) {
  test(`${command} sends Markdown and all explicitly supplied card fields`, async t => {
    const create = command === 'put';
    const args = create ? ['put'] : ['update', id];
    const body = { body: markdown, ...fields };
    const { req } = await exchange(t, [...args, file, ...flags, '--json'], create ? 'POST' : 'PATCH',
      create ? '/api/cards' : cardPath, { card: { ...card, ...body } });
    assert.deepEqual(jsonBody(req), body);
  });
}

test('update can patch a single field without a file or incidental resets', async t => {
  const { req } = await exchange(t, ['--json', 'update', id, '--title', fields.title], 'PATCH', cardPath,
    { card: { ...card, title: fields.title } });
  assert.deepEqual(jsonBody(req), { title: fields.title });
});

test('update with just a file replaces only the body, not the title', async t => {
  const { req } = await exchange(t, ['update', id, file, '--json'], 'PATCH', cardPath, { card });
  assert.deepEqual(jsonBody(req), { body: markdown });
});

test('update can clear both dates and unset the task flag', async t => {
  const { req } = await exchange(t, ['update', id, '--start', 'none', '--end', 'none', '--no-task', '--json'],
    'PATCH', cardPath, { card });
  assert.deepEqual(jsonBody(req), { startingDate: null, endingDate: null, isTask: false });
});

for (const status of ['open', 'review', 'done']) {
  test(`status patches only status (${status})`, async t => {
    const { req } = await exchange(t, ['status', id, status, '--json'], 'PATCH', cardPath, { card: { ...card, status } });
    assert.deepEqual(jsonBody(req), { status });
  });
}

// Valid one-pixel images, including NUL and non-UTF-8 bytes.
const samples = {
  png: ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNg+P8fAAMBAf+I73F5AAAAAElFTkSuQmCC'],
  jpg: ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCzAJkNf//Z'],
  webp: ['image/webp', 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8Skv/M0THMftX//TZv02b9Nm/9MWAAA='],
};
for (const [ext, [mime, base64]] of Object.entries(samples)) {
  test(`attach .${ext} posts raw bytes, MIME type and encoded basename`, async t => {
    const name = `café 100% #2.${ext}`;
    const absolute = join(cwd, name);
    const bytes = Buffer.from(base64, 'base64');
    await writeFile(absolute, bytes);
    const { req } = await exchange(t, ['attach', id, absolute, '--json'], 'POST', `${cardPath}/images`,
      { image: { ...image, name, contentType: mime } });
    assert.equal(req.headers['content-type'], mime);
    assert.equal(req.headers['x-filename'], encodeURIComponent(name));
    assert.deepEqual(req.body, bytes);
  });
}

for (const args of [['images', id], ['images', 'list', id]]) {
  test(`${args.slice(0, -1).join(' ')} fetches the image collection`, async t => {
    await exchange(t, ['--json', ...args], 'GET', `${cardPath}/images`, { images: [image] });
  });
}

test('invalid commands fail locally with a JSON diagnostic on stderr', async t => {
  const api = await service(t, () => ({ json: { card } }));
  for (const args of [
    ['no-such-command'], ['list', 'extra'], ['search'], ['read'], ['read', 'not-a-uuid'],
    ['put'], ['put', 'missing.md'], ['put', file, '--title'], ['put', file, '--status', 'later'],
    ['put', file, '--start', 'tomorrow'], ['update', id, '--end', '2027-02-29'],
    ['update', id], ['update', id, '--bogus'], ['update', 'not-a-uuid', file],
    ['status', id], ['status', id, 'closed'], ['attach', id], ['attach', id, file],
    ['attach', id, 'missing.png'], ['images'], ['images', 'list', 'not-a-uuid'],
  ]) {
    await t.test(args.join(' '), async () => {
      const before = api.requests.length;
      failed(await run([...args, '--json'], api.env));
      assert.equal(api.requests.length, before, 'invalid input must not reach the API');
    });
  }
});

test('put validates title and Markdown sizes before attempting a write', async t => {
  const api = await service(t, () => ({ json: { card } }));
  await writeFile(join(cwd, 'oversized.md'), 'x'.repeat(20_001));
  failed(await run(['put', file, '--json', '--title', 'x'.repeat(201)], api.env));
  failed(await run(['put', 'oversized.md', '--json'], api.env));
  assert.equal(api.requests.length, 0);
});

test('localhost works with an IPv4-only server, without exposing credentials to a proxy', async t => {
  const api = await service(t, () => ({ json: { cards: [] } }));
  const proxy = await service(t, () => ({ status: 407 }));
  const result = await run(['list', '--json'], {
    ...api.env, GLAMP_URL: api.url.replace('127.0.0.1', 'localhost'),
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.url, NO_PROXY: '',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(proxy.requests.length, 0);
});

test('missing token does not send an unauthenticated request', async t => {
  const api = await service(t, () => ({ json: { cards: [] } }));
  failed(await run(['--json', 'list'], { GLAMP_URL: api.url }));
  assert.equal(api.requests.length, 0);
});

test('HTTP debug tracing is refused before sending credentials', async t => {
  const api = await service(t, () => ({ json: { cards: [] } }));
  failed(await run(['list', '--json'], { ...api.env, NODE_DEBUG: 'http,https' }));
  assert.equal(api.requests.length, 0);
});

test('plain HTTP is rejected for non-loopback hosts', async t => {
  // 0.0.0.0 is unspecified, NOT loopback. This needs no DNS or outbound service.
  const api = await service(t, () => ({ json: { cards: [] } }));
  const result = await run(['list', '--json'], { ...api.env, GLAMP_URL: api.url.replace('127.0.0.1', '0.0.0.0') });
  failed(result);
  assert.match(result.stderr, /https|loopback|localhost|GLAMP_URL/i);
  assert.equal(api.requests.length, 0);
});

test('HTTP errors never disclose the bearer token, even when the server reflects it', async t => {
  const api = await service(t, req => {
    const message = `Rejected authorization: ${req.headers.authorization}`;
    return api.requests.length === 1 ? { status: 403, json: { error: message } } : { status: 500, text: message };
  });
  failed(await run(['--json', 'list'], api.env));
  failed(await run(['list'], api.env), false);
  assert.equal(api.requests.length, 2);
  for (const req of api.requests) assert.equal(req.headers.authorization, `Bearer ${token}`);
});

test('a successful API response containing the token fails closed in JSON and human modes', async t => {
  const api = await service(t, req => ({ json: { cards: [{ ...card, title: `Reflected ${req.headers.authorization}` }] } }));
  failed(await run(['list', '--json'], api.env));
  failed(await run(['list'], api.env), false);
  assert.equal(api.requests.length, 2);
  for (const req of api.requests) assert.equal(req.headers.authorization, `Bearer ${token}`);
});

test('redirects are errors, not a second request (same origin or different port)', async t => {
  const sink = await service(t, () => ({ json: { cards: [] } }));
  for (const [status, location] of [[302, '/redirect-target'], [307, `${sink.url}/redirect-target`]]) {
    const api = await service(t, req => req.url === '/redirect-target'
      ? { json: { cards: [] } } : { status, headers: { location } });
    failed(await run(['list', '--json'], api.env));
    assert.equal(api.requests.length, 1, 'must not follow a same-origin redirect');
    assert.equal(sink.requests.length, 0, 'must not contact the redirect target');
  }
});
