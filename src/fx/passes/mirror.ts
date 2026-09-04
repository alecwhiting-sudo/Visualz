import type { FxPass } from '../types'
import { makeFxPass } from './base'

// mode 0: quadrant — mirror both axes (bottom-left quadrant tiled 4x).
// mode 1: horizontal — mirror the left half onto the right.
// mode 2: vertical — mirror the bottom half onto the top.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uMode;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  int mode = int(uMode + 0.5);
  vec2 m;
  if (mode == 0) {
    m = vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y) * 2.0;
  } else if (mode == 1) {
    m = vec2((uv.x < 0.5 ? uv.x : 1.0 - uv.x) * 2.0, uv.y);
  } else {
    m = vec2(uv.x, (uv.y < 0.5 ? uv.y : 1.0 - uv.y) * 2.0);
  }
  m = clamp(m, 0.0, 1.0);
  outColor = texture(uSrc, m);
}`

export function mirrorPass(): FxPass {
  return makeFxPass(
    'mirror',
    'Mirror',
    [{ name: 'mode', label: 'Mode', min: 0, max: 2, default: 0, step: 1 }],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uMode'), values.get('mode') ?? 0)
    },
  )
}
