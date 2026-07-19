/**
 * CODE tab task: plain-language explainers for every editable shader stage of
 * every built-in scene — REQUIREMENTS.md §3.1 layer 3 ("Code") says edits
 * "hot-recompile, see it live" but says nothing about *understanding* what's
 * there before you edit it; this is that missing rung. Keyed by
 * `SceneMeta.id` (registry key) then `ShaderStage.key` (as returned by
 * `SceneRuntime.getShaderSources()`), so `ShaderPanel` (src/app/App.tsx) can
 * look a doc up by whatever scene+stage is currently selected and hide its
 * disclosure entirely when there isn't one (composite `blend-*` scenes have
 * no entry here at all, by design — their children's docs would need a
 * prefix-aware lookup this task doesn't ask for).
 *
 * `tryThis[].target` is a contract, not prose: it MUST be an exact substring
 * of the corresponding stage's CURRENT stock GLSL source (verified verbatim,
 * not just "a plausible-looking snippet") — tests/unit/shaderDocs.test.ts
 * greps every one of these against a freshly-constructed scene's
 * `getShaderSources()` output. A doc pointing at code that isn't there is
 * worse than no doc at all, per the task brief.
 */

export interface ShaderDocTryThis {
  /** An exact, verbatim substring of the stage's stock GLSL source. */
  target: string
  /** One sentence: what changing `target` does, with a concrete suggestion. */
  effect: string
}

export interface ShaderDocEntry {
  /** 2-4 plain-language sentences on what the maths does, for a curious non-expert. */
  summary: string
  tryThis: ShaderDocTryThis[]
}

