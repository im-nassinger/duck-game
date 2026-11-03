// Plays the buffers audio-output.js sends (D-60), on the browser's audio thread, and tells it how far playing has got.
// With nothing queued it plays silence, and silence doesn't count as played, so the main thread can see the queue is empty.

// About 10 ms at 48 kHz.
const reportEveryFrames = 512;

class OutputProcessor extends AudioWorkletProcessor {
	#queue = [];
	#offset = 0;
	#playedFrames = 0;
	#framesSinceReport = reportEveryFrames;

	constructor() {
		super();
		this.port.onmessage = ({ data: channelData }) => this.#queue.push(channelData);
	}

	process(_inputs, [output]) {
		const size = output[0].length;
		let written = 0;
		while (written < size && this.#queue.length > 0) {
			const buffer = this.#queue[0];
			const count = Math.min(size - written, buffer[0].length - this.#offset);
			for (let channel = 0; channel < output.length; channel++) {
				output[channel].set(buffer[channel].subarray(this.#offset, this.#offset + count), written);
			}
			written += count;
			this.#offset += count;
			if (this.#offset === buffer[0].length) {
				this.#queue.shift();
				this.#offset = 0;
			}
		}
		this.#playedFrames += written;
		this.#framesSinceReport += size;
		if (this.#framesSinceReport >= reportEveryFrames) {
			this.#framesSinceReport = 0;
			this.port.postMessage(this.#playedFrames);
		}
		return true;
	}
}

registerProcessor('duck-game-output', OutputProcessor);
