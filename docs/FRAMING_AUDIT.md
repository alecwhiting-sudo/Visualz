# Framing audit — every scene vs. Scene Contract F1–F4

Audit of all 24 builtin scenes + the composite container against the Framing
rules (docs/SCENE_CONTRACT.md), taken before any scene migration for the
canvas-format feature (16:9 / 9:16 / 1:1). Classes: **conformant** (declare
`meta.framing`, no visual change), **mechanical migration** (F1/F2/F3 rewrite,
golden regenerated, no design questions), **design pass** (portrait
composition is an aesthetic decision — needs eyes).

## A. Conformant today — declaration-only

| Scene | Why it already holds |
|---|---|
| cymatics | Field evaluated everywhere; min-axis scale; long axis shows more plate |
| morphogen | Same full-bleed min-axis pattern (all four generators defined for any p) |
| resonance | Same; doc comment even states the unbounded-domain intent |
| mandeldive | Full-bleed plane eval; at dive depth structure fills any frame |
| orbitdive | Full-bleed plane eval with interior ember floor (no dead black) |
| physarum | COVER mapping (the documented reference); toroidal domain, seam off-screen |
| waves | COVER mapping; Dirichlet walls live at sim edge, cropped by cover |
| glyphrain | The F1 model: `columns = round(param × aspect)` — grid genuinely tiles any frame |
| guilloche | Bounded curve *engineered* full-bleed (per-axis envelope to BLEED=0.94) |
| whipline | Physics already runs on the real frame rect: `Wx=max(aspect,1), Wy=max(1/aspect,1)` — F1/F2 avant la lettre |
| whipstorm | Same full-rect wall-bounce physics |
| fluidink | Sim grid sized to the surface aspect at init (F1) so dye already covers the frame 1:1, no crop/letterbox map needed; splat/ambient/wind-cell distances aspect-corrected (`uAspect`) so they're circular/square at every format instead of stretched |

`framing` declarations: all `'field'` except guilloche / whipline / whipstorm
(`'bounded'` — composed objects that happen to fill the frame; band-coverage
still expected to pass but not contractually required).

## B. Mechanical migrations (F1/F2/F3 — no design questions)

1. **flowfield** — the flagship. FIT map + fixed respawn box `abs(p)>1.5`
   means: portrait swarm is an inscribed square band, and the respawn wall
   lands visibly inside the frame on the long axis. Migrate: domain extents
   `(hx,hy)` from aspect (F1), respawn bound + CPU seed from extents (F2),
   point size `uResHeight/360` → short-axis key (F3), render map becomes
   identity-per-axis over the extended domain.
2. **grayscott** — the only true letterbox (flat bg painted outside the
   square). Adopt waves/physarum's COVER map; sim grid stays 256² (Neumann
   walls then sit outside the crop on the long axis).
3. **kaleido** — square 512² sim shown with CLAMP_TO_EDGE smear on the long
   axis. Adopt COVER map (radial feedback field crops naturally). Smear was
   never a designed look.
4. **attractor, photoswarm** — F3 only: `uResHeight/720` / `uResHeight/360`
   point-size keys → short axis. (Their FIT composition is a design pass, C.)
5. **Aspect-source fixes** — orrery (`gpu.canvas` at computeJoints),
   whipline (`gpu.width` in init/update), whipstorm (same) read the canvas
   instead of the passed surface. Identical behaviour today (composite child
   targets match the canvas), so this is a latent-bug fix with **no golden
   change** — its own commit.

Order: 5 (invisible, de-risks composite) → 1 → 2 → 3 → 4. One scene per
commit, golden regenerated and eyeballed per commit, band-coverage test added
with each `'field'` declaration.

## C. Design passes (portrait composition needs eyes — with the user)

| Scene | The decision |
|---|---|
| terrain | COLS=28 fixed → derive column count/spacing from aspect (glyphrain's move)? Changes 16:9 too (wider floor) |
| starflight | FIT star plane → extend spawn plane x/y to frame extents (F1 fits naturally); density then aspect-compensated |
| attractor | Centred trajectory: portrait = gutters above/below. Accept (it's an object) or scale-to-fill? |
| lissajous | Same centred-curve question; guilloche's per-axis envelope is the precedent if we want fill |
| glyphlattice | Inscribed lattice at 0.82 short axis; also has anisotropic NDC glyph extents worth a pixel-space fix |
| neuralweb | Containment circle keyed to short axis → portrait empty top/bottom. Elliptical bound? Bigger circle + cover? |
| julia | Set is a centred object with black far field; zoom already covers it live. Likely accept as bounded |
| tunnel | Radially centred by construction; portrait fine. Accept as bounded |
| orrery | Machine on a disc (REACH=0.82). Accept as bounded |
| photoswarm | Image has intrinsic aspect; double-fit (image then screen) is arguably correct. Accept as bounded |

## D. Cross-cutting notes

- Point-size keying today splits three ways (height-keyed, constant-px,
  pixel-uniform CPU quads). F3 standard: short axis (or sqrt(w·h)). The
  constant-px scenes (starflight, neuralweb, whipstorm sparks) are a
  *resolution* inconsistency, not a format one — out of scope here.
- whipline/whipstorm ribbon half-width is fixed NDC (anisotropic at
  aspect≠1); guilloche/orrery's pixel-space extrusion is the fix pattern if
  it ever bothers anyone. Not format-blocking.
- composite forwards params and shaders to children but not `ingest` — known
  gap, unrelated to formats.
- Ingest is non-square-safe in tunnel and photoswarm, square-assuming in
  flowfield/kaleido/grayscott — portrait handoff snapshots will be squashed
  into square fields there. Acceptable (it seeds a sim, not a picture);
  noted for the flowfield migration.
