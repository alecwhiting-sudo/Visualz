# Gray-Scott Reaction-Diffusion — Scene Spec

Reasoner design (2026-07-15), accepted by the architect. Target:
`src/scenes/builtin/grayscott.ts` (family `'simulation'` — SceneMeta.family union is
extended by architect decision), reusing targets.ts unchanged. All numerics validated
in scratch CPU mirrors of the exact GLSL.

## 0. Executive decisions

| Fork | Decision | Why (validated) |
|---|---|---|
| State layout | RGBA32F ping-pong, `.r=U`, `.g=V`, `.b=0`, `.a=1` reserved | 2 floats needed; format mandated by targets.ts; NEAREST/texelFetch per convention |
| Diffusion | **Du=1.0, Dv=0.5** (Karl-Sims convention) | Makes the standard Pearson F/k catalog land in its named regimes |
| Laplacian | **9-point** (center −1, orthogonal 0.2, diagonal 0.05) | 5-point's axis anisotropy turns spots into diamonds; +4 fetches is cheap |
| Integration | Explicit Euler, dt_sub=1.0, **16 fixed substeps = 16 ping-pong draws/frame** | Substeps must be separate passes (neighbor staleness); dt=1.0 well inside the cliff (clean ≤1.15, NaN at 1.24) |
| Clock | **Frame-clocked, NOT dt-clocked** — reaction ignores frame.dt | Euler is conditionally stable so dt_sub must be constant; 30fps render and 60fps live are byte-identical per frame index (stricter than flowfield, whose integrator is unconditionally stable) |
| Sim resolution | Fixed **256²** ship; goldens bake **128²** via `?grid=` | 512² ≈ 8× golden cost for no visual gain; grid size is the art (feature scale), not a quality knob |
| Seed | Spots-only (~18 strong V-blobs), U=1 background | RD is contractive once pinned: deterministic nuclei lock the layout → cross-build robust |
| Display | One fullscreen pass: manual-bilinear V + gradient emboss, min-axis square fit | State is NEAREST float; hand bilinear (4 fetch + mix) upscales 256² smoothly. No fade pass — the field IS the state |

## 1. Validated numerics

- Stability cliff (Du=1.0): clean through dt=1.15; 1.20 marginal; **1.24 → NaN**. Speed knob hard-capped at 1.10.
- Boundedness: every corner of F∈[0.01,0.09]×k∈[0.04,0.07] BOUNDED over 15k steps (worst vMax ≤ 0.45, zero NaN). Gray-Scott is mass-limited — it structurally cannot explode at dt ≤ 1.15; worst failure is graceful death to uniform color.
- Cross-build determinism: RD is **contractive, not chaotic** — a pessimistic 1e-6/step perturbation decays (after 1536 steps max|ΔV|=1.3e-4, 0 pixels differ >0.05). The reaction shader has no transcendentals. Goldens need NO per-Chromium-bump regeneration policy (contrast Lorenz).
- Audio stress: droplets every frame + max feed modulation + dt=1.1 over 12k steps → bounded (vMax 0.63, 0 NaN), pattern stays lively.

## 2. Presets & ranges

Du=1.0/Dv=0.5/dt=1.0, all validated alive. **Default = Coral.**

| Preset | F | k | Look |
|---|---|---|---|
| **Coral** (default) | 0.0545 | 0.0620 | branching coral |
| Mitosis | 0.0367 | 0.0649 | dividing dots |
| Solitons | 0.0300 | 0.0620 | drifting blobs |
| Worms | 0.0390 | 0.0580 | connected labyrinth |

(The folklore Worms F=0.078/k=0.061 dies at this Du — excluded.)

Knob ranges: `F ∈ [0.020, 0.060]`, `k ∈ [0.050, 0.066]`. The alive region is a curved
arc, so 3 corners of the box go uniform-dead — allowed (valid non-crashing state, no
clamp); presets are the safe anchors.

## 3. Params (8)

| name | label | min | max | default |
|---|---|---|---|---|
| feed | Feed rate (F) | 0.020 | 0.060 | 0.0545 |
| kill | Kill rate (k) | 0.050 | 0.066 | 0.0620 |
| speed | Evolution speed | 0.30 | 1.10 | 1.0 (multiplies dt_sub, hard cap 1.10, N stays 16) |
| dropletSize | Onset droplet size | 0.010 | 0.060 | 0.030 |
| hueShift | Hue | 0 | 1 | 0.55 |
| hueSpread | Hue spread | 0 | 1 | 0.35 |
| emboss | Relief depth | 0 | 1 | 0.5 |
| brightness | Brightness | 0.3 | 2.0 | 1.0 |

No count (fixed grid), no trail.

## 4. `update-fs` (one Euler substep; run 16×/frame ping-ponging)

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize, uFrame;
uniform float uF, uK, uDu, uDv, uDt, uInject, uDropRadius;
out vec4 outState;

const int DROPS = 6;
uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }

