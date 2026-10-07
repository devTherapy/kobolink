'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'

type CopyState = 'idle' | 'copying' | 'copied' | 'failed'

/** How long "Copied" stays on the button before it goes back to "Copy link". */
const COPIED_LABEL_MS = 2500

const MANUAL_COPY_MESSAGE =
  "We couldn't copy the link automatically. It's selected — press Ctrl+C (or ⌘C on a Mac) to copy it."

export interface CopyLinkProps {
  /** The exact URL to put on the clipboard — built by the caller with `linkUrl()`, never here. */
  url: string
}

/**
 * The link's URL as text a person can read, select and copy, with a Copy
 * button beside it. The URL is in a read-only `<input>` rather than a `<code>`
 * for one reason that matters here: it is *selectable programmatically*, which
 * is what the fallback needs.
 *
 * Copying is three attempts, each only if the previous one is unavailable or
 * refuses:
 *  1. the async Clipboard API — only exists in a secure context (HTTPS or
 *     localhost) and can reject on a denied permission;
 *  2. `document.execCommand('copy')` on the selected input — deprecated, but
 *     it is the one path that still works on an http:// dev host and in
 *     older in-app browsers;
 *  3. say so, leave the URL selected, and tell the merchant the shortcut — the
 *     result is never silent and never a false "Copied".
 *
 * The outcome is said twice, for two audiences: the button's label changes
 * for a sighted user, and an always-mounted `role="status"` region announces
 * it (a live region inserted at the moment it has content is not reliably
 * announced, and a changed button label is not announced at all).
 */
export function CopyLink({ url }: CopyLinkProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [state, setState] = useState<CopyState>('idle')
  const inputId = useId()

  useEffect(() => () => clearTimeout(timerRef.current), [])

  function selectUrl() {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
    input.setSelectionRange(0, input.value.length)
  }

  function succeed() {
    setState('copied')
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setState('idle'), COPIED_LABEL_MS)
  }

  async function handleCopy() {
    clearTimeout(timerRef.current)
    setState('copying')

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        succeed()
        return
      }
    } catch {
      // Denied, or the document is not focused: fall through to the next attempt.
    }

    selectUrl()
    try {
      if (typeof document.execCommand === 'function' && document.execCommand('copy')) {
        succeed()
        return
      }
    } catch {
      // Same: fall through to telling the merchant.
    }

    // The URL is already selected by `selectUrl()` above — Ctrl+C finishes the job.
    setState('failed')
  }

  const message =
    state === 'copied' ? 'Link copied to the clipboard.' : state === 'failed' ? MANUAL_COPY_MESSAGE : ''

  return (
    <div className="flex flex-col gap-2">
      {/* A column until `lg`: the two-column page puts this card at ~320px
          between 768 and 1023, where a row would clip the URL — and the URL
          is the one thing here that must be readable in full. */}
      <div className="flex flex-col gap-2 lg:flex-row">
        <label htmlFor={inputId} className="sr-only">
          Payment link URL
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          readOnly
          value={url}
          spellCheck={false}
          autoComplete="off"
          translate="no"
          onFocus={(event) => event.currentTarget.select()}
          // `lg:flex-1`, not a bare `flex-1`: below `lg` this row is a column,
          // where `flex: 1` would collapse the input's height to zero basis.
          className="h-11 min-w-0 lg:flex-1 rounded-(--radius-input) border border-(--color-border) bg-(--color-surface) px-3 font-mono text-[13px] text-(--color-ink)"
        />
        <Button
          variant="secondary"
          surface="surface"
          status={state === 'copying' ? 'loading' : state === 'failed' ? 'error' : 'idle'}
          errorMessage={MANUAL_COPY_MESSAGE}
          onClick={() => {
            void handleCopy()
          }}
        >
          {state === 'copied' ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p
        role="status"
        className={
          state === 'failed'
            ? 'text-[13px] text-(--color-danger) empty:hidden'
            : 'text-[13px] text-(--color-ink-2) empty:hidden'
        }
      >
        {message}
      </p>
    </div>
  )
}
