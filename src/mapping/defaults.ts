import type { MappingRule } from './types'

/**
 * Default KEYBOARD mapping table — chosen to feel good live on the Lissajous
 * scene, its keys (number row for X frequency, qwe for Y frequency, space for
 * a drift kick, f/g for a flash-and-fade trail) are the only defaults still
 * hardcoded per-scene, same as before.
 *
 * The 2x2 trigger PAD grid used to be hardcoded here too (all four pads
 * identical, pulsing `hueSpeed`/`drift`/`freqX`/`freqY` — dead on every scene
 * but Lissajous). Pads/PERFORM batch: pad targets are now derived positionally
 * from whichever scene is live, via `MappingRuntime.setPadTargets` (called by
 * the engine at construction and after every scene switch) — there is
 * deliberately no trigger rule left in this table.
 */
export const DEFAULT_MAPPINGS: MappingRule[] = [
  { source: { type: 'key', key: '1' }, action: { type: 'set', param: 'freqX', value: 1 } },
  { source: { type: 'key', key: '2' }, action: { type: 'set', param: 'freqX', value: 2 } },
  { source: { type: 'key', key: '3' }, action: { type: 'set', param: 'freqX', value: 3 } },
  { source: { type: 'key', key: '4' }, action: { type: 'set', param: 'freqX', value: 4 } },
  { source: { type: 'key', key: '5' }, action: { type: 'set', param: 'freqX', value: 5 } },
  { source: { type: 'key', key: '6' }, action: { type: 'set', param: 'freqX', value: 6 } },

  { source: { type: 'key', key: 'q' }, action: { type: 'set', param: 'freqY', value: 2 } },
  { source: { type: 'key', key: 'w' }, action: { type: 'set', param: 'freqY', value: 3 } },
  { source: { type: 'key', key: 'e' }, action: { type: 'set', param: 'freqY', value: 5 } },

  {
    source: { type: 'key', key: ' ' },
    action: { type: 'pulse', param: 'drift', amount: 1.2, halflife: 0.4 },
  },

  {
    source: { type: 'key', key: 'f' },
    action: { type: 'ramp', param: 'trail', target: 0.35, duration: 0.15 },
  },
  {
    source: { type: 'key', key: 'g' },
    action: { type: 'ramp', param: 'trail', target: 0.08, duration: 1.5 },
  },
]
