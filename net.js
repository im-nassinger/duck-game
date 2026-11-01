// Online play for Duck Game in the browser (web-port task T11; MULTIPLAYER.md section 4, DECISIONS D-44).
// The game's network back end, NCWebRTC (game code), calls this through JSImports (interop\NetInterop.cs):
// - command(json): host, update, search, join, connect, close, reset;
// - send(peerId, bytes, reliable): one game packet to one player;
// - pollEvents() and pollPackets(): once per frame, everything that arrived since the last call.
// Nothing here calls into the game: it only queues, so packets are handled on the game's own frame (no threads).
//
// The matchmaking server (web/signaling, PROTOCOL.md) introduces players and passes WebRTC set-up messages.
// Every pair of players gets its own RTCPeerConnection (the game is a full mesh) with two data channels:
// "dg" (unordered, no retries: UDP-like, for almost every packet) and "dg-reliable" (unordered, reliable:
// packets of 1200 bytes or more, as the Steam back end does).
//
// The server address: ?signal=ws://host:port, else globalThis.duckGameConfig.signalingUrl (config.js), else port 8787
// on the machine that served the page (so localhost and a page served to the local network both work).
// ?join=CODE is a join link (T12): the game joins that lobby at start-up (Main.cs), and -lanjoiner's "join" takes it
// instead of the first open lobby. copy-link puts such a link on the clipboard.
// While the matchmaking server can't be reached, the game hears "connecting", then "unreachable" (never connected)
// or "reconnecting" and "lost" (it was connected), and a lobby asked for meanwhile is made once it is back.

const params = new URLSearchParams(location.search);
const config = globalThis.duckGameConfig ?? {};
// localhost means 127.0.0.1 here: browsers try ::1 for "localhost" first, and the server listens on IPv4 only.
const pageHost = ['localhost', '[::1]'].includes(location.hostname) ? '127.0.0.1' : location.hostname;
const signalingUrl = (params.get('signal') ?? config.signalingUrl ?? `ws://${pageHost}:8787`).replace(/\/+$/, '');
const httpUrl = signalingUrl.replace(/^ws/, 'http');

const requestTimeoutMs = 10000;
const resumeGraceMs = 15000;
const closeDelayMs = 1000;
const maxBufferedBytes = 1 << 20;
const autoJoinTimeoutMs = 20000;
// A connection not open is looked at every checkOpeningMs (watchOpening). The offer is made again, up to
// maxOpenAttempts times, when the other side didn't acknowledge it within ackTimeoutMs, didn't answer within
// answerWaitMs (a busy PC can take that long), or answered but ICE still hadn't started iceStartTimeoutMs later.
// The game drops a connection that isn't up after 18 s (NetworkConnection), so the first two must be quick.
// A set-up still going after maxSetupMs is given up (ICE failing on its own ends it sooner).
const checkOpeningMs = 2000;
const ackTimeoutMs = 6000;
const iceStartTimeoutMs = 8000;
const answerWaitMs = 45000;
const maxOpenAttempts = 3;
const maxSetupMs = 60000;
// Safety net: stop waiting on one set-up message after this long, or every later one would queue behind it.
const signalTimeoutMs = 20000;
const fallbackIceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const events = [];
const packets = [];
let packetBytes = 0;
const peers = new Map();

let socket = null;
let socketReady = null;
let session = null;
let wantSocket = false;
let droppedAt = 0;
let reconnectTimer = 0;
let reconnectDelayMs = 500;
let iceServers = null;
let iceExpiresAt = 0;
let nextRef = 1;
const pending = new Map();
let signalChain = Promise.resolve();

let hostedLobby = null;
let hostInfo = null;
let hostMaxPlayers = 8;
// The game asked to host but the server couldn't be reached yet: host as soon as it is.
let hostWanted = false;
let joinedLobby = null;
let hostPeerId = null;
let lostReported = false;
let lastCopy = null;

const stats = { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0, dropped: 0, signals: 0, reconnects: 0 };

function emit(event) {
	events.push(event);
}

function log(text) {
	console.log(`[net] ${text}`);
	emit({ type: 'log', text });
}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---- The matchmaking socket ----

function ensureSocket() {
	wantSocket = true;
	if (!socketReady) {
		if (!session && !droppedAt) {
			emit({ type: 'signaling', state: 'connecting' });
		}
		socketReady = openSocket();
	}
	return socketReady;
}

