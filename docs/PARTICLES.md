# Particles Family — GPGPU Technique Spec (WebGL2, no compute)

Design by the reasoner tier (2026-07-15), accepted by the architect. Targets:
`src/gpu/targets.ts` (reusable GPGPU helpers, ARCHITECTURE §3.7) and two scenes in
`src/scenes/builtin/`: flow field + Lorenz attractor. All numerics validated in
design-time scratch prototypes.

## 0. Executive decisions

| Fork | Decision | Why (validated) |
|---|---|---|
| State precision | **RGBA32F, required.** No RGBA16F fallback. | Half-float ULP near NDC 1.0 is 9.77e-4: flow velocities of 2e-4/step stall to zero in f16, 5e-4/step accumulate 95% rounding bias (f16 moved 0.586 where f32 moved 0.300). Position must be f32 |
| State texture | One RGBA32F ping-pong texture per scene, no MRT | Flow packs (px,py,vx,vy); Lorenz (x,y,z,age) — 4 floats/texel fits |
| Filtering | NEAREST + `texelFetch` | Avoids OES_texture_float_linear (absent on older iOS) |
| Flow integration | Exponential-approach semi-implicit Euler: `v += (target−v)·(1−e^(−response·dt))` | Unconditionally stable for any dt/response; bounded velocities ~1.4; identical at dt=1/30 and 1/60 |
| Lorenz integration | **RK2 (midpoint), 4 fixed unrolled substeps, h = speed·dt/4** | Bounded over 10k frames at every speed∈[0.1,3]×dt∈{1/30,1/60}; Euler inflates the envelope with step size (z-max 62 at speed 3); RK2 holds z-max ~47 ≈ RK4 at half cost |
| In-shader randomness | `hash32` from docs/DSL.md §5 keyed on (particleIndex, frame) | Brand-consistent with DSL noise; no time seeds |

Accepted flags: (1) `src/testing/hooks.ts` needs a `?scene=` selector reading a scene
registry — builder scope, no SceneRuntime change. (2) `SceneRuntime` has no
`reset()/seek()` hook, so stateful GPU scenes can't reset on mid-timeline scrub;
goldens/export/replay all start at frame 0 and `loadSession` re-calls
`scene.init(gpu, seed)` which IS the reset — fine for v1; interactive scrubbing later
needs a `SceneRuntime.reset(seed)` architect decision.

## 1. Capability check

RGBA32F color-renderability gated by `EXT_color_buffer_float` — present on iOS 15+
Safari, desktop browsers, and ANGLE-SwiftShader (CI). `texelFetch` needs no filtering
extension.

```ts
// src/gpu/targets.ts
export interface FloatCaps { ok: boolean; reason?: string }
export function checkFloatRenderable(gpu: Gpu): FloatCaps {
  const gl = gpu.gl
  if (!gl.getExtension('EXT_color_buffer_float'))
    return { ok: false, reason: 'EXT_color_buffer_float unavailable — particle family requires float render targets' }
  // Runtime completeness probe (some stacks report the ext but fail FBO).
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fbo); gl.deleteTexture(tex)
  return ok ? { ok: true } : { ok: false, reason: 'RGBA32F not framebuffer-complete on this driver' }
}
```

Call in `init()`; on failure THROW with reason (never silently drop to RGBA16F — the
stall makes that a correctness bug, not a quality knob).

## 2. targets.ts API (the §3.7 GPGPU helpers)

All textures NEAREST/CLAMP_TO_EDGE, no mips, `texStorage2D(RGBA32F)` +
`texSubImage2D(RGBA, FLOAT, initial)`.

