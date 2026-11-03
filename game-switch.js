// The game switch (D-57), kept by the matchmaking server (web/signaling, gameSwitch.ts): whether the game is open to
// players. main.js asks before loading the game and shows a "closed" screen instead while it is off; the admin page
// (admin/index.html) turns it on and off with the admin password, which only the server can check.
// The server is the one net.js uses: ?signal=, else config.js's signalingUrl, else port 8787 on the page's machine.

const params = new URLSearchParams(location.search);
const config = globalThis.duckGameConfig ?? {};
const pageHost = ['localhost', '[::1]'].includes(location.hostname) ? '127.0.0.1' : location.hostname;
const signalingUrl = (params.get('signal') ?? config.signalingUrl ?? `ws://${pageHost}:8787`).replace(/\/+$/, '');
export const serverUrl = signalingUrl.replace(/^ws/, 'http');

const checkTimeoutMs = 5000;

// False only when the server says the game is closed. A server that can't be reached, or one from before D-57, lets
// the game load: an outage of the matchmaking server shouldn't lock everyone out of playing on their own.
export async function isGameOpen() {
	try {
		const response = await fetch(`${serverUrl}/game`, { cache: 'no-store', signal: AbortSignal.timeout(checkTimeoutMs) });
		if (!response.ok) {
			return true;
		}
		const { enabled } = await response.json();
		return enabled !== false;
	} catch {
		return true;
	}
}

// The admin page's request: {password} checks the password, {password, enabled} also turns the game on or off.
// Resolves to {enabled, durable}, or throws an Error whose message is the server's error code ("wrong-password",
// "rate-limited", "not-saved") or "unreachable".
export async function adminRequest(body) {
	let response;
	try {
		response = await fetch(`${serverUrl}/admin/game`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			cache: 'no-store',
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		throw new Error('unreachable');
	}
	const answer = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(answer.error ?? `status-${response.status}`);
	}
	return answer;
}
