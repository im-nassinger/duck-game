// Starts Duck Game in the browser (web-port tasks T7 and T8). The steps, in order:
// 1. start the .NET runtime (downloads the assemblies and dotnet.native.wasm),
// 2. load the saves from IndexedDB into /save (D-30),
// 3. copy the game files listed in game-files.json into the in-memory file system (D-16, D-31),
// 4. run Program.Main, which sets the game up and returns,
// 5. call BrowserHost.Frame() once per animation frame (D-14, D-29), or from a worker's timer while the tab is
//    hidden during an online game (B-25).
// The runtime's files and the game packs download at the same time, and one bar shows the whole start-up (D-52).
// Browsers keep sound off until the first click or key press; the game starts anyway, and the sound
// turns on with that first input (D-34). The page also owns the keys the browser would grab, fullscreen,
// pausing in a hidden tab, quitting, and the file picker and downloads (D-35 to D-38).
// The page's own screens are drawn like the game's (ui.js). On touch screens, on-screen buttons drive a virtual
// gamepad (touch.js, D-53).
// ?arg=... passes command-line arguments, one per arg, for example ?arg=-command&arg=lev%20arcade.
// ?log shows the console log under the game. (?autostart is still accepted; starting is automatic now.)
import { dotnet } from './_framework/dotnet.js';
// Online play (T11): defines globalThis.duckGameNet, which the game's WebRTC back end calls (NetInterop.cs).
import './net.js';
import * as ui from './ui.js';
// Before the runtime starts: it wraps navigator.getGamepads, which SDL reads.
import * as touch from './touch.js';
// Whether the game is open (D-57): asked at once, answered before anything is downloaded.
import * as gameSwitch from './game-switch.js';

const gameOpen = gameSwitch.isGameOpen();

// The service worker that makes the site installable (D-58). Browsers only allow one on https and localhost.
if (globalThis.isSecureContext && navigator.serviceWorker) {
	navigator.serviceWorker.register('sw.js').catch((error) => console.warn(`The service worker didn't register: ${describe(error)}`));
}

// ---- The display the game sees (D-59) ----
// SDL takes its display size from screen.width/height (emscripten_get_screen_size), and the game picks its back buffer
// from that. A phone held upright reports a tall, narrow screen, so the back buffer came out tall too, and the 16:9
// picture was a tiny box in the middle once the page fitted that canvas into a landscape window (B-32). So the game is
// told about a landscape display of at least 1920 x 1080. The page's own code reads the real screen (realScreen).
const screenGetters = Object.getOwnPropertyDescriptors(Screen.prototype);

function realScreen() {
	return { width: screenGetters.width.get.call(screen), height: screenGetters.height.get.call(screen) };
}

function reportLandscapeDisplay() {
	const real = realScreen();
	const long = Math.max(real.width, real.height);
	const short = Math.min(real.width, real.height);
	const bigEnough = long >= 1920 && short >= 1080;
	Object.defineProperty(screen, 'width', { value: bigEnough ? long : 1920 });
	Object.defineProperty(screen, 'height', { value: bigEnough ? short : 1080 });
}
reportLandscapeDisplay();

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('canvas');
const loader = document.getElementById('loader');
const statusText = document.getElementById('status');
const progressFill = document.getElementById('progress-fill');
const duckRun = document.getElementById('duck-run');
const actionButton = document.getElementById('action');
const crashText = document.getElementById('crash');
const logElement = document.getElementById('log');
const soundHint = document.getElementById('sound');
const dialog = document.getElementById('dialog');
const dialogText = document.getElementById('dialog-text');
const dialogField = document.getElementById('dialog-field');
const dialogName = document.getElementById('dialog-name');
const dialogOk = document.getElementById('dialog-ok');
const dialogCancel = document.getElementById('dialog-cancel');
const touchMode = touch.isTouchDevice();
// The on-screen controls (touch.js), on touch screens only; they show once the game has loaded.
let touchControls = null;

const maxLogLines = 400;
// A longer gap between animation frames (hidden tab, minimized window, a long dialog) isn't caught up (D-37).
const maxFrameGapMs = 250;
// Picked files and files to save live here in the virtual file system (FileDialogFna.BrowserFileFolder).
const browserFileFolder = '/tmp/browser-files/';

// Tests read this through the DevTools protocol; the game reaches the functions through JSImports (interop\JsInterop.cs).
const host = {
	state: 'loading',
	paused: false,
	error: null,
	stats: { frames: 0, slowFrames: 0, maxFrameMs: 0, firstFrameMs: 0, timingResyncs: 0 },
	saveSyncs: 0,
	downloads: [],
	fileDialog: null,
	audioContexts: [],
	runtime: null,
	exports: null,
	flushSaves,
	openFile,
	saveFile,
	downloadFile,
	gameClosed,
};
globalThis.duckGameHost = host;

function log(text, isError) {
	const line = document.createElement('div');
	line.textContent = text;
	if (isError) {
		line.className = 'error';
	}
	logElement.appendChild(line);
	while (logElement.childElementCount > maxLogLines) {
		logElement.firstChild.remove();
	}
	logElement.scrollTop = logElement.scrollHeight;
}
logElement.hidden = !params.has('log');

