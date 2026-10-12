// Bloom shaders: a separable two-pass Gaussian blur on a bright-pass extract.
// WebGL2, embedded strings like the main shaders.

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

float gaussian(float x, float sigma) {
  return exp(-0.5 * x * x / (sigma * sigma)) / (sigma * sqrt(6.28318530718));
}

void main() {
  vec2 texel = 1.0 / uRes;
  vec3 acc = vec3(0.0);
  float weightSum = 0.0;
  float sigma = uBlurRadius * 0.35;

  // 9-tap separable Gaussian
  for (int i = -4; i <= 4; i++) {
    float offset = float(i);
    vec2 uv = vUv + (uHorizontal ? vec2(offset, 0.0) : vec2(0.0, offset)) * texel;
    vec3 texelColor = texture(uScene, uv).rgb;

    // Bright-pass: only bloom what's above threshold
    float luminance = dot(texelColor, vec3(0.2126, 0.7152, 0.0722));
    if (luminance > uThreshold) {
      float w = gaussian(offset, sigma);
      acc += texelColor * w;
      weightSum += w;
    }
  }

  fragColor = weightSum > 0.0 ? vec4(acc / weightSum, 1.0) : vec4(0.0);
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
uniform vec2 uBloomRes;
uniform vec2 uSceneRes;

void main() {
  vec3 scene = texture(uScene, vUv).rgb;

  // Bloom may be at a lower resolution than the scene (reduced-res bloom path).
  // Sample it with a proper bilinear upsample when its res differs from the scene.
  vec3 bloom;
  if (uBloomRes == uSceneRes) {
    bloom = texture(uBloom, vUv).rgb;
  } else {
    vec2 s = uSceneRes;
    vec2 b = uBloomRes;
    vec2 f = vec2(0.5) / b;
    vec2 uv = (vUv * s + vec2(0.5)) / b;
    vec3 a = texture(uBloom, uv - f).rgb;
    vec3 bb = texture(uBloom, uv + vec2(f.x, -f.y)).rgb;
    vec3 c = texture(uBloom, uv + vec2(-f.x, f.y)).rgb;
    vec3 d = texture(uBloom, uv + f).rgb;
    bloom = (a + bb + c + d) * 0.25;
  }

  // Additive bloom with intensity control
  vec3 col = scene + bloom * uIntensity;

  // Vignette and gamma (same as main shader)
  vec2 uv = vUv * 2.0 - 1.0;
  col *= 1.0 - 0.42 * dot(uv, uv);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));

  // Dither to prevent banding in darks
  // Note: gl_FragCoord not available here without redeclaring, skip dither for bloom pass
  fragColor = vec4(col * uDim, 1.0);
}
`;