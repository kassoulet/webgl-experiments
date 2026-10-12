// The loudness meter tap, as source text. Embedded rather than shipped as a
// file, for the same reasons the GLSL is: no extra fetch, no MIME or path to
// get wrong, no worker chunk for the service worker to precache, and it works
// offline from any host. The engine loads it with `addModule(blobURL)`.
//
// It renders nothing: it copies the master signal out in blocks for the
// loudness meter on the main thread (src/audio/loudness.ts, the LiveMeter
// wrapper), and exists so the graph pulls it. The cost of embedding is that
// this file is not type-checked — it is small, it talks to the audio thread
// only, and the smoke test drives it in a real page.

export const METER_WORKLET_SOURCE = `
const BLOCK = 4096; // ~85 ms at 48 kHz

class LoudnessTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fill = 0;
    // Two scratch buffers. postMessage clones them, so they can be written
    // again immediately: nothing is allocated on the audio thread.
    this.buffers = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    this.message = { pcm: this.buffers };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const left = input[0];
    const right = input[1] ?? input[0];
    const n = left.length;
    const L = this.buffers[0];
    const R = this.buffers[1];
    for (let i = 0; i < n; i++) {
      L[this.fill] = left[i];
      R[this.fill] = right[i];
      this.fill++;
      if (this.fill === BLOCK) {
        this.fill = 0;
        this.port.postMessage(this.message);
      }
    }
    return true;
  }
}

registerProcessor('loudness-processor', LoudnessTap);
`;

/** A URL for the worklet source, to be revoked when the context closes. */
export function meterWorkletUrl(source: string = METER_WORKLET_SOURCE): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}
