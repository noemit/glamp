import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { enablePush } from '../public/push.js';

const key = new Uint8Array(65).fill(255);
key[0] = 4;
const publicKey = Buffer.from(key).toString('base64url');
const wire = { endpoint: 'https://example.test/sub', keys: { auth: 'auth', p256dh: 'key' } };

function browser(t, { oldKey, grant = 'granted', config = { publicKey } } = {}) {
  const calls = [];
  const sub = { toJSON: () => wire };
  const old = oldKey && { ...sub, options: { applicationServerKey: oldKey.buffer },
    unsubscribe: async () => { calls.push('unsubscribe'); return true; } };
  const pushManager = {
    async getSubscription() { calls.push('getSubscription'); return old; },
    async subscribe({ applicationServerKey, userVisibleOnly }) {
      calls.push('subscribe');
      assert.deepEqual(applicationServerKey, key);
      assert.equal(userVisibleOnly, true);
      return sub;
    },
  };
  const globals = {
    window: { isSecureContext: true, PushManager: class {}, Notification: { permission: 'default',
      async requestPermission() { calls.push('permission'); return grant; } } },
    navigator: { serviceWorker: {
      async register(path) { calls.push(`register ${path}`); return {}; },
      get ready() { calls.push('ready'); return Promise.resolve({ pushManager }); },
    } },
    async fetch(path, options) {
      calls.push(`${options.method} ${path}`);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      if (path === '/api/push/key') return Response.json(config);
      assert.equal(path, '/api/push/subscribe');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), wire);
      return new Response(null, { status: 204 });
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  }
  return calls;
}

for (const [scenario, oldKey, actions] of [
  ['first opt-in', undefined, ['subscribe']],
  ['same key', key, []],
  ['rotated key', key.map((b, i) => i ? 17 : b), ['unsubscribe', 'subscribe']],
]) {
  test(scenario, async t => {
    const calls = browser(t, { oldKey });
    const result = enablePush();
    assert.deepEqual(calls, ['permission'], 'permission requested within the click stack');
    assert.equal(await result, true);
    assert.deepEqual(calls, ['permission', 'GET /api/push/key', 'register /sw.js', 'ready',
      'getSubscription', ...actions, 'POST /api/push/subscribe']);
  });
}

test('denial does not perform push setup', async t => {
  const calls = browser(t, { grant: 'denied' });
  await assert.rejects(enablePush(), /blocked/i);
  assert.deepEqual(calls, ['permission']);
});

test('key configuration error leaves existing subscription alone', async t => {
  const calls = browser(t, { oldKey: key, config: { error: 'Push is not configured' } });
  await assert.rejects(enablePush(), /not configured/);
  assert.deepEqual(calls, ['permission', 'GET /api/push/key']);
});

test('insecure context and iOS browser tab get guidance, not a permission prompt', async t => {
  const calls = browser(t);
  window.isSecureContext = false;
  await assert.rejects(enablePush(), /HTTPS/);
  window.isSecureContext = true;
  navigator.userAgent = 'iPhone';
  await assert.rejects(enablePush(), /Home Screen/);
  assert.deepEqual(calls, []);
});

const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const id = '06ecdf81-a497-4ce6-9c45-c11d8fe682a4';
const origin = 'https://app.example';
const path = `/?card=${id}`;
function worker(clients) {
  const handlers = new Map();
  const notices = [];
  vm.runInNewContext(sw, { URL, self: {
    addEventListener: (name, fn) => handlers.set(name, fn),
    registration: { showNotification: async (...args) => notices.push(structuredClone(args)) },
    location: { origin }, clients,
  } });
  assert.equal(handlers.has('fetch'), false);
  async function dispatch(name, fields) {
    let work;
    handlers.get(name)({ ...fields, waitUntil: p => { work = p; } });
    await work;
  }
  return { dispatch, notices, click: data => dispatch('notificationclick', { notification: { data, close() {} } }) };
}

test('lock screen gets only generic content; retain only a valid card ID', async () => {
  const { dispatch, notices } = worker();
  const payload = { cardId: id, title: 'private title', body: 'private content', url: 'https://other.example' };
  await dispatch('push', { data: { json: () => payload } });
  await dispatch('push', { data: { json: () => { throw new SyntaxError(); } } });
  const [title, options] = notices[0];
  assert.deepEqual(options.data, { cardId: id });
  assert.equal(options.icon, '/icons/icon-192.png');
  assert.doesNotMatch(JSON.stringify(notices), /private|other\.example/);
  assert.equal(notices[1][0], title);
  assert.equal(notices[1][1].body, options.body);
  assert.equal(notices[1][1].data, null);
});

test('click opens only a derived card path; never navigate an editing window', async () => {
  const calls = [];
  let windows = [{ url: origin + '/?edit=1', focus: assert.fail, navigate: assert.fail }];
  const { click } = worker({ matchAll: async () => windows, openWindow: async path => calls.push(path) });
  const url = 'https://other.example';
  for (const cardId of [null, '', url, `${id}#fragment`, `${id}&next=/`]) await click({ url, cardId });
  assert.deepEqual(calls, []);
  await click({ cardId: id, url });
  assert.deepEqual(calls, [path]);
  windows.push({ url: origin + path, focus: async () => calls.push('focus'), navigate: assert.fail });
  await click({ cardId: id, url });
  assert.deepEqual(calls, [path, 'focus']);
});
