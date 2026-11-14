// The faces available for lettering.
//
// This is the SAME catalogue the T-Shirt Brothers design studio offers, so a
// customer who picked Bebas Neue on the website and a digitizer opening the
// job here are looking at one list rather than two. A font that exists in the
// ordering tool and not in the digitizing tool is a job that cannot be made.
//
// WHY A FONT THAT DOES NOT LOAD IS A REAL PROBLEM HERE, not a cosmetic one.
// Lettering is rasterised through a canvas and traced into outlines, and the
// canvas font string ends in a fallback. If the family is missing the browser
// quietly substitutes it, the trace succeeds, the panel looks right — and the
// machine sews a different typeface onto a customer's garment. Nothing
// downstream can catch it, because by then it is just outlines. So a face is
// LOADED and then CHECKED before it is used, and a failure is reported rather
// than absorbed.
//
// DOM-dependent by necessity (font loading is a browser service), so it is
// kept out of the engine modules and the headless tests cover only the pure
// parts: the catalogue's shape and the family-name quoting.

/** A named group in the picker, in the order the studio presents them. */
export interface FontGroup {
  label: string
  families: string[]
}

/**
 * Faces that come with the operating system.
 *
 * Listed separately because they need no network: they are the ones that
 * still work when the shop's connection is down, which on a deadline is not
 * a small thing.
 */
export const SYSTEM_FAMILIES = [
  'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Verdana',
  'Comic Sans MS', 'Helvetica', 'Palatino', 'Garamond', 'Tahoma',
  'Futura', 'Optima', 'Gill Sans', 'Baskerville', 'Didot',
  'Brush Script MT', 'Snell Roundhand', 'Zapfino', 'Copperplate', 'Arial Black',
]

export const FONT_GROUPS: FontGroup[] = [
  {
    label: 'On this computer',
    families: SYSTEM_FAMILIES,
  },
  {
    label: 'Collegiate / varsity',
    families: [
      'Graduate', 'Jockey One', 'Changa One', 'League Gothic', 'Archivo Black',
      'Sarpanch',
    ],
  },
  {
    label: 'Athletic / display',
    families: [
      'Bebas Neue', 'Anton', 'Oswald', 'Fjalla One', 'Big Shoulders Display',
      'Squada One', 'Faster One', 'Racing Sans One', 'Saira Condensed',
      'Teko', 'Yanone Kaffeesatz', 'Khand', 'Staatliches', 'Saira Stencil One',
    ],
  },
  {
    label: 'Sans-serif',
    families: [
      'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Raleway',
      'Nunito', 'Ubuntu', 'Rubik', 'Work Sans', 'Quicksand', 'Mulish',
      'Barlow', 'Karla', 'Cabin', 'Exo 2', 'Titillium Web', 'Varela Round',
      'Archivo', 'Outfit', 'Sora', 'DM Sans', 'Space Grotesk', 'Manrope',
      'Plus Jakarta Sans', 'Albert Sans', 'Figtree',
    ],
  },
  {
    label: 'Serif',
    families: [
      'Playfair Display', 'Merriweather', 'Lora', 'PT Serif', 'Bitter',
      'Libre Baskerville', 'EB Garamond', 'Crimson Text', 'Cormorant Garamond',
      'Spectral', 'Source Serif 4', 'DM Serif Display', 'Noto Serif',
      'Abril Fatface', 'Cinzel', 'Yeseva One', 'Prata', 'Cardo', 'Old Standard TT',
    ],
  },
  {
    label: 'Script / handwriting',
    families: [
      'Dancing Script', 'Great Vibes', 'Sacramento', 'Satisfy', 'Kalam',
      'Caveat', 'Indie Flower', 'Shadows Into Light', 'Patrick Hand',
      'Architects Daughter', 'Amatic SC', 'Gloria Hallelujah',
      'Covered By Your Grace', 'Rock Salt', 'Kaushan Script', 'Gochi Hand',
      'Oleo Script', 'Pinyon Script', 'Stalemate', 'Henny Penny', 'Yellowtail',
      'Allura', 'Tangerine', 'Marck Script', 'Zeyada', 'Homemade Apple',
    ],
  },
  {
    label: 'Decorative',
    families: [
      'Righteous', 'Passion One', 'Bungee', 'Bangers', 'Fredoka One', 'Lobster',
      'Pacifico', 'Permanent Marker', 'Press Start 2P', 'Russo One', 'Orbitron',
      'Audiowide', 'Black Ops One', 'Bungee Shade', 'Bungee Outline',
      'Bungee Inline', 'Bungee Spice', 'Creepster', 'Fascinate Inline',
      'Monoton', 'Sigmar One', 'Special Elite', 'Titan One', 'Ultra',
      'Alfa Slab One', 'Bowlby One', 'Concert One', 'Knewave', 'Modak',
      'Frijole', 'Limelight', 'Sansita', 'Shrikhand', 'Nosifer', 'Eater',
      'Pirata One', 'Rampart One', 'Codystar',
    ],
  },
  {
    label: 'Distressed (Rubik)',
    families: [
      'Rubik Mono One', 'Rubik Bubbles', 'Rubik Glitch', 'Rubik Iso',
      'Rubik Vinyl', 'Rubik Marker Hatch', 'Rubik Beastly', 'Rubik Spray Paint',
      'Rubik Wet Paint', 'Rubik Puddles', 'Rubik Burned', 'Rubik 80s Fade',
      'Rubik Lines', 'Rubik Maze', 'Rubik Pixels',
    ],
  },
  {
    label: 'Blackletter',
    families: ['UnifrakturMaguntia', 'UnifrakturCook', 'MedievalSharp'],
  },
  {
    label: 'Monospace / pixel',
    families: [
      'Roboto Mono', 'Source Code Pro', 'Fira Code', 'JetBrains Mono',
      'Space Mono', 'DM Mono', 'VT323', 'Wallpoet',
    ],
  },
]

