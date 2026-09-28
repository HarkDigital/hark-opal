import * as THREE from 'three'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, SERVICES } from '../../content'
import { clamp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { Dimmer, releaseAfterUpload, stoneFloor } from '../../kit/opal'
import { StoryClock } from '../../kit/pace'
import { N, FH, FW, FY, R, arcPoint, buildAtlas, buildCards, buildFins, buildPools, finHex, finT, finTangent, gainOf, spectrum, type Atlas, type Cards, type Pools } from './spectrum'
import '../chapter.css'
import './services.css'

/*
 * SERVICES · "Spectrum". A Dan Flavin corridor, grown up: eleven tall frosted
 * glass fins on black stone in a gentle arc, each backlit by a pair of tubes
 * in one color of the dusk (blush → rose → lilac → violet → periwinkle →
 * ice → warm white: neighbors close, so the row is ONE spectrum), each with
 * its service's icon and number polished clear into the frost (spectrum.ts,
 * icons.ts).
 *
 * Laid out in vh (the chapter is LEN = 7.0 vh long):
 *   0–0.66 vh  the whole row in perspective, every fin glowing softly; a
 *              light sweeps the polished bevels. "What we do" / Eleven ways
 *              to be heard. (held ~0.4 vh clear of the cut; landing 0.06)
 *   0.66–0.86  the glide in to fin 01; its card fades in as the camera lands
 *   0.84–6.56  eleven beats of 0.52 vh (~2.2 s each at a comfortable wheel,
 *              so every card — the first and last included — reads fully
 *              for ~2 s): the camera glides round the inner arc; the fin it
 *              arrives at dims up (its icon goes crisp and bright),
 *              neighbors stay low so the spectrum still reads; the room's
 *              light field takes that color; the card names the fin.
 *   6.56–7.0   pull back to the whole spectrum, every fin lit gently and
 *              HELD (no bright finale inside the cut; the color-field cut
 *              dissolves the row into its own light).
 *
 * PACING (WCAG 2.3.1). Nothing reads `local` directly: a StoryClock turns it
 * into `q`, which follows the scroll at a reading rate (1.1 fins a second; a
 * glide between fins takes ≥ 0.5 s), so the lit fin changes ≤ ~1.1×/s however
 * fast the page moves. When the reader scans (a fling, or the story falls
 * > 1.6 fins behind) the gallery goes to TRAVEL: every fin drops low, the card
 * fades, and the clock chases the scroll in a steady pan past dim glass. At
 * rest the camera settles, the fin dims up (Dimmer, no flicker), the card fills.
 */

/** the chapter's length in vh (chapters/index.ts): the beats below are placed in vh */
const LEN = 7.0
const vh = (x: number) => x / LEN
/** each service: 0.52 vh of scroll (fin 01's card is on from ~A: it gets a full slot too) */
const A = vh(0.84)
const B = vh(0.84 + 0.52 * N)
const SPAN = (B - A) / N
/** share of a slot spent gliding between fins (the rest is a dwell) */
const GLIDE = 0.55
/** levels: the lit fin 1; neighbors; the intro row; the finale row; traveling */
const DIM = 0.22
const INTRO_LV = 0.4
const OUT_LV = 0.46
const TRAVEL_LV = 0.1
/** reading pace, fins per second (≤ 1.2 item changes/s) */
const READ_RATE = 1.1
/** scanning chase, fins per second: proportional to how far behind, clamped */
const CHASE_K = 2.2
const CHASE_MIN = 2.2
const CHASE_MAX = 10
/** minimum seconds between two fins lighting (a second guard behind the clock) */
const LIT_GAP = 0.6
/** the intro: headline + wide shot until INTRO_OUT; the glide in to fin 01 by WIDE_IN */
const INTRO_OUT = vh(0.66)
const WIDE_IN = vh(0.86)
const LIT_FROM = vh(0.83)
/** the card: in over CARD_IN, out over CARD_OUT (just before the finale) */
const CARD_IN = [vh(0.8), vh(0.86)] as const
const CARD_OUT = [B - vh(0.02), B + vh(0.04)] as const
/** the finale: pull back FIN_A–FIN_B; the whole row is lit gently from FIN_A */
const FIN_A = B
const FIN_B = B + vh(0.16)
const FOV = 40
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180)

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const approach = (x: number, to: number, step: number) => (x < to ? Math.min(to, x + step) : Math.max(to, x - step))

