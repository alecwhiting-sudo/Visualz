import { describe, expect, it } from 'vitest'
import { framesDueForAudioTime, framesToRenderForAudioSync } from '../../src/app/replayPacing'

describe('framesDueForAudioTime', () => {
  it('is 1 the instant the audio reaches the take start (elapsed 0)', () => {
    expect(framesDueForAudioTime(0, 60)).toBe(1)
  })

  it('matches floor(elapsed*fps)+1 for a mid-take reading', () => {
    // 60fps, frame duration ~0.0167s: by 0.05s in, frames 0-3 are all due
    // (frame N is due once N/fps <= elapsed) => 4 frames total.
    expect(framesDueForAudioTime(0.05, 60)).toBe(4)
  })

  it('grows by exactly one frame per additional 1/fps of elapsed time', () => {
    const fps = 30
    expect(framesDueForAudioTime(1 / fps, fps)).toBe(2)
    expect(framesDueForAudioTime(2 / fps, fps)).toBe(3)
  })

  it('is 0 for negative elapsed (audio not yet at the take start)', () => {
    expect(framesDueForAudioTime(-0.5, 60)).toBe(0)
  })

  it('is 0 for non-finite elapsed or a non-positive fps', () => {
    expect(framesDueForAudioTime(NaN, 60)).toBe(0)
    expect(framesDueForAudioTime(Infinity, 60)).toBe(0)
    expect(framesDueForAudioTime(1, 0)).toBe(0)
    expect(framesDueForAudioTime(1, -30)).toBe(0)
  })
})

describe('framesToRenderForAudioSync', () => {
  it('renders exactly the frames due when nothing has rendered yet', () => {
    expect(framesToRenderForAudioSync(0, 0.05, 60, 1000)).toBe(4)
  })

  it('renders only the delta once some frames are already rendered', () => {
    expect(framesToRenderForAudioSync(4, 0.05, 60, 1000)).toBe(0)
    expect(framesToRenderForAudioSync(2, 0.05, 60, 1000)).toBe(2)
  })

  it('catches up in one burst after a late/dropped rAF tick (self-correcting)', () => {
    // A tick was skipped: audio raced ahead to 0.5s while only 1 frame had
    // rendered — the next tick must render the whole backlog at once.
    expect(framesToRenderForAudioSync(1, 0.5, 60, 1000)).toBe(30)
  })

  it('never renders past durationFrames even if the audio clock races ahead', () => {
    expect(framesToRenderForAudioSync(0, 10, 60, 90)).toBe(90)
    expect(framesToRenderForAudioSync(90, 10, 60, 90)).toBe(0)
  })

  it('never returns negative (audio momentarily behind the engine)', () => {
    expect(framesToRenderForAudioSync(50, 0.05, 60, 1000)).toBe(0)
  })
})
