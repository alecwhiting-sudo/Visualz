/**
 * The signal bus: every input (audio features, MIDI, pads, expressions) writes
 * named numeric signals here each frame; every consumer (scene params, mappings)
 * reads from here. Recording a session = recording what flows through this bus.
 */

export class SignalBus {
  private values = new Map<string, number>()

  set(name: string, value: number): void {
    this.values.set(name, value)
  }

  get(name: string, fallback = 0): number {
    const v = this.values.get(name)
    return v === undefined ? fallback : v
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  names(): string[] {
    return [...this.values.keys()]
  }

  /** Flat copy of the current frame's signals, for the session recorder / UI meters. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values)
  }

  clear(): void {
    this.values.clear()
  }
}
