// Aurora visual renderer: aurora curtains, starfield, glow, particles.

import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders.ts';
import { BLOOM_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER, COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER } from './bloom.ts';
import { visualSettings } from '../profile.ts';
import { hashString } from '@fractal-rave/shared';
import type {
  Profile,
  Quality,
  RenderStats,
  Seed,
  VisualSettings,
  AuroraConductorState,
  AuroraSectionVisuals,
} from '../types.ts';

export interface FrameInput {
  time: number;
  state: AuroraConductorState;
  dim?: number;
  overrides?: DrawOptions;
}

export interface DrawOptions {
  time?: number;
  layers?: [number, number, number, number];
  pulse?: number;
  drift?: boolean;
  dim?: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private bloomProgram!: WebGLProgram;
  private compositeProgram!: WebGLProgram;
  private vertexBuffer!: WebGLBuffer;
  private sceneTexture!: WebGLTexture;
  private sceneFramebuffer!: WebGLFramebuffer;
  private bloomTexture!: WebGLTexture;
  private bloomFramebuffer!: WebGLFramebuffer;
  private hdrSupported = false;
  private scale = 1;
  private steps = 64;
  private volumetric = true;
  private stars = 2;
  private symmetry = 6;
  private quality: Quality = 'auto';
  private profile: Profile;
  private readonly seedHash: number;
  private lastTime = 0;
  private frameTimes: number[] = [];
  private fps = 60;

  constructor(canvas: HTMLCanvasElement, opts: { profile: Profile; seed: Seed; quality: Quality }) {
    this.canvas = canvas;
    this.profile = opts.profile;
    this.seedHash = hashString(String(opts.seed));
    this.quality = opts.quality;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    this.hdrSupported = gl.getExtension('EXT_color_buffer_float') !== null;
    if (!this.hdrSupported) console.warn('EXT_color_buffer_float not supported, falling back to RGBA8');

    this.setupShaders();
    this.setupGeometry();
    this.resize();
    this.applyVisualSettings(visualSettings(this.profile, this.quality));
  }

