import type { FxPass } from '../types'
import { makeFxPass } from './base'

// Mosaic: quantize to a grid of square cells sized off the SHORT axis (F3-
// style format-neutral measure — see docs/SCENE_CONTRACT.md) so a cell reads
// as visually square at 16:9, 9:16, and 1:1 alike, not stretched.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uCells;
out vec4 outColor;
void main() {
  float cells = max(1.0, uCells);
  float cellPx = max(1.0, min(uResolution.x, uResolution.y) / cells);
  vec2 cellCoord = floor(gl_FragCoord.xy / cellPx) * cellPx + cellPx * 0.5;
  vec2 uv = clamp(cellCoord / uResolution, 0.0, 1.0);
  outColor = texture(uSrc, uv);
}`

export function pixelatePass(): FxPass {
  return makeFxPass(
    'pixelate',
    'Pixelate',
    [{ name: 'cells', label: 'Cells', min: 4, max: 400, default: 120, step: 1 }],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uCells'), values.get('cells') ?? 120)
    },
  )
}
