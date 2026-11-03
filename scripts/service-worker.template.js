// Only the public app shell is cached. Auth and financial API requests pass through.
const CACHE_NAME = '__CACHE_VERSION__'
const FILES = __SHELL_FILES__
const ROOT = new URL('./', self.location.href)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(FILES.filter((file) => file !== './').map((file) => new Request(new URL(file, ROOT), { cache: 'reload' })))
    const shellUrl = new URL(ROOT)
    shellUrl.searchParams.set('app-shell', CACHE_NAME)
    const shell = await fetch(shellUrl, { cache: 'reload' })
    if (!shell.ok) throw new Error('Public app shell unavailable')
    await cache.put(ROOT.href, shell)
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('northstar-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-cache' })
        if (response.ok && !url.search && response.headers.get('content-type')?.includes('text/html')) {
          const cache = await caches.open(CACHE_NAME)
          await cache.put(ROOT.href, response.clone())
        }
        return response
      } catch (error) {
        const cached = await caches.match(ROOT.href)
        if (cached) return cached
        throw error
      }
    })())
    return
  }
  if (!FILES.some((file) => new URL(file, ROOT).href === url.href)) return
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request)
    if (cached) return cached
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  }))
})