// The runtime sometimes throws plain objects (after a Mono assertion, for example), which print as [object Object].
function describe(error) {
	if (error instanceof Error) {
		return error.stack || String(error);
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// Mirror the runtime's console output onto the page.
for (const level of ['log', 'info', 'warn', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...args) => {
		original(...args);
		log(args.join(' '), level === 'error');
	};
}

function setStatus(text) {
	ui.setText(statusText, text, { maxChars: loader.classList.contains('stopped') ? 50 : 0 });
}

function megabytes(bytes) {
	return (bytes / 1048576).toFixed(1);
}

function showAction(label, onClick) {
	ui.setText(actionButton, label.toUpperCase(), { color: ui.colors.menu });
	actionButton.classList.add('selected');
	actionButton.hidden = false;
	actionButton.disabled = false;
	actionButton.onclick = onClick;
	actionButton.focus();
}

// The loading screen turns into a box with a message, for a crash or after quitting.
function showStopped(title) {
	loader.classList.add('stopped');
	loader.hidden = false;
	touchControls?.setActive(false);
	crashText.hidden = true;
	actionButton.hidden = true;
	setStatus(title);
}

// The admin page closed the game (D-57): the loading screen says so instead of loading it.
function showClosed() {
	host.state = 'closed';
	soundHint.hidden = true;
	showStopped('Duck Game is closed right now. Come back later!');
	showAction('Try again', () => location.reload());
}

// While it runs, the game is closed for this player too once the admin page turns it off: the page finishes any save
// and reloads, which then shows the closed screen.
const switchCheckMs = 60000;
function watchGameSwitch() {
	setInterval(async () => {
		if (host.state !== 'running' || (await gameSwitch.isGameOpen())) {
			return;
		}
		host.state = 'closing';
		await savesIdle();
		location.reload();
	}, switchCheckMs);
}

function fail(title, details) {
	host.state = 'crashed';
	host.error = `${title}\n${details}`;
	console.error(host.error);
	suspendAudio();
	soundHint.hidden = true;
	showStopped(title);
	crashText.textContent = details;
	crashText.hidden = false;
	showAction('Reload', () => location.reload());
}

// ---- Loading progress: one bar for the whole start-up (D-52) ----
// The downloads count in bytes as they arrive: the runtime's files (their sizes are in runtime-files.json, from
// tools\list-runtime-files.ps1) and the game packs (game-files.json). The steps after the downloads report nothing
// while they run, and some block the page for seconds. So during each of them the bar eases toward the step's end on a
// CSS transition, which the browser runs off the main thread (as it runs the duck's animation). The last step is the
// game's own loading, which runs over many frames until its first level (the title screen): this screen stays up
// through it, because the game's own loading bar shows full from the start in the browser (its total is a fixed guess
// that the browser build passes in its first frame). The steps' times are from the
// AOT build on the test PC (DECISIONS D-39), and each step's share of the bar follows its time.
const startSteps = [
	{ name: 'engine', message: 'Starting the game engine', seconds: 2 },
	{ name: 'files', message: 'Unpacking the game files', seconds: 0.5 },
	{ name: 'main', message: 'Starting Duck Game', seconds: 1.5 },
	{ name: 'frame', message: 'Starting Duck Game', seconds: 2.5 },
	{ name: 'game', message: 'Loading the game', seconds: 6 },
];
// For splitting the bar between the downloads and the steps after them, by how long each should take.
const startSeconds = startSteps.reduce((sum, step) => sum + step.seconds, 0);
for (const step of startSteps) {
	step.share = step.seconds / startSeconds;
}
// If the game never reports its first level, the screen still goes after this long in the game step.
const gameLoadTimeoutMs = 120000;
const downloadBytesPerSecond = 5e6;
const cacheBytesPerSecond = 2e8;

const loading = {
	runtimeSizes: {},
	oneOfSizes: {},
	runtimeTotal: 0,
	// Bytes received so far by file name: a download the runtime retries starts again from 0.
	runtimeReceived: new Map(),
	packTotal: 0,
	packReceived: 0,
	fromCache: false,
	downloadShare: 0.8,
	step: 0,
	frameRequest: 0,
	gameStepStarted: 0,
};

function receivedBytes() {
	let received = loading.packReceived;
	for (const bytes of loading.runtimeReceived.values()) {
		received += bytes;
	}
	return received;
}

// The fill's current width, also halfway through a transition.
function shownFill() {
	const transform = getComputedStyle(progressFill).transform;
	const scale = transform.startsWith('matrix(') ? parseFloat(transform.slice(7)) : 0;
	return Number.isFinite(scale) ? scale : 0;
}

function setFill(value, easeTo, seconds) {
	const from = Math.max(value, shownFill());
	progressFill.style.transition = 'none';
	progressFill.style.transform = `scaleX(${from})`;
	if (easeTo > from) {
		// Read back, so the transition starts from the width just set.
		progressFill.getBoundingClientRect();
		progressFill.style.transition = `transform ${seconds}s cubic-bezier(0.2, 0.7, 0.4, 1)`;
		progressFill.style.transform = `scaleX(${easeTo})`;
	}
}

function showLoading() {
	loading.frameRequest = 0;
	if (host.state !== 'loading' && host.state !== 'ready' && host.state !== 'running') {
		return;
	}
	const total = loading.runtimeTotal + loading.packTotal;
	const received = Math.min(receivedBytes(), total);
	const downloaded = total ? received / total : 1;
	const done = startSteps.slice(0, loading.step).reduce((sum, step) => sum + step.share, 0);
	const startShare = 1 - loading.downloadShare;
	const value = loading.downloadShare * downloaded + startShare * done;
	const step = startSteps[loading.step];
	if (downloaded < 1) {
		const verb = loading.fromCache ? 'Loading' : 'Downloading';
		setStatus(`${verb} Duck Game (${megabytes(received)} / ${megabytes(total)} MB)`);
		setFill(value, value, 0);
	} else if (step) {
		setStatus(step.message);
		// Up to 90% of the step, slowing down, in a bit more than its usual time.
		setFill(value, value + startShare * step.share * 0.9, step.seconds * 1.5);
	} else {
		setFill(1, 1, 0);
	}
}

// The game loads over many frames after its first one; this screen stays up until it has a level.
function startGameLoading() {
	loading.step = startSteps.findIndex((step) => step.name === 'game');
	loading.gameStepStarted = performance.now();
	showLoading();
}

function checkGameLoaded() {
	let level = null;
	try {
		level = host.exports.CurrentLevel();
	} catch {
		// Treated as still loading; the time-out below still ends it.
	}
	const waited = performance.now() - loading.gameStepStarted;
	if (!level && waited < gameLoadTimeoutMs) {
		return;
	}
	loading.gameStepStarted = 0;
	loading.step = startSteps.length;
	console.log(`The game loaded in ${(waited / 1000).toFixed(1)} s after its first frame (${level ?? 'no level yet'})`);
	// The full bar shows for a moment before the game appears.
	setFill(1, 1, 0);
	setTimeout(() => {
		if (!loader.classList.contains('stopped')) {
			loader.hidden = true;
			touchControls?.setActive(true);
		}
	}, 200);
}

// Download progress arrives in many small pieces: draw it once per frame.
function updateLoading() {
	loading.frameRequest ||= requestAnimationFrame(showLoading);
}

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Moves the bar to the next step. Before a step that blocks the page, wait until the browser has drawn the new state
// and started the bar's transition, so both keep moving while the step runs.
async function startStep(name) {
	loading.step = startSteps.findIndex((step) => step.name === name);
	cancelAnimationFrame(loading.frameRequest);
	showLoading();
	await nextFrame();
	await nextFrame();
}

async function fetchJson(url, { optional = false } = {}) {
	// Always asked again (a 304 when unchanged): they name the files of the current build.
	const response = await fetch(url, { cache: 'no-cache' });
	if (!response.ok) {
		if (optional) {
			return null;
		}
		throw new Error(`Could not fetch ${url}: ${response.status}`);
	}
	return response.json();
}

// How much of the bar the downloads get: about their share of the start-up's time, which depends on what is already
// kept in the file cache (D-47).
async function planLoading(runtimeFiles, index) {
	loading.oneOfSizes = runtimeFiles?.oneOf ?? {};
	loading.runtimeSizes = { ...runtimeFiles?.always, ...loading.oneOfSizes };
	loading.runtimeTotal = Object.values(runtimeFiles?.always ?? {}).reduce((sum, size) => sum + size, 0);
	loading.packTotal = index.packs.reduce((sum, pack) => sum + pack.size, 0);
	const cache = await openFileCache();
	const kept = new Set(cache ? (await cache.keys().catch(() => [])).map((request) => request.url) : []);
	const files = [
		...Object.entries(runtimeFiles?.always ?? {}).map(([name, size]) => [`_framework/${name}`, size]),
		...index.packs.map((pack) => [pack.hash ? packKey(pack) : pack.url, pack.size]),
	];
	let keptBytes = 0;
	let newBytes = 0;
	for (const [url, size] of files) {
		if (kept.has(new URL(url, location.href).href)) {
			keptBytes += size;
		} else {
			newBytes += size;
		}
	}
	loading.fromCache = newBytes === 0;
	const downloadSeconds = newBytes / downloadBytesPerSecond + keptBytes / cacheBytesPerSecond;
	loading.downloadShare = downloadSeconds / (downloadSeconds + startSeconds);
	showLoading();
}

// The runtime's download of one file, counted for the bar as its bytes arrive.
function countRuntimeFile(name, response) {
	if (!response.ok || !response.body) {
		return response;
	}
	// Of the ICU files, only the one the runtime picked counts.
	if (name in loading.oneOfSizes && !loading.runtimeReceived.has(name)) {
		loading.runtimeTotal += loading.oneOfSizes[name];
	}
	loading.runtimeReceived.set(name, 0);
	let received = 0;
	const counter = new TransformStream({
		transform(chunk, controller) {
			received += chunk.byteLength;
			if (name in loading.runtimeSizes) {
				loading.runtimeReceived.set(name, received);
				updateLoading();
			}
			controller.enqueue(chunk);
		},
	});
	// The runtime compiles dotnet.native.wasm while it streams in, which needs its Content-Type.
	return new Response(response.body.pipeThrough(counter), {
		status: response.status,
		statusText: response.statusText,
		headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream' },
	});
}

// The game writes its crash reports to ducklog.txt (Program.WriteToLog), in the current folder, /.
function readDuckLog() {
	try {
		return host.runtime.Module.FS.readFile('/ducklog.txt', { encoding: 'utf8' });
	} catch {
		return '';
	}
}

// ---- Sound: browsers keep an AudioContext suspended until the page gets a click or key press (D-34) ----

// SDL creates its AudioContext during the game's first frame. Remember every context, so the page can turn
// them on with the first input, and off while the tab is hidden or the game has quit.
const NativeAudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
if (NativeAudioContext) {
	class TrackedAudioContext extends NativeAudioContext {
		constructor(...args) {
			super(...args);
			host.audioContexts.push(this);
			this.addEventListener('statechange', updateSoundHint);
			updateSoundHint();
		}
	}
	globalThis.AudioContext = TrackedAudioContext;
	globalThis.webkitAudioContext = TrackedAudioContext;
}

function resumeAudio() {
	if (host.state !== 'running' || host.paused) {
		return;
	}
	for (const context of host.audioContexts) {
		if (context.state === 'suspended') {
			context.resume().catch(() => {});
		}
	}
}

function suspendAudio() {
	for (const context of host.audioContexts) {
		if (context.state === 'running') {
			context.suspend().catch(() => {});
		}
	}
}

// The hint fades further a few seconds after it shows.
const soundHintFadeMs = 5000;
let soundHintTimer = 0;

function updateSoundHint() {
	const blocked = host.audioContexts.some((context) => context.state === 'suspended');
	const hidden = !(blocked && host.state === 'running' && !host.paused);
	if (soundHint.hidden && !hidden) {
		soundHint.classList.remove('faded');
		clearTimeout(soundHintTimer);
		soundHintTimer = setTimeout(() => soundHint.classList.add('faded'), soundHintFadeMs);
	}
	soundHint.hidden = hidden;
}

// Any of these counts as the user's permission for sound. (Escape doesn't, by the HTML spec.)
for (const type of ['pointerdown', 'keydown', 'touchend']) {
	window.addEventListener(type, resumeAudio, true);
}

// ---- Saves: /save lives in IndexedDB (IDBFS) ----

function syncSaves(populate) {
	const fs = host.runtime.Module.FS;
	return new Promise((resolve, reject) => {
		fs.syncfs(populate, (error) => (error ? reject(error) : resolve()));
	});
}

async function mountSaves() {
	const fs = host.runtime.Module.FS;
	fs.mkdirTree('/save');
	fs.mount(fs.filesystems.IDBFS, {}, '/save');
	// Copy what IndexedDB has into /save before the game reads its profiles and options.
	await syncSaves(true);
	console.log(`Saves: ${countFiles(fs, '/save')} files loaded from IndexedDB`);
}

function countFiles(fs, folder) {
	let count = 0;
	for (const name of fs.readdir(folder)) {
		if (name === '.' || name === '..') {
			continue;
		}
		const path = `${folder}/${name}`;
		count += fs.isDir(fs.stat(path).mode) ? countFiles(fs, path) : 1;
	}
	return count;
}

// BrowserStorage.flushHandler calls this after each save write (D-21). One copy runs at a time;
// calls that arrive meanwhile are folded into one more copy after it.
let saveSyncRunning = false;
let saveSyncQueued = false;
let saveIdleWaiters = [];

function flushSaves() {
	if (saveSyncRunning) {
		saveSyncQueued = true;
		return;
	}
	saveSyncRunning = true;
	syncSaves(false)
		.then(() => {
			host.saveSyncs += 1;
		})
		.catch((error) => console.error(`Saving to IndexedDB failed: ${describe(error)}`))
		.finally(() => {
			saveSyncRunning = false;
			if (saveSyncQueued) {
				saveSyncQueued = false;
				flushSaves();
				return;
			}
			const waiters = saveIdleWaiters;
			saveIdleWaiters = [];
			waiters.forEach((resolve) => resolve());
		});
}

// Resolves once no copy to IndexedDB is running or queued.
function savesIdle() {
	if (!saveSyncRunning) {
		return Promise.resolve();
	}
	return new Promise((resolve) => saveIdleWaiters.push(resolve));
}

// ---- Keeping downloads for next time (D-47, D-54) ----
// GitHub Pages lets the browser reuse a file for only 10 minutes, every deploy gives every file a new ETag, and the
// browser's HTTP cache won't keep a file as big as dotnet.native.wasm (60 MB). So (with cacheFiles in config.js) the
// runtime's files and the game packs are kept by the page itself. Each of them is named by its content (the .NET
// build names _framework's files; each pack has a hash in game-files.json, from tools\pack-game-files.ps1), so a kept
// copy never goes stale: after a new build or deploy only what changed is downloaded, and the copies no longer used
// are dropped. They go in Cache Storage, or in IndexedDB on a page that has no Cache Storage: browsers only give it
// to secure pages, and a page from the dev server on http://<PC address> (a phone on the network) isn't one.
const fileCacheName = 'duck-game-files';
const cacheFiles = Boolean(globalThis.duckGameConfig?.cacheFiles);
// The files this page used, so pruneFileCache knows what to keep.
const usedUrls = new Set();
let fileCache;

// Null when the cache is off or refused.
function openFileCache() {
	fileCache ??= (async () => {
		if (!cacheFiles) {
			return null;
		}
		try {
			return globalThis.caches ? await caches.open(fileCacheName) : await openIndexedDbCache();
		} catch (error) {
			console.warn(`Downloads won't be kept for next time: ${describe(error)}`);
			return null;
		}
	})();
	return fileCache;
}

function idbRequest(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

// The part of the Cache Storage interface the page uses (match, put, keys, delete), kept in IndexedDB.
async function openIndexedDbCache() {
	const opening = indexedDB.open(fileCacheName, 1);
	opening.onupgradeneeded = () => opening.result.createObjectStore('files');
	const db = await idbRequest(opening);
	const files = (mode) => db.transaction('files', mode).objectStore('files');
	console.log('No Cache Storage on this page (not https): downloads are kept in IndexedDB');
	return {
		async match(url) {
			const entry = await idbRequest(files('readonly').get(url));
			return entry ? new Response(entry.blob, { headers: { 'Content-Type': entry.type } }) : undefined;
		},
		async put(url, response) {
			// Read before the transaction starts: it would end while waiting for the body.
			const blob = await response.blob();
			const type = response.headers.get('Content-Type') ?? 'application/octet-stream';
			await idbRequest(files('readwrite').put({ blob, type }, url));
		},
		async keys() {
			return (await idbRequest(files('readonly').getAllKeys())).map((url) => ({ url }));
		},
		async delete(entry) {
			await idbRequest(files('readwrite').delete(entry.url));
		},
	};
}

async function cachedResponse(cache, url) {
	const key = new URL(url, location.href).href;
	usedUrls.add(key);
	try {
		return (await cache.match(key)) ?? null;
	} catch (error) {
		console.warn(`Could not read ${url} from the cache: ${describe(error)}`);
		return null;
	}
}

function keepResponse(cache, url, response) {
	return cache
		.put(new URL(url, location.href).href, response)
		.catch((error) => console.warn(`Could not keep ${url} for next time: ${describe(error)}`));
}

// The .NET runtime's downloads go through here (withResourceLoader), to count them for the bar and, on the hosted
// site, to keep them. Its JavaScript modules must stay plain URLs.
function loadRuntimeFile(type, name, url, integrity) {
	if (type === 'dotnetjs') {
		return undefined;
	}
	return (async () => {
		const cache = await openFileCache();
		const kept = cache && (await cachedResponse(cache, url));
		if (kept) {
			return countRuntimeFile(name, kept);
		}
		// With the integrity check, a damaged download fails here and is never kept. The files are named by their
		// content, so without the file cache the HTTP cache may keep them for good (as the runtime itself asks).
		const response = await fetch(url, { cache: cache ? 'no-store' : 'force-cache', integrity: integrity || undefined });
		if (cache && response.ok) {
			keepResponse(cache, url, response.clone());
		}
		return countRuntimeFile(name, response);
	})();
}

// Drops the files of earlier deploys.
async function pruneFileCache(cache) {
	for (const request of await cache.keys()) {
		if (!usedUrls.has(request.url)) {
			await cache.delete(request);
		}
	}
}

// ---- Game files: Content/, spriteatlas/ and a few text files, copied into the in-memory file system ----
// tools\pack-game-files.ps1 packs them into a few large files; game-files.json says where each file is (D-31).
// Packs with a hash go through the file cache, so a returning player downloads only the packs that changed.

// The pack's name in the file cache: its URL when that holds the hash (deploy\make-site.ps1 names the packs so),
// otherwise the URL with the hash added.
function packKey(pack) {
	return pack.url.includes(pack.hash) ? pack.url : `${pack.url}?v=${pack.hash}`;
}

async function cachedPack(cache, pack) {
	if (!cache || !pack.hash) {
		return null;
	}
	const response = await cachedResponse(cache, packKey(pack));
	const bytes = response && new Uint8Array(await response.arrayBuffer());
	return bytes?.length === pack.size ? bytes : null;
}

function storePack(cache, pack, bytes) {
	if (!cache || !pack.hash) {
		return Promise.resolve();
	}
	// The Response takes a copy of the bytes, so the in-memory file system can own the original.
	return keepResponse(cache, packKey(pack), new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
}

async function sha256Hex(bytes) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Downloads one pack, reporting the bytes as they arrive.
async function fetchPack(pack, onBytes) {
	// A hashed pack goes into Cache Storage instead of the HTTP cache, so it isn't stored twice.
	const response = await fetch(pack.url, { cache: pack.hash ? 'no-store' : 'default' });
	if (!response.ok) {
		throw new Error(`Could not fetch ${pack.url}: ${response.status}`);
	}
	const bytes = new Uint8Array(pack.size);
	const reader = response.body.getReader();
	let offset = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		bytes.set(value, offset);
		offset += value.length;
		onBytes(value.length);
	}
	if (offset !== pack.size) {
		throw new Error(`${pack.url} has ${offset} bytes, expected ${pack.size}. Rebuild with build.ps1.`);
	}
	if (pack.hash && globalThis.crypto?.subtle && !(await sha256Hex(bytes)).startsWith(pack.hash)) {
		throw new Error(`${pack.url} doesn't match its hash`);
	}
	return bytes;
}

// Tries a pack a few times, because a tunnel or proxy can drop a long download (504) that works on the next try.
async function fetchPackWithRetry(pack, onBytes) {
	const attempts = 4;
	for (let attempt = 1; ; attempt++) {
		let received = 0;
		try {
			return await fetchPack(pack, (count) => {
				received += count;
				onBytes(count);
			});
		} catch (error) {
			onBytes(-received);
			if (attempt === attempts) {
				throw error;
			}
			console.warn(`${error.message}; retrying (${attempt}/${attempts - 1})`);
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
		}
	}
}

// Downloads the packs, while the runtime downloads and starts. They go into the file system once it is ready.
async function downloadGameFiles(index) {
	const started = performance.now();
	const onBytes = (count) => {
		loading.packReceived += count;
		updateLoading();
	};
	// One pack at a time, so a slow link gives each one its full speed instead of timing them all out.
	const cache = await openFileCache();
	const packs = [];
	const stores = [];
	let cachedPacks = 0;
	for (const pack of index.packs) {
		let bytes = await cachedPack(cache, pack);
		if (bytes) {
			cachedPacks += 1;
			onBytes(bytes.length);
		} else {
			bytes = await fetchPackWithRetry(pack, onBytes);
			stores.push(storePack(cache, pack, bytes));
		}
		packs.push(bytes);
	}
	if (cache) {
		// Not awaited: the game can start while the new packs are written to disk.
		Promise.all(stores)
			.then(() => pruneFileCache(cache))
			.catch((error) => console.warn(`Could not tidy the game file cache: ${describe(error)}`));
	}
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	const fromCache = cache ? `, ${cachedPacks} of ${index.packs.length} packs from the cache` : '';
	console.log(`Loaded ${index.packs.length} game packs (${megabytes(loading.packTotal)} MB${fromCache}) in ${seconds} s`);
	return packs;
}

function writeGameFiles(index, packs) {
	const fs = host.runtime.Module.FS;
	const folders = new Set(index.files.map(([path]) => path.substring(0, path.lastIndexOf('/'))));
	for (const folder of folders) {
		if (folder) {
			fs.mkdirTree('/' + folder);
		}
	}
	// Each file shares its pack's buffer (canOwn), so nothing is copied twice.
	for (const [path, pack, offset, size] of index.files) {
		fs.writeFile('/' + path, packs[pack].subarray(offset, offset + size), { canOwn: true });
	}
	console.log(`Copied ${index.files.length} game files into the virtual file system`);
}

// ---- Main loop, and pausing while the tab is hidden (D-37) ----

let frameRequest = 0;
let lastFrameEnd = 0;
let resyncTiming = false;

function requestFrame() {
	// While hidden and online, the background ticker drives the frames instead (B-25).
	if (!frameRequest && !backgroundTicker) {
		frameRequest = requestAnimationFrame(tick);
	}
}

// ---- A hidden tab while online (BUGS.md B-25, D-45) ----
// A hidden tab gets no animation frames, so the game would stop sending and the other players would drop it after
// 16 s. While online it keeps running instead, on a worker's timer: browsers slow page timers in hidden tabs to about
// once a second, but not a worker's. The sound keeps playing too (it is a live match).

const backgroundTickerSource = 'let timer = 0; onmessage = (event) => { clearInterval(timer); if (event.data > 0) timer = setInterval(() => postMessage(0), event.data); };';
let backgroundTicker = null;
let backgroundTickerUrl = null;

function startBackgroundFrames() {
	if (backgroundTicker) {
		return;
	}
	cancelAnimationFrame(frameRequest);
	frameRequest = 0;
	backgroundTickerUrl ??= URL.createObjectURL(new Blob([backgroundTickerSource], { type: 'text/javascript' }));
	backgroundTicker = new Worker(backgroundTickerUrl);
	// Ticks that queued up behind a slow frame are skipped, not run back to back.
	backgroundTicker.onmessage = () => {
		if (performance.now() - lastFrameEnd > 8) {
			tick();
		}
	};
	backgroundTicker.postMessage(1000 / 60);
	host.stats.backgroundRuns = (host.stats.backgroundRuns ?? 0) + 1;
	console.log('Hidden while online: the game keeps running');
}

function stopBackgroundFrames() {
	if (!backgroundTicker) {
		return;
	}
	backgroundTicker.terminate();
	backgroundTicker = null;
	requestFrame();
}

function tick() {
	frameRequest = 0;
	if (host.state !== 'running' || host.paused) {
		return;
	}
	const started = performance.now();
	// After a pause, FNA would run up to half a second of missed updates in one go. Skip them instead.
	if (resyncTiming || (lastFrameEnd && started - lastFrameEnd > maxFrameGapMs)) {
		resyncTiming = false;
		host.stats.timingResyncs += 1;
		host.exports.ResumeTiming();
	}
	let crash;
	try {
		crash = host.exports.Frame();
	} catch (error) {
		fail('The game stopped with a runtime error', describe(error) + '\n\n' + readDuckLog());
		return;
	}
	const ms = performance.now() - started;
	const stats = host.stats;
	if (stats.frames === 0) {
		stats.firstFrameMs = Math.round(ms);
		console.log(`First frame (game start-up) took ${stats.firstFrameMs} ms`);
		if (!crash) {
			startGameLoading();
		}
	} else if (!crash && loading.gameStepStarted) {
		checkGameLoaded();
	}
	stats.frames += 1;
	stats.maxFrameMs = Math.max(stats.maxFrameMs, Math.round(ms));
	if (ms > 50) {
		stats.slowFrames += 1;
	}
	if (crash) {
		fail('Duck Game crashed', crash);
		return;
	}
	lastFrameEnd = performance.now();
	requestFrame();
}

function pauseGame() {
	if (host.state !== 'running' || host.paused) {
		return;
	}
	host.paused = true;
	cancelAnimationFrame(frameRequest);
	frameRequest = 0;
	saveNow();
	suspendAudio();
	updateSoundHint();
}

function resumeGame() {
	if (host.state !== 'running' || !host.paused) {
		return;
	}
	host.paused = false;
	resyncTiming = true;
	// Allowed without a new click once the page had one; otherwise the sound hint shows again.
	resumeAudio();
	updateSoundHint();
	requestFrame();
}

// Save what the game only saves on exit when the tab is hidden or closed (D-21).
function saveNow() {
	if (host.state === 'running') {
		try {
			host.exports.SaveNow();
		} catch (error) {
			console.error(`SaveNow failed: ${describe(error)}`);
		}
	}
}

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		if (host.state === 'running' && globalThis.duckGameNet?.isOnline()) {
			saveNow();
			startBackgroundFrames();
		} else {
			pauseGame();
		}
	} else {
		stopBackgroundFrames();
		resumeGame();
	}
});
window.addEventListener('pagehide', saveNow);