```ts
export class FloatTarget {
  readonly texture: WebGLTexture
  readonly fbo: WebGLFramebuffer
  readonly size: number
  constructor(gpu: Gpu, size: number, initial?: Float32Array)  // length size*size*4 or zeros
  upload(data: Float32Array): void
  bindTarget(): void            // bind fbo + viewport(0,0,size,size)
  bindTexture(unit: number): void
  dispose(): void
}
export class PingPong {
  constructor(gpu: Gpu, size: number, initial?: Float32Array)
  get src(): FloatTarget        // read-from (current state)
  get dst(): FloatTarget        // write-to (next state)
  swap(): void
  resize(size: number, initial: Float32Array): void   // count-quality re-init (§6)
  dispose(): void
}
/** Attribute-less fullscreen-triangle pass (one empty VAO; drawArrays(TRIANGLES,0,3)).
 *  Update fragment reads gl_FragCoord.xy — no varyings. */
export class FullscreenPass {
  constructor(gpu: Gpu)
  draw(): void
  dispose(): void
}
```

## 3. Texture layout & quality ladder

Particle i → texel (i % side, floor(i / side)), square, side = 2^k, N = side².
Ladder (count param snaps): 64²=4,096 (mobile floor) / 128²=16,384 / **256²=65,536
default** / 512²=262,144 (desktop "100k+").

## 4. Frame sequence (both scenes)

update(): dst.bindTarget → disable BLEND/DEPTH → update program with src texture bound
+ uniforms → FullscreenPass.draw → swap.
render(): default framebuffer, canvas viewport → fade pass (translucent black quad,
alpha = trail, SRC_ALPHA/ONE_MINUS_SRC_ALPHA — same trails mechanism as lissajous;
relies on preserveDrawingBuffer:true) → point pass: blendFunc(ONE, ONE) additive
premultiplied, render program with src texture, empty VAO, drawArrays(POINTS, 0, N).
All uniforms derive only from ctx.frame and ctx.signals.

## 5. Scene 1 — Flow field

State (px,py,vx,vy). Init CPU with mulberry32(seed): p ∈ [-1.5,1.5]² uniform, v = 0.

Field: 2-octave scalar potential ψ from hash32 2D value noise; velocity target = 2D
curl (∂ψ/∂y, −∂ψ/∂x) — divergence-free. Finite difference **ε = 0.01** (validated
converged: mean|curl| 0.875 stable from ε=0.05 to 0.001; ε=0.5 over-smooths to 0.646).

Update fragment core (GLSL ES 3.00; uint arithmetic is mod-2³², matching Math.imul/>>>):

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize, uFrame;
uniform float uDt, uTime, uFieldScale, uDrift, uFlowSpeed, uResponse, uPulse;
out vec4 outState;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
float lattice2(int ix,int iy){ uint k = hash32(uint(ix)) ^ (uint(iy)*0x9e3779b9u); return float(hash32(k))/4294967296.0*2.0-1.0; }
float fade(float t){ return t*t*(3.0-2.0*t); }
float vnoise2(vec2 p){
  vec2 i=floor(p), f=p-i; vec2 u=vec2(fade(f.x),fade(f.y));
  int ix=int(i.x), iy=int(i.y);
  float a=lattice2(ix,iy), b=lattice2(ix+1,iy), c=lattice2(ix,iy+1), d=lattice2(ix+1,iy+1);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float psi(vec2 p, float t){
  return vnoise2(p + vec2(t, -0.6*t))
       + 0.5*vnoise2(p*2.03 + vec2(-0.7*t+31.4, t+11.1));
}
vec2 curl(vec2 p, float t){
  const float e=0.01;
  float dx = psi(p+vec2(e,0.0),t) - psi(p-vec2(e,0.0),t);
  float dy = psi(p+vec2(0.0,e),t) - psi(p-vec2(0.0,e),t);
  return vec2(dy, -dx) / (2.0*e);
}
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int idx = tc.y*uTexSize + tc.x;
  vec4 s = texelFetch(uState, tc, 0);
  vec2 p = s.xy, v = s.zw;
  vec2 target = curl(p*uFieldScale, uTime*uDrift) * uFlowSpeed;
  target += -p * uPulse;                       // onset impulse: centre attraction
  float a = 1.0 - exp(-uResponse*uDt);         // unconditionally stable
  v += (target - v) * a;
  p += v * uDt;
  if(abs(p.x)>1.5 || abs(p.y)>1.5){            // deterministic respawn keyed (idx, frame)
    uint fs = uint(idx)*2u ^ (uint(uFrame)*0x9e3779b9u);
    p = vec2(float(hash32(fs)), float(hash32(fs+1u)))/4294967296.0 * 2.8 - 1.4;
    v = vec2(0.0);
  }
  outState = vec4(p, v);
}
```

Render VS (min-axis aspect fit, same convention as lissajous):

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int uTexSize;
uniform float uAspect, uPointSize, uResHeight;
out float vSpeed;
void main(){
  int i = gl_VertexID;
  vec4 s = texelFetch(uState, ivec2(i % uTexSize, i / uTexSize), 0);
  vSpeed = length(s.zw);
  vec2 p = s.xy;
  p.x /= max(uAspect,1.0);
  p.y *= min(uAspect,1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight/360.0, 1.0);
}
```

