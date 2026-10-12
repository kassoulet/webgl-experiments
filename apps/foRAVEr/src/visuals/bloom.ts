// Bloom shaders: a separable two-pass Gaussian blur on a bright-pass extract,
// then an additive composite that also tone maps. WebGL2, embedded strings like
// the main shader.
//
// Two details here are not decoration and were both wrong once:
//
//  - The tap variable is called `tap`, not `sample`. `sample` is a *reserved
//    word* in GLSL ES, so naming a variable that kills the whole shader at
//    compile time — and a shader that fails to compile leaves a black
//    rectangle, not an error a listener will ever report.
//  - The two blur passes read and write different textures (scene to A, A to
//    B). Blurring into the texture you are sampling from is a feedback loop:
//    the driver is entitled to hand back anything at all, which on some
//    hardware is a shimmering mess and on others is a flat grey.

export const BLOOM_VERTEX_SHADER = `#version 300 es
// Full-screen triangle, same as the scene vertex shader.
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BLOOM_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uThreshold;
uniform float uBlurRadius;
uniform bool uHorizontal;

const float TAU = 6.28318530718;

float gaussian(float x, float sigma) {
  return exp(-0.5 * x * x / (sigma * sigma)) / (sigma * sqrt(TAU));
}

// Soft-knee bright pass: everything above the threshold contributes, and the
// contribution is compressed rather than clipped, so a hot core glows wide
// instead of blooming into a hard-edged disc.
vec3 brightPass(vec3 colour) {
  float luminance = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  float over = max(0.0, luminance - uThreshold);
  return colour * (over / (luminance + 1e-5)) * (over / (1.0 + over));
}

void main() {
  vec2 texel = 1.0 / uRes;
  vec3 acc = vec3(0.0);
  float weightSum = 0.0;
  float sigma = max(0.5, uBlurRadius * 0.4);

  // Nine taps, along one axis. The weights are the whole of the Gaussian; the
  // normalisation is over *all* taps, not only the bright ones, so a bright
  // point next to a dark one blurs into the dark rather than staying a disc.
  for (int i = -4; i <= 4; i++) {
    float offset = float(i);
    vec2 uv = vUv + (uHorizontal ? vec2(offset, 0.0) : vec2(0.0, offset)) * texel;
    float w = gaussian(offset, sigma);
    acc += brightPass(texture(uScene, uv).rgb) * w;
    weightSum += w;
  }

  fragColor = vec4(weightSum > 0.0 ? acc / weightSum : vec3(0.0), 1.0);
}
`;

export const COMPOSITE_VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uIntensity;
uniform float uDim;

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 glow = texture(uBloom, vUv).rgb;

  // Additive, then the tone map. The vignette is in the scene shader, not here:
  // two of them, one in linear light and one after the gamma, darken the corners
  // of a kaleidoscope twice as hard as either intends.
  vec3 colour = max(scene + glow * uIntensity, vec3(0.0));

  // An exponential roll-off rather than a clamp. A rave picture is meant to have
  // hot cores well above white; clipping them turns the glow into a flat white
  // blob, and this keeps the colour in the highlight all the way up to 1.0.
  colour = vec3(1.0) - exp(-colour);
  colour = pow(colour, vec3(1.0 / 2.2));

  fragColor = vec4(colour * uDim, 1.0);
}
`;
