// No fetch handler or offline cache: private pages and API calls stay with the server.
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function validCardId(id) {
  return typeof id === 'string' && uuid.test(id);
}

self.addEventListener('push', event => {
  let id;
  try { id = event.data?.json()?.cardId; } catch { /* No usable deep link. */ }
  event.waitUntil(self.registration.showNotification('Glamp', {
    body: 'A card is ready for review.',
    icon: '/icons/icon-192.png',
    data: validCardId(id) ? { cardId: id } : null,
  }));
});

async function openCard(id) {
  // Derive the path here; never follow a URL supplied by a notification.
  const path = `/?card=${id}`;
  const target = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const exact = windows.find(client => client.url === target);
  if (exact) return exact.focus();
  // Another tab may contain unsaved edits. Don't navigate or reload it.
  return self.clients.openWindow(path);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data?.cardId;
  if (validCardId(id)) event.waitUntil(openCard(id));
});
