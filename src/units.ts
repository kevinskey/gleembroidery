// Lengths, in the units a shop actually speaks.
//
// The machine works in millimetres and so does everything inside this
// program. But Doc's hoops are sold in inches, his customers ask for "a
// three inch left chest", and the tape measure on the bench reads in
// sixteenths. Making someone convert in their head is how a 3" logo gets
// digitized at 3 cm.
//
// So: one stored unit (mm, always), two ways of writing it, and a parser
// that accepts whatever someone actually types — "2 7/16", "2-7/16",
// "2.4375", or a bare number in whatever unit is showing.
//
// Pure and DOM-free.

export type Unit = 'mm' | 'inch'

export const MM_PER_INCH = 25.4

/**
 * Millimetres as inches to the nearest sixteenth.
 *
 * A fraction rather than a decimal because that is what a tape measure
 * says: 2 7/16" is a thing you can find on a ruler, 2.4375" is not.
 * Sixteenths because that is as fine as the ruler goes — pretending to
 * thirty-seconds would be claiming a precision nobody can measure by hand.
 */
export function toInchFraction(mm: number): string {
  const neg = mm < 0
  const total = Math.abs(mm) / MM_PER_INCH
  let whole = Math.floor(total)
  let sixteenths = Math.round((total - whole) * 16)
  if (sixteenths === 16) { whole += 1; sixteenths = 0 }
  const sign = neg ? '-' : ''
  if (sixteenths === 0) return `${sign}${whole}"`
  // Reduce: 8/16 reads as 1/2, because that is what anyone would say.
  let n = sixteenths, d = 16
  while (n % 2 === 0 && d % 2 === 0) { n /= 2; d /= 2 }
  return whole ? `${sign}${whole} ${n}/${d}"` : `${sign}${n}/${d}"`
}

/** A length written the way the chosen unit writes it. */
export function formatLength(mm: number, unit: Unit): string {
  return unit === 'inch' ? toInchFraction(mm) : `${mm.toFixed(1)} mm`
}

/** The same, bare — for a field someone is going to type over. */
export function formatField(mm: number, unit: Unit): string {
  if (unit === 'inch') return toInchFraction(mm).replace(/"$/, '')
  return (Math.round(mm * 10) / 10).toString()
}

/**
 * Read a length someone typed.
 *
 * Accepts, in the current unit: `2 7/16`, `2-7/16`, `7/16`, `2.4375`, `2`.
 * An explicit `mm` or `"` suffix overrides the current unit, because
 * somebody who writes `60mm` while the inch field is showing means 60 mm
 * and should not get 1524.
 *
 * Returns null for anything it cannot read, rather than a guess: a field
 * that silently turns nonsense into zero resizes a design to nothing.
 */
export function parseLength(text: string, unit: Unit): number | null {
  const raw = text.trim().toLowerCase()
  if (!raw) return null

  let u: Unit = unit
  let body = raw
  if (/mm$/.test(body)) { u = 'mm'; body = body.slice(0, -2).trim() }
  else if (/(in|")$/.test(body)) {
    u = 'inch'
    body = body.replace(/(in|")$/, '').trim()
  }

  const sign = body.startsWith('-') ? -1 : 1
  if (body.startsWith('-') || body.startsWith('+')) body = body.slice(1).trim()

  // "2 7/16" or "2-7/16"
  const mixed = /^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)$/.exec(body)
  if (mixed) {
    const d = Number(mixed[3])
    if (!d) return null
    const v = Number(mixed[1]) + Number(mixed[2]) / d
    return sign * (u === 'inch' ? v * MM_PER_INCH : v)
  }
  // "7/16"
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(body)
  if (frac) {
    const d = Number(frac[2])
    if (!d) return null
    const v = Number(frac[1]) / d
    return sign * (u === 'inch' ? v * MM_PER_INCH : v)
  }
  // "2.4375"
  const dec = /^\d*\.?\d+$/.exec(body)
  if (dec) {
    const v = Number(body)
    if (!isFinite(v)) return null
    return sign * (u === 'inch' ? v * MM_PER_INCH : v)
  }
  return null
}

/** A size as both, for the status bar. */
export function sizePair(wMm: number, hMm: number): string {
  return `${toInchFraction(wMm)} × ${toInchFraction(hMm)} `
    + `(${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm)`
}
