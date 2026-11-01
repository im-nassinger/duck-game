// The page's own screens, drawn the way the game draws its own (D-52): text in the game's BIOS font
// (Graphics.DrawString), panels in its menu box (UIBox's 9-slice uiBox), choices like its menu items (UIMenuItem: the
// menu colour and the arrow on the selected one), and the loading screen of MonoMain (the message over a red bar along
// the bottom, and a grey running duck). The images in ui/ are copies of the game's own Content\*.png.
// Sizes are in game pixels of a 720-line screen. main.js's fitCanvas sets --u, one such pixel in CSS pixels, and
// --f1 to --f4, one font pixel at that text scale, rounded to whole device pixels so the letters stay sharp.

// BitmapFont._characters up to '~': cell n of biosFont.png (16 to a row, 8 by 8) is the n-th character here.
// Note that '>' and '<' are swapped in the game's table, as here.
const fontCharacters = ' !"#$%&\'()*+,-./0123456789:;>=<?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const glyphSize = 8;
const lineHeight = 10;
const fontColumns = 16;
// The loading screen's duck: frames 1 to 6 of the "run" animation with its arm, tinted (80, 80, 80).
const duckFrames = [1, 2, 3, 4, 5, 6];
const duckSize = 32;
const armSize = 16;
const armOffset = { x: 5, y: 14 };
const duckTint = 'rgb(80, 80, 80)';

export const colors = {
	white: '#ffffff',
	// Colors.MenuOption, the menu items' colour.
	menu: '#eb8933',
	gray: '#adadad',
	red: '#ff8b80',
};

const images = {};

function loadImage(name) {
	const image = new Image();
	image.src = `ui/${name}.png`;
	return image.decode().then(() => {
		images[name] = image;
	});
}

// Resolves when the images are in; without them (a missing file) the text shows in the page's own font instead.
export const ready = Promise.all(['biosFont', 'duck', 'duckArms'].map(loadImage)).catch((error) => {
	console.warn(`The page's game font didn't load: ${error}`);
});

function wrapLines(text, maxChars) {
	const lines = [];
	for (const paragraph of text.split('\n')) {
		if (!maxChars || paragraph.length <= maxChars) {
			lines.push(paragraph);
			continue;
		}
		let line = '';
		for (const word of paragraph.split(' ')) {
			const next = line ? `${line} ${word}` : word;
			if (next.length <= maxChars) {
				line = next;
				continue;
			}
			if (line) {
				lines.push(line);
			}
			line = word;
			while (line.length > maxChars) {
				lines.push(line.slice(0, maxChars));
				line = line.slice(maxChars);
			}
		}
		lines.push(line);
	}
	return lines;
}

function glyphIndex(character) {
	const index = fontCharacters.indexOf(character);
	return index < 0 ? fontCharacters.indexOf('?') : index;
}

function tint(context, color) {
	if (color === colors.white) {
		return;
	}
	context.globalCompositeOperation = 'source-in';
	context.fillStyle = color;
	context.fillRect(0, 0, context.canvas.width, context.canvas.height);
	context.globalCompositeOperation = 'source-over';
}

// The lines in the BIOS font, one canvas pixel per font pixel.
function drawLines(lines, color) {
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, ...lines.map((line) => line.length)) * glyphSize;
	canvas.height = (lines.length - 1) * lineHeight + glyphSize;
	const context = canvas.getContext('2d');
	lines.forEach((line, row) => {
		for (let column = 0; column < line.length; column++) {
			const index = glyphIndex(line[column]);
			context.drawImage(images.biosFont, (index % fontColumns) * glyphSize, Math.floor(index / fontColumns) * glyphSize,
				glyphSize, glyphSize, column * glyphSize, row * lineHeight, glyphSize, glyphSize);
		}
	});
	tint(context, color);
	return canvas;
}

// scale is a text scale (1 to 4, for --f1 to --f4) or the name of another CSS variable holding one font pixel.
function sizeInFontPixels(element, width, height, scale) {
	const pixel = typeof scale === 'string' ? `var(${scale})` : `var(--f${scale})`;
	element.style.width = `calc(${pixel} * ${width})`;
	element.style.height = `calc(${pixel} * ${height})`;
}

// Puts text in the element, drawn in the game's font. The text itself stays in the element (hidden), so its
// textContent, a screen reader and the tests still see it.
export function setText(element, text, { scale = 2, color = colors.white, maxChars = 0 } = {}) {
	const label = document.createElement('span');
	label.textContent = text;
	if (!images.biosFont) {
		label.className = 'plain-text';
		element.replaceChildren(label);
		return;
	}
	const pixels = drawLines(wrapLines(text, maxChars), color);
	pixels.className = 'pixels';
	sizeInFontPixels(pixels, pixels.width, pixels.height, scale);
	label.className = 'hidden-text';
	element.replaceChildren(pixels, label);
}

