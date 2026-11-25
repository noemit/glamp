import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import webPush from 'web-push';
import { notifyReview, pushRouter } from '../server/push.mjs';

const sampleKeys = () => ({
  p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
  auth: randomBytes(16).toString('base64url')
});
const gateways = [
  'https://web.push.apple.com/test-token',
  'https://updates.push.services.mozilla.com/wpush/v2/test-token',
  'https://fcm.googleapis.com/fcm/send/test-token',
  'https://wns2-par02p.notify.windows.com/w/?token=test-token'
];

// The app tests cover the parent auth mount. Here all requests model an already-authorized owner.
test('private push configuration, persistence and delivery', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'glamp-push-'));
  const local = join(dir, 'push_subscriptions');
  const env = { ...process.env };
  const changed = ['GLAMP_DATA_DIR', 'NODE_ENV', 'VERCEL', 'DATABASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
  t.after(async () => {
    for (const key of changed) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (const key of changed) delete process.env[key];
  process.env.GLAMP_DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  const app = express().use('/api/push', express.json({ limit: '8kb' }), pushRouter);
  const server = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/api/push${route}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
  });
  const post = body => request('/subscribe', 'POST', body);
  const vapid = webPush.generateVAPIDKeys();
  await t.test('requires a valid, persistent VAPID identity and exposes only the public key', async () => {
    const missing = await request('/key');
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /VAPID_PUBLIC_KEY.*VAPID_PRIVATE_KEY.*VAPID_SUBJECT/);
    Object.assign(process.env, { VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: webPush.generateVAPIDKeys().privateKey });
    assert.equal((await request('/key')).status, 503);
    process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
    const response = await request('/key');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await response.json(), { publicKey: vapid.publicKey });
  });
  const keys = sampleKeys();
  await t.test('accepts only HTTPS gateway delivery addresses and valid key material', async () => {
    const disallowed = [ 'http://web.push.apple.com/token', 'https://push.example.test/send', 'https://127.0.0.1/',
      'https://fcm.googleapis.com/not-push', 'https://fcm.googleapis.com.example.test/fcm/send/test',
      'https://web.push.apple.com:8443/token', 'https://user@web.push.apple.com/token',
      'https://web.push.apple.com/token#fragment', 'https://example.test\\@web.push.apple.com/token' ];
    for (const endpoint of disallowed) assert.equal((await post({ endpoint, keys })).status, 400);
    assert.equal((await post({ endpoint: gateways[0], keys: { ...keys, auth: 'short' } })).status, 400);
    assert.equal((await post({ endpoint: gateways[0], keys: { ...keys, p256dh: 'A'.repeat(87) } })).status, 400);
    assert.deepEqual(await readdir(local), []);
  });
  await t.test('persists a private, idempotent subscription per device', async () => {
    const subscriptions = gateways.map(endpoint => ({ endpoint, keys, ignored: 'unnecessary data' }));
    const responses = await Promise.all([...subscriptions, subscriptions[0]].map(post));
    assert.ok(responses.every(r => r.status === 204));
    assert.equal((await stat(local)).mode & 0o077, 0);
    const files = await readdir(local);
    assert.equal(files.length, 4);
    for (const file of files) {
      assert.match(file, /^[0-9a-f]{64}\.json$/);
      assert.equal((await stat(join(local, file))).mode & 0o077, 0);
      const sub = JSON.parse(await readFile(join(local, file), 'utf8'));
      assert.ok(gateways.includes(sub.endpoint));
      assert.deepEqual(sub, { endpoint: sub.endpoint, keys });
    }
  });
  await t.test('revalidates on send, encrypts a card id only, prunes expired but not transient failures', async () => {
    const card = { id: randomUUID(), title: 'Private text' };
    const badFile = join(local, 'a'.repeat(64) + '.json');
    await writeFile(badFile, JSON.stringify({ endpoint: 'https://example.test', keys }));
    const sender = t.mock.method(webPush, 'sendNotification', async (sub, body, options) => {
      assert.ok(gateways.includes(sub.endpoint));
      assert.deepEqual(JSON.parse(body), { cardId: card.id });
      const details = webPush.generateRequestDetails(sub, body, options);
      assert.match(details.headers.Authorization, /^vapid /);
      assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(details.body.includes(card.id), false);
      if (sub.endpoint === gateways[0]) throw Object.assign(new Error(), { statusCode: 410 });
      if (sub.endpoint === gateways[2]) throw Object.assign(new Error(), { statusCode: 503 });
    });
    assert.deepEqual(await notifyReview(card), { sent: 2, expired: 1, failed: 2 });
    assert.equal(sender.mock.callCount(), 4);
    await rm(badFile);
    sender.mock.restore();
    assert.equal((await readdir(local)).length, 3);
    assert.equal((await request('/subscribe', 'DELETE', { endpoint: gateways[2] })).status, 204);
    assert.equal((await readdir(local)).length, 2);
    await assert.rejects(notifyReview({ id: 'invalid' }), /UUID/);
  });
  await t.test('refuses local fallback when deployed, even if given a previously usable local directory', async () => {
    process.env.NODE_ENV = 'production';
    assert.equal((await request('/key')).status, 503);
    process.env.NODE_ENV = 'test';
    process.env.VERCEL = '1';
    const res = await post({ endpoint: gateways[0], keys });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /DATABASE_URL.*sql\/push.sql/);
    await assert.rejects(notifyReview({ id: randomUUID() }), /storage unavailable/i);
    assert.equal((await readdir(local)).length, 2);
  });
});