// ---- Quitting (BUGS.md B-17, D-38) ----

// BrowserHost calls this from inside Frame() once the game has quit and its saves are written.
function gameClosed() {
	host.state = 'closed';
	console.log('Duck Game closed');
	suspendAudio();
	soundHint.hidden = true;
	closeDialog(null);
	if (document.fullscreenElement) {
		document.exitFullscreen().catch(() => {});
	}
	showStopped('Duck Game closed. Your progress is saved.');
	showAction('Play again', async () => {
		actionButton.disabled = true;
		setStatus('Finishing the save...');
		await savesIdle();
		location.reload();
	});
}

// ---- Keys: keep the game's keys away from the browser, and the browser's shortcuts away from the game (D-35) ----

const isFunctionKey = (key) => /^F([1-9]|1[0-2])$/.test(key);
// Keys the browser acts on by itself (focus moves, back, scrolling, find, menus) that the game uses.
const gameKeys = new Set([
	'Tab', 'Backspace', 'Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
	'PageUp', 'PageDown', 'Home', 'End', 'Alt', 'AltGraph', 'ContextMenu',
]);
// With Ctrl or Cmd: reload, close, new tab or window, switch tabs, quit, address bar. These stay the browser's.
const browserShortcutKeys = new Set(['r', 'w', 't', 'n', 'q', 'l', 'tab', 'pageup', 'pagedown']);
// With Ctrl or Cmd: copy, cut and paste, which SDL's clipboard support needs, and the zoom keys.
const passThroughKeys = new Set(['c', 'x', 'v', '+', '-', '=', '0']);

