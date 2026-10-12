// The shaders, as strings (spec §4). Embedded rather than fetched, for the same
// reasons the AudioWorklet source is: no extra request, no MIME or path to get
// wrong, nothing extra for the service worker to precache, and the picture works
// offline from any static host.
//
// Backticks inside a GLSL comment would terminate this template literal, so
// there are none.
//
// The picture is not FOraveR's kaleidoscope. It is a big oscilloscope, on black,
// wearing a video tape. Three things here are the difference:
//
//  1. The trace is *measured*. uScope is a 256x2 texture written every frame
//     from a real AnalyserNode on the master bus: row 0 is the waveform, row 1
//     the spectrum. Nothing in this file invents a shape and hopes it looks
//     like music. If the engine stops, the line goes flat, and that is the
//     correct picture for silence.
//  2. The scope *behaves like a scope*. It auto-ranges, so a breakdown is
//     magnified and a drop is not; it triggers on a rising zero crossing, so
//     the trace stands still instead of sliding sideways; and a write head
//     crosses the trace once a bar with the phosphor fading behind it. The
//     persistence is a function of mod(head - x, 1), so it is exact rather than
//     an accumulation buffer that would have to be cleared every frame.
//  3. The frame is mostly black. The reference video is 64.9% pure black with a
//     mean luma between 0.0 and 0.13, so the palette's dark stops are used as
//     written and nothing here is brightened "to be safe" — that is exactly how
//     a dark picture turns into a bright one.