function openSocket() {
	return new Promise((resolve, reject) => {
		let url = `${signalingUrl}/ws`;
		if (session) {
			url += `?peerId=${encodeURIComponent(session.peerId)}&token=${encodeURIComponent(session.token)}`;
		}
		const ws = new WebSocket(url);
		socket = ws;
		let welcomed = false;
		ws.onmessage = (message) => {
			let data;
			try {
				data = JSON.parse(message.data);
			} catch {
				return;
			}
			if (data.type === 'welcome') {
				welcomed = true;
				onWelcome(data);
				resolve();
				return;
			}
			onServerMessage(data);
		};
		ws.onclose = (close) => {
			if (socket !== ws) {
				return;
			}
			socket = null;
			socketReady = null;
			failPending(`matchmaking connection closed (${close.code})`);
			if (!welcomed) {
				reject(new Error(`Could not reach the matchmaking server at ${signalingUrl} (${close.code})`));
			}
			onSocketDropped(close.code);
		};
	});
}

function onWelcome(welcome) {
	const resumed = session !== null && welcome.resumed;
	const hadSession = session !== null;
	session = { peerId: welcome.peerId, token: welcome.token };
	droppedAt = 0;
	lostReported = false;
	reconnectDelayMs = 500;
	emit({ type: 'signaling', state: 'connected', peerId: session.peerId });
	if (hostWanted && !hostedLobby) {
		host(hostInfo ?? {}, hostMaxPlayers);
	} else if (hadSession && !resumed) {
		// The old session expired: our lobby is gone. Players already connected keep their data channels.
		log('the matchmaking session expired; making the lobby again');
		restoreLobby();
	} else if (resumed) {
		log('matchmaking connection resumed');
	}
}

async function restoreLobby() {
	try {
		if (hostedLobby) {
			hostedLobby = null;
			const reply = await request({ type: 'host', info: hostInfo ?? {}, maxPlayers: hostMaxPlayers });
			hostedLobby = reply.lobbyId;
			emit({ type: 'hosted', lobbyId: hostedLobby });
		} else if (joinedLobby) {
			await request({ type: 'join', lobbyId: joinedLobby });
		}
	} catch (error) {
		emit({ type: 'error', text: `Could not restore the lobby: ${describe(error)}` });
	}
}

// PROTOCOL.md "Reconnecting": 1000 and 1001 end the session; anything else keeps it for 15 s, so reconnect
// with peerId and token. Data channels don't need the server, so a match keeps running meanwhile.
function onSocketDropped(code) {
	if (code === 1000 || code === 1001 || code === 4000) {
		return;
	}
	if (!wantSocket || reconnectTimer) {
		return;
	}
	if (!droppedAt) {
		droppedAt = performance.now();
		emit({ type: 'signaling', state: session ? 'reconnecting' : 'unreachable' });
	}
	if (session && !lostReported && performance.now() - droppedAt > resumeGraceMs) {
		lostReported = true;
		emit({ type: 'signaling', state: 'lost' });
	}
	reconnectTimer = setTimeout(() => {
		reconnectTimer = 0;
		stats.reconnects += 1;
		ensureSocket().catch(() => {});
	}, reconnectDelayMs);
	reconnectDelayMs = Math.min(reconnectDelayMs * 2, 4000);
}

function sendToServer(message) {
	if (!socket || socket.readyState !== WebSocket.OPEN) {
		return false;
	}
	socket.send(JSON.stringify(message));
	return true;
}

// Sends a message with a ref and waits for the reply (or error) carrying the same ref.
async function request(message) {
	await ensureSocket();
	const ref = nextRef++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(ref);
			reject(new Error(`no answer to ${message.type}`));
		}, requestTimeoutMs);
		pending.set(ref, { resolve, reject, timer });
		if (!sendToServer({ ...message, ref })) {
			clearTimeout(timer);
			pending.delete(ref);
			reject(new Error('not connected to the matchmaking server'));
		}
	});
}

function failPending(reason) {
	for (const [ref, waiter] of pending) {
		clearTimeout(waiter.timer);
		waiter.reject(new Error(reason));
		pending.delete(ref);
	}
}

