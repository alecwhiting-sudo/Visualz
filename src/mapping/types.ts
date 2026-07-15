/**
 * Mapping layer types (ARCHITECTURE.md §3.4): "one table, four frontends".
 * Keyboard, touch, MIDI, and auto beat-events all write `SourceEvent`s into the
 * same `MappingRuntime`; each `MappingRule` maps a source to an `Action` that
 * mutates scene params (directly, or via the signal bus for continuous input).
 */

export type SourceEvent =
  | { type: 'key'; key: string; edge: 'down' | 'up' } // key: KeyboardEvent.key, lowercased
  | { type: 'trigger'; index: number } // on-screen pad grid hit, 0-based

export type Action =
  | { type: 'set'; param: string; value: number }
  | { type: 'ramp'; param: string; target: number; duration: number } // seconds, linear
  | { type: 'pulse'; param: string; amount: number; halflife: number } // additive, exp decay

export interface MappingRule {
  source: { type: 'key'; key: string } | { type: 'trigger'; index: number }
  action: Action
}
