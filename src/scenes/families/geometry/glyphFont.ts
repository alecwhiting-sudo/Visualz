/**
 * Shared deterministic 5x7 bitmap font machinery (extracted from
 * glyphlattice.ts — task #42's mechanical-extraction step, kept byte-for-byte
 * identical so glyphlattice's existing goldens and its 'glyph-fs' code-layer
 * source string are unaffected). No canvas fillText / system fonts: those
 * aren't pixel-identical across platforms, which would break golden-image
 * tests and export determinism. Each glyph is 7 rows of a 5-bit mask (bit 4 =
 * leftmost pixel). A-Z, 0-9, and 6 symbols: 42 glyphs.
 *
 * Any scene drawing text-as-geometry (glyphlattice.ts, glyphgeometry.ts)
 * imports this module rather than keeping its own copy of the atlas/shaders.
 */

export const GLYPH_BITMAPS: number[][] = [
  // A-Z
  [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  [0b01111, 0b10000, 0b10000, 0b10011, 0b10001, 0b10001, 0b01110],
  [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  [0b10001, 0b11001, 0b10101, 0b10101, 0b10011, 0b10001, 0b10001],
  [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  // 0-9
  [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  // symbols: < > = + * #
  [0b00001, 0b00010, 0b00100, 0b01000, 0b00100, 0b00010, 0b00001],
  [0b10000, 0b01000, 0b00100, 0b00010, 0b00100, 0b01000, 0b10000],
  [0b00000, 0b00000, 0b11111, 0b00000, 0b11111, 0b00000, 0b00000],
  [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  [0b00000, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0b00000],
  [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
]
export const NUM_GLYPHS = GLYPH_BITMAPS.length
export const GLYPH_W = 5
export const GLYPH_H = 7
export const ATLAS_CELL = 8 // padded cell so NEAREST sampling never bleeds across glyphs
export const ATLAS_COLS = 8
export const ATLAS_ROWS = Math.ceil(NUM_GLYPHS / ATLAS_COLS)
export const ATLAS_W = ATLAS_COLS * ATLAS_CELL
export const ATLAS_H = ATLAS_ROWS * ATLAS_CELL

export function buildAtlasData(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H)
  for (let gi = 0; gi < NUM_GLYPHS; gi++) {
    const cellX = (gi % ATLAS_COLS) * ATLAS_CELL
    const cellY = Math.floor(gi / ATLAS_COLS) * ATLAS_CELL
    const bits = GLYPH_BITMAPS[gi]
    for (let row = 0; row < GLYPH_H; row++) {
      const rowBits = bits[row]
      for (let col = 0; col < GLYPH_W; col++) {
        if ((rowBits >> (GLYPH_W - 1 - col)) & 1) {
          data[(cellY + row) * ATLAS_W + (cellX + col)] = 255
        }
      }
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// Fixed-vertex-shader pass-through: glyph geometry arrives in already
// aspect-corrected clip space (CPU aspect correction — see glyphlattice.ts /
// glyphgeometry.ts class docs), so this VS does no transform work.
export const GLYPH_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 aColor;
out vec2 vUV;
out vec4 vColor;
void main() {
  vUV = aUV;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export const GLYPH_FS = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUV;
in vec4 vColor;
out vec4 outColor;
void main() {
  float mask = texture(uAtlas, vUV).r;
  outColor = vec4(vColor.rgb, vColor.a * mask);
}`
