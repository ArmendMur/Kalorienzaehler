const CACHE_NAME = 'kalorien-zaehler-v3.3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/htm/dist/htm.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Jedes Asset einzeln laden und cachen (Promise.allSettled verhindert Abbruch)
      await Promise.allSettled(
        STATIC_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url);
            if (res.ok || res.type === 'opaque') {
              await cache.put(url, res);
            }
          } catch (err) {
            try {
              const res = await fetch(url, { mode: 'no-cors' });
              await cache.put(url, res);
            } catch (e) {
              console.warn('Install asset fetch failed:', url);
            }
          }
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_CACHE' || (event.data && event.data.type === 'CLEAR_CACHE')) {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

const getCachedHtml = async () => {
  try {
    const cache = await caches.open(CACHE_NAME);
    const direct = (await cache.match('./index.html')) ||
                   (await cache.match('./')) ||
                   (await cache.match('index.html')) ||
                   (await caches.match('./index.html')) ||
                   (await caches.match('./'));
    if (direct) return direct;

    const keys = await cache.keys();
    for (const k of keys) {
      const p = new URL(k.url).pathname;
      if (p.endsWith('/index.html') || p.endsWith('/') || p.includes('kalorienzaehler')) {
        const match = await cache.match(k);
        if (match) return match;
      }
    }
  } catch (e) {}
  return null;
};

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Don't cache Gemini API or OpenFoodFacts live API calls
  if (event.request.url.includes('generativelanguage.googleapis.com') || event.request.url.includes('world.openfoodfacts.org')) {
    return;
  }

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Nur ECHTE HTML-Dokumentennavigation der eigenen App als HTML-Navigation behandeln!
  // Externe Skripte (wie cdn.tailwindcss.com) dürfen NIEMALS als HTML abgefangen werden!
  const isHtmlNavigation = isSameOrigin && (
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    url.pathname.endsWith('/index.html') ||
    (url.pathname.endsWith('/') && !url.pathname.includes('.'))
  );

  if (isHtmlNavigation) {
    // Netzwerk Prio 1 mit schnellem 2.2s-Fallback auf Cache bei Offline / schlechtem Empfang
    event.respondWith((async () => {
      // 1. Wenn das Gerät offline ist: Sofort ohne Verzögerung aus dem Cache laden
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const offlineRes = await getCachedHtml();
        if (offlineRes) return offlineRes;
      }

      // 2. Netzwerk-Request starten (Prio 1)
      const networkPromise = (async () => {
        try {
          const networkResponse = await fetch(event.request, { cache: 'no-cache' });
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, copy);
            await cache.put('./index.html', copy.clone());
            await cache.put('./', copy.clone());
          }
          return networkResponse;
        } catch (err) {
          return null;
        }
      })();

      // 3. Timeout von 2.2 Sekunden (verhindert hängende weiße Bildschirme bei Funklöchern)
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(null), 2200);
      });

      const fastWinner = await Promise.race([networkPromise, timeoutPromise]);
      if (fastWinner && fastWinner.status === 200) {
        return fastWinner;
      }

      // 4. Netzwerk hat länger als 2.2s gebraucht oder ist fehlgeschlagen -> Cache liefern!
      const cached = await getCachedHtml();
      if (cached) {
        networkPromise.catch(() => {});
        return cached;
      }

      // 5. Falls noch gar kein Cache existiert: auf Netzwerk warten
      const fallbackNet = await networkPromise;
      if (fallbackNet) return fallbackNet;

      return new Response("Offline - Keine Verbindung und kein Cache vorhanden.", {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })());
    return;
  }

  // Cache-First für statische Assets (Scripts, Stylesheets, Icons, Fonts)
  event.respondWith((async () => {
    const cachedResponse = await caches.match(event.request);
    if (cachedResponse) {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        fetch(event.request).then(async (networkResponse) => {
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, networkResponse);
          }
        }).catch(() => {});
      }
      return cachedResponse;
    }

    try {
      const networkResponse = await fetch(event.request);
      if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
        const copy = networkResponse.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, copy);
      }
      return networkResponse;
    } catch (err) {
      const fallback = await caches.match(event.request);
      if (fallback) return fallback;
      throw err;
    }
  })());
});