/** Every family in the catalogue, in picker order, without duplicates. */
export const ALL_FAMILIES: string[] = (() => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const g of FONT_GROUPS) {
    for (const f of g.families) {
      if (seen.has(f)) continue
      seen.add(f)
      out.push(f)
    }
  }
  return out
})()

const SYSTEM_SET = new Set(SYSTEM_FAMILIES)

/** Does this family need fetching from Google Fonts? */
export function isWebFont(family: string): boolean {
  return ALL_FAMILIES.includes(family) && !SYSTEM_SET.has(family)
}

/**
 * Families that ship only ONE weight on Google Fonts.
 *
 * Asking the CSS API for `:wght@400;700` on these returns a 400 for the whole
 * request — not a fallback, an error — so the face silently never arrives.
 * The list is carried over from the studio, where it was arrived at the hard
 * way.
 */
const SINGLE_WEIGHT = new Set([
  'Bungee Outline', 'Bungee Inline', 'Bungee Spice', 'Bungee Shade',
  'Rubik Mono One', 'Rubik Bubbles', 'Rubik Glitch', 'Rubik Iso',
  'Rubik Vinyl', 'Rubik Marker Hatch', 'Rubik Beastly',
  'Rubik Spray Paint', 'Rubik Wet Paint', 'Rubik Puddles',
  'Rubik Burned', 'Rubik 80s Fade', 'Rubik Lines', 'Rubik Maze', 'Rubik Pixels',
  'Press Start 2P', 'VT323', 'Wallpoet', 'Codystar', 'Modak',
  'Frijole', 'Limelight', 'Shrikhand', 'Nosifer', 'Eater', 'Pirata One',
  'Rampart One', 'Sigmar One', 'Titan One', 'Ultra', 'Bowlby One',
  'Concert One', 'Knewave', 'Faster One', 'Squada One', 'Saira Stencil One',
  'Staatliches', 'Alfa Slab One', 'Russo One', 'Audiowide', 'Black Ops One',
  'Creepster', 'Fascinate Inline', 'Monoton', 'Special Elite',
  'Bangers', 'Fredoka One', 'Lobster', 'Pacifico', 'Permanent Marker',
  'Anton', 'Bebas Neue', 'Righteous', 'Passion One', 'Bungee', 'Racing Sans One',
  'Yeseva One', 'Abril Fatface', 'Sansita',
  'Stalemate', 'Henny Penny', 'Yellowtail', 'Allura', 'Tangerine',
  'Marck Script', 'Zeyada', 'Homemade Apple', 'Great Vibes', 'Sacramento',
  'Satisfy', 'Dancing Script', 'Kaushan Script', 'Gochi Hand', 'Oleo Script',
  'Pinyon Script', 'Indie Flower', 'Shadows Into Light', 'Rock Salt',
  'Amatic SC', 'Gloria Hallelujah', 'Covered By Your Grace',
  'UnifrakturMaguntia', 'UnifrakturCook', 'MedievalSharp',
  'Varela Round', 'Fjalla One', 'DM Serif Display', 'Prata',
  'Patrick Hand', 'Architects Daughter', 'DM Mono',
  'Graduate', 'Jockey One', 'Changa One', 'League Gothic', 'Archivo Black',
])