/** sceneId -> stageKey -> doc. */
export const SHADER_DOCS: Record<string, Record<string, ShaderDocEntry>> = {
  lissajous: {
    'line-fs': {
      summary:
        "Every frame the Lissajous curve is drawn as a single connected line strip in one flat color — the scene computes that color on the CPU by cycling smoothly through the hue wheel and hands it in as a uniform. This shader itself does no maths beyond outputting that color at full opacity for every pixel of the line.",
      tryThis: [
        {
          target: 'uColor',
          effect:
            'this is fed a hue-cycling color from the CPU every frame; replace it with a fixed color like vec3(1.0, 0.4, 0.0) to lock the curve to one color instead of cycling through the rainbow.',
        },
        {
          target: 'vec4(uColor, 1.0)',
          effect:
            "the 1.0 is the line's opacity; lower it to e.g. 0.4 to make the curve itself semi-transparent, blending with the fading trail underneath instead of drawing solid.",
        },
        {
          target: 'outColor = vec4(uColor, 1.0);',
          effect:
            'replace the whole line with `outColor = vec4(uColor * 1.5, 1.0);` to push the color past 1.0 for a blown-out, glowing look once combined with the trail fade below.',
        },
      ],
    },
    'fade-fs': {
      summary:
        "This pass doesn't draw the curve at all — it draws one dark, nearly-transparent rectangle over the whole canvas every frame, which is what leaves fading trails behind the moving curve instead of a solid wipe to black each frame.",
      tryThis: [
        {
          target: 'vec4(0.0, 0.0, 0.0, uFade)',
          effect:
            'the three 0.0s are the fade color\'s RGB; change them to something like 0.05, 0.0, 0.08 to leave a dark violet tint behind instead of fading to pure black.',
        },
        {
          target: 'uFade',
          effect:
            'already controlled by the Trail fade knob; multiplying it here, e.g. `uFade * 0.5`, halves the fade rate independent of the knob\'s own range.',
        },
        {
          target: 'void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }',
          effect:
            "swap the whole body for `outColor = vec4(0.0, 0.0, 0.0, 1.0);` to make trails vanish instantly every frame (a hard cut instead of a fade), regardless of the knob.",
        },
      ],
    },
  },

  flowfield: {
    'update-fs': {
      summary:
        "Each particle carries a position and velocity in a ping-ponged texture. Every frame this shader samples a smooth 2D noise field (built from two layered octaves of hashed lattice noise) and takes its curl — the perpendicular gradient — to get a divergence-free flow direction, like following contour lines on a weather map, so particles swirl without ever bunching up. An audio onset briefly pulls everything toward the centre before the flow pushes it back out, and particles that wander too far off-screen respawn at a fresh, deterministically seeded spot.",
      tryThis: [
        {
          target: 'const float e=0.01;',
          effect:
            "e is the finite-difference step used to compute the curl (the flow's swirliness) from the noise potential; a bigger step like 0.05 blurs the flow into smoother, larger swirls, a smaller one like 0.002 sharpens it into fine eddies.",
        },
        {
          target: 'target += -p * uPulse;',
          effect:
            'this pulls every particle straight toward the center on an audio onset; delete the leading "-" to make onsets push particles AWAY from center instead — an explosion instead of an implosion.',
        },
        {
          target: 'if(abs(p.x)>1.5 || abs(p.y)>1.5){',
          effect:
            'particles that wander past ±1.5 in flow-space respawn at a random spot; shrink 1.5 to 0.8 to keep the swarm tighter to the visible frame, or grow it to 3.0 to let particles roam further off-screen first.',
        },
        {
          target: 'p = vec2(float(hash32(fs)), float(hash32(fs+1u)))/4294967296.0 * 2.8 - 1.4;',
          effect:
            'respawn positions are drawn uniformly over a 2.8-wide square centered on the origin; shrink both the 2.8 and 1.4 (keeping 1.4 = half of 2.8) to respawn particles closer to the middle of the screen.',
        },
        {
          target: 'float a = 1.0 - exp(-uResponse*uDt);',
          effect:
            "this is the smoothing factor the Response knob controls, blending velocity toward the flow's target direction; try squaring it, `uResponse*uResponse*uDt`, to make high Response values snap much harder.",
        },
      ],
    },
    'render-fs': {
      summary:
        'Each particle is drawn as a soft circular point sprite whose color cycles hue with its own speed — fast-moving particles read as a different color from slow ones. Pixels outside a unit circle around the point are discarded and the rest fade toward transparent at the edge, giving each dot a soft glow instead of a hard square.',
      tryThis: [
        {
          target: 'if(r2 > 1.0) discard;',
          effect:
            'this crops each point sprite to a circle; change 1.0 to 0.3 for tiny, sharp dot centers only, or remove the whole line to draw square particles instead.',
        },
        {
          target: 'vSpeed*0.5',
          effect:
            "how strongly a particle's speed shifts its hue; raise the 0.5 to 2.0 so fast particles cycle through many more colors, or drop it toward 0.0 for a single steady hue regardless of speed.",
        },
        {
          target: 'hsv2rgb(vec3(fract(uHueShift + vSpeed*0.5), 0.85, 1.0))',
          effect:
            'the 0.85 is saturation; lower it toward 0.3 for washed-out pastel particles, or push it to 1.0 for maximally vivid color.',
        },
        {
          target: 'float alpha = exp(-r2*uFalloff);',
          effect:
            'the soft-edge falloff curve; wrapping it as `exp(-r2*uFalloff*uFalloff)` makes the Falloff-driven edge fade much more aggressively for the same knob range.',
        },
      ],
    },
  },

  julia: {
    'render-fs': {
      summary:
        "Julia sets are drawn by repeatedly squaring a complex number z (starting at the pixel's own position) and adding a fixed constant c, which slowly orbits in a circle over time — pixels whose z spirals off toward infinity are colored by roughly how many iterations that took (the escape time), and pixels that never escape stay black. A layer of 2D noise is added to the coordinates before iterating (the domain warp), bending the whole fractal as if it were printed on rippling fabric.",
      tryThis: [
        {
          target: 'const int ITER = 96;',
          effect:
            'the maximum number of squaring iterations per pixel; raising it to 200 sharpens fine boundary detail (and costs more GPU time), lowering it to 32 speeds things up but blurs the finest filaments.',
        },
        {
          target: 'p += uWarp * vec2(vnoise2(p*2.0 + uTime), vnoise2(p*2.0 - uTime));',
          effect:
            "the domain warp is already knob-controlled (Domain warp), but the 2.0 frequency multiplier sets the warp's own texture scale — raise it for finer, busier ripples, lower it for broad, slow bends.",
        },
        {
          target: 'if (m2 > 16.0) {',
          effect:
            'the escape radius (squared): once |z|² passes this, the pixel is considered "escaped". Raising it to 400.0 gives smoother color gradients at the cost of a few more iterations before escape is detected.',
        },
        {
          target: 'float hue = fract(uHueShift + pow(t, 0.65) * uHueSpread);',
          effect:
            'the 0.65 exponent compresses or expands the escape-time gradient; try 0.3 to push most of the hue range toward the outer, slow-escaping pixels, or 1.5 to concentrate it near the boundary.',
        },
        {
          target: 'float glow = 0.08 + pow(t, 0.9) * 1.6;',
          effect:
            "0.08 is the darkest glow (deep in the set's interior-adjacent boundary) and 1.6 is the brightness gain; raise 0.08 for a visible floor everywhere, or push 1.6 higher for a hotter, more overexposed edge.",
        },
      ],
    },
  },

  mandeldive: {
    'render-fs': {
      summary:
        "The Mandelbrot set: for every pixel c — a point on the complex plane near a curated \"dive\" location — this repeatedly computes z = z² + c starting from z = 0, and the number of iterations before |z| escapes gives that pixel's color, which is how the famous fractal boundary emerges. Unlike Julia, c varies per pixel while z always starts at zero. A slow audio-reactive \"zoom breath\" pushes the camera deeper into the fractal and back out, and a bright \"orbit trap\" glow highlights points whose path during iteration passes close to a fixed reference point.",
      tryThis: [
        {
          target: 'const int MAX_ITER = 200;',
          effect:
            'the hard cap on iterations per pixel (paired with the CPU-side depth-dependent iteration budget); raising it lets very deep zooms resolve more detail before falling back to a flat interior color, at a real GPU cost.',
        },
        {
          target: 'const float ESCAPE_R2 = 16.0;',
          effect:
            'the squared escape radius; raising it to 400.0 gives smoother color bands along the boundary at the cost of a couple more iterations per escaping pixel.',
        },
        {
          target: 'const vec2 TRAP_POINT = vec2(0.0, 0.25);',
          effect:
            "the fixed point the orbit-trap glow measures distance to; move it (try vec2(-0.1, 0.1)) to shift where in the fractal the glowing highlight tends to land.",
        },
        {
          target: 'float trapGlow = clamp(uTrapMix * exp(-minDist * 8.0), 0.0, 1.0);',
          effect:
            'the 8.0 controls how tightly the trap glow hugs the trap point; lower it to 3.0 for a wider, softer halo, or raise it to 20.0 for a thin, precise highlight.',
        },
        {
          target: 'float glow = 0.08 + pow(t, 0.9) * 1.6;',
          effect:
            'the same escape-shading curve Julia Warp uses: 0.08 is the dark floor, 1.6 the brightness gain — raise 1.6 for a hotter boundary glow.',
        },
      ],
    },
  },

  morph: {
    'render-fs': {
      summary:
        "Four different pattern generators — wave interference, a phyllotaxis spiral (the sunflower-seed packing pattern), a six-fold kaleidoscope fold, and warped flow noise — are each computed for every pixel, every frame. A slow \"journey\" phase continuously cross-fades between whichever two are next in the cycle, so the whole scene morphs from one mathematical pattern into the next rather than cutting between them.",
      tryThis: [
        {
          target: 'return pow(band, 3.0);',
          effect:
            'in the wave-interference generator, this sharpens the interference bands; raise 3.0 to 6.0 for thinner, brighter fringes, or lower it to 1.0 for broad, soft waves.',
        },
        {
          target: 'float u = sqrt(max(r, 0.0)) * scale * 3.0 - time * 0.15;',
          effect:
            "the sqrt spacing is what gives phyllotaxis its even sunflower-seed packing; raise the 3.0 to spread the seeds further apart, or change 0.15 to speed up/slow down how fast the spiral seems to grow outward.",
        },
        {
          target: 'float seg = PI / 3.0;',
          effect:
            'this is what makes the hex-fold generator six-fold symmetric (PI/3 = 60°); try PI / 4.0 for eight-fold (octagonal) symmetry or PI / 5.0 for ten-fold.',
        },
        {
          target: 'float n = vnoise2(q) + 0.5 * vnoise2(q * 2.03 + vec2(17.3, -9.1));',
          effect:
            'a second, finer noise octave layered at half strength on top of the main flow field; raise 0.5 toward 1.0 for a busier, more turbulent texture.',
        },
        {
          target: 'float hue = fract(uHueShift + intensity * uHueSpread + uJourney * 0.13);',
          effect:
            "the 0.13 makes the base hue itself drift slowly as the journey advances, so even the same pattern never repeats its exact palette; raise it for a faster color drift across the whole journey.",
        },
      ],
    },
  },

  tunnel: {
    'render-fs': {
      summary:
        "Every pixel's polar angle and radius are mapped to a position (\"depth\") down an infinite tube — the radius is inverted (1/r) so the center of the screen reads as far away and the edges as close, and time pushes everything steadily down the tube. A 512-frame rolling history of the audio's bass/mid/high/rms levels is looked up at each pixel's computed depth, so the rings and colors on screen at any moment are literally the recent audio timeline stretched out along the tunnel's length.",
      tryThis: [
        {
          target: 'const float TUBE_RADIUS = 0.35;',
          effect:
            "the base radius the depth calculation pivots around; a bigger value like 0.6 widens the tunnel's throat (feels closer/wider), a smaller one like 0.15 narrows it into a tight tube.",
        },
        {
          target: 'const float ROT_SPEED = 0.15;',
          effect:
            'a constant background twist rate applied on top of the Twist knob; raise it for a faster baseline spin even when Twist is turned down.',
        },
        {
          target: 'float band = sin(depth2 * float(uRings));',
          effect:
            "wrap this in abs(), i.e. `abs(sin(depth2 * float(uRings)))`, for a different ring-banding style — sharper, evenly-spaced rings instead of smoothly alternating bright/dark ones.",
        },
        {
          target: 'brightness *= 0.75 + 0.25 * sin(aTw * float(uSpokes) + depth2);',
          effect:
            'the 0.75/0.25 mix sets how deep the spoke shadows cut; try 0.5 + 0.5 * ... for much darker, more dramatic spoke shadows.',
        },
        {
          target: 'float rr = rad * (1.0 - 0.25 * bassVal);',
          effect:
            'how strongly bass compresses the tunnel radius (a "pumping" effect); raise 0.25 toward 0.6 for a much more dramatic bass-driven squeeze.',
        },
      ],
    },
  },

  kaleido: {
    'feedback-fs': {
      summary:
        "Each frame samples the PREVIOUS frame's image through a mirror-folded, spinning, zooming lookup — folding the angle around the circle into one wedge and mirroring it repeatedly is what creates the classic kaleidoscope symmetry — then fades it slightly and adds a fresh ring of glowing seed blobs so the loop never fully decays to black. Because every frame feeds off the last, tiny changes compound over time into constantly evolving mandala-like patterns.",
      tryThis: [
        {
          target: 'if (af > seg * 0.5) af = seg - af;',
          effect:
            'this mirrors each wedge back onto itself, which is what makes the pattern kaleidoscope-symmetric; delete this line to make the pattern spin instead of mirror-fold, losing the mirrored symmetry entirely.',
        },
        {
          target: 'float glow = exp(-d * d * 40.0);',
          effect:
            'the seed blobs\' glow falloff; lower 40.0 to 10.0 for bigger, softer glowing blobs, or raise it to 120.0 for tiny, pinprick-sharp ones.',
        },
        {
          target: 'float blobAngle = (float(i) + 0.15 + h * 0.5) * seg + uSpin;',
          effect:
            'the 0.15/0.5 terms control how evenly-spaced vs. randomly-scattered the seed blobs are within each segment; raise the 0.5 for more scatter, or set it to 0.0 for perfectly even spacing.',
        },
        {
          target: 'const int MAX_SEGMENTS = 16;',
          effect:
            "the hard ceiling on mirrored wedges (paired with the Segments knob's own max of 16); raising both together allows more, finer mirrored wedges.",
        },
        {
          target: 'vec2 sampleUv = (folded * uZoomRate) * 0.5 + 0.5;',
          effect:
            "already driven by the Zoom rate knob, but wrapping it as `(folded * uZoomRate * uZoomRate) * 0.5 + 0.5` makes the knob's effect nonlinear — subtle near 1.0, dramatic at the extremes.",
        },
      ],
    },
    'blit-fs': {
      summary:
        "This is just a display pass: it fits the kaleidoscope's square simulation onto the screen at whatever aspect ratio the canvas actually is, then applies a small brightness curve before showing it. There's no simulation happening here at all — the actual kaleidoscope maths lives entirely in the feedback stage.",
      tryThis: [
        {
          target: 'col = pow(clamp(col, 0.0, 1.0), vec3(0.85));',
          effect:
            'a gamma-like brightness curve; raise 0.85 toward 1.5 for a darker, moodier look, or lower it toward 0.5 for a blown-out, bright look.',
        },
        {
          target: 'vec2 suv = uv * 0.5 + 0.5;',
          effect:
            "scaling uv before the 0.5+0.5 remap (e.g. `uv * 0.5 * 1.5 + 0.5`) zooms the final on-screen image independently of the simulation's own internal zoom rate.",
        },
        {
          target: 'vec3 col = texture(uSrc, suv).rgb;',
          effect:
            'sampling here is a straight passthrough; try `texture(uSrc, suv + vec2(0.01, 0.0)).rgb` for a one-off chromatic-aberration-style horizontal shift.',
        },
      ],
    },
  },

  glyphgeometry: {
    'glyph-fs': {
      summary:
        "Everything on screen is text — there are no line primitives in this scene at all. Nested rings of glyphs trace closed curves that morph between a superformula, a spirograph, and a star-rose as the Figure knob turns, each character rotated to the curve's local direction. This shader stamps each glyph: it reads the baked 5×7 bitmap font atlas as an on/off ink mask and multiplies it by the ring's color and trail alpha.",
      tryThis: [
        {
          target: 'float mask = texture(uAtlas, vUV).r;',
          effect:
            'invert with float mask = 1.0 - texture(uAtlas, vUV).r; to punch every character out as a hole in a solid block — negative-space calligraphy.',
        },
        {
          target: 'vColor.a * mask',
          effect:
            "try pow(mask, 2.0) * vColor.a to thin the strokes toward each glyph's center, so dense inner rings read as fine linework instead of blooming together.",
        },
        {
          target: 'outColor = vec4(vColor.rgb, vColor.a * mask);',
          effect:
            'try vec4(vColor.rgb * (1.0 + mask), vColor.a * mask) to give every character a hot core a step brighter than its ring color.',
        },
      ],
    },
    'fade-fs': {
      summary:
        "This pass never draws the geometry — it lays one nearly-transparent dark rectangle over the whole canvas each frame, which is what leaves the rotating text rings' motion echoes behind them instead of a hard wipe. The Trail knob feeds its opacity.",
      tryThis: [
        {
          target: 'vec4(0.0, 0.0, 0.0, uFade)',
          effect:
            'tint the fade color, e.g. vec4(0.05, 0.0, 0.08, uFade), so trails decay into a violet afterglow instead of pure black.',
        },
        {
          target: 'uFade',
          effect:
            "multiply it, e.g. uFade * 0.5, to halve the fade rate independently of the Trail knob's own range — extremely long ghosting.",
        },
        {
          target: 'void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }',
          effect:
            'swap the body for outColor = vec4(0.0, 0.0, 0.0, 1.0); to kill trails entirely — every frame a clean slate, pure crisp text geometry.',
        },
      ],
    },
  },
  waves: {
    'update-fs': {
      summary:
        "A real physics simulation: each texel stores the water height now and one step ago, and every substep applies the discrete wave equation — the new height is twice the current minus the previous plus the neighborhood curvature (the Laplacian) times the wave speed, all scaled by damping. Emitters force smooth sinusoidal ripples in, onsets drop one-shot impulses, and texels inside the rotating polygon obstacles are pinned to zero — that pinning is what makes wavefronts visibly reflect off the geometry.",
      tryThis: [
        {
          target: 'float uNext = (2.0 * u - uPrev + uC2 * lap) * uDamping;',
          effect:
            'the whole wave equation in one line; nudge the 2.0 to 2.02 for a subtly unstable, ever-livelier field, or remove the uDamping factor for lossless reflections that ring forever.',
        },
        {
          target: 'float apothem = r * cos(PI / sides);',
          effect:
            "the polygon obstacle's inscribed-radius formula; replace cos(PI / sides) with 1.0 to turn every obstacle into a perfect circle regardless of its side count.",
        },
        {
          target: 'float falloff = exp(-d * d * 600.0);',
          effect:
            'how tightly each emitter forces the water; lower 600.0 toward 100.0 for broad, diffuse swells, or raise it toward 2000.0 for pinpoint ripple origins.',
        },
        {
          target: 'float osc = sin(TWO_PI * uEmitterFreq[i] * uSimTime + uEmitterPhase[i]);',
          effect:
            'swap sin for sign(sin(...)) to drive the emitters with a square wave — a percussive pulse train of wavefronts instead of a smooth ripple.',
        },
      ],
    },
    'render-fs': {
      summary:
        'Turns the raw height field into light: the water surface is slope-shaded (the height gradient becomes a surface normal, so crests catch light like real water), the crest color comes from the Hue knob, and the polygon obstacles are drawn as quiet silhouettes so you can see the geometry the waves are bouncing between.',
      tryThis: [
        {
          target: 'float energy = pow(clamp(abs(h) * 2.2, 0.0, 1.0), 1.5);',
          effect:
            'the crest-brightness contrast curve; lower the 1.5 exponent toward 0.6 for a soft filled-in glow, or raise it toward 3.0 for thin, sharp, high-contrast rings.',
        },
        {
          target: 'vec3 n = normalize(vec3(-gx * 5.0, -gy * 5.0, 1.0));',
          effect:
            'the slope-lighting strength; raise the 5.0s for punchier, more three-dimensional crests, lower them for a flatter, painterly surface.',
        },
        {
          target: 'col = mix(col, vec3(0.1, 0.11, 0.14), wm * 0.85);',
          effect:
            'the obstacle silhouette color; swap the dark gray for a bright color to make the reflecting geometry glow instead of reading as shadow.',
        },
        {
          target: 'vec3 crest = hsv2rgb(vec3(fract(uHue), 0.55, 1.0));',
          effect:
            'the 0.55 is crest saturation; push it to 1.0 for neon ripples or drop it toward 0.1 for a near-monochrome moonlit-water look.',
        },
      ],
    },
  },
  glyphrain: {
    'glyph-fs': {
      summary:
        "The Matrix look, rectilinear by construction: characters fall in perfectly straight vertical columns (bright head, dimming tail), and circuit-trace paths carry a second stream of text through crisp 90° turns. The heads, tails, and flash brightness are all computed on the CPU and arrive as per-glyph color/alpha; this shader just stamps each character by reading the baked 5×7 bitmap font as an on/off ink mask.",
      tryThis: [
        {
          target: 'float mask = texture(uAtlas, vUV).r;',
          effect:
            'invert with float mask = 1.0 - texture(uAtlas, vUV).r; for negative rain — solid blocks with letter-shaped holes falling instead of glowing characters.',
        },
        {
          target: 'in vec4 vColor;',
          effect:
            'add if (vColor.a < 0.15) discard; at the top of main to hard-cut the faintest tail glyphs instead of letting them fade to near-invisible — shorter, punchier streamers.',
        },
        {
          target: 'outColor = vec4(vColor.rgb, vColor.a * mask);',
          effect:
            'try vec4(vColor.rgb * (1.0 + mask * 0.6), vColor.a * mask) to punch every character brighter at its core — a hot phosphor glow on the heads.',
        },
      ],
    },
    'fade-fs': {
      summary:
        'The persistence pass: one nearly-transparent dark rectangle over the whole canvas each frame, which is what leaves the falling characters their ghostly after-image instead of a clean wipe. The Trail knob feeds its opacity.',
      tryThis: [
        {
          target: 'outColor = vec4(0.0, 0.0, 0.0, uFade);',
          effect:
            'fade toward vec4(0.0, 0.05, 0.0, uFade) instead of pure black for a green phosphor-burn tint on everything the rain leaves behind.',
        },
        {
          target: 'uFade',
          effect:
            'square it — uFade * uFade — so trails decay much more slowly at the same Trail knob setting, long CRT-style ghosting.',
        },
        {
          target: 'void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }',
          effect:
            'replace the body with outColor = vec4(0.0, 0.0, 0.0, 1.0); to kill persistence entirely — crisp rain with no ghosting at all.',
        },
      ],
    },
  },
  grayscott: {
    'update-fs': {
      summary:
        "Gray-Scott reaction-diffusion models two chemicals, U and V, that diffuse across a grid and react with each other — V consumes U, and both slowly decay. Depending on the feed/kill rates, this simple rule spontaneously produces the spots, stripes, and coral-like patterns you're seeing, the same kind of maths behind some real animal skin patterns. Sixteen tiny simulation steps run every rendered frame, and an audio onset drops a scatter of fresh V-rich droplets onto the grid, giving the pattern something new to grow from.",
      tryThis: [
        {
          target: 'float uvv = U*V*V;',
          effect:
            "the reaction term U·V² is the heart of Gray-Scott — try `2.0*U*V*V` to double the reaction rate everywhere, which tends to speed up pattern formation and shift which spot/stripe regime you land in.",
        },
        {
          target: 'const int DROPS = 6;',
          effect:
            'how many fresh V-droplets an audio onset scatters onto the grid; raise it to 20 for busier, more chaotic onset bursts, or drop it to 1 for a single, precise seed each time.',
        },
        {
          target: 'if (distance(pos, c) < uDropRadius) { Vn = max(Vn, 0.5); Un = min(Un, 0.3); }',
          effect:
            'the values an onset droplet forces V/U to; raise 0.5 to 0.8 (and lower 0.3) for punchier, more disruptive onset splashes.',
        },
        {
          target: '0.05 * (rg(tc+ivec2(1,1)) + rg(tc+ivec2(-1,1)) + rg(tc+ivec2(1,-1)) + rg(tc+ivec2(-1,-1)))',
          effect:
            "the diagonal-neighbor weight in the diffusion blur (a discrete Laplacian); raising it relative to the axis-aligned 0.2 weight makes diffusion rounder/smoother, lowering it makes patterns more blocky/axis-aligned.",
        },
      ],
    },
    'render-fs': {
      summary:
        'This stage just displays the U/V simulation state as color: it bilinearly samples V (the raw simulation texture has hard per-cell steps), computes a fake surface normal from how V slopes locally to fake an embossed 3D relief lit from one fixed direction, and maps V\'s concentration to a hue/brightness ramp.',
      tryThis: [
        {
          target: 'vec3 n = normalize(vec3(-gx, -gy, uEmboss*0.15 + 1e-3));',
          effect:
            "the 0.15 sets how \"tall\" the fake relief looks relative to V's slope; raise it toward 0.5 to flatten the emboss, or lower it toward 0.02 for taller, sharper-looking ridges.",
        },
        {
          target: 'float shade = mix(1.0, clamp(dot(n, normalize(vec3(-0.5,-0.5,1.0))),0.0,1.0), uEmboss);',
          effect:
            'the fixed light direction vec3(-0.5,-0.5,1.0); change it to vec3(0.5,-0.5,1.0) to relight the embossed relief from the opposite side.',
        },
        {
          target: 'float vv = clamp(v/0.45, 0.0, 1.0);',
          effect:
            "0.45 normalizes V's concentration into the 0-1 color range; lower it toward 0.3 to saturate colors at lower V levels, making the pattern look fuller/brighter overall.",
        },
        {
          target: 'outColor = vec4(0.02,0.02,0.03,1.0); return;',
          effect:
            'the near-black color shown outside the simulation\'s square area on a non-square canvas; brighten it to something like vec4(0.1,0.0,0.15,1.0) for a visible violet border instead of near-black.',
        },
        {
          target: 'st += uWarp * vec2(sin((st.y+uWarpPhase)*6.2831), cos((st.x+uWarpPhase)*6.2831));',
          effect:
            'a subtle beat-synced ripple applied to the sampling coordinates before display; raise the implicit amplitude by multiplying uWarp here (e.g. `uWarp*3.0 * vec2(...)`) for a much more visible wobble.',
        },
      ],
    },
  },

  photoswarm: {
    'update-fs': {
      summary:
        "Each particle has a \"home\" position sampled from a bright pixel of your photo. Every frame a spring pulls it back toward that home, a layer of swirling curl-noise (scaled by the bass level) knocks it around, and a radial shockwave impulse fires outward from the image's center on each audio onset. Let the music settle and the swarm reforms the photo; hit a drop and it blasts apart.",
      tryThis: [
        {
          target: 'vec2 accel = (home - p) * uReturn;',
          effect:
            "the spring pulling each particle toward its home pixel, scaled by the Spring return knob; try squaring the pull, e.g. `(home - p) * uReturn * length(home - p)`, for a spring that's gentle far away and snaps hard up close.",
        },
        {
          target: 'accel += curl(p * 1.6, uTime * 0.25) * uTurbulence * uBass;',
          effect:
            'the 1.6 sets how fine-grained the turbulence swirls look and the 0.25 how fast they drift; raise 1.6 toward 4.0 for much finer, busier turbulence detail.',
        },
        {
          target: 'vec2 dir = r > 1e-4 ? p / r : vec2(1.0, 0.0);',
          effect:
            "the shockwave direction; a particle sitting exactly on center (r near zero) defaults to being pushed right — change the fallback to vec2(0.0, 1.0) to push it up instead.",
        },
        {
          target: 'v *= exp(-uDamping * uDt);',
          effect:
            'velocity damping every frame, normally derived automatically from the Spring return knob; hardcoding a bigger fixed damping here makes the swarm settle much faster regardless of that knob.',
        },
      ],
    },
    'render-fs': {
      summary:
        "Each particle is drawn as a soft circular point sprite using its own home-pixel color, sampled once when the photo was imported. Pixels outside a unit circle around the point are discarded and the rest fade toward transparent at the edge; rendered with additive blending, so overlapping particles brighten rather than occlude — the brightest, most tightly packed regions of your photo glow the most.",
      tryThis: [
        {
          target: 'if(r2 > 1.0) discard;',
          effect:
            'crops each point sprite to a circle; shrink 1.0 to 0.3 for tiny, sharp dot centers, or remove the line entirely for square particles.',
        },
        {
          target: 'float alpha = exp(-r2*uFalloff);',
          effect:
            'the soft-edge falloff; try `exp(-r2*8.0)` to hardcode a sharper edge regardless of point size, or `exp(-r2*1.5)` for much softer, more overlapping glows.',
        },
        {
          target: 'outColor = vec4(vColor*alpha, alpha);',
          effect:
            'the final premultiplied-alpha color; try `vec4(vColor*alpha*2.0, alpha)` to push brightness past 1.0 — with additive blending this blows out overlapping particles into white-hot highlights.',
        },
      ],
    },
  },
  fractallab: {
    'render-fs': {
      summary:
        'Every pixel becomes a complex number that gets folded through the same equation over and over: optionally mirrored into the positive quadrant (the abs-mix), raised to a power you control, then shifted by a constant. Points that stay bounded are inside the set and stay dark; points that flee to infinity are colored by how fast they escaped — the glowing filigree is the boundary between those two fates. Because the power and the mirror amount are knobs, this one scene contains the Mandelbrot, Julia, multibrot, and Burning-Ship families and everything between them.',
      tryThis: [
        {
          target: 'const int ITER = 100;',
          effect:
            'iteration depth: lower to 40 for a softer, blobbier boundary; raising it sharpens the filigree but costs GPU time.',
        },
        {
          target: 'const float HUE_SPREAD = 0.85;',
          effect:
            'how much of the color wheel the escape gradient walks — try 2.0 for wild rainbow banding, or 0.2 for a near-monochrome glow.',
        },
        {
          target: 'float glow = 0.06 + pow(t, 0.85) * 1.6;',
          effect:
            'the 1.6 is edge brightness — try 3.0 for burning edges; the 0.85 exponent shifts where along the escape gradient the brightness ramps.',
        },
        {
          target: 'vec2 w = mix(z, abs(z), uAbsMix);',
          effect:
            'the Burning-Ship fold — replace abs(z) with vec2(abs(z.x), z.y) to mirror only the real axis, a different (also classic) ship variant.',
        },
        {
          target: 'vec2 z = p;',
          effect:
            'the starting point of every orbit — change to vec2(0.0) and the juliaMix knob then blends toward a true Mandelbrot-style rendering instead of a Julia-style one.',
        },
      ],
    },
  },
  glyphlattice: {
    'line-fs': {
      summary:
        "The lattice is a family of curves whose maths morphs continuously between three classic line-drawing families — Lissajous figures, rose curves, and harmonograph traces — with all positions and colors computed on the CPU each frame. This fragment shader just paints each line pixel with the per-vertex color handed in: hue-cycled per curve, dimmer for the cross-links between curves, with alpha carrying the trail falloff.",
      tryThis: [
        {
          target: 'outColor = vColor;',
          effect:
            'the whole lattice-line color comes straight from the CPU-computed per-vertex color; try outColor = vec4(vColor.rgb * 1.6, vColor.a); to push brightness past 1.0 for a hotter, blown-out glow once the trail fade stacks up.',
        },
        {
          target: 'in vec4 vColor;',
          effect:
            'this carries both color and per-vertex alpha; add if (vColor.a < 0.4) discard; at the top of main to hide the dim cross-link rungs and show only the bright main curves.',
        },
        {
          target: 'vec4 outColor;',
          effect:
            'replace the body below with outColor = vec4(vColor.rgb, 1.0); to force every line and cross-link fully opaque, ignoring the trail-falloff alpha entirely — a harder, technical-drawing look.',
        },
      ],
    },
    'glyph-fs': {
      summary:
        "Every character in the text rain is a tiny textured quad sampling one cell of a 5×7 bitmap font atlas baked in code at startup (no system fonts — that's what keeps exports pixel-identical everywhere). The atlas value is a pure on/off mask; the glyph's color and its position in the string's fading tail arrive as per-vertex color and alpha.",
      tryThis: [
        {
          target: 'float mask = texture(uAtlas, vUV).r;',
          effect:
            'this reads the baked bitmap font as an alpha mask; try float mask = 1.0 - texture(uAtlas, vUV).r; to invert every glyph into its own negative silhouette — solid blocks with letter-shaped holes.',
        },
        {
          target: 'vColor.a * mask',
          effect:
            "the final alpha multiplies the CPU's per-glyph trail falloff by the bitmap mask; try pow(vColor.a, 0.5) * mask to make trailing glyphs linger far longer behind the bright head.",
        },
        {
          target: 'outColor = vec4(vColor.rgb, vColor.a * mask);',
          effect:
            'try outColor = vec4(vColor.rgb * (1.0 + mask), vColor.a * mask); to punch each character a step brighter than its base color — a hot-white core inside every glyph.',
        },
      ],
    },
  },
  resonance: {
    'render-fs': {
      summary:
        'This is a Chladni plate: the pattern sand makes on a metal plate vibrating at a resonant frequency. Each mode pair (m, n) defines a standing wave; where the two waves cancel, the plate is still and the "sand" collects — those are the bright nodal lines. The music picks the mode numbers (sent in as uniforms from the CPU) and each onset crossfades to a new resonance.',
      tryThis: [
        {
          target: 'cos(m * PI * x) * cos(n * PI * y) - cos(n * PI * x) * cos(m * PI * y);',
          effect:
            'the plate equation itself — change the minus to a plus for the other symmetry class of modes (diagonal instead of square symmetry), or swap cos for sin for a plate clamped at the edges instead of free.',
        },
        {
          target: 'float intensity = exp(-uSharpness * abs(v));',
          effect:
            'the line renderer — replace abs(v) with (v * v) for softer, wider bands, or invert with (1.0 - exp(...)) to fill the moving regions instead of the still ones.',
        },
        {
          target: 'fract(uHueShift + intensity * 0.12)',
          effect:
            'the 0.12 is how much hue varies across a line — try 0.5 so each nodal line rainbows from core to edge.',
        },
        {
          target: '0.55',
          effect:
            'color saturation — 0.0 gives the classic white-sand-on-black-plate look, 1.0 goes fully vivid.',
        },
      ],
    },
  },
}