export const VERTEX_SHADER = `#version 300 es
precision highp float;

// One full-screen triangle. No geometry, no buffers, no attributes: the vertex
// comes from gl_VertexID, so the draw call is one triangle and nothing else.
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uSeed;

uniform vec3  uVoid;
uniform vec3  uDeep;
uniform vec3  uMid;
uniform vec3  uHot;
uniform vec3  uAccent;

uniform vec4  uMix;          // scope, colour, vhs, glitch
uniform vec4  uLevels;       // kick, bass, hat, stab
uniform float uPulse;        // the flash budget, already capped by the conductor
uniform vec3  uDrift;        // x, y, speed

// The scope's data. Row 0 of the texture is the waveform, row 1 the spectrum.
uniform sampler2D uScope;
uniform float uScopeBins;
uniform float uScopePeak;    // 0..1, the waveform's peak this frame
uniform float uScopeRms;     // 0..1
uniform float uScopeSigned;  // 1.0 when the texture is 8-bit and the wave biased
uniform float uTrigger;      // bins to start the trace at, so it stands still
uniform float uSweep;        // 0..1 across the trace: the write head's position
uniform float uScopeGain;    // 1 in the app; a capture can hold the ranging still

uniform float uOctaves;
uniform float uExposure;
uniform float uScanLines;

const float TAU = 6.28318530718;
const float PI = 3.14159265359;

/** Where the trace sits in the frame. uv.y runs -1..1 over half the height, so
 *  the scope occupies the upper two thirds and the spectrum the bottom third. */
const float BOX_Y = 0.34;
const float BOX_H = 0.46;
const float SPEC_BASE = -0.92;
const float SPEC_H = 0.30;
const float BARS = 24.0;
/**
 * How bright the spectrum is allowed to be, against the trace.
 *
 * Measured on a pinned frame, the bars carried more of the picture than the trace
 * did — 8.6% of the frame against the trace's 3.7% — which is the wrong way
 * round on a real scope. There the trace is the instrument's output and the
 * spectrum is a small readout under it.
 *
 * Dimming alone cannot fix that, and the reason is worth keeping. The trace is a
 * thin wavy line and the bars are vertical columns, so on any given row the bars
 * are lit across a fixed 68% duty cycle while the trace is at its core for only
 * a fraction of the width: the fill wins on average before anyone weighs it. And
 * the pipeline is linear-light with the gamma applied at the end, so scaling
 * scene light by 0.4 buys only about 0.7 on screen — reaching the target by
 * weight alone needs a twelve-fold cut, which is not a readout, it is a smudge.
 *
 * So SPEC_WEIGHT is a modest trim and the real change is SPEC_H above: the bars
 * were 0.52 of the frame's half-height, a quarter of the screen, which is nothing
 * like the strip along the bottom an analyser readout actually is.
 *
 * Both together, measured on a pinned frame: the trace band carries 699 of light
 * against the spectrum band's 666, and the trace's brightest pixel is 92.6%
 * against the bars' 59.3%. The trace is the subject and the bars are an aside,
 * and the stars tool is what holds it there.
 */
const float SPEC_WEIGHT = 0.25;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// A third dimension, for hashing a grid cell: the block mosaic below needs a
// different offset for every (column, row, frame) triple, and a vec2 built out
// of two of them correlates the x and y offsets in a way that shows up as a
// diagonal preference in the blocks.
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float norm = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    norm += amp;
    amp *= 0.5;
    p = rot * p * 2.03;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// The palette as a ramp with a real black at the bottom, because on this
// material black is a colour of the picture and not an absence of one.
vec3 rampColour(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = uVoid;
  c = mix(c, uDeep, smoothstep(0.0, 0.30, t));
  c = mix(c, uMid, smoothstep(0.26, 0.68, t));
  c = mix(c, uHot, smoothstep(0.64, 0.95, t));
  c += uAccent * pow(smoothstep(0.80, 1.0, t), 2.0) * 0.40;
  return c;
}

// The phosphor.
//
// A trace's core burns out to white and only its halo keeps the palette's
// colour, and that is not a stylistic choice — it is what lets the picture be
// legible at all. The measured palette is very dark: its brightest stop is
// #4924b6, which is 0.16 in linear luma. A line drawn in that colour, on a
// frame that is 85% below a 0.12 luma, is a line nobody can see. So the core is
// pushed most of the way to white and the palette tints everything around it,
// which is also exactly what a real phosphor does.
vec3 phosphor(float t) {
  return mix(rampColour(0.45 + 0.45 * t), vec3(1.0), 0.72);
}

// One pixel, in the units this shader works in: uv.y runs -1..1, so a pixel is
// 2/height tall. Every width below is a pixel count times this, which is what
// keeps the trace the same weight at every resolution scale.
float pixel() {
  return 2.0 / uRes.y;
}

// A grid line at every integer of a, w wide in pixels.
float gridLine(float a, float w) {
  float f = abs(fract(a) - 0.5);
  return exp(-pow(f / w, 2.0));
}

// --- the scope's data ------------------------------------------------------

// Bilinear by hand. The texture is NEAREST, because a float texture is not
// guaranteed to be filterable without OES_texture_float_linear and asking for
// linear and quietly not getting it is a silent quality loss. Two exact taps
// cost less than the extension would.
float scopeAt(float f, float row) {
  float bins = uScopeBins;
  f = mod(f, bins);
  float i0 = floor(f);
  float a = texture(uScope, vec2((i0 + 0.5) / bins, row)).r;
  float b = texture(uScope, vec2((mod(i0 + 1.0, bins) + 0.5) / bins, row)).r;
  return mix(a, b, f - i0);
}

float waveAt(float f) {
  float v = scopeAt(f, 0.25);
  // Which of the two is the decode, and which is the data, is the whole point of
  // the uniform: the float target stores the waveform signed as it is, and the
  // 8-bit fallback cannot store a negative byte, so it stores it biased into
  // 0..1 and this undoes that. uScopeSigned is 1 on the fallback.
  //
  // The order of the two arguments matters and is easy to get backwards, because
  // the wrong way round still draws a trace — just a wrong one. Un-biasing the
  // float path folds a signed signal into 0..1, so the waveform never crosses
  // its centre line; *not* un-biasing the fallback leaves a signal that is
  // always positive, so the trace sits entirely above the centre and a third of
  // its amplitude is gone. Both are invisible in a log and obvious in a picture.
  return mix(v, v * 2.0 - 1.0, uScopeSigned);
}

float spectrumAt(float f) {
  return scopeAt(f, 0.75);
}

// --- the oscilloscope ------------------------------------------------------

// The light one pixel of instrument puts out, in linear colour.
float scopeTrace(vec2 uv, float aspect) {
  float px = pixel();
  float halfW = aspect;
  float x = clamp(uv.x / halfW, -1.0, 1.0);
  float u = x * 0.5 + 0.5;
  float light = 0.0;

  // Everything below is inside the graticule. One mask for all of it, because
  // an instrument is a box: a trace that runs off the top of the screen, or a
  // write head that draws a line through the whole frame, stops being an
  // instrument and becomes a pattern.
  vec2 q = vec2(uv.x / (2.0 * halfW) + 0.5, (uv.y - BOX_Y) / (2.0 * BOX_H) + 0.5);
  float inside = step(abs(q.x - 0.5), 0.5) * step(abs(q.y - 0.5), 0.5);

  // --- the waveform --------------------------------------------------------
  // Auto-ranging, like a VOLTS/DIV knob: the deflection is divided by the
  // frame's own peak, so a breakdown is drawn large and a drop is drawn at true
  // scale, rather than both being pinned to the rails.
  float gain = clamp(0.32 * uScopeGain / max(uScopePeak, 0.05), 0.6, 3.2);
  float f = uTrigger + u * (uScopeBins - 1.0);
  // The beam stops at the rail. At the top of the auto-ranging range the
  // deflection is three times the box's half-height, so without this a
  // transient on a quiet passage draws straight out through the top of the
  // screen and lands in bands the instrument has nothing to do with.
  //
  // tanh, rather than a clamp, because a clamp puts a corner in the trace where
  // it turns round and a real beam does not: it goes flat against the rail and
  // stays there. Below the rail tanh is linear to within a percent, so an
  // ordinary passage is drawn straight and only a transient ever touches it.
  float rail = BOX_H * 0.94;
  float y = BOX_Y + rail * tanh(waveAt(f) * 0.30 * gain / rail);
  float d = uv.y - y;

  // The write head and its phosphor. age is 0 at the head and grows behind it,
  // wrapping, so the line the scope has just drawn is hot and the line it drew a
  // bar ago has faded out. This is the persistence, and it is why the picture
  // moves on the beat without anything accumulating between frames.
  float age = mod(uSweep - u, 1.0);
  float persist = exp(-age * 3.4) * 0.85 + 0.15;

  // The core is deliberately well above 1.0. It is a line two pixels tall in a
  // frame that is 85% black, so its weight barely moves the picture's mean
  // luminance while being the difference between a scope and a smudge — and the
  // bloom pass needs something above white to bleed from.
  light += (exp(-(d * d) / (px * px * 2.0)) * 2.6
          + exp(-(d * d) / (px * px * 30.0)) * 0.30) * persist * inside;

  // The head itself: a bright dot standing *on* the trace, and nothing else.
  // Unmasked it draws a line the height of the frame, which is a bug that looks
  // like a deliberate design choice right up until you see what it is.
  float headD = u - uSweep;
  light += exp(-(headD * headD) / 2.0e-6) * exp(-(d * d) / (px * px * 9.0)) * 1.6;

  // The graticule. Not scaled by the signal: a graticule is printed on the
  // glass, and a real one does not fade when the signal is quiet.
  light += (gridLine(q.x * 10.0, px) * 0.34 + gridLine(q.y * 8.0, px) * 0.22) * inside;
  // The box itself. The distance to a rectangle's outline is the distance to the
  // *nearer* of the two edge distances, not the further one — using the further
  // one draws the horizontal borders and quietly never draws the vertical ones.
  float edge = min(abs(abs(uv.x) - halfW), abs(abs(uv.y) - BOX_Y) - BOX_H);
  light += (1.0 - smoothstep(0.0, px * 2.0, abs(edge))) * 0.5;

  // --- the spectrum, as bars along the bottom ------------------------------
  // Twenty-four bars, one tap each: the engine has already reduced each bar's
  // frequency range to its peak, which is what an analyser's peak detector does
  // and what stops the display being one wide block of bass and a hairline of
  // everything else. The whole readout is scaled by SPEC_WEIGHT so that it reads
  // as the aside it is — see that constant for the measurement that set it.
  float slot = u * BARS;
  float bar = floor(slot);
  float s = spectrumAt((bar + 0.5) / BARS * (uScopeBins - 1.0));
  // Perceptual: a linear height for a log-spaced spectrum is all bass and no top
  // end, which is not what the analyser is showing.
  s = pow(clamp(s, 0.0, 1.0), 0.65) * (0.45 + 0.55 * (1.0 - bar / BARS));
  float top = SPEC_BASE + s * SPEC_H;
  float inBar = step(fract(slot), 0.68) * step(abs(uv.x), halfW);
  light += (smoothstep(top + px * 1.5, top - px * 1.5, uv.y) * step(SPEC_BASE, uv.y) * 0.30
          + exp(-pow((uv.y - top) / (px * 1.4), 2.0)) * 0.9) * inBar * SPEC_WEIGHT;
  // The analyser's floor, so the bars sit on something.
  light += (1.0 - smoothstep(0.0, px * 1.8, abs(uv.y - SPEC_BASE))) * 0.35
         * step(abs(uv.x), halfW) * SPEC_WEIGHT;

  return light;
}

// --- the colour field ------------------------------------------------------

// Deliberately dim. This is the layer that keeps the frame from being a line on
// a void, and the measurement says the void is 65% of the picture, so this one
// is a wash and not a light source — but it is still a *layer*, and it is the
// one the passage's colour weight opens. uMix.y is what makes a breakdown a
// nearly black frame and a drop a room with colour in it; a wash drawn at the
// same strength in every passage is a background, and the arrangement's colour
// weight would be a number the shader never reads.
vec3 colourField(vec2 uv) {
  float wash = clamp(uMix.y, 0.0, 1.0);
  vec3 c = mix(uVoid, uDeep, (0.25 + 0.75 * smoothstep(-1.1, 1.1, uv.y)) * wash);

  // Two washes that wander on the drift, one on the palette's mid and one on
  // its accent, so both ends of the ramp are on screen at once.
  vec2 a = (uv - vec2(uDrift.x * 0.55, uDrift.y * 0.35 + 0.15)) * vec2(1.0, 1.35);
  vec2 b = (uv - vec2(-uDrift.y * 0.45 - 0.35, uDrift.x * 0.45 - 0.25)) * vec2(1.25, 1.0);
  c += uMid * (1.0 - smoothstep(0.0, 1.15, length(a))) * (0.045 + 0.10 * uLevels.y) * wash;
  c += uAccent * (1.0 - smoothstep(0.0, 0.95, length(b))) * (0.030 + 0.075 * uLevels.z) * wash;

  // Enough structure that the wash is not a smooth gradient: on an 8-bit
  // display a 200-pixel ramp bands visibly, and grain is cheaper than dithering
  // the output.
  c *= 0.82 + 0.36 * fbm(uv * 1.9 + uDrift.xy * uTime * 0.04, int(uOctaves));
  return c;
}

// The picture proper: the two layers that are *of* the set, so that the tape and
// the glitch above them can displace and split them together.
vec3 picture(vec2 uv, float aspect) {
  vec3 c = colourField(uv);
  if (uMix.x > 0.001) c += phosphor(uScopeRms) * scopeTrace(uv, aspect) * uMix.x;
  return c;
}

// --- the tape --------------------------------------------------------------

// The VHS layer, in screen space: a property of the *tape*, not of the picture,
// so it is not displaced by the glitch and it is not part of the bloom. Every
// one of these is off most of the time. A tape artefact that is always on is not
// an artefact, it is a texture.
vec3 tape(vec3 c) {
  float vhs = uMix.z;
  if (vhs < 0.001) return c;

  float t = uTime;
  float roll = floor(t * 6.0);

  // Scanlines. The count is a property of the *output*, not of the drawing
  // buffer, so the pattern is the same at every quality setting: counting
  // gl_FragCoord rows would give a different one each time the internal
  // resolution moved.
  float scan = 0.5 + 0.5 * cos(vUv.y * uScanLines * TAU);
  c *= 1.0 - vhs * 0.30 * scan * scan;

  // Composite video keeps luma at full resolution and colour at a third of it,
  // which is why an old tape's reds and blues smear sideways while the black and
  // the white stay sharp. A wide, cheap stand-in for that.
  c = mix(c, c * vec3(1.06, 0.98, 1.10), vhs * 0.5);

  // Tape dropouts: whole scanlines that have lost their signal. Sparse, and only
  // as strong as the passage asks for, which is where it belongs.
  float line = floor(vUv.y * uScanLines * 0.5);
  float dropped = step(1.0 - vhs * 0.035, hash21(vec2(line, roll) + uSeed));
  c += dropped * (0.10 + 0.30 * hash21(vec2(line, roll + 7.0))) * vec3(0.9, 0.95, 1.0) * vhs;

  // Head switching: the few lines at the bottom of the frame where the tape
  // passes the head, which has never been a clean picture on any machine. Kept
  // low, because a hard bright band across the bottom of the frame reads as a
  // rendering fault rather than as a worn tape — and it sits exactly where the
  // spectrum is trying to be read.
  float head = smoothstep(0.030, 0.0, vUv.y);
  c += vec3(0.5, 0.5, 0.55) * head * hash21(vec2(floor(vUv.x * 320.0), roll)) * vhs * 0.35;

  // Luma noise, and this one rides on the signal rather than sitting on top of
  // it. That is both what tape noise physically is — it is a property of the
  // recorded signal, and a dark frame on a tape is dark, not noisy — and the
  // only version that works on *this* picture.
  //
  // The reason is the transfer function. The scene is rendered in linear light
  // and gamma is applied once at the end, and near black the curve is steeper
  // than one: a linear difference of 0.007 becomes about 0.12 on screen. A flat
  // noise term of 0.03, which sounds small, is four times the background on
  // this material — the frame is 85% below a 0.12 luma — so the black becomes
  // snow and the trace has to compete with it. Scaling by the local luminance
  // puts the noise where there is a signal to make it and leaves the black
  // black, which is the whole point of the picture.
  float level = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float noise = hash21(gl_FragCoord.xy + vec2(fract(t) * 311.0, 0.0)) - 0.5;
  c += noise * 0.05 * vhs * (0.02 + 0.9 * level);
  return c;
}

// --- the glitch ------------------------------------------------------------

// The displacement, as a function of the coordinates rather than as a sampled
// texture, so the same shift moves the colour and the trace together: a glitch
// that tore the trace but not the wash behind it would read as two pictures
// rather than as one broken one.
vec2 glitchWarp(vec2 uv, float aspect) {
  float g = uMix.w;
  // The tape's time-base error rides along with the glitch, so the picture is
  // never quite still even when the arrangement is calm.
  uv.x += (sin(uv.y * 24.0 + uTime * 1.7) * 0.00035
         + sin(uv.y * 3.0 - uTime * 0.6) * 0.0008) * (g + uMix.z);
  if (g < 0.001) return uv;

  // Twelve is the frame rate of the *tape*, not of the screen, so the tearing
  // does not lock to the display and stand still on a 120 Hz panel.
  float frame = floor(uTime * 12.0);

  // Slice displacement: a handful of horizontal bands torn sideways.
  float rows = mix(28.0, 150.0, g);
  float row = floor(uv.y * rows);
  float h = hash21(vec2(row, frame) + uSeed * 0.017);
  float hit = step(1.0 - g * 0.30, h);
  uv.x += (hash21(vec2(row, frame + 3.0)) - 0.5) * hit * g * 0.55;

  // A block mosaic on a few bands, which is what a digital tape does when its
  // error correction gives up rather than tearing cleanly.
  float blockRow = floor(uv.y * 9.0);
  float blocky = step(1.0 - g * 0.22, hash21(vec2(blockRow, frame) + uSeed * 0.031));
  float bx = floor(uv.x * 14.0);
  uv.x += (hash31(vec3(bx, blockRow, frame)) - 0.5) * blocky * g * 0.18;
  uv.y += (hash31(vec3(bx, blockRow, frame + 5.0)) - 0.5) * blocky * g * 0.02;
  return uv;
}

void main() {
  float aspect = uRes.x / max(uRes.y, 1.0);
  // Aspect-corrected, so the graticule is a rectangle of the right proportions
  // rather than a square stretched across the frame.
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec2 suv = glitchWarp(uv, aspect);

  vec3 c = picture(suv, aspect);

  // Chroma separation: the red and the blue pushed apart in opposite directions.
  // It is the oldest visual shorthand there is for "this signal is wrong", and
  // the one artefact in the reference that is unmistakable at a glance. It
  // costs three evaluations of the picture, so it only runs when a layer is
  // actually asking for it.
  float split = (uMix.z * 0.0016 + uMix.w * 0.006) * (0.5 + uLevels.x);
  if (split > 0.0002) {
    c.r = picture(suv + vec2(split, 0.0), aspect).r;
    c.b = picture(suv - vec2(split * 1.4, 0.0), aspect).b;
  }

  c = tape(c);

  // The flash budget (spec §3). This is the only place the drums touch the
  // brightness, and uPulse has already been multiplied by the passage's own
  // allowance and the reader's flash mode. On a picture that is two-thirds black
  // a small gain is still a hard flash, which is why the cap is 0.18.
  float pulse = clamp(uPulse, 0.0, 1.0);
  c = c * (1.0 + pulse * 0.5) + uHot * pulse * 0.10;

  // A vignette: a scope in a dark room, not a screen in a bright one.
  c *= clamp(1.0 - 0.28 * dot(uv, uv) * 0.5, 0.0, 1.0);

  // Exposure, in linear light, before the tone map. Applied here rather than in
  // the composite so the bloom can see the trace above 1.0 and have something
  // to bleed.
  fragColor = vec4(max(c * uExposure, vec3(0.0)), 1.0);
}
`;
