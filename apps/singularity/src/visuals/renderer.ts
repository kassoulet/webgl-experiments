// The renderer: one full-screen triangle, one fragment shader, and a resolution
// that moves to hold the frame rate (spec §3: "render at a scaled internal
// resolution with dynamic resolution scaling to hold the frame rate, then
// upscale; the raymarch step count is the quality knob").
//
// The canvas is sized in device pixels at `scale`; CSS stretches it to the
// viewport, which is the upscale. No second pass, no framebuffer.
//
// Bloom: a two-pass pipeline — scene → offscreen texture → separable
// Gaussian blur (bright-pass threshold) → additive composite to canvas.

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.ts';
import { BLOOM_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER } from './bloom.ts';
import { visualSettings } from '../profile.ts';
import { starTint } from '../palette.ts';
import { hashString } from '../rng.ts';
import type { Camera, ConductorState, Profile, Quality, RenderStats, Seed, VisualSettings } from '../types.ts';

const UNIFORMS = [
  'uRes', 'uTime', 'uCamPos', 'uYaw', 'uPitch',
  'uDeep', 'uMid', 'uHot', 'uCoolStar', 'uWarmStar',
  'uBrightness', 'uDensity', 'uWarp', 'uSteps', 'uVolumetric',
  'uStars', 'uDim', 'uExposure', 'uSeed', 'uFlare', 'uFlareLevel',
] as const;

type UniformName = (typeof UNIFORMS)[number];

/** One frame's worth of input: the clock, the shared state and the camera. */
export interface FrameInput {
  time: number;
  state: ConductorState;
  camera: Camera;
  /** How bright the picture is (the sleep timer fades it out). */
  dim?: number;
  /** Uniforms a capture needs to hold still or isolate; the app never sets this. */
  overrides?: FrameOverrides;
}

/**
 * Uniforms a diagnostic draw can force, for the picture's equivalent of
 * rendering the engine offline: the *real* shader, with one thing held still.
 * `stars` is the one that matters most — drawing the same moment with 1, 2, 3,
 * or 0 layers and subtracting the captures isolates each layer exactly, because
 * a star layer contributes additively and everything else is identical.
 */
export interface FrameOverrides {
  /** Star layers, 0–3. 0 is a starless sky, band included. */
  stars?: number;
  /** Nebula density. 0 leaves the sky empty but for the stars. */
  density?: number;
  /** Force the volumetric march on, or the 2D layered fallback off. */
  volumetric?: boolean;
  /** 0..1, over the brightness the audio asks for. */
  brightness?: number;
  /** Force the lit star's brightness, for a capture that compares with and
   *  without it. The direction still comes from the conductor's own event. */
  flare?: number;
}

export interface RendererOptions {
  profile: Profile;
  quality?: Quality;
  seed?: Seed;
}

/**
 * The two ends of the star temperature range, from the palette module so there
 * is one place that says what a star's colour is — and in linear light, which is
 * the space the shader's `mix` and tone mapping work in.
 */
const COOL_STAR = starTint(0);
const WARM_STAR = starTint(1);
/** What a lit star's direction defaults to when the conductor has no event:
 *  only the diagnostic `flare` override can ask for one then. */
