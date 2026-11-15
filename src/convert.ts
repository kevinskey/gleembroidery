// Changing an object's stitch type.
//
// The geometry always survives — outlines, nodes, curves and holes are the
// document, and every stitch type's settings live side by side on the object,
// so switching back and forth is lossless. What does NOT always survive is
// the MEANING of the geometry, and that is what this module is for.
//
// Two paths drawn as the rails of a column are a pairing; as a fill they are
// a shape and a hole. Hand-placed penetrations are an order; as a run they
// are a route to be re-spaced. None of that is recoverable by looking at the
// coordinates afterwards, so it is said BEFORE the change, in words, rather
// than discovered later by someone wondering why their column became a ring.
//
// Pure and DOM-free.

import type { EmbObject, StitchType } from './model'

/** Types that cannot do anything useful with an open path. */
const NEEDS_CLOSED: StitchType[] = ['fill', 'applique', 'knockdown', 'lace', 'patch']

const CLOSE_EPS_MM = 0.05

function hasClosedPath(obj: EmbObject): boolean {
  return obj.paths.some((p) => {
    if (p.length < 3) return false
    const a = p[0], b = p[p.length - 1]
    return Math.hypot(b.x - a.x, b.y - a.y) < CLOSE_EPS_MM
  })
}

export interface ConvertReport {
  /** False means the change would produce an object that cannot sew. */
  allowed: boolean
  /** What the digitizer loses or gains, in plain words. Empty is a clean swap. */
  notes: string[]
}

/**
 * What happens if this object becomes `to`.
 *
 * Refusals are for geometry that cannot work at all. Everything else is a
 * NOTE: the change goes through and the digitizer is told what changed about
 * it, because refusing a conversion someone deliberately asked for is worse
 * than letting them see the result and undo.
 */
export function convertCheck(obj: EmbObject, to: StitchType): ConvertReport {
  const notes: string[] = []
  if (obj.type === to) return { allowed: true, notes: [] }

  if (NEEDS_CLOSED.includes(to) && !hasClosedPath(obj)) {
    return {
      allowed: false,
      notes: [`a ${to} needs a closed shape, and this object's outline is open — close it first, or pick a line type`],
    }
  }

  // A two-rail column's pairing is the digitizing. Nothing else reads it.
  if (obj.twoRail && to !== 'satin') {
    notes.push('the two rails stop being a pair and become two separate outlines — the pairing that made this a column is not recoverable by switching back')
  }

  // Hand-placed order is a decision no other type preserves.
  if (obj.type === 'manual') {
    notes.push('the placed penetrations become an ordinary outline: spacing will be regenerated, so the exact needle positions are lost')
  }
  if (to === 'manual') {
    notes.push('every point of the current outline becomes a needle penetration, at whatever spacing the outline happens to have — curves are taken at their flattened points')
  }

  // Appliqué is a sequence with machine stops, not a stitch.
  if (obj.type === 'applique' && to !== 'applique') {
    notes.push('the placement / tack-down / border sequence and its machine stops are dropped — only the outline remains')
  }
  if (to === 'applique') {
    notes.push('this becomes a three-phase sequence with machine stops between the phases')
  }

  // Lace is structural; nothing else is.
  if (obj.type === 'lace' && to !== 'lace') {
    notes.push('this stops being a freestanding structure — the mesh and its reinforced border are not generated for other types')
  }

  // Text keeps regenerating from the words whatever the stitch type is.
  if (obj.text && (to === 'manual' || to === 'none')) {
    notes.push('the lettering stays editable, but this type will not regenerate stitches from it')
  }

  if (to === 'none') {
    notes.push('no stitches are generated — the outline is kept as construction geometry')
  }

  return { allowed: true, notes }
}

/**
 * Apply a type change.
 *
 * Deliberately does nothing but set the type and clear flags whose meaning
 * does not carry. Settings for every type are already on the object and are
 * LEFT ALONE, so switching away and back restores what was there — the user
 * who flips type to look at something and flips back should get their
 * density and underlay returned, not defaults.
 */
export function convertObject(obj: EmbObject, to: StitchType): EmbObject {
  const next: EmbObject = { ...obj, type: to }
  // twoRail says "these two paths are a pairing", which only satin reads.
  // Leaving it set on a fill would make a later switch back to satin claim a
  // pairing the digitizer may have since broken by editing a rail.
  if (to !== 'satin') delete (next as { twoRail?: boolean }).twoRail
  return next
}
