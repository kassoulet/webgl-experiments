// The renderer: one full-screen triangle, one fragment shader, and a resolution
// that moves to hold the frame rate (spec §4).
//
// The canvas is sized in device pixels at `scale`; CSS stretches it to the
// viewport, which is the upscale. Bloom is a two-pass pipeline — scene →
// offscreen HDR texture → separable Gaussian blur (bright-pass) → additive
// composite — because a phosphor trace without glow is a line in a spreadsheet.
//
// Two things here have no counterpart in FOraveR's renderer, because they come
// from the fact that this picture is *of the sound* rather than beside it:
//
//  - The scope texture. 256x2 floats, uploaded every frame from the engine's
//    AnalyserNode, is the only input the picture has that is not a number the
//    conductor made up. R32F where the driver takes it and an 8-bit fallback
//    where it does not, because a texture that silently failed to upload is a
//    flat line on a black screen and nothing else.
//  - The trigger. A real scope does not start its sweep at an arbitrary point
//    in the buffer; it waits for the signal to cross its trigger level, which
//    is why the trace stands still. The search for that crossing is here, in
//    JS, once per frame, over a window small enough to be free.

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.ts';
import {
  BLOOM_VERTEX_SHADER,
  BLOOM_FRAGMENT_SHADER,
  COMPOSITE_VERTEX_SHADER,
  COMPOSITE_FRAGMENT_SHADER,
  METER_FRAGMENT_SHADER,
} from './bloom.ts';
import { visualSettings } from '../profile.ts';
import { hashString } from '../rng.ts';
import { SCOPE_BINS, findTrigger } from '../scope.ts';
import type {
  ConductorState,
  DrawOptions,
  FlashMode,
  Palette,
  Profile,
  Quality,
  RGB,
  RenderStats,
  ScopeFrame,
  Seed,
  VisualSettings,
} from '../types.ts';

const UNIFORMS = [
  'uRes', 'uTime', 'uSeed',
  'uVoid', 'uDeep', 'uMid', 'uHot', 'uAccent',
  'uMix', 'uLevels', 'uPulse', 'uDrift',
  'uScope', 'uScopeBins', 'uScopePeak', 'uScopeRms', 'uScopeSigned', 'uTrigger', 'uSweep', 'uScopeGain',
  'uOctaves', 'uExposure', 'uScanLines',
] as const;

type UniformName = (typeof UNIFORMS)[number];

/** The reduction target's edge, in pixels. Small enough that the readback is
 *  free, big enough that a mostly-black frame with one bright trace in it still
 *  lands a sample on the trace. */
const METER_SIZE = 32;

/** How often the frame's mean light is read back. Every frame would stall the
 *  pipeline behind a synchronous read for a number nothing acts on. */
const METER_EVERY = 12;

/** One frame's worth of input: the clock, the arrangement and the sound. */
export interface FrameInput {
  time: number;
  state: ConductorState;
  /** This frame's oscilloscope data, or null when there is no audio yet — an
   *  offline render of the picture alone, or before the first analyser frame. */
  scope: ScopeFrame | null;
  /** How bright the picture is (the sleep timer fades it out). */
  dim?: number;
  /** Numbers a capture holds still; the app never sets this. */
  overrides?: DrawOptions;
}

export interface RendererOptions {
  profile: Profile;
  quality?: Quality;
  seed?: Seed;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly profile: Profile;
  quality: Quality;
  flashMode: FlashMode = 'soft';

  private readonly seedValue: number;
  private settings: VisualSettings;
  private scale: number;
  private minScale: number;
  private octaves: number;
  private minOctaves: number;
  private maxOctaves: number;
  private available: boolean;
  private frames: number;
  private frameAvg: number;
  private lastFrame: number;
  private dim: number;
  private mean: number;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private locations: Record<UniformName, WebGLUniformLocation | null>;

