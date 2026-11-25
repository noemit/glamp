function checkSupport() {
  if (!window.isSecureContext) {
    throw new Error('Notifications require HTTPS (or localhost for development).');
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !navigator.standalone && !window.matchMedia?.('(display-mode: standalone)').matches) {
    throw new Error('On iOS or iPadOS 16.4 or later, use Add to Home Screen, then open Glamp from its icon to enable notifications.');
  }
  if (!navigator.serviceWorker || !window.PushManager || !window.Notification?.requestPermission) {
    throw new Error('This browser does not support Web Push notifications.');
  }
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.error === 'string' ? body.error :
      `Push setup failed (HTTP ${response.status}). Check that you are signed in and try again.`);
  }
  return response;
}

function decodeKey(value) {
  // Web Push uses a base64url-encoded, uncompressed P-256 public key.
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{87}=?$/.test(value)) {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (bytes.length === 65 && bytes[0] === 4) return bytes;
  }
  throw new Error('The server did not return a valid Web Push public key.');
}

function sameKey(buffer, key) {
  if (!buffer) return false;
  const existing = new Uint8Array(buffer);
  return existing.length === key.length && existing.every((byte, i) => byte === key[i]);
}

// Call directly from the enable button's click handler, never on page load.
export async function enablePush() {
  checkSupport();
  const notifications = window.Notification;
  let permission = notifications.permission;
  // No async work before this call: iOS needs the button's transient activation.
  if (permission === 'default') permission = await notifications.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Notifications are blocked. Allow them in your browser or system settings.' :
      'Notification permission was not granted. Click Enable again when you are ready.');
  }

  const response = await request('/api/push/key', { method: 'GET' });
  const config = await response.json().catch(() => null);
  if (typeof config?.error === 'string') throw new Error(config.error);
  const key = decodeKey(config?.publicKey);

  await navigator.serviceWorker.register('/sw.js');
  const { pushManager } = await navigator.serviceWorker.ready;
  let subscription = await pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
    if (!await subscription.unsubscribe()) throw new Error('Could not replace the old push subscription. Try again.');
    subscription = null;
  }
  subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await request('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription.toJSON()),
  });
  return true;
}
