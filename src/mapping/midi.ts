import type { SourceEvent } from './types'

/**
 * MIDI frontend for the mapping layer (ARCHITECTURE.md §3.4: "one table, four
 * frontends"). Like `keyboard.ts`, this is a live-input adapter that sits at
 * the edge of the deterministic pipeline: it translates hardware events into
 * `SourceEvent`s / signal-bus writes and nothing downstream needs to know the
 * source was a Faderfox or a Launchkey. No timestamps beyond "the frame it
 * arrives on" are recorded here — the engine stamps `transport.frame` when it
 * forwards to the recorder, same as every other frontend.
 *
 * WebMIDI is Chrome/Edge-only (REQUIREMENTS.md §2) and entirely absent from
 * Safari/Firefox/iOS — `attachMidi` degrades to a no-op handle and reports
 * `{ supported: false }` rather than throwing, so the rest of the app (and its
 * tests) never has to special-case "no MIDI here".
 */

// --- Pure message decoding ---------------------------------------------------

export type DecodedMidiMessage =
  | { kind: 'cc'; channel: number; num: number; value: number } // value 0-127
  | { kind: 'noteon'; channel: number; num: number; velocity: number } // velocity 1-127
  | { kind: 'noteoff'; channel: number; num: number }
  | { kind: 'ignored' }

/**
 * Decodes one raw Web MIDI message. Normalizes the channel (0-15) out of the
 * status byte's low nibble. A note-on with velocity 0 is the universal MIDI
 * convention for "note off without a real 0x80 status" — many controllers
 * (including USB-MIDI keyboards) send only note-on and rely on this fold, so
 * it's treated identically to a real note-off. Everything else (clock,
 * pitchbend, aftertouch, program change, sysex, …) is explicitly ignored in
 * v1, per spec.
 */
export function decodeMidiMessage(data: Uint8Array): DecodedMidiMessage {
  const status = data[0]
  if (status === undefined || status < 0x80) return { kind: 'ignored' } // no status byte (or a stray data byte): nothing to decode
  const type = status & 0xf0
  const channel = status & 0x0f
  const data1 = data[1] ?? 0
  const data2 = data[2] ?? 0
  if (type === 0xb0) return { kind: 'cc', channel, num: data1, value: data2 }
  if (type === 0x90) {
    return data2 === 0
      ? { kind: 'noteoff', channel, num: data1 }
      : { kind: 'noteon', channel, num: data1, velocity: data2 }
  }
  if (type === 0x80) return { kind: 'noteoff', channel, num: data1 }
  return { kind: 'ignored' }
}

/** Collects a `MIDIInputMap` (which only exposes `forEach`, not iteration) into
 * a plain Set — used both for the initial scan and every hot-plug resync. */
function collectInputs(map: MIDIInputMap): Set<MIDIInput> {
  const set = new Set<MIDIInput>()
  map.forEach((input) => set.add(input))
  return set
}

// --- Frontend -----------------------------------------------------------------

/** The narrow slice of `Engine` this frontend needs — CC/note signals ride the
 * same `setInputSignal` path as the XY pad (recorded as `inputSignal` events),
 * and note-on rides the same `queueInput` path as the touch trigger pads
 * (recorded as `input` events), so both replay exactly like any other input. */
export interface MidiSink {
  queueInput(e: SourceEvent): void
  setInputSignal(name: string, value: number): void
}

/** One attached input port, per-session UI state layered on top of it. */
export interface MidiDevice {
  /** The Web MIDI port id — stable per physical device across attach/detach
   * within a browser session (not persisted; see module docstring). */
  id: string
  name: string
  /** Whether messages from this device are currently processed. Inactive
   * devices are ignored entirely: no signals published, no trigger events
   * queued, not eligible for learn. Defaults to `true` on (re)connect. */
  active: boolean
}

export interface MidiState {
  supported: boolean
  devices: MidiDevice[]
}

export interface MidiHandle {
  /** Detaches every input listener and the hot-plug subscription. Idempotent. */
  detach(): void
  /** Toggles whether one device (by its port id) is processed at all. No-op
   * for an unknown id (e.g. it was just unplugged). Fires `onChange`. */
  setDeviceActive(id: string, active: boolean): void
  /** Current device list snapshot — same shape `onChange` delivers. */
  getDevices(): MidiDevice[]
}

