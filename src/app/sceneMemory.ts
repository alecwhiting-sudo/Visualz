import type { Engine } from '../engine/engine'
import { SCENES } from '../scenes/registry'
import type { SceneRigEntry } from '../session/rig'

/**
 * Per-algorithm memory (docs/SESSIONS.md §4): capture "how the user left
 * this algorithm" when they switch away, re-apply it when they return.
 *
 * Capture is a passive read of the LIVE engine (params diffed against the
 * live scene's own schema defaults — which for composites is only complete
 * post-init, another reason to read the live instance; bindings via
 * `getBinding`; shader sources diffed against a fresh instance's stock).
 *
 * Apply goes through the engine's RECORDING-AWARE seams (`setParam` /
 * `setBinding` / `setShaderSource`) — the plan's central trick: a restore
 * that happens mid-take lands in the event log as ordinary recorded
 * events, so replay/export reproduce the rig with zero take-schema
 * changes. Failures (an expression that no longer compiles, a shader that
 * no longer builds against a changed stock) are collected and surfaced,
 * never thrown (plan §6 R2).
 */

const PARAM_EPS = 1e-9

/** Stock shader sources for a scene id, from a throwaway un-inited
 * instance (the shaderDocs.test.ts insight: builtin scenes set their
 * editable sources as instance-field initializers). Scenes whose sources
 * only exist post-init (composites) return {} — their shader edits simply
 * aren't captured, which degrades softly. */
function stockShaderSources(sceneId: string): Record<string, string> {
  try {
    const entry = SCENES[sceneId]
    if (!entry) return {}
    const scene = entry.create()
    const sources = scene.getShaderSources ? scene.getShaderSources() : []
    return Object.fromEntries(sources.map((s) => [s.key, s.source]))
  } catch {
    return {}
  }
}

/** Reads the live scene's user-visible state as a sparse-absolute rig
 * entry; returns null when nothing differs from defaults (untouched
 * algorithms cost nothing — plan §3). `frames` is merged in by the caller
 * (App owns the frame banks). */
export function captureSceneEntry(engine: Engine): SceneRigEntry | null {
  const scene = engine.scene
  const entry: SceneRigEntry = {}

  const params: Record<string, number> = {}
  const bindings: Record<string, string> = {}
  for (const p of scene.params) {
    const bound = engine.getBinding(p.name)
    if (bound !== undefined) {
      bindings[p.name] = bound
      continue // the expression owns it; the underlying value is transient
    }
    const v = scene.getParam(p.name)
    if (Math.abs(v - p.default) > PARAM_EPS) params[p.name] = v
  }
  if (Object.keys(params).length) entry.params = params
  if (Object.keys(bindings).length) entry.bindings = bindings

  const stock = stockShaderSources(scene.meta.id)
  const shaders: Record<string, string> = {}
  for (const stage of engine.getShaderSources()) {
    const stockSrc = stock[stage.key]
    if (stockSrc !== undefined && stage.source !== stockSrc) shaders[stage.key] = stage.source
  }
  if (Object.keys(shaders).length) entry.shaders = shaders

  return Object.keys(entry).length ? entry : null
}

/** Applies a rig entry to the (already-switched) live scene through the
 * recorded seams. Returns human-readable notes for anything skipped. */
export function applySceneEntry(engine: Engine, entry: SceneRigEntry): string[] {
  const notes: string[] = []
  const known = new Set(engine.scene.params.map((p) => p.name))

  for (const [name, value] of Object.entries(entry.params ?? {})) {
    if (!known.has(name)) {
      notes.push(`Skipped unknown parameter "${name}"`)
      continue
    }
    engine.setParam(name, value)
  }
  for (const [name, src] of Object.entries(entry.bindings ?? {})) {
    if (!known.has(name)) {
      notes.push(`Skipped expression for unknown parameter "${name}"`)
      continue
    }
    try {
      engine.setBinding(name, src)
    } catch (err) {
      notes.push(`Expression for "${name}" no longer compiles: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const stages = new Set(engine.getShaderSources().map((s) => s.key))
  for (const [key, source] of Object.entries(entry.shaders ?? {})) {
    if (!stages.has(key)) {
      notes.push(`Skipped shader edit for unknown stage "${key}"`)
      continue
    }
    try {
      engine.setShaderSource(key, source)
    } catch (err) {
      notes.push(`Shader edit "${key}" no longer compiles: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return notes
}