Render FS (premultiplied additive, hue from speed):

```glsl
#version 300 es
precision highp float;
in float vSpeed;
uniform float uHueShift, uFalloff;   // uFalloff ~4.0
out vec4 outColor;
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
void main(){
  vec2 d = gl_PointCoord*2.0-1.0;
  float r2 = dot(d,d);
  if(r2 > 1.0) discard;
  float alpha = exp(-r2*uFalloff);
  vec3 col = hsv2rgb(vec3(fract(uHueShift + vSpeed*0.5), 0.85, 1.0));
  outColor = vec4(col*alpha, alpha);
}
```

Params: count 4096–262144 (default 65536, snaps); fieldScale 0.5–6 (2.0); flowSpeed
0–2 (0.6); drift 0–2 (0.3); response 0.5–8 (3.0); pointSize 1–6 (2.0); trail 0.02–0.5
(0.12); hueShift 0–1 (0.55).

Signal reactivity (read in update(), zero user setup): `uFlowSpeed = flowSpeed·(1+0.8·bass)`;
`uFieldScale = fieldScale·(1+0.25·high)`; `uPulse`: CPU envelope
`pulse = pulse·exp(−6·dt) + 2.5·onset`, clamp ≤ 3.

## 6. Count re-init semantics (decisive)

`setParam('count', v)`: snap to ladder; if changed, at the top of next update() call
`pp.resize(newSide, seedState(seed, N))` regenerating frame-0 CPU seed data from the
stored seed. A count change is a hard swarm reset to seed positions (a visible
performative "reset burst") — recorded as an ordinary param event, so replay re-seeds
identically. You cannot deterministically resample a chaotic swarm; this is the only
self-consistent choice.

## 7. Scene 2 — Lorenz attractor

State (x,y,z,age). σ=10, ρ=28, β=8/3 (canonical, bounded).

Init (CPU, deterministic): integrate a reference RK2 trajectory (h=0.005), warm up
2000 steps, place particle i at trajectory point after i strides of 3 steps + ±0.02
mulberry32 perturbation per axis; age = i/N. Distributes the swarm along the whole
butterfly from frame 0 (validated extent x∈[-18.7,18], y∈[-25.5,24.3], z∈[3.6,46.2],
unchanged after 300 frames) — structure exists at frame 1.

