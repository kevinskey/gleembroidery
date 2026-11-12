// Background stitch generation, keyed to the document revision.
//
// Spec §2 requires that generation be associated with the correct project and
// revision, and that an outdated result can never overwrite a newer edit. Two
// mechanisms enforce that here:
//
//   * every request carries a monotonic REVISION, and a response whose
//     revision is not the current one is dropped on arrival;
//   * a superseded worker is TERMINATED rather than left running, so a slow
//     generation cannot keep burning a core after its input is obsolete.
//     That is also what makes cancellation real rather than cosmetic.
//
// Edits are debounced, so dragging a slider does not spawn a generation per
// frame — but the debounce is short enough that the preview still feels live.

import { useEffect, useRef, useState } from 'react'
import type { Doc } from './model'
import type { StitchPlan } from './stitches'
import type { GenerateRequest, GenerateResponse } from './worker'
import { digitize } from './digitize'
import { docSignature } from './project'

const DEBOUNCE_MS = 90
const EMPTY: StitchPlan = { blocks: [] }

export interface PlanState {
  plan: StitchPlan
  warnings: string[]
  /** Generation is in flight; what is on screen is the previous revision. */
  busy: boolean
  /** Milliseconds the last completed generation took. */
  ms: number
  /** True when the worker could not start and generation ran inline. */
  inline: boolean
}

function supportsWorker(): boolean {
  try {
    return typeof Worker !== 'undefined'
  } catch {
    return false
  }
}

export function useStitchPlan(doc: Doc): PlanState {
  const [state, setState] = useState<PlanState>({
    plan: EMPTY, warnings: [], busy: false, ms: 0, inline: false,
  })
  const revision = useRef(0)
  const worker = useRef<Worker | null>(null)

  // The effect is keyed on the document's CONTENT, not its identity, and the
  // document itself is read through a ref. The contract is "tell me when it
  // changed" — a host that rebuilds the doc object on every render must not
  // be able to spin this hook forever.
  const signature = docSignature(doc)
  const latest = useRef(doc)
  latest.current = doc

  useEffect(() => {
    const doc = latest.current
    const rev = ++revision.current

    // Whatever is running belongs to an older revision. Its result would be
    // discarded anyway, so stop paying for it.
    if (worker.current) {
      worker.current.terminate()
      worker.current = null
    }

    setState((s) => ({ ...s, busy: true }))
    const timer = setTimeout(() => {
      if (!supportsWorker()) {
        // No worker available (older WebView, blocked blob URLs). Correctness
        // beats responsiveness — but it still gets the debounce, or every
        // keystroke runs a full digitize on the main thread.
        const t0 = performance.now()
        const { plan, warnings } = digitize(doc)
        setState({ plan, warnings, busy: false, ms: performance.now() - t0, inline: true })
        return
      }
      let w: Worker
      try {
        w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      } catch {
        // Construction failed despite Worker existing — fall back inline.
        const t0 = performance.now()
        const { plan, warnings } = digitize(doc)
        setState({ plan, warnings, busy: false, ms: performance.now() - t0, inline: true })
        return
      }
      worker.current = w

      w.onmessage = (e: MessageEvent<GenerateResponse>) => {
        // The stale guard. Without it a slow generation landing after a fast
        // one would overwrite newer stitches with older ones.
        if (e.data.revision !== revision.current) return
        setState({
          plan: e.data.plan,
          warnings: e.data.warnings,
          busy: false,
          ms: e.data.ms,
          inline: false,
        })
        w.terminate()
        if (worker.current === w) worker.current = null
      }

      w.onerror = (err) => {
        // Terminate and clear: a dead worker left live leaks a thread, and
        // leaving the previous revision's stitches on screen would show the
        // user a design that no longer exists.
        w.terminate()
        if (worker.current === w) worker.current = null
        if (revision.current !== rev) return
        setState({
          plan: EMPTY,
          warnings: [`Stitch generation failed: ${err.message || 'worker error'}`],
          busy: false,
          ms: 0,
          inline: false,
        })
      }

      const req: GenerateRequest = { revision: rev, doc }
      w.postMessage(req)
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      if (worker.current) {
        worker.current.terminate()
        worker.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return state
}
