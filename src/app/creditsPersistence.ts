/**
 * localStorage persistence for the two export-credits lines (SESSION tab,
 * near Export). Same shape as `midiPersistence.ts`: parsing/validation kept
 * pure and dependency-free (no `localStorage` reference here) so it's
 * cheaply unit-testable; the actual reads/writes live in tiny try/catch
 * wrappers in App.tsx (localStorage can throw — quota, private-browsing
 * Safari — and a storage hiccup must never crash the app).
 *
 * This is a user identity setting, not performance data — it never rides the
 * `SessionDoc`/recording seam (unlike `fxParam` events etc.), per the task
 * spec, and stays out of export determinism entirely when both lines are
 * blank (see `src/export/credits.ts`'s `creditsActive`).
 */

export const CREDITS_STORAGE_KEY = 'visualz.export.credits.v1'

export interface CreditsLines {
  line1: string
  line2: string
}

export function blankCreditsLines(): CreditsLines {
  return { line1: '', line2: '' }
}

/**
 * Parses a stored credits-lines JSON string. Returns `blankCreditsLines()`
 * for anything malformed (non-JSON, wrong shape, non-string fields) rather
 * than throwing — a corrupt or foreign value under this key must never
 * crash the app on boot.
 */
export function parseCreditsLines(raw: string | null): CreditsLines {
  if (!raw) return blankCreditsLines()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return blankCreditsLines()
    const { line1, line2 } = parsed as Record<string, unknown>
    return {
      line1: typeof line1 === 'string' ? line1 : '',
      line2: typeof line2 === 'string' ? line2 : '',
    }
  } catch {
    return blankCreditsLines()
  }
}
