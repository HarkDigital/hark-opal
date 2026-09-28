import { holdInert, releaseInert } from './inert'
import { BRAND, SITE } from '../content'
import { MARK_PATHS, MARK_VIEWBOX } from './mark'
import { calmUi } from './prefs'

/*
 * The boot screen — OPAL: a small tile of thick FROSTED GLASS on black, the
 * Hark mark etched clear through it. Behind the glass sits a light box: a
 * rose → lilac → periwinkle card and a bank of thin vertical tubes (the same
 * rig as the hero's slab). As the site loads, the light RISES behind the
 * glass (a soft-edged level climbing from the bottom), so the frost glows up
 * in soft bands while the etched window shows the tubes as crisp lines; the
 * window itself comes into focus as the load lands (a short rack focus).
 * "Lights up · 045%" in Red Hat Mono underneath. All SVG, no canvas: two
 * inline SVGs in the same user space (mark units) — the glass, and over it
 * the etched window — so the crisp and the diffused light line up exactly.
 *
 * Exit: the MATCH-CUT. The hero publishes where its own etched mark sits on
 * its landing frame (on <html>, CSS px: --hark-mark-x/-y = the center of the
 * mark's square SVG viewBox, --hark-mark-size = its side — the viewBox this
 * loader's window is drawn in). The window glides onto that spot while the
 * frosted glass dissolves around it and the black lifts late in the glide;
 * then finish() resolves ('hark:reveal' dims the hero's slab up) and the
 * window lets go over the hero's own mark as its light comes up — a
 * crossfade: the loader lingers for that last fade, click-through and
 * hidden from assistive tech, then removes itself. Without those properties
 * (or when the story opens anywhere but the hero's landing frame), or under
 * reduced motion / Motion off, it's a clean fade: the tile goes first, then
 * the black (the black's lift also overlaps the story's own light coming
 * up). Every change is a single monotone fade or glide: no strike, no dip,
 * no flicker.
 *
 * The light never outruns time: it takes at least MIN_MS even on a warm
 * cache, so the glass always visibly lights up.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 * Rules: shows at least ~1.2s, never hangs (finish() always resolves; every
 * wait is a bounded timer, never a rAF), the page behind — the skip link
 * too — is inert while it's up, skip removes it at once (?nointro).
 */
const MIN_MS = 1200
/** the light eases toward its target on this ticker (a timer: it runs in hidden tabs too) */
const TICK_MS = 33
/** longest we wait for the light to finish rising after the load lands */
const FILL_MAX_MS = 420
/** fully lit and in focus, a beat before the exit */
const HOLD_MS = 180
/** the match-cut: the window's glide onto the hero's mark, then its let-go */
const FLIGHT_MS = 720
const LETGO_MS = 760
/** no match-cut: the tile goes first, then the black */
const TILE_OUT_MS = 260
const FADE_MS = 380

/* the glass, in the mark's own units (its SVG viewBox) */
const [, , MW, MH] = MARK_VIEWBOX.split(/\s+/).map(Number)
/** frosted margin around the etched mark */
const PAD = 0.26 * MW
const GX = -PAD
const GY = -PAD
const GW = MW + 2 * PAD
const GH = MH + 2 * PAD
const RADIUS = GW * 0.07
/** the rising edge's soft feather */
const FEATHER = GH * 0.34
/** tube bank: fractions across the glass (five of the seven pass behind the mark) */
const TUBES = [0.11, 0.24, 0.37, 0.5, 0.63, 0.76, 0.89]
/** DUSK: rose → lilac → periwinkle, one gradient between neighbors */
const TUBE_CORE = ['#ffd0e0', '#ffd6e6', '#f3dcff', '#ecdcff', '#e0d8ff', '#d6dcff', '#d0dcff']
const TUBE_GLOW = ['#ff7aa8', '#ff8fb8', '#e7a6e6', '#c7a8ff', '#b3a6ff', '#9aa6ff', '#7f9cff']

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))
const f1 = (n: number) => n.toFixed(1)

/** WAAPI when it's there (it ignores the reduced-motion CSS that zeroes transitions; a fade is not motion) */
function play(el: Element | null, frames: Keyframe[], opts: KeyframeAnimationOptions) {
  if (!el) return
  try {
    el.animate(frames, { fill: 'forwards', ...opts })
  } catch {
    const last = frames[frames.length - 1]
    if (el instanceof HTMLElement || el instanceof SVGElement)
      for (const [k, v] of Object.entries(last)) if (k !== 'offset' && k !== 'easing') el.style.setProperty(k, String(v))
  }
}

