import type { FxPass } from '../types'
import { makeFxPass } from './base'

// Centered zoom scale — designed to be signal-bound (e.g. `1 + bass*0.2`) so
// a caller drives `zoom` off the SignalBus each frame for a pulse-with-the-
// beat effect. The pass itself stays a pure function of `zoom`.
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uResolution;
uniform float uZoom;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float z = clamp(uZoom, 0.001, 100.0);
  vec2 zuv = clamp((uv - 0.5) / z + 0.5, 0.0, 1.0);
  outColor = texture(uSrc, zuv);
}`

export function zoomPulsePass(): FxPass {
  return makeFxPass(
    'zoompulse',
    'Zoom Pulse',
    [{ name: 'zoom', label: 'Zoom', min: 0.5, max: 1.5, default: 1 }],
    FS,
    (gl, program, values) => {
      gl.uniform1f(gl.getUniformLocation(program, 'uZoom'), values.get('zoom') ?? 1)
    },
  )
}