/**
 * Subscribes to every currently-connected MIDI input and any hot-plugged in
 * later (`onstatechange`), so two controllers (e.g. a Launchkey Mini and a
 * Faderfox EC4) both flow into the same sink at once, each independently
 * toggleable via the returned handle.
 *
 * `onChange` is called immediately (sync, if unsupported; once access
 * resolves otherwise), and again on every hot-plug or `setDeviceActive` call,
 * so the UI can render live device checkboxes. `onActivity` fires with the
 * fully-qualified signal name (`midi.cc.<n>` / `midi.note.<n>`) for every CC
 * or note-on received from an *active* device — the learn-mode UI arms a
 * param, then binds it to whatever name arrives next.
 */
export function attachMidi(
  sink: MidiSink,
  onChange: (state: MidiState) => void,
  onActivity: (signalName: string) => void,
): MidiHandle {
  const devices = new Map<string, { input: MIDIInput; name: string; active: boolean }>()

  const snapshot = (): MidiDevice[] =>
    [...devices.values()].map((d) => ({ id: d.input.id, name: d.name, active: d.active }))

  // Present on desktop Chrome/Edge (REQUIREMENTS.md §2); entirely absent from
  // the `Navigator` prototype on Safari/Firefox/iOS at runtime, regardless of
  // what the (this project's) TypeScript DOM lib declares statically.
  if (typeof navigator.requestMIDIAccess !== 'function') {
    onChange({ supported: false, devices: [] })
    return {
      detach: () => {},
      setDeviceActive: () => {},
      getDevices: () => [],
    }
  }

  let disposed = false
  let access: MIDIAccess | null = null

  const handleMessage = (id: string) => (ev: MIDIMessageEvent) => {
    // Looked up fresh per message (not closed over) so a `setDeviceActive`
    // toggle takes effect on the very next message, not just future ones
    // re-subscribed from scratch.
    const device = devices.get(id)
    if (!device || !device.active || !ev.data) return
    const decoded = decodeMidiMessage(ev.data)
    switch (decoded.kind) {
      case 'cc': {
        const name = `midi.cc.${decoded.num}`
        sink.setInputSignal(name, decoded.value / 127)
        onActivity(name)
        break
      }
      case 'noteon': {
        const name = `midi.note.${decoded.num}`
        sink.setInputSignal(name, decoded.velocity / 127)
        // Notes address the same trigger space as the on-screen pad grid
        // (ARCHITECTURE.md §3.4: one mapping table, four frontends) — a note
        // number IS a trigger index here, so existing trigger mappings (or
        // new ones keyed to a specific note) fire off hardware keys too.
        sink.queueInput({ type: 'trigger', index: decoded.num })
        onActivity(name)
        break
      }
      case 'noteoff':
        // Off events zero the note signal but are not learn activity — a
        // release should never bind (only a deliberate press/twist should).
        sink.setInputSignal(`midi.note.${decoded.num}`, 0)
        break
      case 'ignored':
        break
    }
  }

  const attachInput = (input: MIDIInput) => {
    if (devices.has(input.id)) return
    devices.set(input.id, { input, name: input.name ?? `MIDI input (${input.id})`, active: true })
    input.onmidimessage = handleMessage(input.id)
  }

  const detachInput = (input: MIDIInput) => {
    if (!devices.has(input.id)) return
    devices.delete(input.id)
    input.onmidimessage = null
  }

  const reportChange = () => onChange({ supported: true, devices: snapshot() })

  /** Re-syncs the device map against `access.inputs` — used for the initial
   * scan and every hot-plug event, so a disconnect (reported on the *port*,
   * not conveniently keyed to our map) is caught by simple set-difference
   * rather than trying to match ports by id from the event alone. */
  const resync = (a: MIDIAccess) => {
    const current = collectInputs(a.inputs)
    for (const input of current) attachInput(input)
    for (const { input } of [...devices.values()]) {
      if (!current.has(input)) detachInput(input)
    }
    reportChange()
  }

  navigator.requestMIDIAccess().then(
    (a) => {
      if (disposed) return
      access = a
      resync(a)
      a.onstatechange = (ev) => {
        if (disposed) return
        if (ev.port?.type !== 'input') return // ignore output-port hot-plug entirely
        resync(a)
      }
    },
    () => {
      // Permission denied, or some other rejection — degrade the same as
      // "not supported" rather than leaving the UI hanging.
      if (!disposed) onChange({ supported: false, devices: [] })
    },
  )

  return {
    detach: () => {
      disposed = true
      if (access) access.onstatechange = null
      for (const { input } of devices.values()) detachInput(input)
    },
    setDeviceActive: (id, active) => {
      const device = devices.get(id)
      if (!device) return
      device.active = active
      reportChange()
    },
    getDevices: snapshot,
  }
}
