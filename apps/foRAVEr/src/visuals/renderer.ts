// The renderer: one full-screen triangle, one fragment shader, and a resolution
// that moves to hold the frame rate (spec §3: "render at a scaled internal
// resolution with dynamic resolution scaling to hold the frame rate, then
// upscale; the iteration count is the quality knob").
//
// The canvas is sized in device pixels at `scale`; CSS stretches it to the
// viewport, which is the upscale. Bloom is a two-pass pipeline — scene →
// offscreen HDR texture → separable Gaussian blur (bright-pass) → additive
// composite — because a kaleidoscope without glow is a kaleidoscope diagram.
//
// Where Singularity has a camera that drifts through a volume, this one has no
// camera at all: a full-screen picture of layers has nowhere to fly to, and the
// drift *is* the camera.

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.ts';
import {
  BLOOM_VERTEX_SHADER,
  BLOOM_FRAGMENT_SHADER,
  COMPOSITE_VERTEX_SHADER,
  COMPOSITE_FRAGMENT_SHADER,
} from './bloom.ts';
import { visualSettings } from '../profile.ts';
import { hashString } from '@fractal-rave/shared';
import type {
  FlashMode,
  Profile,
  Quality,
  RenderStats,
  Seed,
  VisualSettings,
  FoRaverConductorState,
} from '../types.ts';

const UNIFORMS = [
  'uRes', 'uTime', 'uSeed',
  'uDeep', 'uMid', 'uHot', 'uAccent',
  'uMix', 'uLevels', 'uPulse',
  'uSpin', 'uWarp', 'uZoom', 'uBreathe', 'uHue', 'uGlow',
  'uSymmetry', 'uIterations', 'uOctaves', 'uExposure', 'uDim',
] as const;

type UniformName = (typeof UNIFORMS)[number];

/** One frame's worth of input: the clock and the state both halves share. */
export interface FrameInput {
  time: number;
  state: FoRaverConductorState;
  /** How bright the picture is (the sleep timer fades it out). */
  dim?: number;
  /** Uniforms a capture needs to hold still; the app never sets this. */
  overrides?: FrameOverrides;
}

/**
 * Uniforms a diagnostic draw can force, for the picture's equivalent of
 * rendering the engine offline: the *real* shader, with one thing held still.
 * Holding the layers still is what makes two captures differ only in the layer
 * under test — everything else, including the tone map, is identical.
 */
export interface FrameOverrides {
  /** Layer weights, `kaleido plasma fractal noise`. Omitted entries stay put. */
  layers?: Partial<{ kaleido: number; plasma: number; fractal: number; noise: number }>;
  /** Force the flash, for a capture with and without one. */
  pulse?: number;
  /** Force the fractal's iteration count, to capture a cheap and an expensive
   *  version of the same moment. */
  iterations?: number;
  /** Force the kaleidoscope's segment count. */
  symmetry?: number;
  /** Freeze the slow drift, so two captures differ only in what was asked for. */
  drift?: boolean;
}

/**
 * What a diagnostic `draw()` may hold still. Everything else comes from the
 * conductor, exactly as the app asks for it: the same shader, the same state,
 * with a few numbers chosen instead of measured.
 */
