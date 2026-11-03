// On-screen controls for phones and tablets (D-53). They drive a virtual gamepad, which SDL reads through
// navigator.getGamepads() like a real one, so the game sees an Xbox-style controller with its default mapping
// (Input.cs, "XBOX GAMEPAD"):
// - the buttons on the right are an Xbox controller's A (jump, OK in menus), B (quack, back in menus), X (fire) and
//   Y (grab or drop) as its diamond, each drawn as the game's own glyph for it (ui\glyph-*.png), the one the game's
//   menu prompts show; LB (strafe) and RB (ragdoll) are in the top corners, and START (pause) is below LB;
// - a thumb on the left half of the screen is a joystick that works as the d-pad (up, down, left, right, and the
//   diagonals): it shows where the thumb lands (that is its centre) and follows the thumb;
// - a thumb on the right half (outside the buttons) slides up for A (jump) and down for the d-pad's down (crouch).
//   While a menu is open (inMenu, from the game) up is the d-pad's up instead, so slides move through a menu both
//   ways and never pick a choice. Each is held until the thumb lifts or slides back the other way by the same
//   distance from the furthest point it reached, and the next slide counts from there. A quick tap there that barely
//   moved presses A once, which picks a menu choice (and hops in a match);
// - a double tap outside the buttons calls onDoubleTap (main.js toggles fullscreen); on the right half its first tap
//   is A as usual and its second isn't;
// - a hint says what the thumbs do when the controls first show.
// The controls show on touch screens, or with ?touch in the address (?touch=0 hides them).

// Standard Gamepad API button indices.
const padButtons = { a: 0, b: 1, x: 2, y: 3, leftShoulder: 4, rightShoulder: 5, start: 9, up: 12, down: 13, left: 14, right: 15 };
const buttonCount = 17;
// A slide counts once the thumb has moved this far, as a share of the screen's shorter side (and at least 18 px).
const slideShare = 0.06;
const slideMinPx = 22;
// The joystick: the knob's travel is this share of the base's width. Within the dead zone (a share of that travel)
// no direction is pressed; past it, each axis that is at least this far out presses its direction, so a thumb at an
// angle presses two (a diagonal).
const stickTravel = 0.5;
const stickDeadZone = 0.3;
const stickAxisShare = 0.4;
// Two taps this close in time and place are a double tap.
const doubleTapMs = 320;
const doubleTapPx = 48;
// A touch that lifts within this time, having moved less than this, is a tap; it holds A this long.
const tapMaxMs = 350;
const tapMaxPx = 12;
const tapHoldMs = 90;
const hintMs = 8000;

const params = new URLSearchParams(location.search);
const forced = params.has('touch') ? params.get('touch') !== '0' : null;

const pad = {
	// The form SDL recognises as a standard-mapping Xbox 360 controller (as test\t8-checks.mjs's fake pad).
	id: 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)',
	index: 0,
	connected: false,
	mapping: 'standard',
	timestamp: performance.now(),
	axes: [0, 0, 0, 0],
	buttons: Array.from({ length: buttonCount }, () => ({ pressed: false, touched: false, value: 0 })),
	vibrationActuator: null,
	hapticActuators: [],
};

// The real gamepads, with the virtual one in the first free slot while the controls are on.
// (A page on http:// from another device on the network may have no Gamepad API of its own.)
const realGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => [];
navigator.getGamepads = () => {
	let pads;
	try {
		pads = Array.from(realGetGamepads() ?? []);
	} catch {
		pads = [];
	}
	if (!pad.connected) {
		return pads;
	}
	let slot = pads.findIndex((entry) => !entry);
	if (slot < 0) {
		slot = pads.length;
	}
	pad.index = slot;
	pads[slot] = pad;
	return pads;
};

function sendPadEvent(type) {
	const event = new Event(type);
	Object.defineProperty(event, 'gamepad', { value: pad });
	window.dispatchEvent(event);
}

// A button is down while anything holds it: a finger on its on-screen button, or a slide.
const holds = new Map();

function hold(name) {
	const count = holds.get(name) ?? 0;
	holds.set(name, count + 1);
	if (count === 0) {
		pad.buttons[padButtons[name]] = { pressed: true, touched: true, value: 1 };
		pad.timestamp = performance.now();
		navigator.vibrate?.(8);
	}
}

