import * as THREE from 'three'
import script from './fonts/script.json'
import sans from './fonts/sans.json'
import display from './fonts/display.json'

/*
 * Single-stroke lettering for neon tubes. A tube is bent along a CENTERLINE,
 * so outline fonts are no use; these are the EMS single-line fonts (SIL OFL)
 * from the hersheytext package, converted by scripts/build-neon-fonts.mjs.
 *
 *   script   EMS Allure (after Allura): connected script, the classic
 *            "Open late" bar-sign hand
 *   sans     EMS Readability: clean monoline caps/lowercase, block signage
 *   display  EMS Osmotron: rounded techno, for numerals and labels
 *
 *   textStrokes('Say hello.', { font: 'script', size: 0.5 })
 *     -> { strokes, width, height }   strokes in the XY plane, y up, z = 0,
 *        centered on the origin (align: 'center'), size = cap height
 *
 * Every stroke is one pen-down run. neonFromStrokes() (kit/neon.ts) joins
 * consecutive strokes with painted-black "blockout" jumpers behind the
 * glass, the way a real sign is one continuous tube.
 */

export type NeonFont = 'script' | 'sans' | 'display'
type FontData = { name: string; license: string; glyphs: Record<string, [number, number[][]]> }
const FONTS: Record<NeonFont, FontData> = {
  script: script as unknown as FontData,
  sans: sans as unknown as FontData,
  display: display as unknown as FontData,
}

/** A polyline the tube follows (world units). */
export interface Stroke {
  pts: THREE.Vector3[]
  closed?: boolean
}

export interface TextOptions {
  font?: NeonFont
  /** cap height in world units (default 1) */
  size?: number
  /** extra space between letters, in cap heights (default 0; script looks best at 0) */
  tracking?: number
  /** word space multiplier (default 1) */
  wordSpace?: number
  /** line height in cap heights (default 1.9) */
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
  /** skew in radians (a hand-bent lean; default 0) */
  slant?: number
}

export interface TextStrokes {
  strokes: Stroke[]
  width: number
  height: number
  /** per-line [minX, maxX] after alignment (for underlines, backers) */
  lines: { y: number; minX: number; maxX: number }[]
}

/** Text as tube centerlines. '\n' breaks lines. Unknown characters are skipped. */
export function textStrokes(text: string, opts: TextOptions = {}): TextStrokes {
  const { font = 'script', size = 1, tracking = 0, wordSpace = 1, lineHeight = 1.9, align = 'center', slant = 0 } = opts
  const f = FONTS[font]
  const lines = text.split('\n')
  const raw: { strokes: number[][]; x0: number; width: number; y: number }[] = []
  let maxW = 0
  lines.forEach((line, li) => {
    let x = 0
    const strokes: number[][] = []
    let minX = Infinity
    let maxX = -Infinity
    for (const ch of line) {
      const g = f.glyphs[ch] ?? f.glyphs[ch === '’' ? "'" : ch === '“' || ch === '”' ? '"' : ch === '—' || ch === '–' ? '-' : '']
      if (!g) {
        x += 0.35
        continue
      }
      const [adv, gs] = g
      if (ch === ' ') {
        x += adv * wordSpace
        continue
      }
      for (const s of gs) {
        const out: number[] = []
        for (let i = 0; i < s.length; i += 2) {
          const px = x + s[i] + s[i + 1] * slant
          out.push(px, s[i + 1])
          minX = Math.min(minX, px)
          maxX = Math.max(maxX, px)
        }
        strokes.push(out)
      }
      x += adv + tracking
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      maxX = 0
    }
    raw.push({ strokes, x0: minX, width: maxX - minX, y: -li * lineHeight })
    maxW = Math.max(maxW, maxX - minX)
  })
  const totalH = (lines.length - 1) * lineHeight + 1
  const out: Stroke[] = []
  const lineInfo: TextStrokes['lines'] = []
  for (const r of raw) {
    const shift = align === 'left' ? -r.x0 - maxW / 2 : align === 'right' ? maxW / 2 - (r.x0 + r.width) : -r.x0 - r.width / 2
    const yOff = r.y + totalH / 2 - 1
    lineInfo.push({ y: (yOff + 0.5) * size, minX: (r.x0 + shift) * size, maxX: (r.x0 + r.width + shift) * size })
    for (const s of r.strokes) {
      const pts: THREE.Vector3[] = []
      for (let i = 0; i < s.length; i += 2) {
        const p = new THREE.Vector3((s[i] + shift) * size, (s[i + 1] + yOff) * size, 0)
        // drop duplicate points (the fonts repeat a point at some joins)
        if (!pts.length || pts[pts.length - 1].distanceToSquared(p) > 1e-10) pts.push(p)
      }
      if (pts.length >= 2) out.push({ pts })
    }
  }
  return { strokes: out, width: maxW * size, height: totalH * size, lines: lineInfo }
}

/** The fonts' names and licenses (credits). */
export const NEON_FONT_CREDITS = Object.values(FONTS).map(f => `${f.name} (${f.license})`)