/** Families whose only weight is 700, where a name-only URL also 400s. */
const BOLD_ONLY = new Set(['UnifrakturCook'])

/** The `family=` fragment of a Google Fonts CSS2 URL for one family. */
export function fontSpec(family: string): string {
  const name = family.replace(/ /g, '+')
  if (BOLD_ONLY.has(family)) return `family=${name}:wght@700`
  if (SINGLE_WEIGHT.has(family)) return `family=${name}`
  return `family=${name}:wght@400;700`
}

/**
 * Is this family actually usable right now?
 *
 * Measured, not asked. `document.fonts.check()` answers for the font the
 * browser WOULD use, which includes the fallback, so it says yes to names
 * that do not exist. Rendering the same string in the candidate family and in
 * two deliberately different generic fallbacks, and seeing whether the widths
 * differ, is the only test that distinguishes "this face is here" from "the
 * browser quietly gave me something else".
 */
export function isFamilyAvailable(family: string): boolean {
  if (typeof document === 'undefined') return false
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  // A string with wide letterform variation between faces.
  const probe = 'mmmwwwiiilll@#WQJgy'
  const width = (f: string) => {
    ctx.font = `64px ${f}`
    return ctx.measureText(probe).width
  }
  // If the family resolves, its width should differ from AT LEAST one of the
  // generics. A face that happens to match monospace exactly will still
  // differ from serif, and vice versa.
  const q = `"${family.replace(/"/g, '')}"`
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    if (Math.abs(width(`${q}, ${generic}`) - width(generic)) > 0.5) return true
  }
  return false
}

/**
 * In-flight and finished loads, one promise per family.
 *
 * Shared rather than repeated because the picker, the edit guard and the
 * open-document preload can all ask for the same face within a frame of each
 * other, and three concurrent attempts would append three stylesheets.
 */
const loads = new Map<string, Promise<boolean>>()

/** Resolve when a stylesheet has actually been parsed, or give up. */
function sheetReady(link: HTMLLinkElement, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    link.addEventListener('load', finish, { once: true })
    link.addEventListener('error', finish, { once: true })
    // A hung CDN must not hang the editor. The caller's measured check is
    // what decides the outcome either way.
    setTimeout(finish, ms)
  })
}

/**
 * Fetch a web font and wait until it is really there.
 *
 * Resolves true when the face is usable, false when it is not — never throws,
 * because every caller's next move is the same either way: use it, or say so.
 *
 * THE ORDER HERE IS THE WHOLE THING. Appending the <link> and calling
 * document.fonts.load straight after does not work: at that moment the
 * stylesheet has not been parsed, so no @font-face rule for the family exists
 * yet, and the load resolves immediately having matched nothing. The measured
 * check then fails and a perfectly good font is reported as unavailable —
 * which is exactly what it did before this comment was written. So: wait for
 * the sheet, THEN ask for the faces, THEN measure.
 */
export async function ensureFamily(family: string): Promise<boolean> {
  if (!family.trim()) return false
  if (isFamilyAvailable(family)) return true
  if (!isWebFont(family)) return false
  if (typeof document === 'undefined') return false

  const cached = loads.get(family)
  if (cached) return cached

  const run = (async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?${fontSpec(family)}&display=swap`
    const ready = sheetReady(link, 8000)
    document.head.appendChild(link)
    await ready
    try {
      // Both weights, because lettering can be set bold and a face whose bold
      // has not arrived would be substituted for just that case.
      await Promise.all([
        document.fonts.load(`400 64px "${family}"`),
        document.fonts.load(`700 64px "${family}"`),
      ])
    } catch {
      /* fall through to the measurement, which is the real answer */
    }
    const ok = isFamilyAvailable(family)
    // A failure is not cached: the usual cause is a connection that is down
    // for a minute, and a shop that reconnects should be able to try again
    // without reloading the page.
    if (!ok) loads.delete(family)
    return ok
  })()

  loads.set(family, run)
  return run
}