/**
 * The hero's mark on screen, as the hero chapter publishes it: CSS custom
 * properties on <html>, in px — --hark-mark-x/-y (the center of the mark's
 * square SVG viewBox) and --hark-mark-size (its side). Null when they're
 * missing, off screen, or the story isn't on the hero's landing frame.
 */
function heroMark(): { cx: number; cy: number; size: number } | null {
  try {
    // the rect is the hero's landing frame: only when that's what's on screen
    // (a deep link to #work, ?c=…, or a scroll during the load lands elsewhere)
    const st = window.__hark?.engine?.state
    const slot = st?.slots[st.index]
    if (!st || !slot || slot.def.id !== 'hero' || st.local > 0.02) return null
    const cs = getComputedStyle(document.documentElement)
    const num = (k: string) => parseFloat(cs.getPropertyValue(k))
    const cx = num('--hark-mark-x')
    const cy = num('--hark-mark-y')
    const size = num('--hark-mark-size')
    if (![cx, cy, size].every(Number.isFinite) || size < 12) return null
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight || size > Math.max(innerWidth, innerHeight)) return null
    return { cx, cy, size }
  } catch {
    return null
  }
}

/** the light box behind the glass: the card and the tube bank (mark units) */
function lightBox(card: string, crisp: boolean) {
  const tubes = TUBES.map((f, i) => {
    const x = f1(GX + f * GW)
    const glow = `<line x1="${x}" y1="${f1(GY)}" x2="${x}" y2="${f1(GY + GH)}" stroke="${TUBE_GLOW[i]}" stroke-width="${crisp ? 110 : 150}" stroke-opacity="${crisp ? 0.45 : 0.9}"/>`
    const core = `<line x1="${x}" y1="${f1(GY)}" x2="${x}" y2="${f1(GY + GH)}" stroke="${TUBE_CORE[i]}" stroke-width="${crisp ? 34 : 44}"/>`
    return glow + core
  }).join('')
  return `<rect x="${f1(GX)}" y="${f1(GY)}" width="${f1(GW)}" height="${f1(GH)}" fill="url(#${card})" opacity="${crisp ? 0.5 : 0.95}"/>${tubes}`
}