function letGo(name) {
	const count = Math.max(0, (holds.get(name) ?? 0) - 1);
	holds.set(name, count);
	if (count === 0) {
		pad.buttons[padButtons[name]] = { pressed: false, touched: false, value: 0 };
		pad.timestamp = performance.now();
	}
}

// A finger's point on the page as laid out: while main.js has turned the page a quarter turn clockwise (a phone held
// upright, D-55), the page's right is the screen's down and the page's down is the screen's left.
function pagePoint(event) {
	if (isRotated()) {
		return { x: event.clientY, y: innerWidth - event.clientX };
	}
	return { x: event.clientX, y: event.clientY };
}

function isRotated() {
	return document.body.classList.contains('rotated');
}

function pageWidth() {
	return isRotated() ? innerHeight : innerWidth;
}

export function isTouchDevice() {
	if (forced !== null) {
		return forced;
	}
	return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches;
}

// The layer covers the screen: its buttons ([data-pad], with the glyph in data-glyph) take the fingers that land on
// them, a finger on the left half is the joystick (#stick), and one on the right half slides.
export function setupTouchControls(layer, { onDoubleTap, inMenu }) {
	const buttons = Array.from(layer.querySelectorAll('[data-pad]'));
	for (const button of buttons) {
		const icon = new Image();
		icon.className = 'icon';
		icon.alt = '';
		icon.draggable = false;
		icon.src = `ui/glyph-${button.dataset.glyph}.png`;
		button.replaceChildren(icon);
	}
	const hint = layer.querySelector('#touch-hint');
	let hintShown = false;
	const stick = layer.querySelector('#stick');
	const knob = layer.querySelector('#stick-knob');

	// What each finger is doing: { kind: 'button', button }, { kind: 'stick', origin, held } or { kind: 'slide', ... }.
	const fingers = new Map();

	const setButton = (finger, button) => {
		if (finger.button === button) {
			return;
		}
		if (finger.button) {
			finger.button.classList.remove('held');
			letGo(finger.button.dataset.pad);
		}
		finger.button = button;
		if (button) {
			button.classList.add('held');
			hold(button.dataset.pad);
		}
	};

	// The joystick appears centred where the thumb landed.
	const startStick = (origin) => {
		stick.style.left = `${origin.x}px`;
		stick.style.top = `${origin.y}px`;
		knob.style.transform = '';
		stick.classList.add('active');
	};
	// The d-pad directions the stick presses: the ones it now points at are held, the others let go.
	const setStickDirections = (finger, directions) => {
		for (const name of finger.held) {
			if (!directions.includes(name)) {
				letGo(name);
			}
		}
		for (const name of directions) {
			if (!finger.held.includes(name)) {
				hold(name);
			}
		}
		if (directions.length) {
			finger.moved = true;
		}
		finger.held = directions;
	};
	const moveStick = (finger, point) => {
		const reach = stick.offsetWidth * stickTravel;
		let x = (point.x - finger.origin.x) / reach;
		let y = (point.y - finger.origin.y) / reach;
		const length = Math.hypot(x, y);
		if (length > 1) {
			x /= length;
			y /= length;
		}
		knob.style.transform = `translate(${x * reach}px, ${y * reach}px)`;
		const directions = [];
		if (length >= stickDeadZone) {
			const share = stickAxisShare * Math.min(1, length);
			if (x <= -share) {
				directions.push('left');
			} else if (x >= share) {
				directions.push('right');
			}
			if (y <= -share) {
				directions.push('up');
			} else if (y >= share) {
				directions.push('down');
			}
		}
		setStickDirections(finger, directions);
	};
	const endStick = (finger) => {
		stick.classList.remove('active');
		setStickDirections(finger, []);
	};

	// A tap: true when it was the second of a double tap (and onDoubleTap ran).
	let lastTap = null;
	const isDoubleTap = (point) => {
		const now = performance.now();
		const second = lastTap && now - lastTap.time < doubleTapMs && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < doubleTapPx;
		lastTap = second ? null : { time: now, x: point.x, y: point.y };
		if (second) {
			onDoubleTap();
		}
		return second;
	};
	const isQuick = (finger) => performance.now() - finger.started < tapMaxMs;

	// The right thumb's slide: the pad button it holds (null when none), where the current slide started, which way
	// it goes (-1 up, 1 down) and the furthest point since. Up is A (jump), or the d-pad's up while a menu is open.
	const moveSlide = (finger, point) => {
		finger.moved = Math.max(finger.moved, Math.hypot(point.x - finger.start.x, point.y - finger.start.y));
		const at = point.y;
		const step = Math.max(slideMinPx, Math.min(innerWidth, innerHeight) * slideShare);
		if (!finger.holding) {
			if (Math.abs(at - finger.from) >= step) {
				finger.direction = at < finger.from ? -1 : 1;
				finger.holding = finger.direction > 0 ? 'down' : inMenu() ? 'up' : 'a';
				hold(finger.holding);
			}
			finger.furthest = at;
			return;
		}
		finger.furthest = finger.direction < 0 ? Math.min(finger.furthest, at) : Math.max(finger.furthest, at);
		if ((at - finger.furthest) * finger.direction <= -step) {
			letGo(finger.holding);
			finger.holding = null;
			finger.from = at;
		}
	};
	const endSlide = (finger) => {
		if (finger.moved < tapMaxPx && isQuick(finger) && !isDoubleTap(finger.start)) {
			hold('a');
			setTimeout(() => letGo('a'), tapHoldMs);
		}
		if (finger.holding) {
			letGo(finger.holding);
		}
	};

	const endFinger = (event) => {
		const finger = fingers.get(event.pointerId);
		if (!finger) {
			return;
		}
		fingers.delete(event.pointerId);
		if (finger.kind === 'button') {
			setButton(finger, null);
		} else if (finger.kind === 'stick') {
			endStick(finger);
			if (!finger.moved && isQuick(finger)) {
				isDoubleTap(finger.origin);
			}
		} else {
			endSlide(finger);
		}
	};

	const stickInUse = () => Array.from(fingers.values()).some((finger) => finger.kind === 'stick');

	layer.addEventListener('pointerdown', (event) => {
		event.preventDefault();
		// Keeps the finger's events coming here wherever it slides.
		layer.setPointerCapture(event.pointerId);
		const button = event.target.closest('[data-pad]');
		const point = pagePoint(event);
		if (button) {
			const finger = { kind: 'button', button: null };
			fingers.set(event.pointerId, finger);
			setButton(finger, button);
		} else if (point.x < pageWidth() / 2 && !stickInUse()) {
			fingers.set(event.pointerId, { kind: 'stick', origin: point, held: [], moved: false, started: performance.now() });
			startStick(point);
		} else {
			fingers.set(event.pointerId, { kind: 'slide', holding: null, direction: 0, from: point.y, furthest: point.y, start: point,
				moved: 0, started: performance.now() });
		}
	});
	layer.addEventListener('pointermove', (event) => {
		const finger = fingers.get(event.pointerId);
		if (!finger) {
			return;
		}
		if (finger.kind === 'button') {
			// A finger can slide from one button to the next.
			const under = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pad]') ?? null;
			setButton(finger, under && layer.contains(under) ? under : null);
		} else if (finger.kind === 'stick') {
			moveStick(finger, pagePoint(event));
		} else {
			moveSlide(finger, pagePoint(event));
		}
	});
	layer.addEventListener('pointerup', endFinger);
	layer.addEventListener('pointercancel', endFinger);
	layer.addEventListener('lostpointercapture', endFinger);
	// No page scrolling, zooming, text selection or long-press menu from the controls.
	layer.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
	layer.addEventListener('contextmenu', (event) => event.preventDefault());

	const releaseAll = () => {
		for (const id of Array.from(fingers.keys())) {
			endFinger({ pointerId: id });
		}
	};
	window.addEventListener('blur', releaseAll);

	return {
		// Shows the controls and connects the virtual gamepad, or hides them and disconnects it.
		setActive(active) {
			if (active === !layer.hidden) {
				return;
			}
			releaseAll();
			layer.hidden = !active;
			pad.connected = active;
			pad.timestamp = performance.now();
			// Picks the pad's slot before the event names it.
			navigator.getGamepads();
			sendPadEvent(active ? 'gamepadconnected' : 'gamepaddisconnected');
			if (active && !hintShown) {
				hintShown = true;
				hint.classList.add('shown');
				setTimeout(() => hint.classList.remove('shown'), hintMs);
			}
		},
		releaseAll,
	};
}
