// Aurora shaders: aurora curtains + starfield + glow + particles.

export const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;

uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uHot;
uniform vec3 uAccent;

uniform vec4 uMix;      // curtains, stars, glow, particles
uniform vec3 uLevels;   // kick, bass, pad
uniform float uPulse;

uniform float uSpin;
uniform float uWarp;
uniform float uZoom;
uniform float uBreathe;
uniform float uHue;
uniform float uGlow;

uniform int uSteps;
uniform int uVolumetric;
uniform int uStars;
uniform int uSymmetry;
uniform float uExposure;
uniform float uDim;

#define PI 3.14159265359
#define TAU 6.28318530718

// Hash functions
float hash11(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 hash22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float hash31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }

// Noise
float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(i), hash11(i + 1.0), f);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * noise2(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// Aurora curtain layer
float auroraCurtains(vec2 uv, float time) {
  vec2 p = uv;
  p.y *= 0.5 + uZoom * 0.5;
  p.x += uSpin * time * 0.1;
  p.y += sin(uTime * 0.3) * 0.1;

  float curtains = 0.0;
  for (int i = 0; i < 4; i++) {
    float freq = 8.0 + float(i) * 6.0;
    float phase = time * 0.2 + float(i) * 2.0;
    float wave = sin(p.y * freq + sin(p.x * 3.0 + phase) * uWarp) * 0.5;
    wave = wave * wave;
    curtains += wave * (1.0 - p.y) * (0.25 / (float(i) + 1.0));
  }
  return curtains * uMix.x;
}

// Starfield layer
float starfield(vec2 uv, float time) {
  float stars = 0.0;
  vec2 grid = uv * float(uStars) * 50.0;

  for (int i = 0; i < 3; i++) {
    vec2 cell = floor(grid) + float(i) * 17.3;
    vec2 starPos = fract(grid) + hash22(cell) - 0.5;
    float dist = length(starPos) * 200.0;

    float twinkle = sin(time * 3.0 + hash11(float(cell.x))) * 0.5 + 0.5;
    float brightness = twinkle * (1.0 - smoothstep(0.0, 0.02, dist));
    stars += brightness * exp(-dist * 5.0);
  }
  return stars * uMix.y;
}

// Glow/bloom layer
float glowLayer(vec2 uv, float time) {
  float glow = 0.0;
  vec2 center = vec2(0.5, 0.5);
  float dist = length(uv - center);
  float pulse = sin(time * 2.0) * 0.5 + 0.5;
  glow = (1.0 - dist * 1.5) * pulse * uGlow;
  return max(0.0, glow) * uMix.z;
}

// Particles layer
float particles(vec2 uv, float time) {
  float parts = 0.0;
  vec2 p = uv * 20.0;
  p.y += time * 0.1;
  p.x += sin(p.y * 2.0 + time) * uWarp * 0.5;

  for (int i = 0; i < 4; i++) {
    vec2 cell = floor(p) + float(i) * 11.7;
    vec2 pt = fract(p) + hash22(cell) - 0.5;
    float d = length(pt);
    float life = fract(hash11(float(cell.x)) + time * 0.5);
    float size = 0.02 * (1.0 - life);
    parts += smoothstep(size, 0.0, d) * life * 0.5;
  }
  return parts * uMix.w;
}

// Color mapping
vec3 paletteColor(float t, vec3 deep, vec3 mid, vec3 hot, vec3 accent) {
  t = smoothstep(0.0, 1.0, t);
  if (t < 0.5) return mix(deep, mid, t * 2.0);
  t = (t - 0.5) * 2.0;
  if (t < 0.7) return mix(mid, hot, t / 0.7);
  return mix(hot, accent, (t - 0.7) / 0.3);
}

// Hue rotation
vec3 hueRotate(vec3 c, float h) {
  const vec3 kRGBtoYPrime = vec3(0.299, 0.587, 0.114);
  const vec3 kRGBtoI = vec3(0.596, -0.274, -0.321);
  const vec3 kRGBtoQ = vec3(0.211, -0.523, 0.311);
  const vec3 kYIQtoR = vec3(1.0, 0.956, 0.621);
  const vec3 kYIQtoG = vec3(1.0, -0.272, -0.647);
  const vec3 kYIQtoB = vec3(1.0, -1.106, 1.703);

  float Y = dot(c, kRGBtoYPrime);
  float I = dot(c, kRGBtoI);
  float Q = dot(c, kRGBtoQ);
  float hc = cos(h);
  float hs = sin(h);
  float I2 = I * hc - Q * hs;
  float Q2 = I * hs + Q * hc;
  return vec3(
    dot(vec3(Y, I2, Q2), kYIQtoR),
    dot(vec3(Y, I2, Q2), kYIQtoG),
    dot(vec3(Y, I2, Q2), kYIQtoB)
  );
}

void main() {
  vec2 uv = vUv;

  // Apply symmetry
  if (uSymmetry > 1) {
    float angle = atan(uv.y - 0.5, uv.x - 0.5);
    float slice = TAU / float(uSymmetry);
    angle = mod(angle, slice) - slice * 0.5;
    float r = length(uv - 0.5);
    uv = vec2(cos(angle), sin(angle)) * r + 0.5;
  }

  // Zoom/breathe
  uv = (uv - 0.5) * (1.0 + uBreathe * 0.1) + 0.5;

  // Layers
  float curtains = auroraCurtains(uv, uTime);
  float stars = starfield(uv, uTime);
  float glow = glowLayer(uv, uTime);
  float parts = particles(uv, uTime);

  // Combine layers. The raw layers sum to ~0.1 at their brightest, which the
  // palette would map entirely to the deep sky; the gain lifts the bands into
  // the mid and hot colours while the gaps stay night.
  float combined = curtains + stars * 0.5 + glow + parts;
  combined = pow(combined, 0.9) * 2.4;

  // Pulse from kick
  combined += uPulse * 0.3;

  // Color
  vec3 color = paletteColor(combined, uDeep, uMid, uHot, uAccent);

  // Hue drift
  color = hueRotate(color, uHue * TAU);

  // Exposure. The scene buffer stays LINEAR: the composite pass adds the
  // bloom on top and applies the single gamma encode for the display.
  color = color * uExposure * uDim;

  fragColor = vec4(color, 1.0);
}
`;

export const BLOOM_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const BLOOM_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform vec2 uRes;

void main() {
  vec2 uv = vUv;
  vec3 color = texture(uScene, uv).rgb;

  // Simple 2-pass bloom would go here
  // For now just pass through with slight bloom
  vec2 invRes = 1.0 / uRes;
  vec3 bloom = vec3(0.0);
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      vec2 offset = vec2(float(i), float(j)) * invRes * 2.0;
      bloom += texture(uScene, uv + offset).rgb;
    }
  }
  bloom /= 25.0;
  bloom = bloom * step(vec3(0.6), bloom);

  color = color + bloom * 0.3;
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;