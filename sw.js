// The service worker that makes the site an installable app (D-58), with manifest.webmanifest.
// It keeps the page's own small files (the page, its scripts, images, the manifest and the file lists) in its own cache,
// network first: online, every load gets the newest copy from the server, and the cache is only used when the network
// fails. The big files (_framework/, game/) pass straight through: main.js keeps those itself (D-47, D-54), in the
// "duck-game-files" cache, which this never touches. Other sites (the matchmaking server) are never handled.

const pageCache = 'duck-game-page-v1';
const ownCaches = /^duck-game-page-/;
const passThrough = /\/(_framework|game)\//;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		for (const name of await caches.keys()) {
			if (ownCaches.test(name) && name !== pageCache) {
				await caches.delete(name);
			}
		}
		await self.clients.claim();
	})());
});

async function networkFirst(request) {
	const cache = await caches.open(pageCache);
	try {
		const response = await fetch(request, { cache: 'no-cache' });
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const kept = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
		if (kept) {
			return kept;
		}
		throw error;
	}
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== self.location.origin || passThrough.test(url.pathname)) {
		return;
	}
	event.respondWith(networkFirst(request));
});
