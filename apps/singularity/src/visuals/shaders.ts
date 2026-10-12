// The shaders, embedded as strings on purpose: the app must work from a file://
// check-out as well as a static host, and an extra fetch is an extra way to fail
// offline. (Complex Plane embeds its WGSL the same way, via `embedded_asset!`.)
//
// GLSL ES 3.00 / WebGL2 — not Complex Plane's WGSL, because the target here is
// every browser, including those without WebGPU (spec §3).

export const VERTEX_SHADER = `#version 300 es
// A full-screen triangle, no vertex buffer at all.
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCamPos;
uniform float uYaw;
uniform float uPitch;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uHot;
uniform vec3 uCoolStar;
uniform vec3 uWarmStar;
uniform float uBrightness;
uniform float uDensity;
uniform float uWarp;
uniform float uSteps;
uniform float uVolumetric;
uniform float uStars;
uniform float uDim;
uniform float uExposure;
uniform float uSeed;
uniform vec3 uFlare;
uniform float uFlareLevel;

// --- hashing and noise -------------------------------------------------------

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash13(vec3 p) { return hash33(p).x; }

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float vnoise2(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, 0.0));
  float b = hash13(vec3(i + vec2(1.0, 0.0), 0.0));
  float c = hash13(vec3(i + vec2(0.0, 1.0), 0.0));
  float d = hash13(vec3(i + vec2(1.0, 1.0), 0.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(p);
    norm += amp;
    amp *= 0.5;
    p = p * 2.03 + vec3(11.3, 7.7, 3.1);
  }
  return sum / max(norm, 1e-4);
}

float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise2(p);
    norm += amp;
    amp *= 0.5;
    p = p * 2.07 + vec2(3.7, 9.1);
  }
  return sum / max(norm, 1e-4);
}

// --- the nebula --------------------------------------------------------------

// Clouds of gas and dust, warped so they read as volume rather than fog. The
// camera is inside them: p is already world space and the drift is in uCamPos.
//
// Most of the sky has to stay *empty* or the nebula becomes a grey wash, so the
// density is the upper tail of the noise, gated by a slow mask the size of a
// cloud: the gas has an inside and an outside you can see.
float cloudDensity(vec3 p) {
  vec3 q = p * 0.85 + uSeed * 0.37;
  vec3 warp = vec3(
    fbm3(q + vec3(0.0, 0.0, 0.0), 4),
    fbm3(q + vec3(5.2, 1.3, 7.7), 4),
    fbm3(q + vec3(9.1, 4.4, 2.2), 4)) - 0.5;
  float d = fbm3(q + warp * uWarp * 1.6, 5);
  // Two scales: broad bodies of gas, and thin filaments inside them.
  float filaments = fbm3(q * 3.3 + vec3(2.0), 3);
  d = d * 0.78 + filaments * 0.22;
  // A sharp edge: gas or sky. A soft ramp here is what turns a nebula into fog,
  // because a thin haze along 26 units of ray still adds up to a grey wash.
  d = smoothstep(0.61, 0.72, d);
  // The cloud has an outside: regions the camera can be in that hold no gas.
  float mask = smoothstep(0.34, 0.60, fbm3(q * 0.30 + vec3(7.0), 3));
  // Inside the cloud, density still varies, so it has volume and not a silhouette.
  d *= 0.55 + 0.45 * fbm3(q * 4.7 + vec3(3.1), 3);
  return d * mask * uDensity;
}

vec3 cloudEmission(vec3 p, float d) {
  float hot = smoothstep(0.35, 0.95, d) * fbm3(p * 2.6 + uTime * 0.004, 3);
  vec3 col = mix(uDeep, uMid, smoothstep(0.0, 0.65, d));
  col = mix(col, uHot, clamp(hot * 1.4, 0.0, 1.0));
  // Emission, not albedo: the gas glows.
  return col * 1.05;
}

// Emission/absorption march: light glows through depth and is absorbed by dust.
vec4 nebulaVolume(vec3 ro, vec3 rd) {
  const int MAX_STEPS = 128;
  const float FAR = 26.0;
  float stepLen = FAR / max(uSteps, 8.0);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  // A per-pixel offset for the first step, so the stepping does not band. It is
  // *not* animated: there is no accumulation pass to average a moving jitter
  // out, so a per-frame one would only make the whole nebula sizzle (spec §3:
  // slow and continuous, no strobing). Fixed per pixel, it still decorrelates
  // the steps of neighbouring pixels, which is all a jitter is for.
  float jitter = hash13(vec3(gl_FragCoord.xy, uSeed + 0.5));
  float t = stepLen * jitter;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (float(i) >= uSteps || t > FAR || trans < 0.02) break;
    vec3 p = ro + rd * t;
    float d = cloudDensity(p);
    if (d > 0.004) {
      float a = 1.0 - exp(-d * stepLen * 1.15);
      // Far gas is dimmer, which is what makes the depth read as depth.
      acc += cloudEmission(p, d) * a * trans * exp(-t * 0.055);
      trans *= 1.0 - a;
    }
    t += stepLen;
  }
  return vec4(acc, trans);
}

// The fallback for weak GPUs: the same clouds as a few parallax planes of 2D
// fbm. A quarter of the cost and no marching.
vec4 nebulaLayered(vec3 rd) {
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int layer = 0; layer < 4; layer++) {
    float depth = 0.55 + 0.5 * float(layer);
    vec2 uv = rd.xy / max(0.28, depth + abs(rd.z));
    uv = uv * (1.9 + 0.7 * float(layer)) + uCamPos.xy * (0.6 + 0.5 * float(layer));
    float d = fbm2(uv + uSeed * 0.02, 4);
    d = smoothstep(0.52, 0.86, d) * uDensity;
    float w = 0.5 - 0.1 * float(layer);
    vec3 col = mix(uDeep, mix(uMid, uHot, 0.3), smoothstep(0.0, 0.8, d));
    acc += col * d * trans * w * 1.5;
    trans *= 1.0 - d * 0.45;
  }
  return vec4(acc, trans);
}

// --- the starfield -----------------------------------------------------------

// A star has to fit inside the cell that owns it, or the cell wall slices its
// spikes off in a straight line — a hard edge that is visible on the brightest
// stars, which are exactly the ones with spikes. So the star is offset from its
// cell centre by at most STAR_JITTER, and its whole extent (spikes included) is
// capped at STAR_REACH = half a cell minus that. The two constants are one
// budget: change either and the other has to keep the sum under half a cell.
const float STAR_JITTER = 0.22;
const float STAR_REACH = 0.5 - STAR_JITTER;

// The shape of one star: a compact core whose falloff reaches zero at 'size',
// and for the brightest few a cross of diffraction spikes whose arms reach
// 'arm'. Both die at their own edge, so a star has no hard boundary.
float starShape(vec3 delta, float size, float arm, bool spiked) {
  float dist = length(delta);
  float core = dist < size ? pow(1.0 - dist / size, 3.0) : 0.0;
  if (!spiked) return core;
  vec3 o = abs(delta);
  float thin = max(size * 0.14, 0.006);
  float alongX = pow(max(0.0, 1.0 - o.x / arm), 4.0) * pow(max(0.0, 1.0 - o.y / thin), 2.0);
  float alongY = pow(max(0.0, 1.0 - o.y / arm), 4.0) * pow(max(0.0, 1.0 - o.x / thin), 2.0);
  return core + (alongX + alongY) * 0.32;
}

// Stars from hashed cells at three depths: whether a star exists, where it sits
// in its cell, its size, its colour temperature and its twinkle rate all come
// from the hash of the cell, so the field is fixed to the sky and it is the
// camera drifting through it that moves it. The nearest layer is sparse and
// bright with the spikes; each one behind it is denser, dimmer and smaller, so
// the depth reads as depth.
//
// A star's disc radius is asked for in *radians* — a size in the sky, not a size
// in cells — so the field does not change when the drawing resolution does. It
// still has to fit its own cell (STAR_REACH), so a layer whose cells are too
// fine for the size it asks for gets smaller stars rather than clipped ones.
//
// Nothing here is animated per frame, and neither the twinkle nor the falloff
// ever reaches a hard stop: a star brightens and dims, it never blinks (spec §3
// "Slow and continuous ... no strobing").
vec3 starLayer(vec3 rd, float cells, float parallax, float seed, float radiusRadians,
               float brightnessScale, float density, bool spikes) {
  vec3 dir = normalize(rd + uCamPos * parallax);
  vec3 p = dir * cells;
  vec3 cell = floor(p);
  vec3 r = hash33(cell + seed);
  // How many of the cells hold a star. The cell count sets how finely the sky is
  // divided, this sets how much of it is lit — so a layer can be made denser
  // without its stars having to shrink to make room.
  if (r.x > density) return vec3(0.0);
  // Only a few carry spikes: spec §3 asks for "a few bright stars", not for
  // every star in the field to have them.
  bool spiked = spikes && r.z > 0.88;
  // The disc radius. The *visible* core is much smaller — the profile is a cube,
  // so half its peak sits at a fifth of this — which is what makes a star with a
  // 0.006 rad disc a point about a pixel across, spikes and all.
  float size = min(STAR_REACH, radiusRadians * cells * (0.55 + 0.45 * r.y));
  float arm = min(STAR_REACH, size * 2.4);
  float reach = spiked ? arm : size;
  vec3 jitter = (hash33(cell + seed + 17.0) - 0.5) * 2.0 * STAR_JITTER;
  // The star sits on the *sphere* the pixels are sampled on, not at the centre
  // of its own cell: a cell's centre is up to a unit away from the surface, so a
  // star placed there has that offset inside its own reach and most of them are
  // never drawn at all — leaving only the cells that happen to graze the sphere,
  // which is a bias you can see as the field's stars avoiding some regions.
  vec3 centre = normalize(cell + 0.5 + jitter) * cells;
  vec3 delta = p - centre;
  if (length(delta) > reach) return vec3(0.0);
  float temp = hash13(cell + seed + 5.0);
  vec3 tint = mix(uCoolStar, uWarmStar, temp);
  // 0.44 at its dimmest: a star dims and brightens, it does not blink.
  float twinkle = 0.72 + 0.28 * sin(uTime * (0.6 + 2.2 * r.z) + r.x * 41.0);
  float lum = brightnessScale * (0.30 + 0.70 * r.z);
  return tint * starShape(delta, size, arm, spiked) * lum * twinkle;
}

// A far-away sound event lights a star (spec §3): a real star of the same field,
// in the direction the sound came from, whose brightness is the event's own
// envelope. It rises over seconds and fades over the event's own duration, so
// the sky answers the sound and nothing ever flashes.
vec3 flareStar(vec3 rd) {
  if (uFlareLevel <= 0.002) return vec3(0.0);
  float cells = 28.0;
  // The far layer's parallax: it is a *distant* star that lights up. It sits
  // exactly where the sound came from, rather than on a hashed cell, so "the
  // star is where the event was" is a claim about a direction and not about a
  // cell's worth of sky.
  vec3 p = normalize(rd + uCamPos * 0.05) * cells;
  vec3 centre = normalize(uFlare) * cells;
  float size = min(STAR_REACH, 0.0085 * cells);
  float arm = min(STAR_REACH, size * 2.4);
  vec3 delta = p - centre;
  if (length(delta) > arm) return vec3(0.0);
  return mix(uCoolStar, uWarmStar, 0.3) * starShape(delta, size, arm, true) * uFlareLevel * 3.2;
}

vec3 starfield(vec3 rd) {
  vec3 col = vec3(0.0);
  // Layers, not a switch: 1 is a sparse bright field, 3 adds two finer, dimmer,
  // nearer-to-background ones. 0 leaves the sky to the band alone (which is what
  // a capture needs to see the band at all).
  float layers = clamp(uStars, 0.0, 3.0);
  if (layers > 0.5) {
    col += starLayer(rd, 28.0, 0.16, 0.0, 0.0062, 1.0, 0.08, true);
    col += flareStar(rd);
  }
  if (layers > 1.5) col += starLayer(rd, 60.0, 0.09, 31.0, 0.0037, 0.68, 0.14, false);
  if (layers > 2.5) col += starLayer(rd, 84.0, 0.04, 67.0, 0.0030, 0.34, 0.22, false);

  // A faint Milky Way: a great-circle band with dust lanes in it. It has to
  // stay *faint*: a haze over the whole sky lifts the black and the picture
  // turns to fog.
  vec3 bandNormal = normalize(vec3(0.32, 0.86, 0.28));
  float b = dot(rd, bandNormal);
  float band = exp(-pow(b / 0.24, 2.0));
  float dust = fbm3(rd * 7.0 + uSeed * 0.11, 3);
  float haze = band * (0.2 + 0.8 * dust);
  vec3 milky = mix(uMid, uHot, 0.45) * 0.6 + uCoolStar * 0.25;
  col += milky * haze * 0.022 * (0.5 + uBrightness);
  return col;
}

// --- assembly ----------------------------------------------------------------

vec3 aces(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = (vUv * uRes - 0.5 * uRes) / max(uRes.y, 1.0);

  float cp = cos(uPitch);
  float sp = sin(uPitch);
  float cy = cos(uYaw);
  float sy = sin(uYaw);
  vec3 forward = vec3(cp * sy, sp, cp * cy);
  vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, forward);
  vec3 rd = normalize(forward + uv.x * right + uv.y * up);

  vec4 nebula = uVolumetric > 0.5 ? nebulaVolume(uCamPos, rd) : nebulaLayered(rd);
  vec3 stars = starfield(rd);

  // Stars behind the gas are dimmed by what the march left through it.
  vec3 deepStars = stars * mix(0.25, 1.0, nebula.a);
  vec3 col = deepStars + nebula.rgb;

  col *= 0.55 + 0.85 * uBrightness;
  col = aces(col * uExposure);

  // A soft vignette and a whisper of dither: no banding in the dark. The dither
  // is fixed in screen space — a per-frame one would flicker every pixel at the
  // frame rate, which is the one thing §3 rules out.
  col *= 1.0 - 0.42 * dot(uv, uv);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col += (hash13(vec3(gl_FragCoord.xy, 3.5)) - 0.5) * 0.004;

  fragColor = vec4(col * uDim, 1.0);
}
`;