function onServerMessage(message) {
	if (message.ref !== undefined && pending.has(message.ref)) {
		const waiter = pending.get(message.ref);
		pending.delete(message.ref);
		clearTimeout(waiter.timer);
		if (message.type === 'error') {
			waiter.reject(Object.assign(new Error(message.text || message.code), { code: message.code }));
		} else {
			waiter.resolve(message);
		}
		return;
	}
	switch (message.type) {
		case 'signal':
			stats.signals += 1;
			if (dropSignalsMs > 0 && !dropSignalsUntil) {
				dropSignalsUntil = performance.now() + dropSignalsMs;
			}
			if (performance.now() < dropSignalsUntil) {
				log(`test: dropped a ${message.kind} signal from ${message.from}`);
				break;
			}
			if (message.kind === 'offer') {
				// Tell the offerer at once that the offer arrived (watchOpening): answering can take seconds on a busy
				// PC. An 'ice' signal with no candidate is ignored by every version of this file.
				sendToServer({ type: 'signal', to: message.from, kind: 'ice', data: null });
			} else if (message.kind === 'answer' || (message.kind === 'ice' && !message.data)) {
				const peer = peers.get(message.from);
				if (peer) {
					peer.offerReceived = true;
				}
			}
			signalChain = signalChain
				.then(() => settleWithin(onSignal(message), signalTimeoutMs, `the ${message.kind} from ${message.from}`))
				.catch((error) => log(`signal from ${message.from} failed: ${describe(error)}`));
			break;
		case 'peer-left':
			if (peers.has(message.peerId)) {
				closePeer(message.peerId, 'left');
			}
			break;
		case 'peer-joined':
			log(`${message.peerId} joined lobby ${message.lobbyId}`);
			break;
		case 'lobby-closed':
			if (message.lobbyId === joinedLobby) {
				log(`lobby ${message.lobbyId} was closed by its host`);
				joinedLobby = null;
			}
			break;
		case 'error':
			emit({ type: 'error', text: `${message.code}: ${message.text}` });
			break;
	}
}

async function loadIceServers() {
	if (iceServers && (!iceExpiresAt || Date.now() < iceExpiresAt - 60000)) {
		return iceServers;
	}
	try {
		const response = await fetch(`${httpUrl}/ice`, { signal: AbortSignal.timeout(5000) });
		const ice = await response.json();
		iceServers = ice.iceServers;
		iceExpiresAt = ice.expiresAt ?? 0;
	} catch (error) {
		log(`could not get the ICE servers (${describe(error)}); using STUN only`);
		iceServers = fallbackIceServers;
		iceExpiresAt = 0;
	}
	return iceServers;
}

// ---- Peer connections ----

function isDead(peer) {
	return peer.closed || peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed';
}

function createPeer(peerId, attempt = 1, startedAt = performance.now()) {
	const old = peers.get(peerId);
	if (old) {
		disposePeer(old);
	}
	const pc = new RTCPeerConnection({ iceServers: iceServers ?? fallbackIceServers });
	const peer = {
		id: peerId,
		pc,
		// Perfect negotiation: if both sides offer at once, the polite one gives way.
		polite: session.peerId > peerId,
		makingOffer: false,
		ignoreOffer: false,
		open: false,
		closed: false,
		closeTimer: 0,
		openTimer: 0,
		createdAt: performance.now(),
		startedAt,
		attempt,
		offerSentAt: 0,
		offerReceived: false,
		answeredAt: 0,
		loggedAt: 0,
		candidates: [],
		sent: 0,
		received: 0,
	};
	// Settles when the connection is disposed: a WebRTC call on a closed connection never settles, so set-up code
	// waits on whichever comes first (whileAlive) instead of hanging the signal queue.
	peer.disposed = new Promise((resolve) => {
		peer.markDisposed = resolve;
	});
	peer.unreliable = pc.createDataChannel('dg', { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 });
	peer.reliable = pc.createDataChannel('dg-reliable', { ordered: false, negotiated: true, id: 1 });
	for (const channel of [peer.unreliable, peer.reliable]) {
		channel.binaryType = 'arraybuffer';
		channel.onmessage = (message) => onPacket(peer, message.data);
	}
	peer.unreliable.onopen = () => {
		if (peers.get(peerId) !== peer) {
			return;
		}
		peer.open = true;
		emit({ type: 'open', peerId });
	};
	peer.unreliable.onclose = () => {
		if (peers.get(peerId) === peer && !peer.closed) {
			closePeer(peerId, 'channel closed');
		}
	};
	pc.onicecandidate = (event) => {
		if (event.candidate) {
			sendToServer({ type: 'signal', to: peerId, kind: 'ice', data: event.candidate.toJSON() });
		}
	};
	pc.onconnectionstatechange = () => {
		if (peers.get(peerId) === peer) {
			log(`${peerId}: ${pc.connectionState}`);
		}
		if (pc.connectionState === 'failed' && peers.get(peerId) === peer && !peer.closed) {
			closePeer(peerId, 'connection failed');
		}
	};
	peers.set(peerId, peer);
	watchOpening(peer);
	return peer;
}

