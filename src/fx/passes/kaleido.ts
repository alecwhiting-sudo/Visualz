import type { FxPass } from '../types'
import { makeFxPass } from './base'

// N-segment polar mirror: fold the angle around the frame center into a
// `2*PI/segments` wedge, then mirror that wedge about its own bisector so
// adjacent copies tile edge-to-edge (the classic kaleidoscope look) rather
// than showing a repeated sawtooth seam.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uSegments;
uniform float uRotate;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = (uv - 0.5) * aspect;
  float r = length(p);
  float segments = max(2.0, uSegments);
  float seg = 6.28318530718 / segments;
  // Fold the FULL circle down to one half-wedge [0, seg/2] first (mod, then
  // mirror around the wedge's own center) -- rotate is added AFTER the
  // fold, as an absolute rotation of the sampled vector, so it picks WHICH
  // wedge of the source the whole mirrored pattern is built from. Adding it
  // BEFORE the fold (the naive approach) gets consumed by the mod/abs and
  // has no visible effect -- every output pixel would keep sampling the same
  // angle-0 wedge regardless of rotate.
  float a = atan(p.y, p.x);
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  a += uRotate * 6.28318530718;
  vec2 q = vec2(cos(a), sin(a)) * r;
  vec2 sampleUv = clamp(q / aspect + 0.5, 0.0, 1.0);
  outColor = texture(uSrc, sampleUv);
}`

export function kaleidoPass(): FxPass {
  return makeFxPass(
    'kaleido',
    'Kaleido',
    [
      { name: 'segments', label: 'Segments', min: 2, max: 16, default: 6, step: 1 },
      { name: 'rotate', label: 'Rotate', min: 0, max: 1, default: 0 },
    ],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uSegments'), values.get('segments') ?? 6)
      gl.uniform1f(gl.getUniformLocation(program, 'uRotate'), values.get('rotate') ?? 0)
    },
  )
}