/** the continuous fin index for story position q: plateaus at each fin, eased glides between */
function track(q: number) {
  const u = (q - A) / SPAN - 0.5
  const n = Math.floor(u)
  const t = clamp((u - n - (1 - GLIDE) / 2) / GLIDE)
  return clamp(n + smoother(t), 0, N - 1)
}
/** the same without plateaus: a steady pan (scanning) */
const trackLinear = (q: number) => clamp((q - A) / SPAN - 0.5, 0, N - 1)

/** 1 = a wide shot of the whole row (intro, finale) */
const wideAt = (q: number) => Math.max(1 - smoothstep(INTRO_OUT, WIDE_IN, q), smoothstep(FIN_A, FIN_B, q))

/** a radial fade for the stone floor (alphaMap reads green: gray on black) */
function floorFade() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  gr.addColorStop(0, '#fff')
  gr.addColorStop(14 / 32, '#fff')
  gr.addColorStop(22 / 32, '#555')
  gr.addColorStop(30 / 32, '#000')
  g.fillStyle = gr
  g.fillRect(0, 0, 256, 256)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  // static: free the canvas once it's on the GPU (perf-05)
  releaseAfterUpload(t)
  return t
}

/** the card's per-fin CSS colors */
function cssVars(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (k: number) => `rgb(${Math.round(255 - (255 - r) * k)}, ${Math.round(255 - (255 - g) * k)}, ${Math.round(255 - (255 - b) * k)})`
  return {
    '--sv-core': mix(0.35),
    '--sv-glow': `rgba(${r}, ${g}, ${b}, 0.7)`,
    '--sv-glow-2': `rgba(${r}, ${g}, ${b}, 0.28)`,
  }
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const beats = beat(0, N, A, B)
  let atlas: Atlas
  let cards: Cards
  let pools: Pools
  const dimmers = Array.from({ length: N }, () => new Dimmer(0.6, 0.45))
  const levels = new Float32Array(N)

  let stage: HTMLElement
  let intro: HTMLElement, introTitle: HTMLElement
  /**
   * the card holds all eleven services stacked in one grid cell (inside a
   * clip). Its TOP edge is fixed where the tallest service puts it, so the
   * index row and the title never move between services; the plate's height
   * follows the service shown (a short glide), so no service sits over an
   * empty band.
   */
  let card: HTMLElement
  let clip: HTMLElement
  let bodies: HTMLElement[] = []
  let heights: number[] = []

  // ---- pacing
  const clock = new StoryClock({ rate: READ_RATE * SPAN })
  let now = 0
  let prevLocal = -1
  let traveling = false
  let travK = 0
  let cardK = 1
  let shown = 0
  let bodyK = 1
  let lit = -1
  let litAt = -1e9
  let darkAt = -1e9
  let settling = false
  // what camera() needs from update()
  let camF = 0
  let camWide = 1
  let camQ = 0
  // measured on resize (px)
  let cardTop = -1
  let cardW = 440

  const colA = new THREE.Color()
  const colB = new THREE.Color()
  const fp = new THREE.Vector3()
  const ft = new THREE.Vector3()
  const pA = new THREE.Vector3()
  const tA = new THREE.Vector3()
  const pB = new THREE.Vector3()
  const tB = new THREE.Vector3()
  const ndc = new THREE.Vector3()
  const dir = new THREE.Vector3()

  const paint = (i: number) => {
    for (const [k, v] of Object.entries(cssVars(finHex(i)))) card.style.setProperty(k, v)
  }
  /** size the plate to the service shown (glides; `now` = jump, e.g. while the card is hidden) */
  const fit = (now = false) => {
    const hh = heights[shown]
    if (!(hh > 0)) return
    if (now) clip.style.transition = 'none'
    clip.style.height = `${hh}px`
    if (now) {
      void clip.offsetHeight
      clip.style.transition = ''
    }
  }
  const swap = (i: number, now = false) => {
    reveal(bodies[shown], 0, 0)
    shown = i
    paint(i)
    fit(now)
  }
  const measure = () => {
    if (!card) return
    // the natural layout first: bottom-anchored, as tall as the tallest service
    card.style.top = ''
    card.style.bottom = ''
    clip.style.height = ''
    cardTop = card.offsetTop
    cardW = card.offsetWidth
    heights = bodies.map(b => b.offsetHeight)
    // then pin the top edge there and let the height follow the service shown
    card.style.top = `${cardTop}px`
    card.style.bottom = 'auto'
    fit(true)
  }

  /** the pose on fin f (continuous), clear of the card */
  const beatPose = (f: number, frame: Frame, pos: THREE.Vector3, tgt: THREE.Vector3) => {
    const w = frame.width
    const h = frame.height
    const aspect = w / h
    arcPoint(f, R, 0, fp)
    finTangent(f, ft)
    if (h > w) {
      // portrait: the fin's upper part (icon, number) in the band between the
      // chrome and the card; it runs on down behind the card
      const top = clamp(0.105 * h, 80, 112)
      const bottom = cardTop > 0 ? cardTop - 12 : h * 0.56
      const band = Math.max(120, bottom - top)
      const y0 = FY - 0.75
      const y1 = FY + FH / 2 + 0.12
      const vh = Math.max(((y1 - y0) * h) / band, (FW * 3.2) / aspect)
      const yc = (top + bottom) / 2 / h
      const d = vh / 2 / TAN
      const ty = (y0 + y1) / 2 - (0.5 - yc) * vh
      arcPoint(f, R - d, ty + 0.35, pos)
      tgt.set(fp.x, ty, fp.z)
      return
    }
    const vh = aspect < 1.45 ? 4.6 : 4.3
    const d = vh / 2 / TAN
    const gutter = clamp(0.034 * w, 16, 48)
    const cardFrac = (gutter + cardW) / w
    const fx = 0.5 + 0.5 * cardFrac + 0.03
    const off = (fx - 0.5) * vh * aspect
    arcPoint(f, R - d, FY + 0.32, pos).addScaledVector(ft, -off)
    tgt.set(fp.x, FY - 0.04, fp.z).addScaledVector(ft, -off)
  }

  /** the whole row: the intro in perspective (down its length), the finale square on. Returns the fov. */
  const widePose = (frame: Frame, out: boolean, pos: THREE.Vector3, tgt: THREE.Vector3) => {
    const w = frame.width
    const h = frame.height
    const aspect = w / h
    if (h > w) {
      if (!out) {
        // down the row from beyond its near end: all eleven receding under the headline
        arcPoint(-6, R - 0.2, 2.3, pos)
        arcPoint(4.5, R, 0.9, tgt)
        return 58
      }
      // back up the row from beyond its far end: the whole spectrum receding, lit
      arcPoint(N - 1 + 6, R - 0.2, 2.3, pos)
      arcPoint(5.5, R, 1.0, tgt)
      return 58
    }
    if (!out) {
      // from beyond fin 01's end, above eye level: the row recedes in a long
      // curve, low in the frame, the headline over the dark field above it
      arcPoint(-6.2, R - 3.4, 2.55, pos)
      arcPoint(3.8, R, 2.2, tgt)
      const back = clamp((1.62 - aspect) * 5, 0, 3)
      if (back > 0) pos.addScaledVector(dir.subVectors(pos, tgt).normalize(), back)
      return FOV
    }
    // square on from inside the arc: every fin in frame with a margin
    const d = 1.07 + ((FW / 2 + 5.0) * 1.1) / (TAN * aspect)
    arcPoint((N - 1) / 2, R - d, FY + 0.75, pos)
    arcPoint((N - 1) / 2, R, FY - 0.3, tgt)
    return FOV
  }

  return {
    id: 'services',
    group,
    anchors: beats.centers,
    async init(ctx) {
      stage = ctx.stage
      // the numerals are drawn with the page's own sans (no slashed zeros)
      try {
        await Promise.all([document.fonts.load('420 48px "Hanken Grotesk Variable"'), document.fonts.load('700 48px "Hanken Grotesk Variable"')])
      } catch {
        /* the redraw on fonts.ready covers it */
      }
      atlas = buildAtlas(ctx.mobile ? 512 : 1024)
      // redraw once the fonts are in, then free the atlas canvas after that upload (perf-05)
      const fontsReady = document.fonts?.ready ?? Promise.resolve()
      fontsReady
        .then(() => atlas.redraw(), () => {})
        .then(() => releaseAfterUpload(atlas.texture))
      await nextFrame()
      const fins = buildFins(atlas.texture, ctx.world.envMap)
      group.add(fins.mesh)
      cards = buildCards(atlas.texture)
      group.add(cards.mesh)
      pools = buildPools()
      group.add(pools.mesh)
      // black stone under the arc, fading out past the fins (no hard horizon
      // line across the light field behind them)
      const floor = stoneFloor(64, 64, ctx.world.envMap)
      floor.position.set(0, 0, R)
      const fm = floor.material as THREE.MeshStandardMaterial
      fm.alphaMap = floorFade()
      fm.transparent = true
      group.add(floor)
      await nextFrame()

      // ---- DOM
      intro = el('div', 'sv-intro', undefined, stage)
      el('p', 'hud-eyebrow', SECTIONS.services.eyebrow, intro)
      introTitle = rise(el('h2', 'hud-h2', undefined, intro), 'Eleven ways to be <em>heard.</em>')

      card = el('div', 'hud-panel sv-card', undefined, stage)
      clip = el('div', 'sv-clip', undefined, card)
      bodies = SERVICES.map((s, i) => {
        const b = el('div', 'sv-body', undefined, clip)
        const row = el('div', 'sv-row', undefined, b)
        el('p', 'hud-label sv-num', `${s.num} / ${String(N).padStart(2, '0')}`, row)
        el('span', 'sv-chip', undefined, row)
        el('h3', 'sv-title', s.title, b)
        el('p', 'hud-body sv-blurb', s.blurb, b)
        const tg = el('ul', 'hud-tags sv-tags', undefined, b)
        for (const t of s.tags) el('li', 'hud-tag', t, tg)
        for (const [k, v] of Object.entries(cssVars(finHex(i)))) b.style.setProperty(k, v)
        reveal(b, i === shown ? 1 : 0, 0)
        return b
      })
      paint(shown)
      reveal(card, 0, 0)
      reveal(intro, 0)
      measure()
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => measure()).observe(stage)
      document.fonts?.ready.then(measure, () => {})
    },

    update(local, frame, ctx) {
      const calm = ctx.reducedMotion || !!frame.still
      const dt = frame.dt
      now += dt
      const vel = Math.abs(frame.velocity)

      // ---- pacing: q, the story clock's view of local
      const teleport = prevLocal < 0 || Math.abs(local - prevLocal) > 0.12
      prevLocal = local
      const behind = teleport || !Number.isFinite(clock.value) ? 0 : Math.abs(local - clock.value) / SPAN
      if (traveling ? vel < 0.5 && behind < 0.25 : vel > 0.9 || behind > 1.6) traveling = !traveling
      clock.rate = SPAN * (traveling ? clamp(CHASE_K * behind, CHASE_MIN, CHASE_MAX) : READ_RATE)
      const q = clock.update(local, dt)
      const tk = traveling ? 1 : 0
      travK = teleport ? tk : approach(travK, tk, dt / 0.35)
      const f = lerp(track(q), trackLinear(q), travK * travK * (3 - 2 * travK))
      camF = f
      camWide = wideAt(q)
      camQ = q

      // ---- which fin is lit: the one the camera has arrived at. A fin dims
      // as the camera leaves it and the next dims up as the camera arrives,
      // so no bright fin slides across the frame; at most one per LIT_GAP s.
      const atRest = vel < 0.2 && !clock.busy
      const near = clamp(Math.round(f), 0, N - 1)
      const arrived = Math.abs(f - Math.round(f)) < 0.08 || atRest
      const want = q < LIT_FROM || q > FIN_A ? -1 : arrived ? near : -1
      if (traveling || want < 0) {
        if (lit >= 0) {
          lit = -1
          darkAt = now
        }
      } else if (want !== lit && (teleport || (now - litAt >= LIT_GAP && now - darkAt >= 0.2))) {
        lit = want
        litAt = now
      }

      // ---- fin levels
      let busy = clock.busy || (!traveling && want !== lit)
      let top = 0
      for (let i = 0; i < N; i++) {
        let tgt: number
        if (q < LIT_FROM) tgt = INTRO_LV
        else if (q > FIN_A) tgt = OUT_LV
        else if (traveling) tgt = TRAVEL_LV
        else tgt = i === lit ? 1 : DIM
        const d = dimmers[i]
        if (teleport) d.set(tgt)
        const lv = d.update(tgt, dt)
        levels[i] = lv
        top = Math.max(top, lv)
        if (d.busy) busy = true
      }
      const cu = cards.uniforms.uLevel.value as number[]
      const pu = pools.uniforms.uLevel.value as number[]
      for (let i = 0; i < N; i++) {
        cu[i] = levels[i]
        pu[i] = levels[i]
      }

      // ---- the room: its light field takes the color the camera faces
      const wide = camWide
      const tc = lerp(finT(f), 0.5, wide)
      spectrum(tc - lerp(0.02, 0.35, wide), colA)
      spectrum(tc + lerp(0.06, 0.35, wide), colB)
      const wp = ctx.world.params
      wp.fieldA = colA
      wp.fieldB = colB
      wp.fieldAngle = Math.PI / 2
      // pale light (ice, warm white) reads far brighter at the same level: normalize
      wp.field = lerp((0.35 + 0.35 * top) * Math.min(1, gainOf(colA) * 1.15), 0.55, wide)
      wp.fieldSize = lerp(1.0, 1.5, wide)
      // no slits in the wide shots: they drop onto the fin tops and read as
      // wires hanging the glass (ux-14); a trace of them in the close beats
      wp.slits = 0.04 * (1 - wide)
      wp.key = 0.5
      wp.fill = 0.06
      // a light sweeping the polished bevels while the row rests (intro)
      wp.envTurn = calm ? 0.4 : 0.4 + Math.sin(frame.time * 0.22) * 0.5 * (1 - smoothstep(vh(0.42), vh(0.67), q))
      // the field sits behind the lit fin's screen position
      arcPoint(f, R, FY, fp)
      ndc.copy(fp).project(ctx.camera)
      if (Number.isFinite(ndc.x) && ndc.z < 1) {
        const aspect = frame.width / frame.height
        wp.focus.set(lerp(clamp(ndc.x, -1.2, 1.2) * aspect, 0, wide), lerp(clamp(ndc.y, -0.8, 0.8), 0.05, wide))
      }
      const pp = ctx.post.params
      pp.bloomThreshold = 1.0
      pp.bloomStrength = 0.42
      pp.bloomRadius = 0.45

      // ---- copy (from q, so the words and the camera agree)
      reveal(intro, 1 - smoothstep(INTRO_OUT, INTRO_OUT + vh(0.06), q))
      setRise(introTitle, q > vh(0.05) && q < INTRO_OUT + vh(0.034))
      const cardVis = smoothstep(CARD_IN[0], CARD_IN[1], q) * (1 - smoothstep(CARD_OUT[0], CARD_OUT[1], q))
      const ck = traveling ? 0 : 1
      cardK = teleport || calm ? ck : approach(cardK, ck, dt / (traveling ? 0.2 : 0.3))
      const vis = cardVis * cardK
      // the card always names the fin the camera is on: never an empty panel
      const cur = clamp(Math.round(f), 0, N - 1)
      if (cur !== shown) {
        if (calm || teleport || vis < 0.02) {
          swap(cur, true)
          bodyK = 1
        } else {
          bodyK = Math.max(0, bodyK - dt / 0.12)
          if (bodyK <= 0) swap(cur)
        }
      } else bodyK = Math.min(1, bodyK + dt / 0.2)
      reveal(bodies[shown], bodyK, 0)
      reveal(card, vis, 0)

      settling = busy || travK !== tk || cardK !== ck || bodyK < 1 || cur !== shown
    },

    camera(_local, frame, out) {
      beatPose(camF, frame, pA, tA)
      const wideFov = widePose(frame, camQ > 0.5, pB, tB)
      const k = camWide * camWide * (3 - 2 * camWide)
      out.position.copy(pA).lerp(pB, k)
      out.target.copy(tA).lerp(tB, k)
      out.fov = lerp(FOV, wideFov, k)
      out.parallax = lerp(0.18, 0.3, k)
    },

    onEnter() {
      clock.reset()
      prevLocal = -1
    },

    busy: () => settling,
  }
}