function isBrowserShortcut(event) {
	const key = event.key.toLowerCase();
	if (event.ctrlKey || event.metaKey) {
		if (browserShortcutKeys.has(key)) {
			return true;
		}
		// Developer tools.
		if (event.shiftKey && ['i', 'j', 'c'].includes(key)) {
			return true;
		}
	}
	return false;
}

const isFullscreenKey = (event) =>
	event.key === 'F11' || (event.key === 'F4' && !event.altKey) || (event.key === 'Enter' && event.altKey);

const isPageUi = (target) => target instanceof Element && target.closest('.ui') !== null;

function onKey(event) {
	if (isPageUi(event.target)) {
		// Typing in the page's own dialog; the dialog's own handler stops it from reaching the game.
		return;
	}
	if (isBrowserShortcut(event)) {
		// The browser handles it; SDL never sees it, so it can't cancel it.
		event.stopImmediatePropagation();
		return;
	}
	if (isFullscreenKey(event)) {
		// The page's fullscreen replaces the game's F4 / Alt+Enter toggle and the browser's F11.
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.type === 'keydown' && !event.repeat) {
			toggleFullscreen();
		}
		return;
	}
	const modified = event.ctrlKey || event.metaKey;
	if (modified ? !passThroughKeys.has(event.key.toLowerCase()) : gameKeys.has(event.key) || isFunctionKey(event.key)) {
		event.preventDefault();
	}
}
window.addEventListener('keydown', onKey, true);
window.addEventListener('keyup', onKey, true);

