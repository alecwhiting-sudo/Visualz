import type { FxPass } from '../types'
import { makeFxPass } from './base'

// Hard luminance quantize with an "invert on band" (Ikeda-ish, high-contrast
// stepped look): each quantized level's band index alternates a full invert,
// so consecutive bands read as sharp light/dark steps rather than a smooth
// ramp. `uMix` crossfades between the original image and the posterized one.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uLevels;
uniform float uMix;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 col = texture(uSrc, uv).rgb;
  float levels = max(2.0, uLevels);
  vec3 q = floor(clamp(col, 0.0, 1.0) * levels) / (levels - 1.0);
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  float band = floor(luma * levels);
  float invert = mod(band, 2.0);
  vec3 posterized = mix(q, 1.0 - q, invert);
  outColor = vec4(mix(col, posterized, clamp(uMix, 0.0, 1.0)), 1.0);
}`

export function posterizePass(): FxPass {
  return makeFxPass(
    'posterize',
    'Posterize',
    [
      { name: 'levels', label: 'Levels', min: 2, max: 16, default: 4, step: 1 },
      { name: 'mix', label: 'Mix', min: 0, max: 1, default: 1 },
    ],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uLevels'), values.get('levels') ?? 4)
      gl.uniform1f(gl.getUniformLocation(program, 'uMix'), values.get('mix') ?? 1)
    },
  )
}