const cardGradient = (id: string) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f1(GX)}" y1="${f1(GY + GH)}" x2="${f1(GX + GW)}" y2="${f1(GY)}">
    <stop offset="0" stop-color="#ff7aa8"/><stop offset="0.55" stop-color="#c7a8ff"/><stop offset="1" stop-color="#7f9cff"/>
  </linearGradient>`

/** the rising level: lit below the edge, dark above, a soft feather between */
const riseMask = (id: string) =>
  `<linearGradient id="${id}-g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${f1(GY + GH)}" y2="${f1(GY + GH + FEATHER)}">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/>
  </linearGradient>
  <mask id="${id}" maskUnits="userSpaceOnUse" x="${f1(GX)}" y="${f1(GY)}" width="${f1(GW)}" height="${f1(GH)}">
    <rect x="${f1(GX)}" y="${f1(GY)}" width="${f1(GW)}" height="${f1(GH)}" fill="url(#${id}-g)"/>
  </mask>`

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  const start = performance.now()
  let target = 0
  let shown = 0
  let painted = -1
  let shownPct = -1
  let ticker = 0
  let rises: SVGLinearGradientElement[] = []
  let focus: SVGFEGaussianBlurElement | null = null
  let focusG: SVGGElement | null = null
  let lights: SVGGElement[] = []
  let glowEls: HTMLElement[] = []
  let pct: HTMLElement | null = null

  if (skip) root.remove()
  else {
    const paths = [...MARK_PATHS.loops, MARK_PATHS.diamond].filter(Boolean)
    const pathEls = paths.map(d => `<path d="${d}"/>`).join('')
    const full = `x="${f1(GX)}" y="${f1(GY)}" width="${f1(GW)}" height="${f1(GH)}"`
    // the window sits exactly on the mark's box inside the glass
    const win = `left:${((PAD / GW) * 100).toFixed(3)}%;top:${((PAD / GH) * 100).toFixed(3)}%;width:${((MW / GW) * 100).toFixed(3)}%;height:${((MH / GH) * 100).toFixed(3)}%`
    root.innerHTML = `
      <div class="ld">
        <div class="ld-bg" aria-hidden="true"><div class="ld-bg-glow"></div></div>
        <p class="sr-only" role="status">Loading ${BRAND.name}, ${SITE.name} concept</p>
        <div class="ld-stage" aria-hidden="true">
          <div class="ld-pool"></div>
          <div class="ld-tile">
            <svg class="ld-glass" viewBox="${f1(GX)} ${f1(GY)} ${f1(GW)} ${f1(GH)}" focusable="false">
              <defs>
                ${cardGradient('ld-card-a')}
                ${riseMask('ld-rise-a')}
                <filter id="ld-frost" filterUnits="userSpaceOnUse" ${full} color-interpolation-filters="sRGB">
                  <feGaussianBlur stdDeviation="${f1(GW * 0.034)}"/>
                </filter>
                <clipPath id="ld-clip"><rect ${full} rx="${f1(RADIUS)}"/></clipPath>
                <linearGradient id="ld-sheen" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#fff" stop-opacity="0.14"/><stop offset="0.38" stop-color="#fff" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="ld-bevel" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#fff" stop-opacity="0.62"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0.3"/>
                </linearGradient>
              </defs>
              <g clip-path="url(#ld-clip)">
                <rect ${full} fill="#08070b"/>
                <g filter="url(#ld-frost)"><g class="ld-light" mask="url(#ld-rise-a)">${lightBox('ld-card-a', false)}</g></g>
                <rect ${full} fill="#fff" opacity="0.035"/>
                <rect ${full} fill="url(#ld-sheen)"/>
              </g>
              <rect x="${f1(GX + 9)}" y="${f1(GY + 9)}" width="${f1(GW - 18)}" height="${f1(GH - 18)}" rx="${f1(RADIUS - 9)}" fill="none" stroke="url(#ld-bevel)" stroke-width="16"/>
            </svg>
            <svg class="ld-win" viewBox="${MARK_VIEWBOX}" style="${win}" focusable="false">
              <defs>
                ${cardGradient('ld-card-b')}
                ${riseMask('ld-rise-b')}
                <clipPath id="ld-clip-mark">${pathEls}</clipPath>
                <filter id="ld-focus" filterUnits="userSpaceOnUse" x="${f1(-PAD)}" y="${f1(-PAD)}" width="${f1(GW)}" height="${f1(GH)}" color-interpolation-filters="sRGB">
                  <feGaussianBlur stdDeviation="60"/>
                </filter>
              </defs>
              <g clip-path="url(#ld-clip-mark)">
                <rect class="ld-win-base" ${full} fill="#060509"/>
                <g class="ld-win-light" filter="url(#ld-focus)"><g class="ld-light" mask="url(#ld-rise-b)">${lightBox('ld-card-b', true)}</g></g>
              </g>
              <g class="ld-win-bevel">${pathEls}</g>
            </svg>
          </div>
          <p class="ld-read"><span>Lights up</span><i></i><b><span data-pct>000</span>%</b></p>
        </div>
      </div>`
    // the whole page sleeps under the loader, the skip link too (it would take
    // focus unseen, under the black)
    holdInert('loader', [
      document.querySelector<HTMLElement>('.skip-link'),
      document.getElementById('track'),
      document.getElementById('stages'),
      document.getElementById('chrome'),
    ])
    rises = [...root.querySelectorAll<SVGLinearGradientElement>('#ld-rise-a-g, #ld-rise-b-g')]
    focus = root.querySelector<SVGFEGaussianBlurElement>('#ld-focus feGaussianBlur')
    focusG = root.querySelector<SVGGElement>('.ld-win-light')
    lights = [...root.querySelectorAll<SVGGElement>('.ld-light')]
    glowEls = [...root.querySelectorAll<HTMLElement>('.ld-pool, .ld-bg-glow')]
    pct = root.querySelector<HTMLElement>('[data-pct]')
    paint(0)
    ticker = window.setInterval(tick, TICK_MS)
  }
  /** the light has risen `v` (0..1) of the way up the glass */
  function paint(v: number) {
    if (Math.abs(v - painted) < 0.0005) return
    painted = v
    // the level: its lit edge climbs from below the glass to above it
    const edge = GY + GH + FEATHER - v * (GH + 2 * FEATHER)
    for (const g of rises) {
      g.setAttribute('y1', f1(edge - FEATHER))
      g.setAttribute('y2', f1(edge))
    }
    // the rig dims up as it rises (a theater dimmer, never a flicker)
    const level = (0.4 + 0.6 * v).toFixed(3)
    for (const l of lights) l.setAttribute('opacity', level)
    // the etched window comes into focus as the load lands
    const blur = 64 * (1 - v) * (1 - v)
    if (blur < 0.5) focusG?.removeAttribute('filter')
    else {
      focusG?.setAttribute('filter', 'url(#ld-focus)')
      focus?.setAttribute('stdDeviation', f1(blur))
    }
    for (const el of glowEls) el.style.opacity = (v * v).toFixed(3)
    const n = Math.round(v * 100)
    if (pct && n !== shownPct) {
      shownPct = n
      pct.textContent = String(n).padStart(3, '0')
    }
  }

  function tick() {
    // never ahead of the real load, never faster than MIN_MS end to end
    const time = Math.min(1, (performance.now() - start) / MIN_MS)
    const goal = Math.min(target, time)
    const next = shown + (goal - shown) * 0.24
    shown = goal - next < 0.002 ? goal : next
    paint(shown)
  }

  return {
    progress(p: number) {
      const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
      if (v > target) target = v
    },
    async finish(): Promise<void> {
      if (skip) return
      const ld = root.querySelector<HTMLElement>('.ld')
      const bg = root.querySelector<HTMLElement>('.ld-bg')
      const tile = root.querySelector<HTMLElement>('.ld-tile')
      const glass = root.querySelector<SVGSVGElement>('.ld-glass')
      const winEl = root.querySelector<SVGSVGElement>('.ld-win')
      const base = root.querySelector<SVGRectElement>('.ld-win-base')
      /** the last fade runs on after finish() resolves (the loader lingers, click-through) */
      let linger = 0
      try {
        await wait(MIN_MS - (performance.now() - start))
        target = 1
        // let the light finish its climb (bounded)
        const t0 = performance.now()
        while (shown < 0.999 && performance.now() - t0 < FILL_MAX_MS) await wait(TICK_MS)
        clearInterval(ticker)
        shown = 1
        paint(1)
        ld?.classList.add('is-lit')
        await wait(HOLD_MS)
        // the page wakes as the loader lifts, so the first Tab lands in it
        releaseInert('loader')
        const extras = [...root.querySelectorAll('.ld-read, .ld-pool, .ld-bg-glow')]
        const to = calmUi() ? null : heroMark()
        const from = winEl?.getBoundingClientRect()
        if (to && winEl && from && from.width > 4 && from.height > 4) {
          // the match-cut: the etched window glides onto the hero's mark while
          // the frost dissolves around it; the black lifts late in the glide
          const fx = from.left + from.width / 2
          const fy = from.top + from.height / 2
          const k = to.size / from.width
          winEl.style.transformOrigin = '50% 50%'
          for (const x of extras) play(x, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out' })
          play(glass, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.035)' }], {
            duration: FLIGHT_MS * 0.6,
            easing: 'cubic-bezier(0.3, 0, 0.4, 1)',
          })
          play(
            winEl,
            [{ transform: 'none' }, { transform: `translate(${f1(to.cx - fx)}px, ${f1(to.cy - fy)}px) scale(${k.toFixed(4)})` }],
            { duration: FLIGHT_MS, easing: 'cubic-bezier(0.6, 0, 0.22, 1)' },
          )
          // the clear window's dark ground thins as it lands on the slab
          play(base, [{ opacity: 1 }, { opacity: 0.5 }], { duration: FLIGHT_MS, easing: 'ease-in-out' })
          play(bg, [{ opacity: 1 }, { opacity: 0 }], { duration: FLIGHT_MS * 0.58, delay: FLIGHT_MS * 0.42, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' })
          await wait(FLIGHT_MS)
          // the let-go crossfades with the hero's own light coming up: finish()
          // resolves now ('hark:reveal' dims the slab up) while the window fades
          play(winEl, [{ opacity: 1 }, { opacity: 0 }], { duration: LETGO_MS, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' })
          linger = LETGO_MS
        } else {
          // no match-cut (or calm): a clean fade — the tile goes first, then the
          // black lifts while the story's own light comes up
          play(tile, [{ opacity: 1 }, { opacity: 0 }], { duration: TILE_OUT_MS, easing: 'ease-out' })
          for (const x of extras) play(x, [{ opacity: 1 }, { opacity: 0 }], { duration: TILE_OUT_MS, easing: 'ease-out' })
          await wait(TILE_OUT_MS * 0.7)
          play(bg, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-in-out' })
          linger = FADE_MS
        }
      } catch {
        /* never hold the page hostage */
        linger = 0
      } finally {
        clearInterval(ticker)
        releaseInert('loader')
        if (linger > 0) {
          root.style.pointerEvents = 'none'
          root.setAttribute('aria-hidden', 'true')
          window.setTimeout(() => root.remove(), linger + 40)
        } else root.remove()
      }
    },
  }
}
