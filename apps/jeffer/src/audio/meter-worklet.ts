// The metering worklet, as source text.
//
// It exists for one reason: the level has to be measured on the audio thread,
// where the samples are, and the main thread is busy drawing a picture that
// wants 60 frames a second. Everything else in the engine is scheduled from
// the main thread and is therefore only as timely as the main thread is.
//
// It is a string rather than a separate entry for the same reason the GLSL is:
// there is no worklet chunk to name, hash and precache. See vite.config.ts.

/** The worklet's processor source, without the module wrapper. */
const WORKLET_SOURCE = `
class LoudnessTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.size) || 1024;
    this.buffer = new Float32Array(size);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      this.buffer[this.filled++] = left[i];
      if (this.filled >= this.buffer.length) {
        // A copy, because the worklet's buffer is reused on the next quantum
        // and the main thread may not have read this one yet.
        this.port.postMessage({ pcm: this.buffer.slice(0) });
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('loudness-tap', LoudnessTap);
`;

/** A Blob URL for the worklet module. The caller revokes it once loaded. */
export function meterWorkletUrl(): string {
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}
