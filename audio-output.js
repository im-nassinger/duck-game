// The game's sound output on an AudioWorklet (D-60, B-34), in place of the ScriptProcessorNode SDL asks for.
// SDL3's Emscripten driver only knows createScriptProcessor, and that node lets the sound fall behind in Firefox: the
// buffers that come late after the main thread stalls all get queued, and the delay stays. This object looks like that
// node to SDL (onaudioprocess, connect, disconnect), but the mixing is asked for by how much sound is really queued, so
// after a stall only the missing amount is mixed. A stall is a short gap in the sound, never a delay after it.

// The sound queued ahead of the speakers. It has to outlast a slow frame of the game on the main thread.
const queuedSeconds = 0.06;

export class WorkletOutput {
	onaudioprocess = null;

	#context;
	#frames;
	#channels;
	#node = null;
	#closed = false;
	#sentFrames = 0;
	#targetFrames;

	// createFallback makes the real ScriptProcessorNode, for a browser that can't load the worklet.
	constructor(context, frames, channels, createFallback) {
		this.#context = context;
		this.#frames = frames;
		this.#channels = channels;
		this.#targetFrames = Math.ceil(queuedSeconds * context.sampleRate);
		this.#start(createFallback);
	}

	async #start(createFallback) {
		let node;
		try {
			await this.#context.audioWorklet.addModule(new URL('audio-output-worklet.js', import.meta.url));
			if (this.#closed) {
				return;
			}
			node = new AudioWorkletNode(this.#context, 'duck-game-output', { numberOfInputs: 0, outputChannelCount: [this.#channels] });
			node.port.onmessage = ({ data: playedFrames }) => this.#fill(playedFrames);
		} catch (error) {
			console.warn(`The sound falls back to a ScriptProcessorNode: ${error}`);
			if (this.#closed) {
				return;
			}
			node = createFallback();
			node.onaudioprocess = (event) => this.onaudioprocess?.(event);
		}
		this.#node = node;
		node.connect(this.#context.destination);
	}

	// playedFrames can be old after a stall, which only makes the queue look fuller than it is, so it never overfills.
	#fill(playedFrames) {
		while (!this.#closed && this.#sentFrames - playedFrames < this.#targetFrames) {
			const channelData = [];
			for (let channel = 0; channel < this.#channels; channel++) {
				channelData.push(new Float32Array(this.#frames));
			}
			this.onaudioprocess?.({
				outputBuffer: { numberOfChannels: this.#channels, getChannelData: (channel) => channelData[channel] },
			});
			this.#sentFrames += this.#frames;
			this.#node.port.postMessage(channelData, channelData.map((data) => data.buffer));
		}
	}

	// #start connects it to the speakers, the only place SDL connects it, once the worklet has loaded.
	connect() {}

	disconnect() {
		this.#closed = true;
		this.#node?.disconnect();
	}
}