function disposePeer(peer) {
	peer.closed = true;
	peer.markDisposed();
	clearTimeout(peer.closeTimer);
	clearTimeout(peer.openTimer);
	try {
		peer.pc.close();
	} catch {
		// Already closed.
	}
}

// Closes at once and tells the game (it drops the player instead of waiting for its 16-second timeout).
function closePeer(peerId, reason) {
	const peer = peers.get(peerId);
	if (!peer) {
		return;
	}
	peers.delete(peerId);
	disposePeer(peer);
	log(`${peerId}: closed (${reason})`);
	emit({ type: 'closed', peerId, reason });
	// Never reached the host: say so now instead of letting the game's join screen time out.
	if (peerId === hostPeerId && !peer.open) {
		emit({ type: 'join-failed', code: 'no-connection', text: `Could not connect to the host (${reason}).` });
	}
}

async function makeOffer(peer) {
	try {
		peer.makingOffer = true;
		const offer = await whileAlive(peer, peer.pc.createOffer());
		if (!peer.closed) {
			await whileAlive(peer, peer.pc.setLocalDescription(offer));
		}
		if (peer.closed) {
			return;
		}
		peer.offerSentAt = performance.now();
		sendToServer({ type: 'signal', to: peer.id, kind: 'offer', data: peer.pc.localDescription.toJSON() });
	} finally {
		peer.makingOffer = false;
	}
}

async function connectTo(peerId) {
	await ensureSocket();
	await loadIceServers();
	const existing = peers.get(peerId);
	if (existing && !isDead(existing)) {
		return;
	}
	await makeOffer(createPeer(peerId));
}

// The game asks for each connection once, so a set-up that stalls (both players offering at once can leave one
// side waiting for an answer that never comes) would stall the join until the game gives up. Offer again instead.
// A busy PC can take many seconds per set-up step (B-29), so a set-up that is moving (answering, ICE checks) just gets
// more time; only one that is stuck (see checkOpeningMs) is started again.
function watchOpening(peer) {
	peer.openTimer = setTimeout(() => {
		if (peers.get(peer.id) !== peer || peer.open || peer.closed) {
			return;
		}
		const { signalingState, connectionState } = peer.pc;
		const now = performance.now();
		const seconds = Math.round((now - peer.startedAt) / 1000);
		if (now - peer.startedAt >= maxSetupMs) {
			closePeer(peer.id, `no connection after ${seconds} s`);
			return;
		}
		const awaitingAnswer = signalingState === 'have-local-offer' && peer.offerSentAt > 0;
		const notReceived = awaitingAnswer && !peer.offerReceived && now - peer.offerSentAt >= ackTimeoutMs;
		const notAnswered = awaitingAnswer && peer.offerReceived && now - peer.offerSentAt >= answerWaitMs;
		const iceNeverStarted = peer.answeredAt > 0 && peer.pc.iceConnectionState === 'new' && now - peer.answeredAt >= iceStartTimeoutMs;
		const stuck = notReceived || notAnswered || iceNeverStarted;
		if (stuck && peer.attempt >= maxOpenAttempts && notReceived) {
			closePeer(peer.id, `no answer after ${maxOpenAttempts} tries`);
			return;
		}
		if (!stuck || peer.attempt >= maxOpenAttempts) {
			// Out of tries but the other side is there: keep waiting until maxSetupMs.
			if (seconds >= 20 && seconds - peer.loggedAt >= 10) {
				peer.loggedAt = seconds;
				log(`${peer.id}: still connecting after ${seconds} s (${signalingState}, ${connectionState})`);
			}
			watchOpening(peer);
			return;
		}
		const why = iceNeverStarted ? 'ICE never started' : notAnswered ? 'no answer' : 'offer not received';
		log(`${peer.id}: ${why} after ${seconds} s (${signalingState}, ${connectionState}); offering again`);
		const fresh = createPeer(peer.id, peer.attempt + 1, peer.startedAt);
		makeOffer(fresh).catch((error) => log(`offer to ${peer.id} failed: ${describe(error)}`));
	}, checkOpeningMs);
}

