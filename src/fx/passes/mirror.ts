import type { FxPass } from '../types'
import { makeFxPass } from './base'

// Scaling modes (0-2) zoom a half/quadrant of the source to fill the frame;
// 0 scales both axes uniformly so proportions hold, but 1 and 2 stretch a
// single axis 2x (user report: distorts aspect). Reflect modes (3-5) never
// rescale: they fold the picture over its centre line(s) at original scale —
// the classic VJ mirror — so aspect is preserved by construction.
// mode 0: quadrant zoom — bottom-left quadrant scaled to fill (uniform).
// mode 1: horizontal stretch — left half stretched 2x onto the right.
// mode 2: vertical stretch — bottom half stretched 2x onto the top.
// mode 3: horizontal reflect — right half becomes the left half, flipped.
// mode 4: vertical reflect — top half becomes the bottom half, flipped.
// mode 5: quadrant reflect — both axes folded, no rescale.
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
  } else if (mode == 2) {
    m = vec2(uv.x, (uv.y < 0.5 ? uv.y : 1.0 - uv.y) * 2.0);
  } else if (mode == 3) {
    m = vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y);
  } else if (mode == 4) {
    m = vec2(uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y);
  } else {
    m = vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y < 0.5 ? uv.y : 1.0 - uv.y);
  }
  m = clamp(m, 0.0, 1.0);
  outColor = texture(uSrc, m);
}`

export function mirrorPass(): FxPass {
  return makeFxPass(
    'mirror',
    'Mirror',
    [{ name: 'mode', label: 'Mode', min: 0, max: 5, default: 0, step: 1 }],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uMode'), values.get('mode') ?? 0)
    },
  )
}