  // The scope's data.
  private scopeTexture: WebGLTexture | null = null;
  private readonly scopeFloats = new Float32Array(SCOPE_BINS * 2);
  private readonly scopeBytes = new Uint8Array(SCOPE_BINS * 2);
  private scopeFloatOk = true;
  private scopeBins = 0;
  private trigger = 0;

  // Bloom and measurement resources.
  private bloomProgram: WebGLProgram | null;
  private compositeProgram: WebGLProgram | null;
  private meterProgram: WebGLProgram | null;
  private sceneFramebuffer: WebGLFramebuffer | null;
  private sceneTexture: WebGLTexture | null;
  private bloomFramebufferA: WebGLFramebuffer | null = null;
  private bloomFramebufferB: WebGLFramebuffer | null = null;
  private bloomTextureA: WebGLTexture | null = null;
  private bloomTextureB: WebGLTexture | null = null;
  private bloomSize: [number, number] | null = null;
  /** Whether the render targets are float. False means the picture is drawn in
   *  8 bits per channel and the bloom is correspondingly tighter. */
  private hdr = true;
  private bloomEnabled: boolean;
  private bloomThreshold = 0.55;
  private bloomIntensity = 1.0;
  private bloomBlurRadius = 7.0;
  private meterFramebuffer: WebGLFramebuffer | null = null;
  private meterTexture: WebGLTexture | null = null;
  private meterLocations: { uScene: WebGLUniformLocation | null; uBloom: WebGLUniformLocation | null; uIntensity: WebGLUniformLocation | null };
  private readonly meterPixels = new Uint8Array(METER_SIZE * METER_SIZE * 4);
  private bloomLocations: {
    uScene: WebGLUniformLocation | null;
    uRes: WebGLUniformLocation | null;
    uThreshold: WebGLUniformLocation | null;
    uBlurRadius: WebGLUniformLocation | null;
    uHorizontal: WebGLUniformLocation | null;
  };
  private compositeLocations: {
    uScene: WebGLUniformLocation | null;
    uBloom: WebGLUniformLocation | null;
    uIntensity: WebGLUniformLocation | null;
    uDim: WebGLUniformLocation | null;
  };
  /** The last frame's layer weights, kept so `stats()` reports the picture
   *  rather than the settings. */
  private lastMix: [number, number, number, number] = [0, 0, 0, 0];
  /** The palette in linear light, and the palette it was converted from. The
   *  conductor hands out one Palette object per passage, so this is converted
   *  once every few seconds rather than sixty times a second. */
  private linearPalette: Palette | null = null;
  private readonly linear = {
    void: new Float32Array(3),
    deep: new Float32Array(3),
    mid: new Float32Array(3),
    hot: new Float32Array(3),
    accent: new Float32Array(3),
  };

  constructor(canvas: HTMLCanvasElement, { profile, quality = 'auto', seed = 'jeffer' }: RendererOptions) {
    this.canvas = canvas;
    this.profile = profile;
    this.quality = quality;
    this.seedValue = hashString(String(seed)) % 4096;
    this.settings = visualSettings(profile, quality);
    this.scale = this.settings.scale;
    this.minScale = Math.min(0.3, this.settings.scale);
    this.octaves = this.settings.octaves;
    this.minOctaves = 1;
    this.maxOctaves = Math.max(this.settings.octaves, 5);
    this.available = false;
    this.frames = 0;
    this.frameAvg = 1 / 60;
    this.lastFrame = 0;
    this.dim = 1;
    this.mean = 0;
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.locations = {} as Record<UniformName, WebGLUniformLocation | null>;

    this.bloomProgram = null;
    this.compositeProgram = null;
    this.meterProgram = null;
    this.sceneFramebuffer = null;
    this.sceneTexture = null;
    this.bloomLocations = { uScene: null, uRes: null, uThreshold: null, uBlurRadius: null, uHorizontal: null };
    this.compositeLocations = { uScene: null, uBloom: null, uIntensity: null, uDim: null };
    this.meterLocations = { uScene: null, uBloom: null, uIntensity: null };
    this.bloomEnabled = this.settings.bloom;
    this.bloomSize = null;
  }

