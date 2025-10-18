// This is a JavaScript file
// sw.js
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || 'PlantApp';
  const body  = data.body  || '通知';
  const tag   = data.tag   || 'plantapp';
  const icon  = data.icon  || '/icons/icon-192.png';
  e.waitUntil(self.registration.showNotification(title, { body, tag, icon, vibrate: [120,60,120] }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

