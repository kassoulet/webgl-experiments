// The shaders, as strings (spec §3). Embedded rather than fetched, for the same
// reasons the AudioWorklet source is: no extra request, no MIME or path to get
// wrong, nothing extra for the service worker to precache, and the picture works
// offline from any static host.
//
// Backticks inside a GLSL comment would terminate this template literal, so
// there are none.

export const VERTEX_SHADER = `#version 300 es
precision highp float;

// One full-screen triangle. No geometry, no buffers, no attributes: the vertex
// is derived from gl_VertexID, so the draw call is one triangle and nothing
// else (spec §3).
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

// The four layers (spec §3): kaleidoscope, plasma, fractal and noise. The
// section decides how much of each is on the screen, so a drop is fractal and
// kaleidoscope and a breakdown is plasma and noise, and the change between them
// is a cross-fade of numbers rather than a cut.
in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uSeed;

uniform vec3  uDeep;
uniform vec3  uMid;
uniform vec3  uHot;
uniform vec3  uAccent;

uniform vec4  uMix;         // kaleido, plasma, fractal, noise
uniform vec4  uLevels;      // kick, bass, hat, stab
uniform float uPulse;       // the flash budget, already capped by the conductor
uniform float uSpin;
uniform float uWarp;
uniform float uZoom;
uniform float uBreathe;
uniform float uHue;
uniform float uGlow;
uniform float uSymmetry;
uniform float uIterations;
uniform float uOctaves;
uniform float uExposure;
uniform float uDim;

const float TAU = 6.28318530718;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
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

// fBm with a rotation between octaves, so the lattice does not line up and the
// texture does not look like a grid of blobs.
float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float norm = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    norm += amp;
    amp *= 0.5;
    p = rot * p * 2.03;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// The plasma: four sine fields added together, domain-warped so the bands bend.
float plasma(vec2 p, float t, int octaves) {
  vec2 q = p;
  q += uWarp * 0.35 * vec2(
    fbm(p * 1.3 + vec2(0.0, t * 0.11), octaves),
    fbm(p * 1.3 + vec2(4.7, -t * 0.09), octaves)
  );
  float v = sin(q.x * 3.0 + t * 0.7);
  v += sin(q.y * 3.7 - t * 0.52);
  v += sin((q.x + q.y) * 2.4 + t * 0.31);
  v += sin(length(q) * 4.5 - t * 0.9);
  return v * 0.25 + 0.5;
}

// The fractal: escape-time on the Mandelbrot set, zoomed. Smooth iteration
// counting rather than a binary hit/miss, because a staircase of flat colour
// bands is the one thing that reads as "old demo" rather than as a picture.
//
// The loop bound is compared as ints and the result divided by a float: GLSL ES
// has no implicit conversion between the two, and a shader that does not compile
// leaves a black rectangle rather than an error anyone reads.
float fractal(vec2 p, int iterations) {
  vec2 c = p;
  vec2 z = vec2(0.0);
  float escaped = 0.0;
  for (int n = 0; n < 256; n++) {
    if (n >= iterations) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    float m = dot(z, z);
    if (m > 16.0) {
      // Smooth: subtract the log of the overshoot.
      escaped = float(n) + 1.0 - log2(max(m, 1.0001)) * 0.25;
      break;
    }
  }
  return escaped > 0.0 ? escaped / float(iterations) : 0.0;
}

// The kaleidoscope: fold the plane into segments and let the texture show
// through the seam. The fold is where the picture's symmetry comes from, and it
// is what makes a bass line visible as shape rather than as a wobble.
vec2 kaleidoscope(vec2 p, float segments, float spin) {
  float r = length(p);
  if (r < 1e-5) return vec2(0.0);
  float seg = max(2.0, floor(segments));
  float wedge = TAU / seg;
  float a = atan(p.y, p.x) + spin;
  a = mod(a, wedge);
  a = abs(a - wedge * 0.5);
  return vec2(cos(a), sin(a)) * r;
}

// The noise layer: a flow field, which is fbm of a position that has itself been
// displaced by fbm, three times. It is the layer that makes a still frame look
// like it is moving even when the drums have stopped.
float flow(vec2 p, float t, int octaves) {
  vec2 q = vec2(
    fbm(p + vec2(0.0, t * 0.10), octaves),
    fbm(p + vec2(5.2, 1.3) - vec2(t * 0.08, 0.0), octaves)
  );
  vec2 r = vec2(
    fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.05, octaves),
    fbm(p + 3.0 * q + vec2(8.3, 2.8) - t * 0.06, octaves)
  );
  return fbm(p + 3.0 * r, octaves);
}

// The palette, as a ramp rather than a mix of two colours: four stops, so a
// fractal's bands have somewhere to go. Saturation and brightness come in
// through uMid and uHot, which the conductor has already tinted for the section.
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = uDeep;
  c = mix(c, uMid, smoothstep(0.0, 0.42, t));
  c = mix(c, uHot, smoothstep(0.38, 0.82, t));
  c += uAccent * pow(smoothstep(0.72, 1.0, t), 2.0) * 0.55;
  return c;
}

// A cheap hue rotation, in YIQ, so the palette drifts through the wheel
// without a lookup table.
vec3 hueRotate(vec3 colour, float turns) {
  const vec3 k = vec3(0.57735);
  float angle = turns * TAU;
  float c = cos(angle);
  float s = sin(angle);
  return colour * c + cross(k, colour) * s + k * dot(k, colour) * (1.0 - c);
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
  float t = uTime;

  // The frame the picture is drawn in: aspect-corrected, breathing, and spun by
  // the drift. Nothing in here cuts, and nothing in here is on a beat.
  vec2 p = uv * (1.0 + 0.06 * sin(t * 0.21)) * uBreathe;
  p *= 1.0 + uLevels.y * 0.03;
  float spin = uSpin * t + 0.35 * sin(t * 0.13);

  int octaves = int(uOctaves);
  vec3 colour = vec3(0.0);
  float weight = 0.0;

  // Kaleidoscope.
  if (uMix.x > 0.001) {
    vec2 k = kaleidoscope(p, uSymmetry, spin);
    float kk = 0.62 * fbm(k * 2.2 + vec2(0.0, t * 0.05), octaves)
             + 0.38 * plasma(k * 1.7 - spin * 0.2, t * 0.6, octaves);
    colour += ramp(kk) * uMix.x;
    weight += uMix.x;
  }

  // Plasma.
  if (uMix.y > 0.001) {
    float pl = plasma(p * 1.25, t, octaves);
    float mixin = 0.7 * pl + 0.3 * fbm(p * 2.6 + t * 0.04, octaves);
    colour += ramp(mixin) * uMix.y;
    weight += uMix.y;
  }

  // Fractal.
  if (uMix.z > 0.001) {
    vec2 f = p * (1.6 + uZoom * 6.0);
    // A slow orbit of the point being looked at, so the set is never static and
    // never snaps to a new place.
    float orbit = t * 0.05;
    vec2 centre = vec2(-0.743643887 + 0.131825904 * cos(orbit), 0.131825904 * sin(orbit));
    vec2 q = f * 0.34 + centre;
    q = mat2(0.8, 0.6, -0.6, 0.8) * q;
    float fi = fractal(q, int(uIterations));
    // Inside the set is the deep colour; outside, the ramp over the escape time.
    float shade = fi > 0.0 ? 0.25 + 0.75 * fi : 0.06;
    colour += ramp(shade) * uMix.z * (0.6 + 0.6 * fi);
    weight += uMix.z;
  }

  // Noise.
  if (uMix.w > 0.001) {
    float n = flow(p * 1.4, t, octaves);
    colour += ramp(n * 0.95 + 0.05) * uMix.w;
    weight += uMix.w;
  }

  if (weight > 0.0001) colour /= weight;

  // The flash budget (spec §3). This is the *only* place the drums touch the
  // brightness, and uPulse has already been multiplied by the section's own
  // allowance and the reader's flash mode — a soft picture gains at most a fifth
  // of its light here, whatever the kick is doing.
  float pulse = clamp(uPulse, 0.0, 1.0);
  colour = colour * (1.0 + pulse * 0.55) + uHot * pulse * 0.22;

  // Glow: the picture is meant to bleed, and the bloom pass does most of it.
  colour *= 0.7 + uGlow * 0.6;
  colour = hueRotate(colour, uHue * 0.12);

  // A vignette, so the kaleidoscope's centre is the subject and the corners of
  // a phone in a dark room are not a bright rectangle.
  float vignette = 1.0 - 0.32 * dot(uv, uv) * 0.5;
  colour *= clamp(vignette, 0.0, 1.0);

  // Exposure, in linear light, before the tone map: a palette's mid stops are
  // genuinely dark numbers (the linear value of a mid green is about 0.2), and
  // without this the whole picture arrives two stops under. It is applied here,
  // not in the composite, so the bloom can see the highlights above 1.0 and
  // have something to bleed.
  colour *= uExposure;

  // A touch of grain: a smooth gradient across 800 pixels bands badly on an
  // 8-bit display, and dithering is cheaper than the banding.
  float grain = hash21(gl_FragCoord.xy + fract(t) * 137.0) - 0.5;
  colour += grain * 0.012;

  fragColor = vec4(max(colour, vec3(0.0)), 1.0);
}
`;