// Keep keyboard focus on the canvas: on start, after the page's own dialogs, and on every click on the game.
function focusGame() {
	if (document.activeElement !== canvas) {
		canvas.focus({ preventScroll: true });
	}
}
window.addEventListener('pointerdown', (event) => {
	if (!isPageUi(event.target)) {
		focusGame();
	}
}, true);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// ---- Fullscreen and scaling (D-36) ----

// The canvas keeps the game's back-buffer size (canvas.width/height, set by SDL) and is scaled to fill the window
// at that aspect ratio, with hard pixel edges. Setting the CSS size (not object-fit) keeps SDL's mouse mapping right.
function fitCanvas() {
	const width = canvas.width;
	const height = canvas.height;
	if (!width || !height) {
		return;
	}
	const view = viewport();
	const scale = Math.min(view.width / width, view.height / height);
	const cssWidth = `${Math.max(1, Math.floor(width * scale))}px`;
	const cssHeight = `${Math.max(1, Math.floor(height * scale))}px`;
	if (canvas.style.width !== cssWidth || canvas.style.height !== cssHeight) {
		canvas.style.width = cssWidth;
		canvas.style.height = cssHeight;
	}
}

// The page's screens are laid out in pixels of a 1280 x 720 screen fitted to the window (index.html, ui.js). It
// doesn't follow the canvas, whose size the game changes during its start-up.
function fitUi() {
	const view = viewport();
	const pixel = Math.min(view.width / 1280, view.height / 720);
	const ratio = window.devicePixelRatio || 1;
	const root = document.documentElement.style;
	root.setProperty('--u', `${pixel}px`);
	for (const textScale of [1, 2, 3, 4]) {
		root.setProperty(`--f${textScale}`, `${Math.max(1, Math.round(pixel * textScale * ratio)) / ratio}px`);
	}
}

