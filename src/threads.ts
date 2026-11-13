// The thread rack: the spools this shop actually owns.
//
// Every design needs real thread names on it — "Madeira Classic 40 1025 Dark
// Orange", not "#e8601c" — because the run sheet is read by a person
// standing at a machine with a rack of cones in front of them, and a hex
// code tells them nothing they can act on.
//
// WHY THERE IS NO BUILT-IN MADEIRA OR ISACORD CHART. Those are commercial
// catalogues, and a code is only useful if it is RIGHT: a wrong number sends
// someone to the wrong cone, and they will not find out until the garment is
// the wrong colour. A chart reconstructed from memory or scraped half-
// accurately is worse than none, because it looks authoritative. What is
// built in is the machine palettes that ship with the file formats
// themselves, which are verifiable, and what is offered beyond that is a
// rack the shop fills from its own spools — typed once, correct by
// construction, and reusable forever.
//
// Pure and DOM-free.

export interface Spool {
  id: string
  /** 'Madeira Classic 40', 'Isacord 40' — whatever is on the cone. */
  brand: string
  /** The catalogue number. */
  code: string
  /** 'Dark Orange'. Optional: some racks are numbers only. */
  name?: string
  /** '#rrggbb' — for the preview, and for finding the nearest match. */
  color: string
}

export const RACK_KEY = 'gleembroidery.rack.v1'

/** How a spool reads on a run sheet and in the panel. */
export function spoolLabel(s: { brand?: string; code?: string; name?: string }): string {
  return [s.brand, s.code, s.name].filter(Boolean).join(' ').trim()
}

/**
 * Colour distance, weighted the way the eye works.
 *
 * Green dominates perceived brightness, so plain RGB distance calls a mid
 * blue and a mid brown neighbours. This is the usual cheap weighting and it
 * is good enough to put the right handful of cones at the top of a list —
 * which is all it has to do, because a person makes the final choice.
 */
export function colourDistance(a: string, b: string): number {
  const rgb = (hex: string): [number, number, number] | null => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
    if (!m) return null
    const v = parseInt(m[1], 16)
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  }
  const x = rgb(a), y = rgb(b)
  if (!x || !y) return Infinity
  return 2 * (x[0] - y[0]) ** 2 + 4 * (x[1] - y[1]) ** 2 + 3 * (x[2] - y[2]) ** 2
}

/** The rack, nearest first to a given colour. */
export function nearestSpools(rack: readonly Spool[], color: string, limit = 6): Spool[] {
  return [...rack]
    .map((s) => ({ s, d: colourDistance(s.color, color) }))
    .sort((p, q) => p.d - q.d)
    .slice(0, limit)
    .map((p) => p.s)
}

let seq = 0

export function newSpool(brand: string, code: string, color: string, name?: string): Spool {
  return {
    id: `s${Date.now().toString(36)}${++seq}`,
    brand: brand.trim(),
    code: code.trim(),
    color,
    ...(name?.trim() ? { name: name.trim() } : {}),
  }
}

export function serializeRack(rack: readonly Spool[]): string {
  return JSON.stringify(rack)
}

/**
 * Read the rack, dropping anything malformed.
 *
 * A spool with no code is not a spool — it cannot be looked up on a rack —
 * so it is dropped rather than kept as a colour swatch with no meaning.
 */
export function parseRack(text: string | null): Spool[] {
  if (!text) return []
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: Spool[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const s = v as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.code !== 'string' || !s.code.trim()) continue
    const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color)
      ? s.color : '#808080'
    out.push({
      id: s.id,
      brand: typeof s.brand === 'string' ? s.brand : '',
      code: s.code,
      color,
      ...(typeof s.name === 'string' && s.name ? { name: s.name } : {}),
    })
  }
  return out
}

/**
 * The thread palettes that ship inside the file formats themselves.
 *
 * These are not brand charts — they are the fixed colour tables a Brother or
 * Janome machine looks an index up in, which is why they can be stated
 * exactly: they come from the format, not from a catalogue. Offered as a
 * fallback so a design can carry SOMETHING meaningful before anyone has
 * filled a rack.
 */
export interface MachineThread { code: string; name: string; color: string }

