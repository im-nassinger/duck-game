// Settings for where the page is served. index.html loads this before main.js; net.js reads it.
//
// signalingUrl: the matchmaking server (web/signaling).
// - null: port 8787 on the machine that served the page. This works for localhost (`deno task start`) and for
//   a page served to the local network (`serve.ps1 -Lan` with `deno task start:lan`).
// - The hosted game (T13) sets the deployed server here instead, for example 'wss://<app>.deno.dev'.
// A ?signal=ws://host:port in the page address still wins over this, for tests.
//
// cacheFiles: keep the runtime's files and the game packs (in Cache Storage, or IndexedDB on an http:// page from
// another device), so a reload or a returning player only downloads what changed (main.js, D-47, D-54). The files
// are named by content, so this is safe for dev builds too; false downloads everything on every load.
globalThis.duckGameConfig = {
	signalingUrl: 'wss://duck-game-signal.nassinger.deno.net',
	cacheFiles: true,
};
