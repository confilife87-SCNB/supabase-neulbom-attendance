const CACHE_NAME = 'neulbom-pwa-v4-2';

const STATIC_ASSETS = [
  './',
  './index.html',
  './config.js',
  './api.js',
  './sw.js',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// ── 설치: 정적 파일 캐시 ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── 활성화: 이전 캐시 삭제 ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── 요청 처리 ──
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // GAS API 호출 → 항상 네트워크 (캐시 안 함)
  if (url.includes('script.google.com')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(
          JSON.stringify({ success: false, error: '오프라인 상태입니다. 네트워크를 확인하세요.' }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // 정적 파일 → 캐시 우선, 실패 시 네트워크
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME)
          .then(cache => cache.put(e.request, clone));
        return res;
      });
    })
  );
});

// ── 새 버전 감지 ──
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
