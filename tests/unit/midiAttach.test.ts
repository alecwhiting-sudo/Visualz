import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachMidi, type MidiState } from '../../src/mapping/midi'
import type { SourceEvent } from '../../src/mapping/types'

/**
 * attachMidi against a fake MIDIAccess: the device map, hot-plug resync,
 * per-device active-gating, learn activity, and detach teardown — the runtime
 * half the pure-decoder tests (midi.test.ts) can't reach. The fake models the
 * narrow Web MIDI surface attachMidi touches: an inputs map exposing forEach,
 * onstatechange, and per-input onmidimessage.
 */

class FakeInput {
  onmidimessage: ((ev: { data: Uint8Array }) => void) | null = null
  constructor(
    public id: string,
    public name: string,
  ) {}
  send(bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) })
  }
}

class FakeAccess {
  private ports = new Map<string, FakeInput>()
  onstatechange: ((ev: { port: { type: string } }) => void) | null = null
  get inputs() {
    const ports = this.ports
    return {
      forEach(cb: (input: FakeInput) => void) {
        ports.forEach(cb)
      },
    }
  }
  plug(input: FakeInput): void {
    this.ports.set(input.id, input)
    this.onstatechange?.({ port: { type: 'input' } })
  }
  unplug(id: string): void {
    this.ports.delete(id)
    this.onstatechange?.({ port: { type: 'input' } })
  }
}

interface Harness {
  access: FakeAccess
  signals: Array<[string, number]>
  inputs: SourceEvent[]
  activity: string[]
  states: MidiState[]
  handle: ReturnType<typeof attachMidi>
}

async function harness(preplugged: FakeInput[] = []): Promise<Harness> {
  const access = new FakeAccess()
  for (const input of preplugged) access.plug(input)
  vi.stubGlobal('navigator', {
    requestMIDIAccess: () => Promise.resolve(access),
  })
  const h: Omit<Harness, 'handle'> = { access, signals: [], inputs: [], activity: [], states: [] }
  const handle = attachMidi(
    {
      setInputSignal: (name, value) => h.signals.push([name, value]),
      queueInput: (e) => h.inputs.push(e),
    },
    (state) => h.states.push(state),
    (name) => h.activity.push(name),
  )
  await Promise.resolve() // let requestMIDIAccess().then(...) run
  return { ...h, handle }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attachMidi (fake MIDIAccess)', () => {
  it('reports unsupported and returns a no-op handle when the API is absent', () => {
    vi.stubGlobal('navigator', {})
    const states: MidiState[] = []
    const handle = attachMidi(
      { setInputSignal: () => {}, queueInput: () => {} },
      (s) => states.push(s),
      () => {},
    )
    expect(states).toEqual([{ supported: false, devices: [] }])
    expect(handle.getDevices()).toEqual([])
    handle.detach() // must not throw
  })

  it('subscribes to every pre-connected input; two devices flow at once', async () => {
    const ec4 = new FakeInput('a', 'Faderfox EC4')
    const launchkey = new FakeInput('b', 'Launchkey Mini')
    const h = await harness([ec4, launchkey])

    expect(h.handle.getDevices()).toEqual([
      { id: 'a', name: 'Faderfox EC4', active: true },
      { id: 'b', name: 'Launchkey Mini', active: true },
    ])
    ec4.send([0xb0, 7, 127]) // CC 7 full
    launchkey.send([0x90, 60, 64]) // note on
    expect(h.signals).toEqual([
      ['midi.cc.7', 1],
      ['midi.note.60', 64 / 127],
    ])
    expect(h.inputs).toEqual([{ type: 'trigger', index: 60 }])
    expect(h.activity).toEqual(['midi.cc.7', 'midi.note.60'])
  })

  it('inactive devices are ignored entirely — no signals, no triggers, no learn activity', async () => {
    const ec4 = new FakeInput('a', 'Faderfox EC4')
    const h = await harness([ec4])
    h.handle.setDeviceActive('a', false)
    ec4.send([0xb0, 7, 127])
    ec4.send([0x90, 60, 100])
    expect(h.signals).toEqual([])
    expect(h.inputs).toEqual([])
    expect(h.activity).toEqual([])

    h.handle.setDeviceActive('a', true) // toggle applies to the very next message
    ec4.send([0xb0, 7, 64])
    expect(h.signals).toEqual([['midi.cc.7', 64 / 127]])
  })

  it('note-off zeroes the signal but never counts as learn activity', async () => {
    const input = new FakeInput('a', 'Launchkey Mini')
    const h = await harness([input])
    input.send([0x90, 60, 100])
    input.send([0x80, 60, 0]) // real note-off
    input.send([0x90, 61, 100])
    input.send([0x90, 61, 0]) // vel-0 note-off fold
    expect(h.signals).toEqual([
      ['midi.note.60', 100 / 127],
      ['midi.note.60', 0],
      ['midi.note.61', 100 / 127],
      ['midi.note.61', 0],
    ])
    expect(h.activity).toEqual(['midi.note.60', 'midi.note.61'])
  })

  it('hot-plug adds devices (active by default) and disconnect drops them', async () => {
    const h = await harness([])
    expect(h.handle.getDevices()).toEqual([])

    const ec4 = new FakeInput('a', 'Faderfox EC4')
    h.access.plug(ec4)
    expect(h.handle.getDevices()).toEqual([{ id: 'a', name: 'Faderfox EC4', active: true }])
    ec4.send([0xb0, 1, 127])
    expect(h.signals).toEqual([['midi.cc.1', 1]])

    h.access.unplug('a')
    expect(h.handle.getDevices()).toEqual([])
    ec4.send([0xb0, 1, 0]) // unsubscribed: handler was cleared
    expect(h.signals).toEqual([['midi.cc.1', 1]])
  })

  it('detach unsubscribes every input and survives a late statechange', async () => {
    const ec4 = new FakeInput('a', 'Faderfox EC4')
    const h = await harness([ec4])
    h.handle.detach()
    expect(ec4.onmidimessage).toBeNull()
    ec4.send([0xb0, 7, 127])
    expect(h.signals).toEqual([])
  })

  it('detach before requestMIDIAccess resolves never subscribes anything', async () => {
    const access = new FakeAccess()
    const ec4 = new FakeInput('a', 'Faderfox EC4')
    access.plug(ec4)
    let resolveAccess: (a: FakeAccess) => void = () => {}
    vi.stubGlobal('navigator', {
      requestMIDIAccess: () => new Promise((res) => (resolveAccess = res)),
    })
    const signals: Array<[string, number]> = []
    const handle = attachMidi(
      { setInputSignal: (n, v) => signals.push([n, v]), queueInput: () => {} },
      () => {},
      () => {},
    )
    handle.detach() // before the promise settles
    resolveAccess(access)
    await Promise.resolve()
    expect(ec4.onmidimessage).toBeNull()
    ec4.send([0xb0, 7, 127])
    expect(signals).toEqual([])
  })
})
