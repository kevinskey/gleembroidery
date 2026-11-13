// Turning a pile of warning text into a list you can act on.
//
// The engine reports what is wrong as sentences, which is right — a warning
// has to say something a person can understand, and "the inner rail will
// crowd" is worth more than an error code. But a column of six sentences at
// the bottom of the window is not a list of problems, it is a wall, and a
// wall is what people stop reading.
//
// So: the same sentences, sorted by how much they matter, grouped by the
// object they belong to, and carrying a FIX where one exists. A diagnostic
// that names a problem and offers nothing to do about it is half a tool.
//
// The object is identified by matching the prefix before the first colon
// against the REAL object names, not by pattern-matching the sentence. That
// distinction matters: matching against a known set either works or does
// not, where a regex over prose quietly mis-attributes a message the day
// someone rewords it.
//
// Pure and DOM-free.

export type Severity =
  /** This object is NOT being stitched. The design is incomplete. */
  | 'error'
  /** It will sew, but something about it will show or will cost time. */
  | 'warning'
  /** Worth knowing before the machine starts. */
  | 'note'

/** Something the user can press to deal with a problem. */
export type Fix =
  /** Knock overlapping objects back so nothing is sewn twice. */
  | 'overlap'
  /** Shade the over-dense areas on the canvas. */
  | 'showDensity'
  /** Jump to the thread fields. */
  | 'thread'
  /** Show the object on the canvas. */
  | 'select'

export interface Problem {
  id: string
  severity: Severity
  /** The object this is about, when the message named one. */
  objectId?: string
  objectName?: string
  /** The message, with the object's name taken off the front. */
  text: string
  fixes: Fix[]
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, note: 2 }

/**
 * Decide how much a message matters.
 *
 * Only one of these is a hard rule: NOT STITCHED means an object produced no
 * stitches, so the design on screen is not the design that will sew. Nothing
 * else is worth promoting to an error, because everything else still comes
 * off the machine — badly, perhaps, but it comes off.
 */
function severityOf(text: string): Severity {
  if (/NOT STITCHED|could not be computed|refused/i.test(text)) return 'error'
  if (/^Restored|^Traced \d+ contour|^Opened |^Saved /i.test(text)) return 'note'
  return 'warning'
}

function fixesFor(text: string, hasObject: boolean, manyObjects: boolean): Fix[] {
  const out: Fix[] = []
  if (/normal density/i.test(text)) {
    out.push('showDensity')
    if (manyObjects) out.push('overlap')
  }
  if (/no thread assigned|UNASSIGNED/i.test(text)) out.push('thread')
  if (hasObject) out.push('select')
  return out
}

/**
 * Group the raw warning strings into problems.
 *
 * `objects` is the real object list; a message whose prefix matches one of
 * their names belongs to it. Messages that match nothing are about the
 * DESIGN — the hoop, the needle count, the thread chart — and those are the
 * ones that matter most, so they sort first within their severity.
 */
export function classifyProblems(
  warnings: readonly string[],
  objects: readonly { id: string; name: string }[],
): Problem[] {
  const byName = new Map(objects.map((o) => [o.name, o.id]))
  const many = objects.length > 1
  const out: Problem[] = warnings.map((w, i) => {
    const colon = w.indexOf(': ')
    const prefix = colon > 0 ? w.slice(0, colon) : ''
    const objectId = byName.get(prefix)
    const text = objectId ? w.slice(colon + 2) : w
    const severity = severityOf(w)
    return {
      id: `p${i}`,
      severity,
      ...(objectId ? { objectId, objectName: prefix } : {}),
      text,
      fixes: fixesFor(text, !!objectId, many),
    }
  })
  return out.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (s) return s
    // Design-level problems before per-object ones: a design that will not
    // fit the hoop matters more than one column that will crowd.
    const d = Number(!!a.objectId) - Number(!!b.objectId)
    if (d) return d
    return 0
  })
}

export interface ProblemSummary {
  errors: number
  warnings: number
  notes: number
  /** Everything except notes — what the badge counts. */
  actionable: number
}

export function summarise(problems: readonly Problem[]): ProblemSummary {
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length
  const notes = problems.filter((p) => p.severity === 'note').length
  return { errors, warnings, notes, actionable: errors + warnings }
}

/**
 * The one thing most worth doing next.
 *
 * Deliberately ONE, and deliberately not a plan. A checklist that claims to
 * know the whole route from artwork to machine file would be guessing at a
 * job it cannot see; the next most serious thing on the list is something it
 * can actually tell.
 */
export function nextStep(problems: readonly Problem[]): Problem | null {
  return problems.find((p) => p.severity !== 'note' && p.fixes.length > 0)
    ?? problems.find((p) => p.severity !== 'note')
    ?? null
}
