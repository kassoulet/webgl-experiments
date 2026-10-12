// Aurora bloom shaders.
//
// The scene pass renders linear; this pass blurs it (a 5x5 tap box blur, which
// is the whole "bloom" budget on a phone) and the composite pass adds the two
// back together with the one gamma encode the display wants. Keeping the blur
// in linear space is what makes bloom read as light rather than as milk.

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
  vec2 invRes = 1.0 / uRes;
  vec3 bloom = vec3(0.0);
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      vec2 offset = vec2(float(i), float(j)) * invRes * 2.0;
      bloom += texture(uScene, uv + offset).rgb;
    }
  }
  bloom /= 25.0;
  // Only the bright parts bloom: below the threshold a blur is just haze.
  bloom = max(bloom - vec3(0.45), vec3(0.0));
  fragColor = vec4(bloom, 1.0);
}
`;

export const COMPOSITE_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;

void main() {
  vec3 scene = texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 color = scene + bloom * 0.8;
  // The single gamma encode of the frame: everything upstream is linear.
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;