Update fragment core:

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uDt, uSpeed;
out vec4 outState;
vec3 deriv(vec3 s){ return vec3(10.0*(s.y-s.x), s.x*(28.0-s.z)-s.y, s.x*s.y-(8.0/3.0)*s.z); }
void main(){
  vec4 st = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  vec3 s = st.xyz;
  float h = uSpeed*uDt/4.0;
  for(int i=0;i<4;i++){          // fixed bound → fully unrolled
    vec3 k1 = deriv(s);
    vec3 k2 = deriv(s + 0.5*h*k1);
    s += h*k2;
  }
  outState = vec4(s, st.a);
}
```

Render VS — centre (0,0,25), rotation about vertical, project (rotatedX, z−25),
base scale 1/32 (0.84 NDC fit) × projScale:

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int uTexSize;
uniform float uAngle, uScale, uAspect, uPointSize, uResHeight;
out float vZ;
void main(){
  int i = gl_VertexID;
  vec3 s = texelFetch(uState, ivec2(i % uTexSize, i / uTexSize), 0).xyz;
  float ca=cos(uAngle), sa=sin(uAngle);
  float rx = s.x*ca - s.y*sa;
  vec2 p = vec2(rx, s.z-25.0) * uScale;    // uScale = 0.03125 * projScale
  vZ = (s.z-25.0)/25.0;
  p.x /= max(uAspect,1.0);
  p.y *= min(uAspect,1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight/360.0, 1.0);
}
```

Render FS: same premultiplied-additive hsv2rgb sprite; hue from height
(`fract(uHueShift + 0.15*vZ)`, sat 0.8); `alpha = exp(-r2*uFalloff) * uBrightness`.

Params: count (ladder, 65536); speed 0.1–3 (1.0); rotSpeed 0–1 (0.15 rad/s);
projScale 0.5–2 (1.0); pointSize 1–6 (2.0); trail 0.02–0.5 (0.10); brightness 0.2–2
(1.0); hueShift 0–1 (0.6).

`uAngle = time·rotSpeed` (transport time only). Reactivity:
`uSpeed = clamp(speed·(0.6+0.8·rms), 0.1, 3)` (clamp keeps the validated-bounded
range); `uBrightness = brightness·(0.7+0.6·bass) + flash` with CPU envelope
`flash = flash·exp(−8·dt) + 0.8·onset`.

## 8. Golden strategy on SwiftShader

SwiftShader is bit-deterministic on a pinned Chromium: same-machine runs are
byte-identical regardless of frame count. The asymmetry is CHAOS AMPLIFICATION across
future Chromium bumps: a 1-ULP transcendental shift diverges the Lorenz microstate
exponentially — bounded at frame 60 (~2 Lyapunov times), unrecognizable by 120. The
flow field is non-chaotic (relaxation contracts; respawn recycles).

Decisions: **flow field snapshots at frame 90; Lorenz at frame 60**; keep global
maxDiffPixelRatio 0.03; the Lorenz golden is defined to be regenerated on any Chromium
bump (existing policy).

## 9. Test plan

Goldens (seed 42): flowfield f90 at 640×360 / 360×640 / 480×480; lorenz f60 at the
same three sizes (aspect hard-rule enforcement). Non-blank: lit pixels > 2000 at the
snapshot frames. Determinism: two-run pixelHash equality via loadSession re-init (both
scenes). Behavioral: animation live (hash f30 ≠ f90); count re-init deterministic and
visually distinct; onset impulse responds (setInputSignal('onset',1) at frame 40
changes the hash vs an unpulsed run). Capability: checkFloatRenderable ok under
SwiftShader; init on a context lacking EXT_color_buffer_float throws naming the
extension.

## 10. hash32 cross-check (GLSL must equal DSL — bit-exact references)

```
hash32(0)          = 33350994      (0x01fce552)
hash32(1)          = 2672842292    (0x9f505634)
hash32(2)          = 127880910     (0x079f4ece)
hash32(1000)       = 937878766     (0x37e6e4ee)
hash32(4294967295) = 2767685996    (0xa4f7896c)
lattice2(0,0) =  0.250534   lattice2(1,0) = -0.461619   lattice2(0,1) = 0.244613
lattice2(-1,-1)= 0.354086   lattice2(5,7) = -0.673272
```