// ---- Always landscape on touch screens (D-55) ----
// A phone held upright would show the game in a small band across the middle, and a phone with rotation locked can't
// turn it. So on a touch screen held upright the page (#app) is turned a quarter turn clockwise and laid out on the
// screen's long side: turned sideways (top to the left), the phone shows the game upright and filling the screen.
// The browser hit-tests the turned page correctly; touch.js turns its slide directions with it.
const app = document.getElementById('app');

function isRotated() {
	return document.body.classList.contains('rotated');
}

const stage = document.getElementById('stage');

// The size the page is laid out in: #stage's own box, which fills the window, or #app while the page is turned. It is
// measured rather than taken from innerWidth/innerHeight, which phones can report wrong for a while after turning.
function viewport() {
	if (stage.clientWidth && stage.clientHeight) {
		return { width: stage.clientWidth, height: stage.clientHeight };
	}
	return isRotated() ? { width: window.innerHeight, height: window.innerWidth } : { width: window.innerWidth, height: window.innerHeight };
}

function layoutApp() {
	const rotate = touchMode && window.innerHeight > window.innerWidth;
	document.body.classList.toggle('rotated', rotate);
	if (rotate) {
		app.style.width = `${window.innerHeight}px`;
		app.style.height = `${window.innerWidth}px`;
		// Turned about its top-left corner, then moved right by the screen's width, so it covers the screen.
		app.style.transform = `translateX(${window.innerWidth}px) rotate(90deg)`;
	} else {
		app.style.width = '';
		app.style.height = '';
		app.style.transform = '';
	}
}

