// Stitch generation, off the main thread.
//
// The engine is deliberately DOM-free, which is what makes this possible at
// all. Generation is pure: a document in, a plan out, no shared state — so a
// worker can be terminated mid-run with nothing to clean up, which is how
// cancellation is implemented (see useStitchPlan).

import { digitize } from './digitize'
import type { Doc } from './model'
import type { StitchPlan } from './stitches'

export interface GenerateRequest {
  /** Document revision this request belongs to. Echoed back untouched. */
  revision: number
  doc: Doc
}

export interface GenerateResponse {
  revision: number
  plan: StitchPlan
  warnings: string[]
  ms: number
}

self.onmessage = (e: MessageEvent<GenerateRequest>) => {
  const { revision, doc } = e.data
  const t0 = performance.now()
  try {
    const { plan, warnings } = digitize(doc)
    const res: GenerateResponse = { revision, plan, warnings, ms: performance.now() - t0 }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    // A generator throwing must not look like "still working" forever.
    const res: GenerateResponse = {
      revision,
      plan: { blocks: [] },
      warnings: [`Stitch generation failed: ${(err as Error).message}`],
      ms: performance.now() - t0,
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}