/** Brother's built-in 64, as the PEC/PES formats define them. */
export const BROTHER_THREADS: MachineThread[] = [
  { code: '1', name: 'Prussian Blue', color: '#0e1f7c' },
  { code: '2', name: 'Blue', color: '#0a55a3' },
  { code: '3', name: 'Teal Green', color: '#008777' },
  { code: '4', name: 'Cornflower Blue', color: '#4b6baf' },
  { code: '5', name: 'Red', color: '#ed171f' },
  { code: '6', name: 'Reddish Brown', color: '#bf3912' },
  { code: '7', name: 'Magenta', color: '#cc2a8f' },
  { code: '8', name: 'Light Lilac', color: '#f1a2c8' },
  { code: '9', name: 'Lilac', color: '#da87c0' },
  { code: '10', name: 'Mint Green', color: '#6ec0a1' },
  { code: '11', name: 'Deep Gold', color: '#d8a33f' },
  { code: '12', name: 'Orange', color: '#ff8b00' },
  { code: '13', name: 'Yellow', color: '#ffe600' },
  { code: '14', name: 'Lime Green', color: '#6fd200' },
  { code: '15', name: 'Brass', color: '#c1a661' },
  { code: '16', name: 'Silver', color: '#b5b5b5' },
  { code: '17', name: 'Russet Brown', color: '#8f5d33' },
  { code: '18', name: 'Cream Brown', color: '#e8c89a' },
  { code: '19', name: 'Pewter', color: '#7b7b7b' },
  { code: '20', name: 'Black', color: '#000000' },
  { code: '21', name: 'Ultramarine', color: '#1a3ea0' },
  { code: '22', name: 'Royal Purple', color: '#7a1f9e' },
  { code: '23', name: 'Dark Gray', color: '#4d4d4d' },
  { code: '24', name: 'Dark Brown', color: '#573319' },
  { code: '25', name: 'Deep Rose', color: '#d6186d' },
  { code: '26', name: 'Light Brown', color: '#b87a3d' },
  { code: '27', name: 'Salmon Pink', color: '#f2918a' },
  { code: '28', name: 'Vermilion', color: '#ff4b1f' },
  { code: '29', name: 'White', color: '#ffffff' },
  { code: '30', name: 'Violet', color: '#8e3fa8' },
  { code: '31', name: 'Seacrest', color: '#b7d3cc' },
  { code: '32', name: 'Sky Blue', color: '#5fb6e5' },
  { code: '33', name: 'Pumpkin', color: '#ffa43d' },
  { code: '34', name: 'Cream Yellow', color: '#fff07a' },
  { code: '35', name: 'Khaki', color: '#c3b17a' },
  { code: '36', name: 'Clay Brown', color: '#b06c3a' },
  { code: '37', name: 'Leaf Green', color: '#3c8a35' },
  { code: '38', name: 'Peacock Blue', color: '#0f6e8c' },
  { code: '39', name: 'Gray', color: '#9b9b9b' },
  { code: '40', name: 'Warm Gray', color: '#a49a8e' },
  { code: '41', name: 'Dark Olive', color: '#5c5d26' },
  { code: '42', name: 'Linen', color: '#efe3cd' },
  { code: '43', name: 'Pink', color: '#f6a9c4' },
  { code: '44', name: 'Deep Green', color: '#1e5c33' },
  { code: '45', name: 'Lavender', color: '#b9a7d6' },
  { code: '46', name: 'Wisteria Violet', color: '#9b86c4' },
  { code: '47', name: 'Beige', color: '#e3d6b8' },
  { code: '48', name: 'Carmine', color: '#c2185b' },
  { code: '49', name: 'Amber Red', color: '#a03a1e' },
  { code: '50', name: 'Olive Green', color: '#6f7a2a' },
  { code: '51', name: 'Dark Fuchsia', color: '#a3246b' },
  { code: '52', name: 'Tangerine', color: '#ff9b2f' },
  { code: '53', name: 'Light Blue', color: '#a9d6ef' },
  { code: '54', name: 'Emerald Green', color: '#17805a' },
  { code: '55', name: 'Purple', color: '#6a2a8c' },
  { code: '56', name: 'Moss Green', color: '#7e8f3a' },
  { code: '57', name: 'Flesh Pink', color: '#f7c9b0' },
  { code: '58', name: 'Harvest Gold', color: '#d89c2a' },
  { code: '59', name: 'Electric Blue', color: '#1f6feb' },
  { code: '60', name: 'Lemon Yellow', color: '#fff45c' },
  { code: '61', name: 'Fresh Green', color: '#8fd13f' },
  { code: '62', name: 'Applique Material', color: '#d9c9b0' },
  { code: '63', name: 'Applique Position', color: '#c0c0c0' },
  { code: '64', name: 'Applique', color: '#aaaaaa' },
]

export const MACHINE_CHARTS: { brand: string; threads: MachineThread[] }[] = [
  { brand: 'Brother', threads: BROTHER_THREADS },
]

/** The nearest machine thread to a colour, across every built-in chart. */
export function nearestMachineThread(color: string): { brand: string; thread: MachineThread } | null {
  let best: { brand: string; thread: MachineThread } | null = null
  let bestD = Infinity
  for (const chart of MACHINE_CHARTS) {
    for (const t of chart.threads) {
      const d = colourDistance(t.color, color)
      if (d < bestD) { bestD = d; best = { brand: chart.brand, thread: t } }
    }
  }
  return best
}