  private setupShaders(): void {
    this.program = this.createProgram(VERTEX_SHADER, FRAGMENT_SHADER) as WebGLProgram;
    this.bloomProgram = this.createProgram(BLOOM_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER) as WebGLProgram;
    this.compositeProgram = this.createProgram(COMPOSITE_VERTEX_SHADER, COMPOSITE_FRAGMENT_SHADER) as WebGLProgram;

    if (!this.program || !this.bloomProgram || !this.compositeProgram) throw new Error('Shader compilation failed');
  }

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram | null {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vs));
      return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fs));
      return null;
    }

    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    // Every program's quad is this one buffer, fed through attribute 0: pinned
    // before linking, so no program can end up reading the wrong attribute.
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  private setupGeometry(): void {
    const gl = this.gl;
    this.vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quadVao = vao;
  }

  private quadVao!: WebGLVertexArrayObject;

  applyVisualSettings(s: VisualSettings): void {
    // The shared VisualSettings is index-signature typed (number | boolean);
    // aurora's settings carry steps/volumetric/stars, so the reads are narrowed
    // explicitly here.
    this.scale = s.scale as number;
    this.steps = (s.steps as number) ?? 64;
    this.volumetric = (s.volumetric as boolean) ?? true;
    this.stars = (s.stars as number) ?? 2;
    this.symmetry = (s.symmetry as number) ?? 6;
    this.resize();
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.applyVisualSettings(visualSettings(this.profile, q));
  }

  resize(): void {
    const gl = this.gl;
    const dpr = this.scale * globalThis.devicePixelRatio;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.createRenderTargets(w, h);
    }
    gl.viewport(0, 0, w, h);
  }

  private createRenderTargets(w: number, h: number): void {
    const gl = this.gl;

    if (this.sceneFramebuffer) gl.deleteFramebuffer(this.sceneFramebuffer);
    if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);
    if (this.bloomFramebuffer) gl.deleteFramebuffer(this.bloomFramebuffer);
    if (this.bloomTexture) gl.deleteTexture(this.bloomTexture);

    const fmt = this.hdrSupported ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdrSupported ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    this.sceneTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.sceneFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0);

    this.bloomTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.bloomFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bloomTexture, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(input: FrameInput): void {
    const gl = this.gl;
    const { time, state, dim = 1, overrides } = input;

    const section = (overrides?.layers ?? state.section.visualMix) as AuroraSectionVisuals;
    const pulse = overrides?.pulse ?? state.pulse;
    const driftFrozen = overrides?.drift ?? false;
    const dimFactor = overrides?.dim ?? dim;

    this.resize();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFramebuffer);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program!);
    this.bindUniforms(this.program!, state, section, pulse, driftFrozen, dimFactor, w, h);

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Bloom pass
    // Bloom pass: the scene is linear; blur it into the bloom target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFramebuffer);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.bloomProgram!);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.uniform1i(gl.getUniformLocation(this.bloomProgram!, 'uScene'), 0);
    gl.uniform2f(gl.getUniformLocation(this.bloomProgram!, 'uRes'), w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Composite to screen: scene + bloom, then the frame's one gamma encode.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.compositeProgram!);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram!, 'uScene'), 0);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram!, 'uBloom'), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);

    this.updateFps(time);
  }

  private bindUniforms(
    program: WebGLProgram,
    state: AuroraConductorState,
    section: AuroraSectionVisuals,
    pulse: number,
    driftFrozen: boolean,
    dim: number,
    w: number,
    h: number,
  ): void {
    const gl = this.gl;
    const u = (name: string) => gl.getUniformLocation(program, name);

    gl.uniform2f(u('uRes'), w, h);
    gl.uniform1f(u('uTime'), driftFrozen ? 0 : state.t);
    gl.uniform1f(u('uSeed'), this.seedHash);

    gl.uniform3fv(u('uDeep'), state.palette.deep);
    gl.uniform3fv(u('uMid'), state.palette.mid);
    gl.uniform3fv(u('uHot'), state.palette.hot);
    gl.uniform3fv(u('uAccent'), state.palette.accent);

    gl.uniform4f(u('uMix'), section.curtains, section.stars, section.glow, section.particles);
    gl.uniform3f(u('uLevels'), state.levels.kick, state.levels.bass, state.levels.pad);
    gl.uniform1f(u('uPulse'), pulse);

    gl.uniform1f(u('uSpin'), state.drift.spin);
    gl.uniform1f(u('uWarp'), state.drift.warp);
    gl.uniform1f(u('uZoom'), state.drift.zoom);
    gl.uniform1f(u('uBreathe'), state.drift.breathe);
    gl.uniform1f(u('uHue'), state.drift.hue);
    gl.uniform1f(u('uGlow'), state.drift.glow);

    gl.uniform1i(u('uSteps'), Math.round(this.steps));
    gl.uniform1i(u('uVolumetric'), this.volumetric ? 1 : 0);
    gl.uniform1i(u('uStars'), Math.round(this.stars));
    gl.uniform1i(u('uSymmetry'), Math.round(this.symmetry));
    gl.uniform1f(u('uExposure'), 1.2);
    gl.uniform1f(u('uDim'), dim);
  }

  private updateFps(time: number): void {
    const dt = time - this.lastTime;
    this.lastTime = time;
    if (dt > 0) {
      this.frameTimes.push(1 / dt);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
      this.fps = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    }
  }

  getStats(): RenderStats {
    return {
      available: true,
      scale: this.scale,
      steps: this.steps,
      fps: this.fps,
      layers: [0, 0, 0, 0],
      quality: this.quality,
      flashMode: 'soft',
      hdr: this.hdrSupported,
    };
  }
}