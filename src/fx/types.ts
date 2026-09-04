import type { Gpu } from '../gpu/context'
import type { RenderSurface } from '../gpu/targets'
import type { ParamSchema } from '../scenes/types'

export interface FxPassMeta {
  id: string
  name: string
}

/**
 * A single post-processing effect in the FX chain (VJ-style secondary
 * transformer over a scene's output — ARCHITECTURE.md's "preview = export"
 * contract applies to the WHOLE pipeline, so this applies to FX too).
 *
 * v1 passes are STATELESS: `render()` must be a pure function of
 * (`src` texture, `values`, `frameTime`) — no mutable state carried between
 * calls. That is what keeps the render-purity check (`rerender()` twice =
 * identical `pixelHash`) and the 30/60/120fps frame-rate-independence check
 * green for free: the chain never accumulates per-call, only per-elapsed-time
 * via whatever `frameTime` (always `frame.time`, Transport-clocked) a pass's
 * shader chooses to read. No `Date.now`/`performance.now`/`Math.random` —
 * any per-frame variation must derive from `frameTime` through a pure
 * hash/trig function so replay/export stay deterministic.
 */
export interface FxPass {
  meta: FxPassMeta
  params: ParamSchema[]
  init(gpu: Gpu): void
  render(gpu: Gpu, src: WebGLTexture, dst: RenderSurface, frameTime: number, values: ReadonlyMap<string, number>): void
  dispose(): void
}