  /** Compile and link. Returns false when this device cannot do WebGL2 at all. */
  init(): boolean {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    this.gl = gl;

    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.available = false;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.available = this.#build();
    });

    this.available = this.#build();
    return this.available;
  }

  #build(): boolean {
    const gl = this.gl;
    if (!gl) return false;

    const program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return false;
    this.program = program;
    this.locations = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) this.locations[name] = gl.getUniformLocation(program, name);

    this.bloomProgram = link(gl, BLOOM_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER);
    if (!this.bloomProgram) return false;
    this.bloomLocations = {
      uScene: gl.getUniformLocation(this.bloomProgram, 'uScene'),
      uRes: gl.getUniformLocation(this.bloomProgram, 'uRes'),
      uThreshold: gl.getUniformLocation(this.bloomProgram, 'uThreshold'),
      uBlurRadius: gl.getUniformLocation(this.bloomProgram, 'uBlurRadius'),
      uHorizontal: gl.getUniformLocation(this.bloomProgram, 'uHorizontal'),
    };

    this.compositeProgram = link(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);
    if (!this.compositeProgram) return false;
    this.compositeLocations = {
      uScene: gl.getUniformLocation(this.compositeProgram, 'uScene'),
      uBloom: gl.getUniformLocation(this.compositeProgram, 'uBloom'),
      uIntensity: gl.getUniformLocation(this.compositeProgram, 'uIntensity'),
      uDim: gl.getUniformLocation(this.compositeProgram, 'uDim'),
    };

    // The meter reuses the composite's own maths, so what it reports is what
    // went to the screen. A separate program that tone mapped slightly
    // differently would make the number a decoration.
    this.meterProgram = link(gl, BLOOM_VERTEX_SHADER, METER_FRAGMENT_SHADER);
    if (!this.meterProgram) return false;
    this.meterLocations = {
      uScene: gl.getUniformLocation(this.meterProgram, 'uScene'),
      uBloom: gl.getUniformLocation(this.meterProgram, 'uBloom'),
      uIntensity: gl.getUniformLocation(this.meterProgram, 'uIntensity'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    if (!this.#buildScopeTexture()) return false;
    if (!this.#buildMeter()) return false;
    this.resize(true);
    return true;
  }

  // --- the scope's texture --------------------------------------------------

  #buildScopeTexture(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    if (this.scopeTexture) gl.deleteTexture(this.scopeTexture);
    const texture = gl.createTexture();
    if (!texture) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Clamp in x (the shader wraps by hand, and a wrap here would need
    // power-of-two) and clamp in y so the two rows cannot bleed into each other.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.scopeTexture = texture;
    this.scopeFloatOk = true;
    // Probe once, at build time, rather than per frame: R32F is a valid WebGL2
    // sized format, but a driver is free to refuse the upload, and finding that
    // out on the first frame means the picture is a black rectangle for exactly
    // as long as it takes somebody to open the console.
    this.#uploadScope();
    if (gl.getError() !== gl.NO_ERROR) {
      this.scopeFloatOk = false;
      this.#uploadScope();
      if (gl.getError() !== gl.NO_ERROR) {
        console.warn('[renderer] the scope texture would not upload; the trace will be flat');
        return false;
      }
    }
    return true;
  }

  /** Write this frame's waveform and spectrum into the scope texture. */
  #uploadScope(scope?: ScopeFrame | null): void {
    const gl = this.gl;
    const texture = this.scopeTexture;
    if (!gl || !texture) return;
    const wave = scope?.wave;
    const spectrum = scope?.spectrum;
    this.scopeBins = wave && spectrum && wave.length === SCOPE_BINS ? SCOPE_BINS : 0;

    if (this.scopeFloatOk) {
      const out = this.scopeFloats;
      out.fill(0);
      if (wave) for (let i = 0; i < SCOPE_BINS; i++) out[i] = wave[i] ?? 0;
      if (spectrum) for (let i = 0; i < SCOPE_BINS; i++) out[SCOPE_BINS + i] = spectrum[i] ?? 0;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, SCOPE_BINS, 2, 0, gl.RED, gl.FLOAT, out);
      return;
    }

    // The 8-bit fallback. The wave is signed, so it is stored biased and the
    // shader undoes that with uScopeSigned; the spectrum is already 0..1.
    const out = this.scopeBytes;
    out.fill(0);
    if (wave) {
      for (let i = 0; i < SCOPE_BINS; i++) {
        out[i] = Math.round(clamp01((wave[i] ?? 0) * 0.5 + 0.5) * 255);
      }
    }
    if (spectrum) {
      for (let i = 0; i < SCOPE_BINS; i++) {
        out[SCOPE_BINS + i] = Math.round(clamp01(spectrum[i] ?? 0) * 255);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SCOPE_BINS, 2, 0, gl.RED, gl.UNSIGNED_BYTE, out);
  }

  #linearPalette(palette: Palette): void {
    if (this.linearPalette === palette) return;
    toLinear(palette.void, this.linear.void);
    toLinear(palette.deep, this.linear.deep);
    toLinear(palette.mid, this.linear.mid);
    toLinear(palette.hot, this.linear.hot);
    toLinear(palette.accent, this.linear.accent);
    this.linearPalette = palette;
  }

  // --- the frame-mean meter -------------------------------------------------

  #buildMeter(): boolean {
    const gl = this.gl;
    if (!gl) return false;
    if (this.meterFramebuffer) gl.deleteFramebuffer(this.meterFramebuffer);
    if (this.meterTexture) gl.deleteTexture(this.meterTexture);
    const texture = gl.createTexture();
    if (!texture) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Deliberately 8-bit and unfiltered. readPixels off a float target has to
    // agree with the driver about which float type to hand back, and asking
    // wrongly leaves an INVALID_OPERATION that no amount of retrying fixes; off
    // an RGBA8 target there is exactly one answer and it works everywhere.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, METER_SIZE, METER_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.meterTexture = texture;
    this.meterFramebuffer = framebuffer;
    return true;
  }

  #readMean(): void {
    const gl = this.gl;
    if (!gl || !this.meterFramebuffer || !this.meterProgram || !this.sceneTexture) return;
    const intensity = this.bloomEnabled ? this.bloomIntensity : 0;
    const bloom = this.bloomEnabled ? this.bloomTextureB : this.sceneTexture;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.meterFramebuffer);
    gl.viewport(0, 0, METER_SIZE, METER_SIZE);
    gl.useProgram(this.meterProgram);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.uniform1i(this.meterLocations.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloom);
    gl.uniform1i(this.meterLocations.uBloom, 1);
    gl.uniform1f(this.meterLocations.uIntensity, intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.readPixels(0, 0, METER_SIZE, METER_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, this.meterPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Rec.709 weights, because this is a luminance and the alternative weights
    // are a leftover from a time when televisions were wrong.
    let sum = 0;
    const pixels = this.meterPixels;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += (pixels[i] as number) * 0.2126 + (pixels[i + 1] as number) * 0.7152 + (pixels[i + 2] as number) * 0.0722;
    }
    const mean = sum / (METER_SIZE * METER_SIZE * 255);
    // Smoothed: this is a diagnostic, and a diagnostic that flickers between
    // "black" and "lit" six times a second is worse than no diagnostic.
    this.mean = this.mean * 0.7 + mean * 0.3;
  }

  /** Call once per frame with the arrangement and the sound. */
  render(frame: FrameInput): void {
    if (!this.available) return;
    const gl = this.gl;
    if (!gl) return;
    const now = frame.time ?? 0;
    const over = frame.overrides ?? {};
    // A pinned frame is not a frame. `now` is a moment somebody chose, so the
    // difference between it and the last one says nothing about how long a frame
    // takes, and folding it into the average is how a capture's own bookkeeping
    // ends up walking the adaptive quality *while the captures are being taken*
    // — the noise field changes under a pinned picture, and "draw this moment
    // twice and get the same pixels" quietly stops being true. A pinned draw
    // therefore reports a frame but does not time one and does not adapt.
    const pinned = over.time !== undefined;
    if (!pinned) {
      const dt = Math.max(1e-4, now - this.lastFrame);
      this.lastFrame = now;
      this.frameAvg = this.frameAvg * 0.9 + dt * 0.1;
    }
    this.frames++;

    this.dim = frame.dim ?? 1;
    this.resize();
    if (this.quality === 'auto' && !pinned && this.frames % 20 === 0) this.#adapt();

    const state = frame.state;
    const mix = state.section.visualMix;
    const layers: [number, number, number, number] = [
      over.layers?.[0] ?? mix.scope,
      over.layers?.[1] ?? mix.colour,
      over.layers?.[2] ?? mix.vhs,
      over.layers?.[3] ?? mix.glitch,
    ];
    this.lastMix = layers;

    // The sound. Uploaded first so a driver that rejects it says so before the
    // picture is drawn, and so the trace this frame is drawn from is this
    // frame's signal rather than the last one's.
    this.#uploadScope(frame.scope);
    this.trigger = findTrigger(frame.scope?.wave);

    const set = this.locations;
    const drift = over.drift ? { x: 0, y: 0, speed: 0 } : state.drift;
    const levels = state.levels;
    const scope = frame.scope;
    this.#linearPalette(state.palette);

    // Pass 1: the scene, into an HDR texture so the trace has somewhere above
    // 1.0 to bloom from.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(set.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(set.uTime, now);
    gl.uniform1f(set.uSeed, this.seedValue);
    gl.uniform3fv(set.uVoid, this.linear.void);
    gl.uniform3fv(set.uDeep, this.linear.deep);
    gl.uniform3fv(set.uMid, this.linear.mid);
    gl.uniform3fv(set.uHot, this.linear.hot);
    gl.uniform3fv(set.uAccent, this.linear.accent);
    gl.uniform4f(set.uMix, layers[0], layers[1], layers[2], layers[3]);
    gl.uniform4f(set.uLevels, levels.kick, levels.bass, levels.hat, levels.stab);
    gl.uniform1f(set.uPulse, clamp01(over.pulse ?? state.pulse));
    gl.uniform3f(set.uDrift, drift.x, drift.y, drift.speed);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scopeTexture);
    gl.uniform1i(set.uScope, 0);
    gl.uniform1f(set.uScopeBins, SCOPE_BINS);
    gl.uniform1f(set.uScopePeak, scope ? clamp01(scope.peak) : 0);
    gl.uniform1f(set.uScopeRms, scope ? clamp01(scope.rms) : 0);
    gl.uniform1f(set.uScopeSigned, this.scopeFloatOk ? 0 : 1);
    gl.uniform1f(set.uTrigger, this.trigger);
    // The write head crosses once a bar, so the persistence is in time with the
    // music rather than in time with the display.
    gl.uniform1f(set.uSweep, state.grid.barPhase);
    gl.uniform1f(set.uScopeGain, over.scopeGain ?? 1);

    gl.uniform1f(set.uOctaves, this.octaves);
    // Exposure follows how loud the set actually is, so a breakdown sits back
    // and a drop opens up. It is the one number the picture takes from the
    // master, and it is a slow one: the loudness it reads is smoothed.
    gl.uniform1f(set.uExposure, 0.95 + 0.5 * clamp01(levels.brightness));
    gl.uniform1f(set.uScanLines, this.settings.scanLines);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Passes 2 and 3: the bright-pass blur, horizontally into A and then
    // vertically into B. Two targets, not one: the second pass samples the
    // texture the first wrote, and sampling the texture you are drawing into is
    // a feedback loop.
    if (this.bloomEnabled) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.bloomProgram);
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.uniform2f(this.bloomLocations.uRes, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.bloomLocations.uThreshold, this.bloomThreshold);
      gl.uniform1f(this.bloomLocations.uBlurRadius, this.bloomBlurRadius);
      gl.uniform1i(this.bloomLocations.uScene, 0);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferA);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
      gl.uniform1i(this.bloomLocations.uHorizontal, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferB);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);
      gl.uniform1i(this.bloomLocations.uHorizontal, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Pass 4: composite, tone map, and apply the sleep fade.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.compositeProgram);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.uniform1i(this.compositeLocations.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomEnabled ? this.bloomTextureB : this.sceneTexture);
    gl.uniform1i(this.compositeLocations.uBloom, 1);
    gl.uniform1f(this.compositeLocations.uIntensity, this.bloomEnabled ? this.bloomIntensity : 0);
    gl.uniform1f(this.compositeLocations.uDim, this.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.frames % METER_EVERY === 0) this.#readMean();
  }

  #ensureFramebuffers(): void {
    const gl = this.gl;
    if (!gl) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (
      this.sceneFramebuffer && this.sceneTexture && this.bloomSize &&
      this.bloomSize[0] === width && this.bloomSize[1] === height
    ) return;

    // Rendering to a float texture needs EXT_color_buffer_float, and plenty of
    // devices — software rasterisers above all — do not have it. WebGL2 lets you
    // *create* an RGBA16F texture everywhere; what it will not let you do is
    // *draw into* one, and the failure shows up as an incomplete framebuffer
    // and a black canvas rather than as an exception anyone can catch. So ask.
    const float = gl.getExtension('EXT_color_buffer_float') !== null;
    if (this.#buildTargets(width, height, float)) return;
    if (float && this.#buildTargets(width, height, false)) {
      console.warn('[renderer] no float render targets; drawing in 8 bits, the glow will be tighter');
      return;
    }
    console.warn('[renderer] could not make a render target; bloom off');
    this.bloomEnabled = false;
    this.bloomSize = [width, height];
  }

  /** Build the three render targets. Returns false and leaves nothing behind if
   *  the driver will not render into them at the given precision. */
  #buildTargets(width: number, height: number, float: boolean): boolean {
    const gl = this.gl;
    if (!gl) return false;
    this.#deleteTargets();
    this.hdr = float;

    const attach = (texture: WebGLTexture): WebGLFramebuffer | null => {
      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(framebuffer);
        return null;
      }
      return framebuffer;
    };

    this.sceneTexture = createTarget(gl, width, height, float);
    this.sceneFramebuffer = attach(this.sceneTexture);
    if (!this.sceneFramebuffer) {
      this.#deleteTargets();
      return false;
    }
    this.bloomTextureA = createTarget(gl, width, height, float);
    this.bloomFramebufferA = attach(this.bloomTextureA);
    this.bloomTextureB = createTarget(gl, width, height, float);
    this.bloomFramebufferB = attach(this.bloomTextureB);
    if (!this.bloomFramebufferA || !this.bloomFramebufferB) {
      this.#deleteTargets();
      return false;
    }
    this.bloomSize = [width, height];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  #deleteTargets(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.sceneFramebuffer) gl.deleteFramebuffer(this.sceneFramebuffer);
    if (this.bloomFramebufferA) gl.deleteFramebuffer(this.bloomFramebufferA);
    if (this.bloomFramebufferB) gl.deleteFramebuffer(this.bloomFramebufferB);
    if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);
    if (this.bloomTextureA) gl.deleteTexture(this.bloomTextureA);
    if (this.bloomTextureB) gl.deleteTexture(this.bloomTextureB);
    this.sceneFramebuffer = null;
    this.bloomFramebufferA = null;
    this.bloomFramebufferB = null;
    this.sceneTexture = null;
    this.bloomTextureA = null;
    this.bloomTextureB = null;
    this.bloomSize = null;
  }

  /** Size the drawing buffer: device pixels, times the resolution scale. */
  resize(force = false): void {
    const canvas = this.canvas;
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const cssW = canvas.clientWidth || globalThis.innerWidth || 1280;
    const cssH = canvas.clientHeight || globalThis.innerHeight || 720;
    const width = Math.max(2, Math.round(cssW * dpr * this.scale));
    const height = Math.max(2, Math.round(cssH * dpr * this.scale));
    if (force || canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      // The bloom targets are the size of the scene target, so they are rebuilt
      // whenever that changes — and never before it, or the first frame would
      // draw into a texture the size of the canvas's default 300x150.
      this.#ensureFramebuffers();
    }
  }

  /** Move resolution first, then the noise depth, to hold the frame rate. */
  #adapt(): void {
    const target = 1 / 60;
    if (this.frameAvg > target * 1.35) {
      if (this.scale > this.minScale) this.scale = Math.max(this.minScale, this.scale * 0.9);
      else if (this.octaves > this.minOctaves) this.octaves = Math.max(this.minOctaves, this.octaves - 1);
    } else if (this.frameAvg < target * 0.72) {
      if (this.octaves < this.maxOctaves) this.octaves = Math.min(this.maxOctaves, this.octaves + 1);
      else if (this.scale < this.settings.scale) this.scale = Math.min(this.settings.scale, this.scale * 1.04);
    }
  }

  /** Quality is a user choice; 'auto' lets the renderer keep moving. */
  setQuality(quality: Quality): void {
    this.quality = quality;
    this.settings = visualSettings(this.profile, quality);
    this.scale = this.settings.scale;
    this.octaves = this.settings.octaves;
    this.minScale = Math.min(0.3, this.settings.scale);
    this.maxOctaves = Math.max(this.settings.octaves, 5);
    this.bloomEnabled = this.settings.bloom;
    if (this.available) this.resize(true);
  }

  /** The flash cap is the conductor's, but the renderer is told which mode is in
   *  force so its stats can report what is actually being drawn. */
  setFlashMode(mode: FlashMode): void {
    this.flashMode = mode;
  }

  /** Audio-only mode: no GPU work at all (spec §6). The context stays alive so
   *  coming back is instant. */
  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none';
    if (!visible) {
      // Drop the drawing buffer to nothing so nothing is kept alive for it.
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.bloomSize = null;
    } else if (this.available) {
      this.resize(true);
    }
  }

  stats(): RenderStats {
    return {
      available: this.available,
      scale: Number(this.scale.toFixed(3)),
      octaves: this.octaves,
      width: this.canvas.width,
      height: this.canvas.height,
      mean: Number(this.mean.toFixed(4)),
      layers: [
        Number(this.lastMix[0].toFixed(3)),
        Number(this.lastMix[1].toFixed(3)),
        Number(this.lastMix[2].toFixed(3)),
        Number(this.lastMix[3].toFixed(3)),
      ],
      fps: Math.round(1 / this.frameAvg),
      quality: this.quality,
      flashMode: this.flashMode,
      hdr: this.hdr,
      scopeBins: this.scopeBins,
    };
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * One sRGB channel to linear.
 *
 * The palette is stored the way it was measured — as the bytes that came off the
 * reference video — but the pipeline is linear-light with the gamma applied once
 * at the very end, in the composite. Handing 0x24 straight to the shader would
 * therefore apply the transfer function twice, which on a palette this dark is
 * not a small error: #242449 would arrive as a mid grey instead of a very dark
 * blue, and the frame that is meant to be two-thirds black would not be.
 */
function channel(v: number): number {
  const c = clamp01(v / 255);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toLinear(rgb: RGB, out: Float32Array): Float32Array {
  out[0] = channel(rgb.r);
  out[1] = channel(rgb.g);
  out[2] = channel(rgb.b);
  return out;
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number, float: boolean): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('[renderer] could not create a render target texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    float ? gl.RGBA16F : gl.RGBA8,
    width, height, 0,
    gl.RGBA,
    float ? gl.FLOAT : gl.UNSIGNED_BYTE,
    null,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  try {
    const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('could not create a program');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`program link failed: ${log}`);
    }
    return program;
  } catch (error) {
    console.error('[renderer]', error);
    return null;
  }
}