export type DrawOptions = FrameOverrides & {
  /**
   * A moment in the set, in seconds. Given one, the picture is pinned there
   * (the frame loop redraws that same moment) so a capture cannot race it.
   */
  time?: number;
  /** How bright the picture is (the sleep fade). 1 by default. */
  dim?: number;
};

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
  private iterations: number;
  private minIterations: number;
  private maxIterations: number;
  private available: boolean;
  private frames: number;
  private frameAvg: number;
  private lastFrame: number;
  private dim: number;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private locations: Record<UniformName, WebGLUniformLocation | null>;

  // Bloom resources.
  private bloomProgram: WebGLProgram | null;
  private compositeProgram: WebGLProgram | null;
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
  private bloomEnabled: boolean;
  private bloomThreshold = 0.62;
  private bloomIntensity = 0.85;
  private bloomBlurRadius = 6.5;
  /** The last frame's layer weights, kept so `stats()` reports the picture
   *  rather than the settings. */
  private lastMix: [number, number, number, number] = [0, 0, 0, 0];

  constructor(canvas: HTMLCanvasElement, { profile, quality = 'auto', seed = 'seed' }: RendererOptions) {
    this.canvas = canvas;
    this.profile = profile;
    this.quality = quality;
    this.seedValue = hashString(String(seed)) % 4096;
    this.settings = visualSettings(profile, quality);
    this.scale = this.settings.scale;
    this.minScale = Math.min(0.25, this.settings.scale);
    this.iterations = this.settings.iterations;
    this.minIterations = 24;
    this.maxIterations = Math.max(this.settings.iterations, 120);
    this.available = false;
    this.frames = 0;
    this.frameAvg = 1 / 60;
    this.lastFrame = 0;
    this.dim = 1;
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.locations = {} as Record<UniformName, WebGLUniformLocation | null>;

    this.bloomProgram = null;
    this.compositeProgram = null;
    this.sceneFramebuffer = null;
    this.sceneTexture = null;
    this.bloomFramebufferA = null;
    this.bloomFramebufferB = null;
    this.bloomTextureA = null;
    this.bloomTextureB = null;
    this.bloomLocations = { uScene: null, uRes: null, uThreshold: null, uBlurRadius: null, uHorizontal: null };
    this.compositeLocations = { uScene: null, uBloom: null, uIntensity: null, uDim: null };
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

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.resize(true);
    return true;
  }

  /** Call once per frame with the conductor state. */
  render(frame: FrameInput): void {
    if (!this.available) return;
    const gl = this.gl;
    if (!gl) return;
    const now = frame.time ?? 0;
    const dt = Math.max(1e-4, now - this.lastFrame);
    this.lastFrame = now;
    this.frameAvg = this.frameAvg * 0.9 + dt * 0.1;
    this.frames++;

    this.dim = frame.dim ?? 1;
    this.resize();
    if (this.quality === 'auto' && this.frames % 20 === 0) this.#adapt();

    const state = frame.state;
    const over = frame.overrides ?? {};
    const mix = state.section.visualMix;
    const layers: [number, number, number, number] = [
      over.layers?.kaleido ?? mix.kaleido,
      over.layers?.plasma ?? mix.plasma,
      over.layers?.fractal ?? mix.fractal,
      over.layers?.noise ?? mix.noise,
    ];
    const set = this.locations;
    const drift = over.drift ? ZERO_DRIFT : state.drift;
    const levels = state.levels;
    this.lastMix = layers;

    // Pass 1: the scene, into an HDR texture so the bright parts have somewhere
    // above 1.0 to bloom from.
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
    gl.uniform3fv(set.uDeep, state.palette.deep);
    gl.uniform3fv(set.uMid, state.palette.mid);
    gl.uniform3fv(set.uHot, state.palette.hot);
    gl.uniform3fv(set.uAccent, state.palette.accent);
    gl.uniform4f(set.uMix, layers[0], layers[1], layers[2], layers[3]);
    gl.uniform4f(set.uLevels, levels.kick, levels.bass, levels.hat, levels.stab);
    gl.uniform1f(set.uPulse, clamp01(over.pulse ?? state.pulse));
    gl.uniform1f(set.uSpin, drift.spin);
    gl.uniform1f(set.uWarp, drift.warp);
    gl.uniform1f(set.uZoom, drift.zoom);
    gl.uniform1f(set.uBreathe, drift.breathe);
    gl.uniform1f(set.uHue, drift.hue);
    gl.uniform1f(set.uGlow, drift.glow);
    gl.uniform1f(set.uSymmetry, Math.max(2, Math.round(over.symmetry ?? this.settings.symmetry)));
    gl.uniform1f(set.uIterations, Math.max(8, Math.round(over.iterations ?? this.iterations)));
    gl.uniform1f(set.uOctaves, this.settings.octaves);
    // Exposure follows how loud the set actually is, so a breakdown sits back
    // and a drop opens up. It is the one number the picture takes from the
    // master, and it is a slow one: the loudness it reads is smoothed.
    gl.uniform1f(set.uExposure, 1.05 + 0.6 * clamp01(levels.brightness));
    gl.uniform1f(set.uDim, 1);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2 and 3: the bright-pass blur, horizontally into A and then vertically
    // into B. Two targets, not one: the second pass samples the texture the first
    // wrote, and sampling the texture you are drawing into is a feedback loop.
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
    gl.uniform1f(this.compositeLocations.uIntensity, this.bloomEnabled ? this.bloomIntensity * drift.glow : 0);
    gl.uniform1f(this.compositeLocations.uDim, this.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    // *draw into* one, and the failure shows up as an incomplete framebuffer and
    // a black canvas rather than as an exception anyone can catch. So ask.
    const float = gl.getExtension('EXT_color_buffer_float') !== null;
    if (this.#buildTargets(width, height, float)) return;
    if (float && this.#buildTargets(width, height, false)) {
      console.warn('[renderer] no float render targets; drawing in 8 bits, bloom will be tighter');
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

  /** Move resolution first, then the iteration count, to hold the frame rate. */
  #adapt(): void {
    const target = 1 / 60;
    if (this.frameAvg > target * 1.35) {
      if (this.scale > this.minScale) this.scale = Math.max(this.minScale, this.scale * 0.9);
      else if (this.iterations > this.minIterations) this.iterations = Math.max(this.minIterations, this.iterations * 0.85);
    } else if (this.frameAvg < target * 0.72) {
      if (this.iterations < this.maxIterations) this.iterations = Math.min(this.maxIterations, this.iterations * 1.06);
      else if (this.scale < this.settings.scale) this.scale = Math.min(this.settings.scale, this.scale * 1.04);
    }
    this.iterations = Math.round(this.iterations);
  }

  /** Quality is a user choice; 'auto' lets the renderer keep moving. */
  setQuality(quality: Quality): void {
    this.quality = quality;
    this.settings = visualSettings(this.profile, quality);
    this.scale = this.settings.scale;
    this.iterations = this.settings.iterations;
    this.minScale = Math.min(0.25, this.settings.scale);
    this.maxIterations = Math.max(this.settings.iterations, 120);
    this.bloomEnabled = this.settings.bloom;
    if (this.available) this.resize(true);
  }

  /** The flash cap is the conductor's, but the renderer is told which mode is in
   *  force so its stats can report what is actually being drawn. */
  setFlashMode(mode: FlashMode): void {
    this.flashMode = mode;
  }

  /** Audio-only mode: no GPU work at all (spec §6 "audio-only mode draws no
   *  GPU"). The context stays alive so coming back is instant. */
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
      iterations: this.iterations,
      fps: Math.round(1 / this.frameAvg),
      layers: [
        Number(this.lastMix[0].toFixed(3)),
        Number(this.lastMix[1].toFixed(3)),
        Number(this.lastMix[2].toFixed(3)),
        Number(this.lastMix[3].toFixed(3)),
      ],
      quality: this.quality,
      flashMode: this.flashMode,
      hdr: this.hdr,
    };
  }
}

const ZERO_DRIFT = { spin: 0, warp: 0, zoom: 0, breathe: 1, hue: 0, glow: 0 };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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