const NO_FLARE = [0, 0, 1] as const;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly profile: Profile;
  quality: Quality;

  private readonly seedValue: number;
  private settings: VisualSettings;
  private scale: number;
  private minScale: number;
  private steps: number;
  private readonly minSteps: number;
  private maxSteps: number;
  private available: boolean;
  private frames: number;
  private frameAvg: number;
  private lastFrame: number;
  private dim: number;
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null;
  private vao: WebGLVertexArrayObject | null;
  private locations: Record<UniformName, WebGLUniformLocation | null>;

  // Bloom resources
  private bloomProgram: WebGLProgram | null;
  private compositeProgram: WebGLProgram | null;
  private sceneFramebuffer: WebGLFramebuffer | null;
  private sceneTexture: WebGLTexture | null;
  private bloomSize: [number, number] | null;
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
    uBloomRes: WebGLUniformLocation | null;
    uSceneRes: WebGLUniformLocation | null;
  };
  private bloomEnabled: boolean;
  private bloomThreshold: number;
  private bloomIntensity: number;
  private bloomBlurRadius: number;
  /** Bloom runs at a lower resolution: it is a low-frequency effect, and the
   *  separable blur is the cheapest way to keep it cheap. We double-buffer the
   *  two blur passes so neither reads the texture it is writing into. */
  private bloomFramebufferA: WebGLFramebuffer | null = null;
  private bloomTextureA: WebGLTexture | null = null;
  private bloomFramebufferB: WebGLFramebuffer | null = null;
  private bloomTextureB: WebGLTexture | null = null;
  private bloomFboSize: [number, number] | null = null;
  private bloomDownsampleProgram: WebGLProgram | null = null;
  private bloomDownsampleLocations: {
    uScene: WebGLUniformLocation | null;
    uRes: WebGLUniformLocation | null;
    uTargetRes: WebGLUniformLocation | null;
  } | null = null;
  private readonly bloomDownsampleVShader: string;
  private readonly bloomDownsampleFShader: string;

  constructor(canvas: HTMLCanvasElement, { profile, quality = 'auto', seed = 'seed' }: RendererOptions) {
    this.canvas = canvas;
    this.profile = profile;
    this.quality = quality;
    this.seedValue = hashString(String(seed)) % 4096;
    this.settings = visualSettings(profile, quality);
    this.scale = this.settings.scale;
    this.minScale = Math.min(0.2, this.settings.scale);
    this.steps = this.settings.steps;
    this.minSteps = 16;
    this.maxSteps = Math.max(this.settings.steps, 110);
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
    this.bloomTextureA = null;
    this.bloomFramebufferB = null;
    this.bloomTextureB = null;
    this.bloomLocations = {
      uScene: null,
      uRes: null,
      uThreshold: null,
      uBlurRadius: null,
      uHorizontal: null,
    };
    this.compositeLocations = {
      uScene: null,
      uBloom: null,
      uIntensity: null,
      uDim: null,
      uBloomRes: null,
      uSceneRes: null,
    };
    this.bloomEnabled = true;
    this.bloomThreshold = 0.65;
    this.bloomIntensity = 0.7;
    this.bloomBlurRadius = 6.0;
    this.bloomSize = null;
    this.bloomFboSize = null;

    // Reduced-resolution bloom: small full-screen shaders, compiled once.
    this.bloomDownsampleVShader = `#version 300 es\nout vec2 vUv;\nvoid main() {\n  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n  vUv = p;\n  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n}\n`;
    this.bloomDownsampleFShader = `#version 300 es\nprecision highp float;\n\nin vec2 vUv;\nout vec4 fragColor;\n\nuniform sampler2D uScene;\nuniform vec2 uRes;\nuniform vec2 uTargetRes;\n\nvoid main() {\n  // bilinear downsample from scene to bloom target\n  vec2 s = uRes;\n  vec2 t = uTargetRes;\n  vec2 f = vec2(0.5) / s;\n  vec2 uv = (vUv * t + vec2(0.5)) / s;\n  vec3 a = texture(uScene, uv - f).rgb;\n  vec3 b = texture(uScene, uv + vec2(f.x, -f.y)).rgb;\n  vec3 c = texture(uScene, uv + vec2(-f.x, f.y)).rgb;\n  vec3 d = texture(uScene, uv + f).rgb;\n  fragColor = vec4((a + b + c + d) * 0.25, 1.0);\n}\n`;
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

    gl.getExtension('EXT_color_buffer_float');

    // Main scene program
    const program = link(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    if (!program) return false;
    this.program = program;
    this.locations = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) this.locations[name] = gl.getUniformLocation(program, name);

    // Bloom programs (blur at bloom-target resolution)
    this.bloomProgram = link(gl, BLOOM_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER);
    if (!this.bloomProgram) return false;
    this.bloomLocations = {
      uScene: gl.getUniformLocation(this.bloomProgram, 'uScene'),
      uRes: gl.getUniformLocation(this.bloomProgram, 'uRes'),
      uThreshold: gl.getUniformLocation(this.bloomProgram, 'uThreshold'),
      uBlurRadius: gl.getUniformLocation(this.bloomProgram, 'uBlurRadius'),
      uHorizontal: gl.getUniformLocation(this.bloomProgram, 'uHorizontal'),
    };

    // Downsample for the reduced-resolution bloom path
    this.bloomDownsampleProgram = link(gl, this.bloomDownsampleVShader, this.bloomDownsampleFShader);
    if (!this.bloomDownsampleProgram) return false;
    this.bloomDownsampleLocations = {
      uScene: gl.getUniformLocation(this.bloomDownsampleProgram, 'uScene'),
      uRes: gl.getUniformLocation(this.bloomDownsampleProgram, 'uRes'),
      uTargetRes: gl.getUniformLocation(this.bloomDownsampleProgram, 'uTargetRes'),
    };

    this.compositeProgram = link(gl, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER);
    if (!this.compositeProgram) return false;
    this.compositeLocations = {
      uScene: gl.getUniformLocation(this.compositeProgram, 'uScene'),
      uBloom: gl.getUniformLocation(this.compositeProgram, 'uBloom'),
      uIntensity: gl.getUniformLocation(this.compositeProgram, 'uIntensity'),
      uDim: gl.getUniformLocation(this.compositeProgram, 'uDim'),
      uBloomRes: gl.getUniformLocation(this.compositeProgram, 'uBloomRes'),
      uSceneRes: gl.getUniformLocation(this.compositeProgram, 'uSceneRes'),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.useProgram(program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.resize(true);
    return true;
  }

  /** Call once per frame with the conductor state and camera. */
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

    const { state, camera } = frame;
    const set = this.locations;

    // Ensure bloom framebuffers match current size
    this.#ensureBloomFramebuffers();

    // Pass 1: Render scene to offscreen framebuffer
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
    gl.uniform3fv(set.uCamPos, camera.position);
    gl.uniform1f(set.uYaw, camera.yaw);
    gl.uniform1f(set.uPitch, camera.pitch);
    gl.uniform3fv(set.uDeep, state.palette.deep);
    gl.uniform3fv(set.uMid, state.palette.mid);
    gl.uniform3fv(set.uHot, state.palette.hot);
    gl.uniform3fv(set.uCoolStar, COOL_STAR);
    gl.uniform3fv(set.uWarmStar, WARM_STAR);

    const levels = state.levels;
    const brightness = clamp01(state.drift.brightness * 0.45 + levels.brightness * 0.4 + levels.pad * 0.15);
    const over = frame.overrides ?? {};
    gl.uniform1f(set.uBrightness, over.brightness ?? 0.35 + brightness * 0.9);
    gl.uniform1f(
      set.uDensity,
      over.density ?? Math.max(0.15, state.drift.density * (0.55 + levels.drone * 0.75)),
    );
    gl.uniform1f(set.uWarp, state.drift.warp);
    gl.uniform1f(set.uSteps, this.steps);
    gl.uniform1f(set.uVolumetric, (over.volumetric ?? this.settings.volumetric) ? 1 : 0);
    gl.uniform1f(set.uStars, over.stars ?? this.settings.stars);
    gl.uniform1f(set.uDim, 1.0); // dim applied in composite
    gl.uniform1f(set.uExposure, 1.15);
    gl.uniform1f(set.uSeed, this.seedValue);
    const flare = state.flare;
    gl.uniform3fv(set.uFlare, flare?.dir ?? NO_FLARE);
    gl.uniform1f(set.uFlareLevel, over.flare ?? flare?.level ?? 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);      // Pass 2-4: Bloom at reduced resolution (downsample → horizontal blur →
      // vertical blur, double-buffered), then composite with the bloom upsampled
      // inside the composite shader when its res differs from the scene's.
      if (this.bloomEnabled) {
        const bw = Math.max(32, Math.round(this.canvas.width * 0.5));
        const bh = Math.max(32, Math.round(this.canvas.height * 0.5));
        this.#ensureBloomTarget(bw, bh);

        // Downsample scene → bloom A.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferA);
        gl.viewport(0, 0, bw, bh);
        gl.useProgram(this.bloomDownsampleProgram);
        gl.bindVertexArray(this.vao);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
        gl.uniform1i(this.bloomDownsampleLocations!.uScene, 0);
        gl.uniform2f(this.bloomDownsampleLocations!.uRes, this.canvas.width, this.canvas.height);
        gl.uniform2f(this.bloomDownsampleLocations!.uTargetRes, bw, bh);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Horizontal blur: bloom A → bloom B.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferB);
        gl.viewport(0, 0, bw, bh);
        gl.useProgram(this.bloomProgram);
        gl.bindVertexArray(this.vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);
        gl.uniform1i(this.bloomLocations!.uScene, 0);
        gl.uniform2f(this.bloomLocations!.uRes, bw, bh);
        // Blur radius is in bloom-target pixels; scale it so the screen-space
        // blur stays the same as the previous full-res bloom.
        gl.uniform1f(this.bloomLocations!.uThreshold, this.bloomThreshold);
        gl.uniform1f(this.bloomLocations!.uBlurRadius, this.bloomBlurRadius * (bw / this.canvas.width));
        gl.uniform1i(this.bloomLocations!.uHorizontal, 1);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Vertical blur: bloom B → bloom A.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferA);
        gl.viewport(0, 0, bw, bh);
        gl.useProgram(this.bloomProgram);
        gl.bindVertexArray(this.vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureB);
        gl.uniform1i(this.bloomLocations!.uScene, 0);
        gl.uniform2f(this.bloomLocations!.uRes, bw, bh);
        gl.uniform1f(this.bloomLocations!.uThreshold, this.bloomThreshold);
        gl.uniform1f(this.bloomLocations!.uBlurRadius, this.bloomBlurRadius * (bw / this.canvas.width));
        gl.uniform1i(this.bloomLocations!.uHorizontal, 0);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Composite: scene (full res) + bloom A (upsampled inside the shader when
        // bloom res != scene res).
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.compositeProgram);
        gl.bindVertexArray(this.vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
        gl.uniform1i(this.compositeLocations!.uScene, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);
        gl.uniform1i(this.compositeLocations!.uBloom, 1);

        gl.uniform1f(this.compositeLocations!.uIntensity, this.bloomIntensity);
        gl.uniform1f(this.compositeLocations!.uDim, this.dim);
        gl.uniform2f(this.compositeLocations!.uBloomRes, bw, bh);
        gl.uniform2f(this.compositeLocations!.uSceneRes, this.canvas.width, this.canvas.height);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        // No bloom: just blit scene to canvas with tonemapping/vignette
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.useProgram(this.compositeProgram);
        gl.bindVertexArray(this.vao);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
        gl.uniform1i(this.compositeLocations!.uScene, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture); // dummy
        gl.uniform1i(this.compositeLocations!.uBloom, 1);

        gl.uniform1f(this.compositeLocations!.uIntensity, 0.0);
        gl.uniform1f(this.compositeLocations!.uDim, this.dim);
        gl.uniform2f(this.compositeLocations!.uBloomRes, this.canvas.width, this.canvas.height);
        gl.uniform2f(this.compositeLocations!.uSceneRes, this.canvas.width, this.canvas.height);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  #ensureBloomFramebuffers(): void {
    const gl = this.gl;
    if (!gl) return;

    const width = this.canvas.width;
    const height = this.canvas.height;

    if (this.sceneFramebuffer && this.sceneTexture && this.bloomSize &&
        this.bloomSize[0] === width && this.bloomSize[1] === height) {
      return; // already correct size
    }

    // Clean up old scene FBO only (bloom target is managed separately now).
    if (this.sceneFramebuffer) gl.deleteFramebuffer(this.sceneFramebuffer);
    if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);

    // Scene framebuffer (RGBA16F for HDR)
    this.sceneTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.sceneFramebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0);

    // Check scene completeness
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[renderer] scene framebuffer incomplete, disabling render');
      this.available = false;
    }

    this.bloomSize = [width, height];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Bloom target (reduced resolution) is created/updated on demand in #ensureBloomTarget.
  }

  /** Create or resize the reduced-resolution bloom FBO pair. Cheap: only touched
   *  when the scene size changes, not every frame. Two FBOs let the two blur
   *  passes ping-pong without a feedback loop. */
  #ensureBloomTarget(width: number, height: number): void {
    const gl = this.gl;
    if (!gl) return;

    if (this.bloomTextureA && this.bloomFboSize &&
        this.bloomFboSize[0] === width && this.bloomFboSize[1] === height) {
      return;
    }

    if (this.bloomTextureA) gl.deleteTexture(this.bloomTextureA);
    if (this.bloomFramebufferA) gl.deleteFramebuffer(this.bloomFramebufferA);
    if (this.bloomTextureB) gl.deleteTexture(this.bloomTextureB);
    if (this.bloomFramebufferB) gl.deleteFramebuffer(this.bloomFramebufferB);

    this.bloomTextureA = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.bloomFramebufferA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bloomTextureA, 0);

    this.bloomTextureB = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTextureB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.bloomFramebufferB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebufferB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bloomTextureB, 0);

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[renderer] bloom target framebuffer incomplete, disabling bloom');
      this.bloomEnabled = false;
    }

    this.bloomFboSize = [width, height];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
      // Framebuffers will be recreated on next render
    }
  }

  /** Move the quality knobs to hold the frame rate. Volumetric is the most
   *  expensive knob (raymarch), so it is the first one dropped when we are over
   *  budget and the first one restored only once we have headroom again. */
  #adapt(): void {
    const target = 1 / 60;
    if (this.frameAvg > target * 1.30) {
      // Over budget: drop the most expensive knob first.
      if (this.settings.volumetric && this.quality !== 'high') {
        this.settings = { ...this.settings, volumetric: false };
        this.#syncSettings();
      } else if (this.scale > this.minScale) {
        this.scale = Math.max(this.minScale, this.scale * 0.92);
      } else if (this.steps > this.minSteps) {
        this.steps = Math.max(this.minSteps, Math.round(this.steps * 0.92));
      }
    } else if (this.frameAvg < target * 0.78) {
      // Under budget: restore in the opposite order.
      if (!this.settings.volumetric && this.quality !== 'low') {
        this.settings = { ...this.settings, volumetric: true };
        this.#syncSettings();
      } else if (this.steps < this.maxSteps) {
        this.steps = Math.min(this.maxSteps, Math.round(this.steps * 1.06));
      } else if (this.scale < this.settings.scale) {
        this.scale = Math.min(this.settings.scale, this.scale * 1.03);
      }
    }
    this.steps = Math.round(this.steps);
  }

  /** Keep the live render knobs consistent with the current settings, without
   *  disturbing an explicit user quality choice. */
  #syncSettings(): void {
    this.scale = this.settings.scale;
    this.steps = this.settings.steps;
    this.minScale = Math.min(0.2, this.settings.scale);
    this.maxSteps = Math.max(this.settings.steps, 110);
    if (this.available) this.resize(true);
  }

  /** Quality is a user choice; 'auto' lets the renderer keep moving. */
  setQuality(quality: Quality): void {
    this.quality = quality;
    this.settings = visualSettings(this.profile, quality);
    this.scale = this.settings.scale;
    this.steps = this.settings.steps;
    this.minScale = Math.min(0.2, this.settings.scale);
    this.maxSteps = Math.max(this.settings.steps, 110);
    if (this.available) this.resize(true);
  }

  /** Audio-only mode: no GPU work at all (spec §6 "audio-only mode draws no
   *  GPU"). The context stays alive so coming back is instant. */
  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none';
    if (!visible) {
      // Drop the drawing buffer to nothing so nothing is kept alive for it.
      this.canvas.width = 1;
      this.canvas.height = 1;
    } else if (this.available) {
      this.resize(true);
    }
  }

  /** Toggle bloom on/off. */
  setBloom(enabled: boolean): void {
    this.bloomEnabled = enabled;
  }

  stats(): RenderStats {
    return {
      available: this.available,
      scale: Number(this.scale.toFixed(3)),
      steps: this.steps,
      fps: Math.round(1 / this.frameAvg),
      volumetric: this.settings.volumetric,
      quality: this.quality,
    };
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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

function link(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
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