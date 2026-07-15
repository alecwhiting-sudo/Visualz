import type { MappingRule } from './types'

/**
 * Default mapping table for the Lissajous scene — chosen to feel good live:
 * number row for X frequency, qwe for Y frequency, space for a drift kick,
 * f/g for a flash-and-fade trail, and the 2x2 trigger pad grid for a bigger
 * combined hit.
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

  ...[0, 1, 2, 3].flatMap((index): MappingRule[] => [
    {
      source: { type: 'trigger', index },
      action: { type: 'pulse', param: 'hueSpeed', amount: 0.6, halflife: 0.5 },
    },
    {
      source: { type: 'trigger', index },
      action: { type: 'pulse', param: 'drift', amount: 0.8, halflife: 0.3 },
    },
    { source: { type: 'trigger', index }, action: { type: 'set', param: 'freqX', value: 7 } },
    { source: { type: 'trigger', index }, action: { type: 'set', param: 'freqY', value: 7 } },
  ]),
]
