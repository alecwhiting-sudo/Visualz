import type { FxPass } from '../types'
import { makeFxPass } from './base'

// Chromatic aberration: R and B sampled at +/- an offset along `angle`, G
// stays put — the classic VJ "glitch" chroma split.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uAmount;
uniform float uAngle;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float theta = uAngle * 6.28318530718;
  vec2 dir = vec2(cos(theta), sin(theta)) * uAmount;
  float r = texture(uSrc, clamp(uv + dir, 0.0, 1.0)).r;
  float g = texture(uSrc, uv).g;
  float b = texture(uSrc, clamp(uv - dir, 0.0, 1.0)).b;
  outColor = vec4(r, g, b, 1.0);
}`

export function rgbShiftPass(): FxPass {
  return makeFxPass(
    'rgbshift',
    'RGB Shift',
    [
      { name: 'amount', label: 'Amount', min: 0, max: 0.05, default: 0.01, step: 0.001 },
      { name: 'angle', label: 'Angle', min: 0, max: 1, default: 0 },
    ],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uAmount'), values.get('amount') ?? 0.01)
      gl.uniform1f(gl.getUniformLocation(program, 'uAngle'), values.get('angle') ?? 0)
    },
  )
}
