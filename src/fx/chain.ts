import type { Gpu } from '../gpu/context'
import { FloatTarget, type RenderSurface } from '../gpu/targets'
import type { FxPass } from './types'
import { kaleidoPass } from './passes/kaleido'
import { mirrorPass } from './passes/mirror'
import { rgbShiftPass } from './passes/rgbshift'
import { pixelatePass } from './passes/pixelate'
import { posterizePass } from './passes/posterize'
import { zoomPulsePass } from './passes/zoompulse'

/** Reserved param name every pass gets for free: 0/1 enable flag, addressed
 * through the same `setParam`/`getParam` surface as every other FX param
 * (`engine.setFxParam(passId, 'enabled', 1)`) rather than a separate method,
 * so it rides the identical session-recording path. */
export const FX_ENABLED_PARAM = 'enabled'

/** Fixed, ordered built-in pass list (task spec's v1 set). This order is the
 * chain's processing order AND the order FX ids surface in the UI — it is
 * part of the session/UI contract, so appending a new built-in pass to the
 * END of this list is safe (existing `fx:<id>.<param>` events still resolve
 * by id, not position) but reordering or removing an existing entry is a
 * breaking change to any recorded session that references it. */
export function buildFxPasses(): FxPass[] {
  return [kaleidoPass(), mirrorPass(), rgbShiftPass(), pixelatePass(), posterizePass(), zoomPulsePass()]
}

/**
 * The post-processing FX chain (VJ-style secondary transformers over a
 * scene's output): a fixed ordered stack of built-in passes, each with an
 * `enabled` flag and its own param values. `render()` ping-pongs the source
 * texture through every ENABLED pass in fixed order and writes the last
 * one's result into `dst`; callers must check `hasEnabled` and skip calling
 * this entirely when it's false (the bypass path — see engine.ts) so an
 * all-disabled chain costs nothing and changes zero pixels versus the
 * pre-FX render path (every existing scene golden stays byte-identical).
 */
export class FxChain {
  readonly passes: FxPass[]
  private enabled = new Map<string, boolean>()
  private values = new Map<string, Map<string, number>>()
  private targetA: FloatTarget | null = null
  private targetB: FloatTarget | null = null
  private targetW = 0
  private targetH = 0

  constructor(passes: FxPass[] = buildFxPasses()) {
    this.passes = passes
    for (const p of passes) {
      this.enabled.set(p.meta.id, false)
      const vals = new Map<string, number>()
      for (const param of p.params) vals.set(param.name, param.default)
      this.values.set(p.meta.id, vals)
    }
  }

  init(gpu: Gpu): void {
    for (const p of this.passes) p.init(gpu)
  }

  /** Resets every pass to disabled with its param defaults — the state a
   * doc with no fx events replays as (version-tolerance for docs recorded
   * before this feature existed), and what `loadSession` resets to before a
   * replay applies whatever `fxParam` events the doc actually carries. */
  reset(): void {
    for (const p of this.passes) {
      this.enabled.set(p.meta.id, false)
      const vals = this.values.get(p.meta.id)!
      for (const param of p.params) vals.set(param.name, param.default)
    }
  }

  isEnabled(id: string): boolean {
    return this.enabled.get(id) ?? false
  }

  setEnabled(id: string, on: boolean): void {
    if (!this.enabled.has(id)) return
    this.enabled.set(id, on)
  }

  /** `name === 'enabled'` reads the pass's enable flag as 0/1; anything else
   * reads that pass's param value (falling back to its schema default for an
   * unknown-but-declared param name, 0 for a totally unknown pass id). */
  getParam(id: string, name: string): number {
    if (name === FX_ENABLED_PARAM) return this.isEnabled(id) ? 1 : 0
    const vals = this.values.get(id)
    if (!vals) return 0
    if (vals.has(name)) return vals.get(name)!
    const pass = this.passes.find((p) => p.meta.id === id)
    return pass?.params.find((p) => p.name === name)?.default ?? 0
  }

  /** Mirrors `getParam`'s routing. Unknown pass id / param name is a no-op
   * (mirrors scenes' own tolerant `setParam`, and keeps replay of a doc that
   * references a since-removed pass from throwing). */
  setParam(id: string, name: string, value: number): void {
    if (name === FX_ENABLED_PARAM) {
      this.setEnabled(id, value >= 0.5)
      return
    }
    this.values.get(id)?.set(name, value)
  }

  get hasEnabled(): boolean {
    for (const on of this.enabled.values()) if (on) return true
    return false
  }

  private enabledPasses(): FxPass[] {
    return this.passes.filter((p) => this.enabled.get(p.meta.id))
  }

  private ensureTargets(gpu: Gpu, w: number, h: number): void {
    if (this.targetA && this.targetW === w && this.targetH === h) return
    this.targetA?.dispose()
    this.targetB?.dispose()
    // LINEAR filtering (post-processing review): these are the intermediate
    // ping-pong targets between chained passes, sampled at warped
    // coordinates by the next pass — same reasoning as engine.ts's
    // sceneTarget.
    this.targetA = new FloatTarget(gpu, { width: w, height: h }, undefined, 'rgba8', 'linear')
    this.targetB = new FloatTarget(gpu, { width: w, height: h }, undefined, 'rgba8', 'linear')
    this.targetW = w
    this.targetH = h
  }

  /**
   * Runs `src` (the scene's own offscreen render) through every enabled pass
   * in fixed order, writing the final result into `dst`. A single enabled
   * pass renders straight from `src` into `dst` with no intermediate target;
   * two-or-more ping-pong through two internally-owned offscreen targets
   * (alternating, so no pass ever reads and writes the same texture) with
   * only the LAST one writing to `dst`. No-op when nothing is enabled —
   * callers should skip calling this entirely in that case (see `hasEnabled`).
   */
  render(gpu: Gpu, src: FloatTarget, dst: RenderSurface, frameTime: number): void {
    const enabled = this.enabledPasses()
    if (enabled.length === 0) return
    if (enabled.length > 1) this.ensureTargets(gpu, dst.width, dst.height)
    let srcTex: WebGLTexture = src.texture
    let useA = true
    for (let i = 0; i < enabled.length; i++) {
      const pass = enabled[i]
      const isLast = i === enabled.length - 1
      const target: RenderSurface = isLast ? dst : useA ? this.targetA! : this.targetB!
      pass.render(gpu, srcTex, target, frameTime, this.values.get(pass.meta.id)!)
      if (!isLast) {
        srcTex = (useA ? this.targetA! : this.targetB!).texture
        useA = !useA
      }
    }
  }

  dispose(): void {
    for (const p of this.passes) p.dispose()
    this.targetA?.dispose()
    this.targetB?.dispose()
    this.targetA = null
    this.targetB = null
    this.targetW = 0
    this.targetH = 0
  }
}
