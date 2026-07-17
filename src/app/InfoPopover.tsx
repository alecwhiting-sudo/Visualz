import { useEffect, useRef, useState } from 'react'

/**
 * Pads/PERFORM batch: a small "?" guidance button that explains a control
 * block inline — used beside the trigger-pad grid and beside the XY pad,
 * everywhere either renders (the PERFORM tab's full-size versions and the
 * perform strip's compact versions).
 *
 * Interaction (task spec): hover shows it (desktop convenience — `hovering`
 * below); click/tap TOGGLES a separate pinned-open state, since touch has no
 * hover at all; Esc or a click/tap outside the popover closes it regardless
 * of which path opened it. The two states are OR'd (`visible = open ||
 * hovering`) rather than unified into one, so a mouse user can still hover-
 * preview one popover while another is click-pinned open elsewhere without
 * the hover accidentally closing the pinned one.
 */
export function InfoPopover({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const [hovering, setHovering] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const visible = open || hovering

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setOpen(false)
        setHovering(false)
      }
    }
    // Click/tap-away closes it — checked against the root (button + panel),
    // so a click ON the button itself doesn't also trigger this (its own
    // onClick handles the toggle); pointerdown fires before React's onClick,
    // but bubbling to `window` still sees the button as a descendant of
    // `rootRef`, so `contains` correctly excludes it.
    const onPointerDown = (ev: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false)
        setHovering(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [visible])

  return (
    <div
      className="info-popover"
      ref={rootRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <button
        type="button"
        className="info-popover-button"
        aria-label={label}
        aria-expanded={visible}
        onClick={() => {
          setOpen((o) => {
            const next = !o
            // A click that CLOSES it must win even while the pointer is
            // still physically hovering (no mouseleave/mouseenter cycle in
            // between, e.g. clicking twice in place) — otherwise the stale
            // `hovering` flag alone would keep `visible` true and the click
            // would silently do nothing. A fresh hover afterwards
            // (mouseleave then mouseenter) still shows the preview again.
            if (!next) setHovering(false)
            return next
          })
        }}
      >
        ?
      </button>
      {visible && (
        <div className="info-popover-content" role="tooltip">
          {text}
        </div>
      )}
    </div>
  )
}