vec2 rg(ivec2 c){                     // clamped fetch => Neumann (zero-flux) boundary
  c = clamp(c, ivec2(0), ivec2(uTexSize-1));
  return texelFetch(uState, c, 0).rg;
}
void main(){
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 s = texelFetch(uState, tc, 0).rg;
  float U = s.r, V = s.g;
  vec2 lap =
      0.2  * (rg(tc+ivec2(1,0)) + rg(tc+ivec2(-1,0)) + rg(tc+ivec2(0,1)) + rg(tc+ivec2(0,-1)))
    + 0.05 * (rg(tc+ivec2(1,1)) + rg(tc+ivec2(-1,1)) + rg(tc+ivec2(1,-1)) + rg(tc+ivec2(-1,-1)))
    - s;
  float uvv = U*V*V;
  float Un = U + (uDu*lap.r - uvv + uF*(1.0 - U)) * uDt;
  float Vn = V + (uDv*lap.g + uvv - (uF + uK)*V) * uDt;
  if (uInject > 0.5) {                // onset droplets, substep 0 only
    vec2 pos = (vec2(tc) + 0.5) / float(uTexSize);
    for (int d = 0; d < DROPS; d++) {
      uint h = hash32(uint(uFrame)*0x9e3779b9u + uint(d)*0x2c1b3c6du);
      vec2 c = vec2(float(hash32(h)), float(hash32(h+1u))) / 4294967296.0;
      if (distance(pos, c) < uDropRadius) { Vn = max(Vn, 0.5); Un = min(Un, 0.3); }
    }
  }
  outState = vec4(Un, Vn, 0.0, 1.0);
}
```

## 5. `render-fs` (single opaque fullscreen display pass)

```glsl
#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int   uTexSize;
uniform vec2  uRes;
uniform float uAspect, uHueShift, uHueSpread, uBrightness, uEmboss, uWarp, uWarpPhase;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

float Vat(vec2 st){                   // manual bilinear from NEAREST float texture
  vec2 t = st*float(uTexSize) - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i); ivec2 mx = ivec2(uTexSize-1);
  float v00=texelFetch(uState,clamp(i,           ivec2(0),mx),0).g;
  float v10=texelFetch(uState,clamp(i+ivec2(1,0),ivec2(0),mx),0).g;
  float v01=texelFetch(uState,clamp(i+ivec2(0,1),ivec2(0),mx),0).g;
  float v11=texelFetch(uState,clamp(i+ivec2(1,1),ivec2(0),mx),0).g;
  return mix(mix(v00,v10,f.x), mix(v01,v11,f.x), f.y);
}
void main(){
  vec2 ndc = (gl_FragCoord.xy/uRes)*2.0 - 1.0;
  ndc.x *= max(uAspect,1.0);          // invert the min-axis fit -> square sim space
  ndc.y /= min(uAspect,1.0);
  vec2 st = ndc*0.5 + 0.5;
  st += uWarp * vec2(sin((st.y+uWarpPhase)*6.2831), cos((st.x+uWarpPhase)*6.2831));
  if (any(lessThan(st, vec2(0.0))) || any(greaterThan(st, vec2(1.0)))) { outColor = vec4(0.02,0.02,0.03,1.0); return; }
  float v = Vat(st);
  float tx = 1.0/float(uTexSize);
  float gx = Vat(st+vec2(tx,0.0)) - Vat(st-vec2(tx,0.0));
  float gy = Vat(st+vec2(0.0,tx)) - Vat(st-vec2(0.0,tx));
  vec3 n = normalize(vec3(-gx, -gy, uEmboss*0.15 + 1e-3));
  float shade = mix(1.0, clamp(dot(n, normalize(vec3(-0.5,-0.5,1.0))),0.0,1.0), uEmboss);
  float vv = clamp(v/0.45, 0.0, 1.0);
  vec3 col = hsv2rgb(vec3(fract(uHueShift + uHueSpread*vv), 0.7, 1.0)) * vv;
  outColor = vec4(col * shade * uBrightness, 1.0);
}
```

Background (0.02,0.02,0.03) sums <30/255 — doesn't trip the non-blank guard.

## 6. Seed & JS frame sequence

Seed: U=1,V=0 everywhere; 18 spots from mulberry32(seed) — center (rng·side, rng·side),
radius 3 + rng·6 texels, inside: U=0.5, V=0.25. Upload as PingPong initial.

update(ctx) — frame-clocked, frame.dt UNUSED:
```
uF = clamp(feed * (1 + 0.15*bass), 0.020, 0.062)
disable BLEND/DEPTH
for i in 0..15:
  dst.bindTarget(); update program; src texture
  uniforms incl. uDt = clamp(speed, 0.3, 1.1); uInject = (i==0 && onset>0.5) ? 1 : 0
  fsPass.draw(); pp.swap()
```
render(ctx): surface.bind(); disable BLEND; display program on pp.src;
uWarp = 0.004, uWarpPhase = beatPhase.

## 7. Goldens

Frame **96** (1536 steps), default Coral, at the baked `?grid=128`. Standard
maxDiffPixelRatio 0.03; NOT flagged for Chromium-bump regeneration (contractive,
transcendental-free).

## 8. Test plan

Seed determinism (unit CPU: byte-equal same seed, differs across seeds); golden triplet
at 3 aspects (?grid=128); two-run loadSession hash determinism at f96; animation-live
(f48 ≠ f96); onset-droplet divergence (pulse at f40); silence non-death (all signals 0:
lit > 2000 at f96 AND f300); non-blank at f96 all aspects; sustained bass=1 for 300
frames bounded + deterministic; seed→layout (seed 42 ≠ seed 7 at f96); capability throw
naming EXT_color_buffer_float.

## 9. Accepted flags

1. `SceneMeta.family` union extended with `'simulation'` (architect-approved — the
   deferred family from REQUIREMENTS §3.2 arrives).
2. `?grid=` test-mode override in hooks.ts (builder scope).
3. No SceneRuntime.reset() — same accepted position as PARTICLES §0.
