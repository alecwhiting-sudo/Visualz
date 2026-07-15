import type { SessionDoc } from './types'

/**
 * Session (de)serialization (ARCHITECTURE.md §3.5). `parseSession` validates a
 * user-supplied file thoroughly — this is the one place session data crosses a
 * trust boundary — and throws a descriptive `Error` on any violation instead of
 * producing a doc that silently misbehaves downstream.
 */

export function serializeSession(doc: SessionDoc): string {
  return JSON.stringify(doc)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

const KNOWN_EVENT_TYPES = new Set(['input', 'inputSignal', 'param', 'binding', 'shader'])
const MAX_SHADER_SOURCE_LENGTH = 100_000

export function parseSession(json: string): SessionDoc {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    throw new Error(`Session file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (!isRecord(raw)) throw new Error('Session must be a JSON object')

  if (raw.version !== 1) {
    throw new Error(`Unsupported session version: ${JSON.stringify(raw.version)} (expected 1)`)
  }
  if (!isFiniteNumber(raw.seed)) {
    throw new Error('Session seed must be a finite number')
  }
  if (!isFiniteNumber(raw.fps)) {
    throw new Error('Session fps must be a finite number')
  }
  if (!isRecord(raw.scene) || typeof raw.scene.id !== 'string' || !isRecord(raw.scene.params)) {
    throw new Error('Session scene must be an object with a string id and a params object')
  }
  for (const [name, value] of Object.entries(raw.scene.params)) {
    if (!isFiniteNumber(value)) {
      throw new Error(`Session scene.params.${name} must be a finite number`)
    }
  }
  if (raw.scene.shaders !== undefined) {
    if (!isRecord(raw.scene.shaders)) {
      throw new Error('Session scene.shaders must be an object when present')
    }
    for (const [key, source] of Object.entries(raw.scene.shaders)) {
      if (typeof source !== 'string') {
        throw new Error(`Session scene.shaders.${key} must be a string`)
      }
      if (source.length > MAX_SHADER_SOURCE_LENGTH) {
        throw new Error(`Session scene.shaders.${key} exceeds max length (${MAX_SHADER_SOURCE_LENGTH})`)
      }
    }
  }
  if (!isRecord(raw.bindings)) {
    throw new Error('Session bindings must be an object')
  }
  for (const [param, src] of Object.entries(raw.bindings)) {
    if (typeof src !== 'string') {
      throw new Error(`Session bindings.${param} must be a string`)
    }
  }
  if (!isRecord(raw.audio)) {
    throw new Error("Session audio must be an object with kind: 'demo' or 'file'")
  }
  if (raw.audio.kind === 'demo') {
    // no further fields to validate
  } else if (raw.audio.kind === 'file') {
    if (typeof raw.audio.name !== 'string') {
      throw new Error('Session audio.name must be a string when kind is "file"')
    }
    if (!isRecord(raw.audio.timeline)) {
      throw new Error('Session audio.timeline must be an object when kind is "file"')
    }
    // Deep timeline validation happens in parseTimeline at load time (Engine.loadSession).
  } else {
    throw new Error(`Session audio.kind must be 'demo' or 'file' (got ${JSON.stringify(raw.audio.kind)})`)
  }
  if (!isFiniteNumber(raw.durationFrames) || raw.durationFrames < 0) {
    throw new Error('Session durationFrames must be a non-negative finite number')
  }
  if (!Array.isArray(raw.events)) {
    throw new Error('Session events must be an array')
  }

  let lastFrame = -1
  for (let i = 0; i < raw.events.length; i++) {
    const e = raw.events[i]
    if (!isRecord(e)) throw new Error(`Session events[${i}] must be an object`)
    if (!Number.isInteger(e.frame) || (e.frame as number) < 0) {
      throw new Error(`Session events[${i}].frame must be a non-negative integer`)
    }
    const frame = e.frame as number
    if (frame < lastFrame) {
      throw new Error(
        `Session events[${i}].frame (${frame}) must be ascending — it comes after frame ${lastFrame}`,
      )
    }
    lastFrame = frame

    if (typeof e.type !== 'string' || !KNOWN_EVENT_TYPES.has(e.type)) {
      throw new Error(`Session events[${i}] has unknown event type: ${JSON.stringify(e.type)}`)
    }
    switch (e.type) {
      case 'input':
        if (!isRecord(e.event) || typeof e.event.type !== 'string') {
          throw new Error(`Session events[${i}].event must be a SourceEvent object`)
        }
        break
      case 'inputSignal':
      case 'param':
        if (typeof e.name !== 'string') {
          throw new Error(`Session events[${i}].name must be a string`)
        }
        if (!isFiniteNumber(e.value)) {
          throw new Error(`Session events[${i}].value must be a finite number`)
        }
        break
      case 'binding':
        if (typeof e.param !== 'string') {
          throw new Error(`Session events[${i}].param must be a string`)
        }
        if (e.src !== null && typeof e.src !== 'string') {
          throw new Error(`Session events[${i}].src must be a string or null`)
        }
        break
      case 'shader':
        if (typeof e.key !== 'string') {
          throw new Error(`Session events[${i}].key must be a string`)
        }
        if (typeof e.source !== 'string') {
          throw new Error(`Session events[${i}].source must be a string`)
        }
        if ((e.source as string).length > MAX_SHADER_SOURCE_LENGTH) {
          throw new Error(`Session events[${i}].source exceeds max length (${MAX_SHADER_SOURCE_LENGTH})`)
        }
        break
    }
  }

  return raw as unknown as SessionDoc
}