const whileAlive = (peer, promise) => Promise.race([promise, peer.disposed]);

function settleWithin(promise, ms, what) {
	let timer = 0;
	const timeout = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A new offer replaces a connection that is not open and either is old, or already finished its offer and answer:
// the other side started over (watchOpening). A connection still offering is left to perfect negotiation.
const isStale = (peer) => !peer.open && !peer.makingOffer
	&& (performance.now() - peer.createdAt > ackTimeoutMs || (peer.pc.signalingState === 'stable' && peer.pc.remoteDescription));

async function onSignal({ from, kind, data }) {
	if (kind === 'bye') {
		closePeer(from, 'bye');
		return;
	}
	if (kind === 'offer') {
		await loadIceServers();
		// Read after the await: connectTo may have made a peer meanwhile.
		let peer = peers.get(from);
		if (!peer || isDead(peer) || isStale(peer)) {
			peer = createPeer(from, peer && !isDead(peer) ? peer.attempt + 1 : 1);
		}
		const collision = peer.makingOffer || peer.pc.signalingState !== 'stable';
		peer.ignoreOffer = !peer.polite && collision;
		if (peer.ignoreOffer) {
			return;
		}
		const started = performance.now();
		await whileAlive(peer, peer.pc.setRemoteDescription(data));
		const answer = peer.closed ? null : await whileAlive(peer, peer.pc.createAnswer());
		if (!peer.closed) {
			await whileAlive(peer, peer.pc.setLocalDescription(answer));
		}
		if (peer.closed || peers.get(from) !== peer) {
			return;
		}
		sendToServer({ type: 'signal', to: from, kind: 'answer', data: peer.pc.localDescription.toJSON() });
		const took = performance.now() - started;
		if (took > 2000) {
			log(`${from}: answering took ${Math.round(took)} ms`);
		}
		await addCandidates(peer);
		return;
	}
	const peer = peers.get(from);
	if (!peer || isDead(peer)) {
		return;
	}
	if (kind === 'answer') {
		if (peer.pc.signalingState === 'have-local-offer') {
			await whileAlive(peer, peer.pc.setRemoteDescription(data));
			peer.answeredAt = performance.now();
			await addCandidates(peer);
		}
	} else if (kind === 'ice' && data) {
		peer.candidates.push(data);
		if (peer.pc.remoteDescription) {
			await addCandidates(peer);
		}
	}
}

async function addCandidates(peer) {
	const candidates = peer.candidates;
	peer.candidates = [];
	for (const candidate of candidates) {
		try {
			await whileAlive(peer, peer.pc.addIceCandidate(candidate));
		} catch (error) {
			if (!peer.ignoreOffer) {
				log(`bad ICE candidate from ${peer.id}: ${describe(error)}`);
			}
		}
	}
}

function onPacket(peer, data) {
	if (peers.get(peer.id) !== peer) {
		return;
	}
	const bytes = new Uint8Array(data);
	peer.received += 1;
	stats.received += 1;
	stats.receivedBytes += bytes.length;
	packets.push({ id: peer.id, bytes });
	packetBytes += 6 + peer.id.length + bytes.length;
}

// ---- Lobbies ----

async function host(info, maxPlayers) {
	hostInfo = info;
	hostMaxPlayers = maxPlayers;
	hostWanted = true;
	try {
		const reply = await request({ type: 'host', info, maxPlayers });
		if (!hostWanted) {
			// The game left meanwhile.
			sendToServer({ type: 'unhost', lobbyId: reply.lobbyId });
			return;
		}
		hostWanted = false;
		hostedLobby = reply.lobbyId;
		emit({ type: 'hosted', lobbyId: hostedLobby });
	} catch (error) {
		// hostWanted stays set, so onWelcome hosts again once the server is back.
		emit({ type: 'error', text: `Could not create the online game: ${describe(error)}` });
	}
}

function update(info) {
	hostInfo = info;
	if (hostedLobby) {
		request({ type: 'update', lobbyId: hostedLobby, info }).catch((error) => log(`lobby update failed: ${describe(error)}`));
	}
}

async function search() {
	try {
		const reply = await request({ type: 'search' });
		emit({ type: 'results', lobbies: reply.lobbies });
	} catch (error) {
		emit({ type: 'search-failed', text: describe(error) });
	}
}

function isJoinable(lobby) {
	return lobby.hostPeerId !== session?.peerId && !lobby.info?.started && lobby.userCount < lobby.maxPlayers;
}

// No code given (the game's -lanjoiner path): ?join=CODE, or the first open lobby, waiting for one to appear.
async function findLobby() {
	const fromPage = params.get('join');
	if (fromPage) {
		return fromPage.toUpperCase();
	}
	const deadline = performance.now() + autoJoinTimeoutMs;
	for (;;) {
		const reply = await request({ type: 'search' });
		const lobby = reply.lobbies.find(isJoinable);
		if (lobby) {
			return lobby.lobbyId;
		}
		if (performance.now() > deadline) {
			throw new Error('no open online game found');
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

async function join(lobbyId) {
	try {
		const code = lobbyId || (await findLobby());
		const reply = await request({ type: 'join', lobbyId: code });
		joinedLobby = reply.lobbyId;
		hostPeerId = reply.hostPeerId;
		emit({ type: 'joined', lobbyId: joinedLobby, hostPeerId });
		// The new player offers to the host (MULTIPLAYER.md 4.4); the rest of the mesh follows when the game asks.
		await connectTo(hostPeerId);
	} catch (error) {
		const text = error.code === 'lobby-not-found' ? 'That game no longer exists.' : error.code === 'lobby-full' ? 'That game is full.' : describe(error);
		emit({ type: 'join-failed', code: error.code ?? 'error', text });
	}
}

// The session ended: close every peer connection and give the lobby back. The socket stays for later searches.
function reset() {
	for (const peerId of [...peers.keys()]) {
		const peer = peers.get(peerId);
		peers.delete(peerId);
		disposePeer(peer);
	}
	packets.length = 0;
	packetBytes = 0;
	if (hostedLobby) {
		sendToServer({ type: 'unhost', lobbyId: hostedLobby });
	}
	if (joinedLobby) {
		sendToServer({ type: 'leave', lobbyId: joinedLobby });
	}
	hostedLobby = null;
	hostInfo = null;
	hostWanted = false;
	joinedLobby = null;
	hostPeerId = null;
}

// The page's address with ?join=CODE, keeping ?signal= (a test or local server) but not the launch options.
function joinLink(lobbyId) {
	const link = new URL(location.pathname, location.origin);
	if (params.has('signal')) {
		link.searchParams.set('signal', params.get('signal'));
	}
	link.searchParams.set('join', lobbyId);
	return link.href;
}

// The game calls this from the frame of a key press, so the page still counts as just used and may write the clipboard.
async function copyLink(lobbyId) {
	const link = joinLink(lobbyId);
	let ok = false;
	try {
		await navigator.clipboard.writeText(link);
		ok = true;
	} catch {
		// No permission or no focus: the old way, through a selected text field.
		const field = document.createElement('textarea');
		field.value = link;
		field.style.position = 'fixed';
		field.style.opacity = '0';
		document.body.appendChild(field);
		field.select();
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		field.remove();
		document.getElementById('canvas')?.focus({ preventScroll: true });
	}
	lastCopy = { link, ok };
	console.log(`[net] join link ${ok ? 'copied' : 'not copied'}: ${link}`);
	emit({ type: 'copied', ok, link });
}

// ?join=CODE in the page's address (a join link), for Main.cs at start-up.
function joinCode() {
	return params.get('join');
}

// True while in an online game (hosting, joined, or connected to anyone): main.js keeps a hidden tab running then.
function isOnline() {
	return hostedLobby !== null || hostWanted || joinedLobby !== null || peers.size > 0;
}

// ---- What the game calls ----

function command(json) {
	const message = JSON.parse(json);
	const failed = (error) => emit({ type: 'error', text: `${message.op} failed: ${describe(error)}` });
	switch (message.op) {
		case 'host':
			reset();
			ensureSocket().catch(failed);
			host(message.info, message.maxPlayers);
			break;
		case 'update':
			update(message.info);
			break;
		case 'search':
			search();
			break;
		case 'join':
			reset();
			join(message.lobbyId);
			break;
		case 'connect':
			connectTo(message.peerId).catch(failed);
			break;
		case 'close': {
			// Wait a moment, so the game's last disconnect messages still go out.
			const peer = peers.get(message.peerId);
			if (peer) {
				clearTimeout(peer.closeTimer);
				peer.closeTimer = setTimeout(() => {
					if (peers.get(message.peerId) === peer) {
						peers.delete(message.peerId);
						disposePeer(peer);
					}
				}, closeDelayMs);
			}
			break;
		}
		case 'reset':
			reset();
			break;
		case 'copy-link':
			copyLink(message.lobbyId);
			break;
		default:
			log(`unknown command ${message.op}`);
	}
}

function send(peerId, view, reliable) {
	const peer = peers.get(peerId);
	if (!peer || !peer.open) {
		stats.dropped += 1;
		return;
	}
	const channel = reliable && peer.reliable.readyState === 'open' ? peer.reliable : peer.unreliable;
	if (channel.readyState !== 'open' || channel.bufferedAmount > maxBufferedBytes) {
		stats.dropped += 1;
		return;
	}
	// The view points into the game's memory and is only valid during this call, so copy it.
	const bytes = view.slice();
	try {
		channel.send(bytes);
	} catch (error) {
		stats.dropped += 1;
		return;
	}
	peer.sent += 1;
	stats.sent += 1;
	stats.sentBytes += bytes.length;
}

function pollEvents() {
	if (events.length === 0) {
		return null;
	}
	const json = JSON.stringify(events);
	events.length = 0;
	return json;
}

// One array per frame, [u16 id length][id][u32 length][bytes] per packet, little-endian (NCWebRTC.DrainPackets).
function pollPackets() {
	if (packets.length === 0) {
		return null;
	}
	const packed = new Uint8Array(packetBytes);
	const view = new DataView(packed.buffer);
	let offset = 0;
	for (const { id, bytes } of packets) {
		view.setUint16(offset, id.length, true);
		offset += 2;
		for (let i = 0; i < id.length; i++) {
			packed[offset + i] = id.charCodeAt(i);
		}
		offset += id.length;
		view.setUint32(offset, bytes.length, true);
		offset += 4;
		packed.set(bytes, offset);
		offset += bytes.length;
	}
	packets.length = 0;
	packetBytes = 0;
	return packed;
}

// For tests and the console: what the network is doing.
function state() {
	return {
		signalingUrl,
		signaling: socket?.readyState === WebSocket.OPEN ? 'connected' : droppedAt ? 'reconnecting' : 'closed',
		peerId: session?.peerId ?? null,
		hostedLobby,
		joinedLobby,
		hostPeerId,
		online: isOnline(),
		lastCopy,
		stats: { ...stats },
		peers: [...peers.values()].map((peer) => ({
			id: peer.id,
			connection: peer.pc.connectionState,
			open: peer.open,
			sent: peer.sent,
			received: peer.received,
		})),
	};
}

// Tests only: drop the matchmaking socket as a network failure would (code 4999 is not "going away").
function dropSignaling() {
	socket?.close(4999, 'test drop');
}

// Tests only: lose every WebRTC set-up message for ms from the next one, so a connection set-up stalls and
// watchOpening has to offer again.
let dropSignalsMs = 0;
let dropSignalsUntil = 0;
function dropSignals(ms) {
	dropSignalsMs = ms;
	dropSignalsUntil = 0;
}

// Leaving the page: end the session at once (code 1001), so the others don't wait for a timeout.
window.addEventListener('pagehide', () => {
	wantSocket = false;
	for (const peer of peers.values()) {
		disposePeer(peer);
	}
	socket?.close(1001, 'page closed');
});

globalThis.duckGameNet = { command, send, pollEvents, pollPackets, joinCode, isOnline, state, dropSignaling, dropSignals };
