/**
 * Session (rig) files — docs/SESSIONS.md. A Session is the user's living
 * setup: per-algorithm overrides (knobs / expressions / shader edits /
 * F1-F8 frame banks) plus global performance furniture. Distinct from a
 * Performance (`SessionDoc`, the take recording) by lifecycle — see the
 * plan's §2 — but shaped so the two can share serializers later.
 *
 * Parsing is TOLERANT by contract (plan §6 R2): unknown scene ids
 * (renamed/removed algorithms — the Hyperbolic precedent), unknown params,
 * or malformed entries are DROPPED and reported in `warnings`, never
 * thrown. Only a structurally unusable file (wrong kind, no object) throws.
 */

/** Per-scene override: only what the user CHANGED, at absolute values
 * (sparse-absolute — plan §3/§6 R3). Structurally compatible with the take
 * doc's initial-state block; `frames` is the session-side extension (take
 * docs don't carry frame banks). */
export interface SceneRigEntry {
  params?: Record<string, number>
  bindings?: Record<string, string>
  shaders?: Record<string, string>
  /** Per-algorithm F1-F8 banks (user decision, plan §7.2): 8 slots of
   * normalized controller positions, null = empty slot. Omitted entirely
   * when every slot is empty. */
  frames?: (number[] | null)[]
}

export interface SessionRigGlobal {
  transitionSpeed?: number
  handoffFadeSeconds?: number
  macroView?: number
  switchTargetId?: string
}

export interface SessionRig {
  kind: 'session'
  version: 1
  name?: string
  scenes: Record<string, SceneRigEntry>
  global: SessionRigGlobal
}

export interface ParsedRig {
  rig: SessionRig
  /** Human-readable notes about entries the tolerant parser dropped. */
  warnings: string[]
}

const FRAME_SLOTS = 8

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberRecord(v: unknown): Record<string, number> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

function frameBank(v: unknown): (number[] | null)[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: (number[] | null)[] = []
  for (let i = 0; i < FRAME_SLOTS; i++) {
    const slot = v[i]
    out.push(
      Array.isArray(slot) && slot.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? slot.map((n) => Math.min(1, Math.max(0, n)))
        : null,
    )
  }
  return out.some((s) => s !== null) ? out : undefined
}

/** Serializes, dropping empty entries so untouched algorithms cost nothing
 * (plan: "if they have not used an algorithm ... no need to save"). */
export function serializeRig(rig: SessionRig): string {
  const scenes: Record<string, SceneRigEntry> = {}
  for (const [id, entry] of Object.entries(rig.scenes)) {
    const compact: SceneRigEntry = {}
    if (entry.params && Object.keys(entry.params).length) compact.params = entry.params
    if (entry.bindings && Object.keys(entry.bindings).length) compact.bindings = entry.bindings
    if (entry.shaders && Object.keys(entry.shaders).length) compact.shaders = entry.shaders
    if (entry.frames && entry.frames.some((f) => f !== null)) compact.frames = entry.frames
    if (Object.keys(compact).length) scenes[id] = compact
  }
  return JSON.stringify({ ...rig, scenes }, null, 2)
}

/**
 * Tolerant parse. `knownSceneIds` gates which scene entries survive —
 * pass the live registry's keys so files referencing removed algorithms
 * degrade with a warning instead of failing (plan §6 R2).
 */
export function parseRig(text: string, knownSceneIds: string[]): ParsedRig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isRecord(raw)) throw new Error('Session file must be a JSON object')
  if (raw.kind !== 'session') throw new Error('Not a session file (missing kind: "session")')
  if (raw.version !== 1) throw new Error(`Unsupported session version ${String(raw.version)}`)

  const warnings: string[] = []
  const known = new Set(knownSceneIds)
  const scenes: Record<string, SceneRigEntry> = {}
  if (isRecord(raw.scenes)) {
    for (const [id, entryRaw] of Object.entries(raw.scenes)) {
      if (!known.has(id)) {
        warnings.push(`Skipped settings for unknown algorithm "${id}"`)
        continue
      }
      if (!isRecord(entryRaw)) {
        warnings.push(`Skipped malformed entry for "${id}"`)
        continue
      }
      const entry: SceneRigEntry = {}
      const params = numberRecord(entryRaw.params)
      const bindings = stringRecord(entryRaw.bindings)
      const shaders = stringRecord(entryRaw.shaders)
      const frames = frameBank(entryRaw.frames)
      if (params) entry.params = params
      if (bindings) entry.bindings = bindings
      if (shaders) entry.shaders = shaders
      if (frames) entry.frames = frames
      if (Object.keys(entry).length) scenes[id] = entry
    }
  }

  const g = isRecord(raw.global) ? raw.global : {}
  const global: SessionRigGlobal = {}
  if (typeof g.transitionSpeed === 'number' && Number.isFinite(g.transitionSpeed)) {
    global.transitionSpeed = Math.min(10, Math.max(0.1, g.transitionSpeed))
  }
  if (typeof g.handoffFadeSeconds === 'number' && Number.isFinite(g.handoffFadeSeconds)) {
    global.handoffFadeSeconds = Math.min(10, Math.max(0.1, g.handoffFadeSeconds))
  }
  if (typeof g.macroView === 'number' && [0, 1, 2, 3].includes(g.macroView)) {
    global.macroView = g.macroView
  }
  if (typeof g.switchTargetId === 'string' && known.has(g.switchTargetId)) {
    global.switchTargetId = g.switchTargetId
  }

  return {
    rig: {
      kind: 'session',
      version: 1,
      ...(typeof raw.name === 'string' && raw.name ? { name: raw.name } : {}),
      scenes,
      global,
    },
    warnings,
  }
}

/** Discriminates a loaded JSON file: 'session' (rig), 'performance' (take
 * doc — pre-`kind` files are recognized by their event-log fields), or
 * 'unknown'. One Load affordance routes on this (plan §6 R5). */
export function classifyFile(text: string): 'session' | 'performance' | 'unknown' {
  try {
    const raw = JSON.parse(text)
    if (!isRecord(raw)) return 'unknown'
    if (raw.kind === 'session') return 'session'
    if (raw.kind === 'performance') return 'performance'
    // Back-compat: existing take docs have no kind field.
    if (typeof raw.durationFrames === 'number' && Array.isArray(raw.events)) return 'performance'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