// The touch buttons keep the same distance from both sides of the phone's screen. Outside fullscreen, a phone in
// landscape leaves the strip beside its camera out of the browser's window (it shows black), so the window is narrower
// than the screen by that much, on the camera's side: the left with the phone's top to the left (landscape-primary),
// else the right. index.html adds the strip to the other side's margin. A gap wider than a camera strip is a window
// that doesn't fill the screen (split screen), and is ignored.
const maxCameraStrip = 80;
function fitEdges() {
	const real = realScreen();
	const gap = real.width - window.innerWidth;
	const landscape = window.innerWidth > window.innerHeight && real.width > real.height;
	const strip = touchMode && !isRotated() && !document.fullscreenElement && landscape && gap > 0 && gap <= maxCameraStrip ? gap : 0;
	const onRight = screen.orientation?.type === 'landscape-secondary';
	const root = document.documentElement.style;
	root.setProperty('--gap-left', `${onRight ? 0 : strip}px`);
	root.setProperty('--gap-right', `${onRight ? strip : 0}px`);
}

function relayout() {
	layoutApp();
	fitCanvas();
	fitUi();
	fitEdges();
}

// Phones report the new size late after turning (and while the address bar slides), so lay out again a moment later.
let relayoutTimer = 0;
function onViewportChange() {
	relayout();
	clearTimeout(relayoutTimer);
	relayoutTimer = setTimeout(relayout, 300);
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
window.visualViewport?.addEventListener('resize', onViewportChange);
screen.orientation?.addEventListener?.('change', onViewportChange);
layoutApp();
fitUi();
// SDL changes the canvas size (and sometimes its CSS size) when the game changes resolution.
new MutationObserver(fitCanvas).observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
fitCanvas();

// The events above don't always come after a phone's last size change (turning it, the address bar sliding, coming
// back to the tab), which left the game in a small box in the middle. So every frame also compares the sizes the
// layout depends on with the ones it was made for, and lays out again when any moved. Reading them is cheap.
let laidOutFor = '';
function layoutKey() {
	return [window.innerWidth, window.innerHeight, stage.clientWidth, stage.clientHeight, canvas.width, canvas.height,
		canvas.style.width, canvas.style.height].join();
}
function watchLayout() {
	if (layoutKey() !== laidOutFor) {
		relayout();
		laidOutFor = layoutKey();
	}
	requestAnimationFrame(watchLayout);
}
requestAnimationFrame(watchLayout);

async function toggleFullscreen() {
	if (document.fullscreenElement) {
		await document.exitFullscreen().catch(() => {});
		return;
	}
	try {
		await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
	} catch (error) {
		console.warn(`Fullscreen was refused: ${describe(error)}`);
		return;
	}
	// Chrome: Escape goes to the game (the pause menu) instead of leaving fullscreen. Holding Escape still leaves.
	try {
		await navigator.keyboard?.lock?.(['Escape']);
	} catch {
		// Not supported (Firefox): Escape leaves fullscreen as usual.
	}
	// A phone turns the game sideways and keeps it there (Android; iOS has no orientation lock).
	if (touchMode) {
		screen.orientation?.lock?.('landscape').catch(() => {});
	}
	focusGame();
}

// No button: a double click on the game (the game itself never uses one) or a double tap on a touch screen
// (touch.js) toggles fullscreen, as do F11, F4 and Alt+Enter.
canvas.addEventListener('dblclick', () => {
	toggleFullscreen();
});

document.addEventListener('fullscreenchange', () => {
	onViewportChange();
	focusGame();
});

// ---- File picker, file-name prompt and downloads, for the game's file dialogs (BUGS.md B-16) ----

let dialogDone = null;
const dialogMenu = ui.makeMenu([dialogOk, dialogCancel]);
// How many letters of the file name show at once.
const dialogFieldChars = 32;

function drawDialogField() {
	if (!dialogField.hidden) {
		ui.drawField(dialogField, dialogName, dialogFieldChars);
	}
}

function showDialog({ text, name, okLabel, onOk }) {
	ui.setText(dialogText, text, { maxChars: 40 });
	dialogField.hidden = name === undefined;
	dialogName.value = name ?? '';
	ui.setText(dialogOk, okLabel.toUpperCase(), { color: ui.colors.menu });
	ui.setText(dialogCancel, 'CANCEL', { color: ui.colors.menu });
	dialog.hidden = false;
	// The touch controls hide while the dialog is up (index.html).
	touchControls?.releaseAll();
	document.body.classList.add('dialog-open');
	dialogOk.onclick = onOk;
	dialogMenu.select(0);
	if (name === undefined) {
		dialogOk.focus();
	} else {
		dialogName.focus();
		dialogName.select();
	}
	drawDialogField();
}

// The field redraws whenever the text, the caret or the selection changes.
for (const type of ['input', 'select', 'selectionchange', 'keyup', 'pointerup', 'focus', 'blur']) {
	dialogName.addEventListener(type, drawDialogField);
}
document.addEventListener('selectionchange', drawDialogField);
dialogField.addEventListener('pointerdown', (event) => {
	if (event.target !== dialogName) {
		event.preventDefault();
		dialogName.focus();
	}
});

// Ends the current file dialog and gives the game its answer (a path, or null for cancelled).
function closeDialog(path) {
	if (!dialogDone) {
		return;
	}
	const done = dialogDone;
	dialogDone = null;
	dialog.hidden = true;
	document.body.classList.remove('dialog-open');
	host.fileDialog = null;
	done(path);
	focusGame();
}

function startDialog(kind) {
	closeDialog(null);
	host.fileDialog = kind;
	dialogDone = (path) => {
		if (host.state === 'running') {
			host.exports.FileDialogClosed(path);
		}
	};
}

// Keys and clicks in the dialog belong to the dialog, not to the game behind it.
for (const type of ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel']) {
	dialog.addEventListener(type, (event) => event.stopPropagation());
}
// Enter picks the selected choice (OK at first, also while typing the name); the arrow keys and Tab move the
// selection, except left and right while typing.
dialog.addEventListener('keydown', (event) => {
	if (event.key === 'Escape') {
		closeDialog(null);
		return;
	}
	if (event.key === 'Enter') {
		event.preventDefault();
		dialogMenu.selected.click();
		return;
	}
	const typing = document.activeElement === dialogName;
	if (typing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
		return;
	}
	if (dialogMenu.onKey(event)) {
		event.preventDefault();
		if (!typing) {
			dialogMenu.selected.focus({ preventScroll: true });
		}
	}
});
dialogCancel.addEventListener('click', () => closeDialog(null));

function safeFileName(name) {
	const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
	return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

// FileDialogFna.ShowOpenFileDialog: an <input type=file>. The picked file is copied into the virtual file system.
function openFile(accept) {
	startDialog('open');
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = accept;
	host.fileInput = input;
	input.addEventListener('change', async () => {
		const file = input.files[0];
		if (!file) {
			closeDialog(null);
			return;
		}
		const fs = host.runtime.Module.FS;
		const path = browserFileFolder + safeFileName(file.name);
		fs.mkdirTree(browserFileFolder);
		fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
		closeDialog(path);
	});
	input.addEventListener('cancel', () => closeDialog(null));
	// The browser only opens a file picker right after a click or key press. The game asks in the same frame
	// as the player's input, so that usually works; otherwise the player clicks once more.
	if (navigator.userActivation?.isActive) {
		input.click();
		return;
	}
	showDialog({ text: `Choose a file to open (${accept || 'any file'}).`, okLabel: 'Choose file...', onOk: () => input.click() });
}

// FileDialogFna.ShowSaveFileDialog: ask for a file name. The game writes the file, then downloadFile hands it over.
function saveFile(suggestedName, accept) {
	startDialog('save');
	const extension = accept.split(',')[0] || '';
	const fallback = `hat${extension}`;
	showDialog({
		text: 'Save as (the file goes to your downloads):',
		name: suggestedName || fallback,
		okLabel: 'Save',
		onOk: () => {
			let name = safeFileName(dialogName.value || fallback);
			if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) {
				name += extension;
			}
			const fs = host.runtime.Module.FS;
			fs.mkdirTree(browserFileFolder);
			closeDialog(browserFileFolder + name);
		},
	});
}

// FileDialogFna.browserDownload: give a file from the virtual file system to the player.
function downloadFile(path) {
	const bytes = host.runtime.Module.FS.readFile(path);
	const name = path.substring(path.lastIndexOf('/') + 1);
	const url = URL.createObjectURL(new Blob([bytes]));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
	host.downloads.push(name);
	console.log(`Downloading ${name} (${bytes.length} bytes)`);
}

// ---- Start-up ----

async function startGame() {
	focusGame();
	await startStep('main');

	const exitCode = await host.runtime.runMain();
	host.exports = (await host.runtime.getAssemblyExports('DuckGame.Web.Interop')).DuckGame.Web.JsInterop;
	if (exitCode !== 0) {
		fail(`Duck Game's start-up failed (exit code ${exitCode})`, readDuckLog());
		return;
	}

	// The loading screen stays up through the first frame, the game's start-up (tick hides it).
	await startStep('frame');
	host.state = 'running';
	focusGame();
	if (document.hidden) {
		host.paused = true;
	} else {
		requestFrame();
	}
}

// False when the game is closed (D-57), and then nothing is loaded.
async function prepare() {
	await ui.ready;
	if (!(await gameOpen)) {
		showClosed();
		return false;
	}
	ui.drawDuck(duckRun);
	setStatus('Loading Duck Game');
	ui.setIcon(document.getElementById('sound-icon'), 'soundOff', { scale: 1 });
	ui.setText(document.getElementById('sound-text'), touchMode ? 'TAP FOR SOUND' : 'CLICK FOR SOUND', { scale: 1 });
	if (touchMode) {
		document.body.classList.add('touch-mode');
		touchControls = touch.setupTouchControls(document.getElementById('touch'), {
			onDoubleTap: toggleFullscreen,
			// Whether a menu has the controls; a build from before D-53's InMenu export says no.
			inMenu: () => {
				try {
					return Boolean(host.exports?.InMenu?.());
				} catch {
					return false;
				}
			},
		});
		ui.setText(document.getElementById('hint-move'), 'LEFT THUMB: MOVE', { scale: '--hint-px' });
		ui.setText(document.getElementById('hint-tap'), 'RIGHT THUMB UP OR TAP: JUMP / OK', { scale: '--hint-px' });
		ui.setText(document.getElementById('hint-down'), 'RIGHT THUMB DOWN: CROUCH', { scale: '--hint-px' });
	}

	const [runtimeFiles, index] = await Promise.all([fetchJson('runtime-files.json', { optional: true }), fetchJson('game-files.json')]);
	await planLoading(runtimeFiles, index);
	// Few downloads at a time: on a slow link (a dev tunnel) 16 parallel downloads each crawl until the tunnel answers 504.
	const runtimeReady = dotnet
		.withConfig({ maxParallelDownloads: 4, enableDownloadRetry: true })
		.withResourceLoader(loadRuntimeFile)
		.withApplicationArgumentsFromQuery()
		.create()
		.then((runtime) => {
			host.runtime = runtime;
			runtime.Module.canvas = canvas;
			startStep('files');
		});
	const [, packs] = await Promise.all([runtimeReady, downloadGameFiles(index)]);
	await mountSaves();
	writeGameFiles(index, packs);
	host.state = 'ready';
	return true;
}

(async () => {
	try {
		if (await prepare()) {
			await startGame();
			watchGameSwitch();
		}
	} catch (error) {
		fail('Duck Game could not start', describe(error) + '\n\n' + readDuckLog());
	}
})();