// Small pixel icons for the page, one row per string ('#' is a lit pixel).
const icons = {
	soundOff: ['...#.......', '..##.......', '####.#...#.', '####..#.#..', '####...#...', '####..#.#..', '####.#...#.', '..##.......', '...#.......'],
};

export function setIcon(element, name, { scale = 2, color = colors.white } = {}) {
	const rows = icons[name];
	const canvas = document.createElement('canvas');
	canvas.width = rows[0].length;
	canvas.height = rows.length;
	const context = canvas.getContext('2d');
	context.fillStyle = color;
	rows.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			if (row[x] === '#') {
				context.fillRect(x, y, 1, 1);
			}
		}
	});
	canvas.className = 'pixels';
	sizeInFontPixels(canvas, canvas.width, canvas.height, scale);
	element.replaceChildren(canvas);
}

// The running duck of the loading screen, as a strip of its frames in the image (index.html's CSS steps through them).
export function drawDuck(image) {
	if (!images.duck || !images.duckArms) {
		return;
	}
	const sheetColumns = images.duck.width / duckSize;
	const armColumns = images.duckArms.width / armSize;
	const plain = document.createElement('canvas');
	plain.width = duckSize * duckFrames.length;
	plain.height = duckSize;
	const frames = plain.getContext('2d');
	// The arm goes behind the body, as on the game's screen.
	duckFrames.forEach((frame, slot) => {
		frames.drawImage(images.duckArms, (frame % armColumns) * armSize, Math.floor(frame / armColumns) * armSize,
			armSize, armSize, slot * duckSize + armOffset.x, armOffset.y, armSize, armSize);
		frames.drawImage(images.duck, (frame % sheetColumns) * duckSize, Math.floor(frame / sheetColumns) * duckSize,
			duckSize, duckSize, slot * duckSize, 0, duckSize, duckSize);
	});
	const tinted = document.createElement('canvas');
	tinted.width = plain.width;
	tinted.height = plain.height;
	const context = tinted.getContext('2d');
	context.drawImage(plain, 0, 0);
	context.globalCompositeOperation = 'multiply';
	context.fillStyle = duckTint;
	context.fillRect(0, 0, tinted.width, tinted.height);
	// Multiply fills the transparent pixels too; keep only the duck's.
	context.globalCompositeOperation = 'destination-in';
	context.drawImage(plain, 0, 0);
	// An image rather than the canvas itself: the browser composites a moving image more reliably.
	image.src = tinted.toDataURL();
}

// A text field in the game's font over a real <input>, which keeps the typing, the caret and the selection.
// The input is see-through and on top, so clicks and keys reach it; this draws what it holds.
export function drawField(field, input, visibleChars) {
	const value = input.value;
	const start = input.selectionStart ?? value.length;
	const end = input.selectionEnd ?? start;
	const first = Math.max(0, end - visibleChars + 1);
	const shown = value.slice(first, first + visibleChars);
	let pixels = field.querySelector('.pixels');
	if (!images.biosFont) {
		input.classList.add('plain-input');
		return;
	}
	const text = drawLines([shown || ' '], colors.white);
	if (start !== end) {
		// The selection: the menu colour behind black letters.
		const context = text.getContext('2d');
		const from = (Math.max(start, first) - first) * glyphSize;
		const to = (Math.min(end, first + visibleChars) - first) * glyphSize;
		context.globalCompositeOperation = 'xor';
		context.fillStyle = colors.menu;
		context.fillRect(from, 0, to - from, glyphSize);
		context.globalCompositeOperation = 'source-over';
	}
	text.className = 'pixels';
	sizeInFontPixels(text, text.width, text.height, 2);
	if (pixels) {
		pixels.replaceWith(text);
	} else {
		field.prepend(text);
	}
	field.style.setProperty('--caret', String(end - first));
	field.classList.toggle('has-selection', start !== end);
}

// Menu choices: one is selected (the arrow), the mouse selects what it is over, and the arrow keys move the selection.
export function makeMenu(buttons) {
	let selected = 0;
	const select = (index) => {
		selected = (index + buttons.length) % buttons.length;
		buttons.forEach((button, i) => button.classList.toggle('selected', i === selected));
	};
	buttons.forEach((button, i) => {
		button.addEventListener('pointerenter', () => select(i));
		button.addEventListener('focus', () => select(i));
	});
	select(0);
	return {
		select,
		get selected() {
			return buttons[selected];
		},
		// True when the key was a menu key and moved the selection.
		onKey(event) {
			const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, Tab: event.shiftKey ? -1 : 1 }[event.key];
			if (!step) {
				return false;
			}
			select(selected + step);
			return true;
		},
	};
}
