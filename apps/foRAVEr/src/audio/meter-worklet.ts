// The meter tap, as source text (spec §5's "levels ... once per frame", and §6's
// loudness targets, which need a real measurement).
//
// It is embedded rather than shipped as a file, for the same reasons the GLSL is
// (see src/visuals/shaders.ts): no extra fetch, no MIME or path to get wrong, no
// worker chunk for the service worker to precache, and it works offline from any
// host. The engine loads it with `addModule(blobURL)`.
//
// The cost of embedding is that this file is not type-checked. It is small, it
// talks to the audio thread only, and `tools/smoke.ts` renders through it.

export const METER_WORKLET_SOURCE = `
// Renders nothing: it copies the master signal out in blocks for the loudness
// meter on the main thread, and exists so the graph pulls it.
const BLOCK = 4096; // ~85 ms at 48 kHz

class LoudnessTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fill = 0;
    // Two scratch buffers. postMessage clones them, so they can be written
    // again immediately: nothing is allocated on the audio thread.
    this.buffers = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    // The message shape is part of the contract with the engine, which reads
    // 'data.pcm': posting the buffers bare would send an array with no 'pcm' in
    // it, and the meter would silently never hear anything.
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

registerProcessor('loudness-tap', LoudnessTap);
`;

/** A URL for the worklet source, to be revoked when the context closes. */
export function meterWorkletUrl(source: string = METER_WORKLET_SOURCE): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}
