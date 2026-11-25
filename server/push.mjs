import { createECDH, ECDH } from 'node:crypto';
import express from 'express';
import webPush from 'web-push';
import { subscriptionStore } from './push-store.mjs';

class PushError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = () => new PushError(400, 'Invalid browser subscription or unsupported push service.');
const storageError = () => new PushError(503,
  'Private push storage unavailable. Check POSTGRES_URL or DATABASE_URL and apply sql/push.sql as the database owner; for local development use a private, writable GLAMP_DATA_DIR.');

function vapidDetails() {
  const { VAPID_SUBJECT: subject, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  if (!subject || !publicKey || !privateKey) {
    throw new PushError(503, 'Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (generate a persistent pair with npx web-push generate-vapid-keys), and VAPID_SUBJECT to a mailto: contact or HTTPS URL.');
  }
  try {
    const url = new URL(subject);
    const contactPage = url.protocol === 'https:' && !url.username && !url.password && url.hostname !== 'localhost';
    const contactEmail = url.protocol === 'mailto:' && /^[^\s@]+@[^\s@]+$/.test(url.pathname);
    if (!contactPage && !contactEmail) throw new Error();
    if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error();
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== publicKey) throw new Error();
  } catch {
    throw new PushError(503, 'Check VAPID_SUBJECT and the matching VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY pair.');
  }
  return { subject, publicKey, privateKey };
}

// Accept only delivery URLs on known Web Push infrastructure, never generic HTTPS URLs.
// Canonicalize before passing to web-push (which uses Node's legacy URL parser and does
// not follow redirects). Recheck at send time as stored data may predate this policy.
function deliveryEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !/^https:\/\//.test(raw) ||
      /[^\x21-\x7e]|[\\#]/.test(raw) || raw.slice(8).split(/[/?]/, 1)[0].includes('@')) throw invalid();
  let url;
  try { url = new URL(raw); } catch { throw invalid(); }
  const { hostname, port, pathname } = url;
  if (url.protocol !== 'https:' || port || url.username || url.password) throw invalid();
  const google = hostname === 'fcm.googleapis.com' && /^\/(?:fcm\/send|wp)\/[^/]+$/.test(pathname);
  const mozilla = hostname === 'updates.push.services.mozilla.com' && /^\/wpush\/v\d+\/[^/]+$/.test(pathname);
  const apple = hostname === 'web.push.apple.com' && /^\/[^/]+$/.test(pathname);
  const windows = /^(?:[a-z0-9-]+\.)?notify\.windows\.com$/.test(hostname) &&
    /^\/w\/?$/.test(pathname) && Boolean(url.searchParams.get('token'));
  if (!(google || mozilla || apple || windows)) throw invalid();
  return url.href;
}

function subscription(body) {
  const endpoint = deliveryEndpoint(body?.endpoint);
  const { p256dh, auth } = body.keys ?? {};
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth)) throw invalid();
  try {
    const key = Buffer.from(p256dh, 'base64url');
    if (key[0] !== 4) throw invalid();
    ECDH.convertKey(key, 'prime256v1'); // Reject invalid P-256 points before storage.
  } catch { throw invalid(); }
  return { endpoint, keys: { p256dh, auth } };
}

// Mounted after the parent's requireAuth, requireOwner and bounded JSON body parser.
// No endpoint enumeration, arbitrary test-send, or notification content supplied over HTTP.
export const pushRouter = express.Router();
pushRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
pushRouter.get('/key', async (_req, res) => {
  const { publicKey } = vapidDetails();
  await subscriptionStore(); // In particular, don't advertise local fallback on a deployment.
  res.json({ publicKey });
});
pushRouter.post('/subscribe', async (req, res) => {
  vapidDetails();
  const sub = subscription(req.body);
  await (await subscriptionStore()).put(sub);
  res.status(204).end();
});
pushRouter.delete('/subscribe', async (req, res) => {
  const endpoint = deliveryEndpoint(req.body?.endpoint);
  await (await subscriptionStore()).remove(endpoint);
  res.status(204).end();
});
pushRouter.use((err, _req, res, _next) => {
  // Storage and Web Push library errors can contain credentials or capability URLs.
  const safe = err instanceof PushError ? err : storageError();
  res.status(safe.status).json({ error: safe.message });
});

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function notifyReview(card) {
  if (typeof card?.id !== 'string' || !uuid.test(card.id)) throw new PushError(400, 'A card UUID is required.');
  const payload = JSON.stringify({ cardId: card.id }); // No private titles or notes on lock screens.
  const vapid = vapidDetails();
  const stats = { sent: 0, expired: 0, failed: 0 };
  try {
    const store = await subscriptionStore();
    const saved = await store.all();
    const send = async raw => {
      let sub;
      try {
        sub = subscription(raw);
        await webPush.sendNotification(sub, payload, { vapidDetails: vapid, TTL: 86400, timeout: 8000 });
        stats.sent++;
      } catch (err) {
        if (sub && [404, 410].includes(err.statusCode)) {
          await store.remove(sub.endpoint);
          stats.expired++;
        } else {
          stats.failed++; // Keep transient failures for subsequent card notifications.
        }
      }
    };
    for (let i = 0; i < saved.length; i += 4) {
      await Promise.all(saved.slice(i, i + 4).map(send));
    }
    return stats;
  } catch { throw storageError(); }
}
