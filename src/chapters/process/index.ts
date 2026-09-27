import * as THREE from 'three'
import type { Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { PROCESS, SECTIONS, STATS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { beat } from '../common'
import { StoryClock } from '../../kit/pace'
import { Dimmer, DUSK, stoneFloor } from '../../kit/opal'
import {
  designCanvas,
  etchedFrost,
  etchTexture,
  FIGURE_FONT,
  floorSpill,
  lightSlab,
  etchLight,
  glintBevel,
  sketchCanvas,
  slabGeometry,
  STAT_ASPECT,
  statCanvas,
  statRow,
  type Cell,
  type DesignSpec,
  type LightSlab,
} from './studio'
import './process.css'

/*
 * PROCESS · THE STUDIO — how a light piece is made, as Hark's process.
 *
 * Four frosted glass sheets stand in a row on the black stone floor, each a
 * stage of the same piece — the Hark mark inside a fine ring — and the camera
 * walks the row (a slow lateral dolly with a gentle arc at each sheet):
 *
 *   0.00–0.16  the row from the left, the headline (SECTIONS.process) comes
 *              into focus at 0.045 and HOLDS through step 01 (out 0.285–0.30),
 *              so the landing (0.2) shows it with sheet one and card 01
 *   0.16–0.315 01 Listen     — a clear sheet of frost; construction lines,
 *              then the mark's contour, polish themselves in line by line (an
 *              etch whose draw order follows the step), a faint warm light
 *   0.315–0.47 02 Prototype  — the design complete, etched; one test tube
 *              behind it, lit dimly: the model you react to
 *   0.47–0.625 03 Build      — the full tube bank installed, dimming up
 *              (Dimmer), its warm white settling into rose → lilac
 *   0.625–0.78 04 Support    — the finished piece glowing; a slow hairline of
 *              light sweeps across its polished bevel (world envTurn)
 *   0.80–0.96  the stats: 10 years · $1M+ · 15 in thin numerals polished into
 *              one long glass bar lit from behind (lilac → periwinkle), each
 *              label under its figure; phones stack three short bars
 *   0.96–1.00  the bar stays lit for the colour-field cut
 *
 * Camera, active sheet, DOM cards and the stats all follow a StoryClock
 * (kit/pace.ts): at most ~1 sheet per second however fast the scroll, and
 * every move between sheets takes ≥ ~0.45 s (WCAG 2.3.1). Lights change
 * only through Dimmers. No RectAreaLights: the cards + tubes are the light.
 */

const SHOW = [STATS[0], STATS[2], STATS[1]] // 10 years, $1M+, 15
const TAGS = [
  'Frosted glass · a first line, polished clear',
  'The design etched · one test tube behind',
  'The tube bank installed · colour settling',
  'Finished · a hairline of light along the bevel',
]
const A0 = 0.16
const A1 = 0.78
const SLOT = (A1 - A0) / PROCESS.length
/** headline: in a → b, out c → d (clear of the ~0.075 cut window) */
const HEAD = [0.045, 0.07, 0.285, 0.3]
/** the clock: local units per second (~1 sheet per second) */
const RATE = 0.13

// ---------------------------------------------------------------- the studio
const PW = 1.5
const PH = 2.1
const DEPTH = 0.09
const LIFT = 0.1 // glass bottom above the floor (in its shoe)
const PY = LIFT + PH / 2
const SP = 2.8
const PX = [0, SP, 2 * SP, 3 * SP]
/**
 * The tube bank's rhythm (fractions of its span, symmetric, one tube on the
 * mark's axis). Deliberately NOT evenly spaced: a regular grating sliding
 * past at about half its pitch per frame aliases into a 30 Hz shimmer
 * (measured as block flashes during the walk between sheets).
 */
const BANK = [-0.5, -0.4, -0.18, 0, 0.18, 0.4, 0.5]
const DESIGN: DesignSpec = { cy: 0.14, mark: 0.7, ring: 0.54, ringLine: 0.011 }
/** the long bar (landscape) */
const BAR = { x: 3 * SP + 7.2, y: 1.32, w: 6.3, h: 0.96 }
const CELL_W = 1.78
const CELL_H = CELL_W / STAT_ASPECT
const PITCH = 1.98
/** the figures' light: a faint lilac field, the numerals drawn in near-white */
const FIG_LIGHT = '#f4eeff'
const FIG_BASE = 0.16
const FIG_HDR = 1.05
/** the stack of three short bars (portrait) */
const SB = { w: 2.0, h: 0.64, gap: 0.8 }
const STACK_TOP = 3.9 // centre y of the top short bar
const stackY = (k: number) => STACK_TOP - k * (SB.h + SB.gap)
const STACK_H = 3 * SB.h + 3 * SB.gap
const STACK_CY = STACK_TOP + SB.h / 2 - STACK_H / 2

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
/** the hairline on the finished piece's bevel: a lilac-white, just touching bloom */
const GLINT = new THREE.Color('#f1e8ff').multiplyScalar(1.15)
const col = (h: string) => new THREE.Color(h)
const C = {
  warm: col(DUSK.warm),
  blush: col(DUSK.blush),
  rose: col(DUSK.rose),
  lilac: col(DUSK.lilac),
  violet: col(DUSK.violet),
  peri: col(DUSK.periwinkle),
}

// ---------------------------------------------------------------- camera keys
type Mode = 'head' | 'card' | 'stats'
interface Key {
  t: [number, number, number]
  yaw: number
  pitch: number
  w: number
  h: number
  mode: Mode
  /** portrait overrides */
  pt?: [number, number, number]
  pyaw?: number
  ppitch?: number
  pw?: number
  ph?: number
}
const sheet = (i: number, yaw: number, pitch: number, zoom: number): Key => ({
  t: [PX[i], PY - 0.02, 0],
  yaw,
  pitch,
  w: PW * 1.1 * zoom,
  h: PH * 1.08 * zoom,
  mode: 'card',
  pw: PW * 1.14 * zoom,
  ph: PH * 1.06 * zoom,
})
const K = {
  est0: { t: [SP * 1.35, 1.05, 0], yaw: -36, pitch: 5, w: 9.2, h: 2.9, mode: 'head', pt: [SP * 0.55, 1.1, 0], pyaw: -32, pw: 3.9, ph: 2.6 },
  est1: { t: [SP * 1.15, 1.08, 0], yaw: -31, pitch: 5, w: 8.4, h: 2.8, mode: 'head', pt: [SP * 0.45, 1.12, 0], pyaw: -27, pw: 3.5, ph: 2.5 },
  p1a: sheet(0, -14, 4, 1.2),
  p1b: sheet(0, -9, 3.5, 1.16),
  p2a: sheet(1, -10, 4, 1.2),
  p2b: sheet(1, -5, 3.5, 1.16),
  p3a: sheet(2, -7, 4, 1.2),
  p3b: sheet(2, -2, 3.5, 1.16),
  // the arc round the finished piece: its right bevel turns to the camera
  p4a: sheet(3, -5, 4, 1.2),
  p4b: sheet(3, 10, 3, 1.14),
  stA: { t: [BAR.x, BAR.y, 0], yaw: -2, pitch: 2, w: BAR.w + 0.3, h: BAR.h, mode: 'stats', pt: [BAR.x, STACK_CY, 0], pyaw: -3, ppitch: 2, pw: SB.w + 0.2, ph: STACK_H },
  stB: { t: [BAR.x, BAR.y, 0], yaw: 1, pitch: 2, w: BAR.w + 0.3, h: BAR.h, mode: 'stats', pt: [BAR.x, STACK_CY, 0], pyaw: 1, ppitch: 2, pw: SB.w + 0.2, ph: STACK_H },
  stC: { t: [BAR.x, BAR.y, 0], yaw: 2, pitch: 2, w: BAR.w + 0.3, h: BAR.h, mode: 'stats', pt: [BAR.x, STACK_CY, 0], pyaw: 2, ppitch: 2, pw: SB.w + 0.2, ph: STACK_H },
} satisfies Record<string, Key>
const B1 = A0 + SLOT
const B2 = A0 + 2 * SLOT
const B3 = A0 + 3 * SLOT
/** moves between sheets straddle the slot boundaries (±0.05 → ≥ 0.75 s at RATE: a slow walk keeps the glass calm) */
const MV = 0.05
const TRACK: [number, Key][] = [
  [0.0, K.est0],
  [0.1, K.est1],
  [0.175, K.p1a],
  [B1 - MV, K.p1b],
  [B1 + MV, K.p2a],
  [B2 - MV, K.p2b],
  [B2 + MV, K.p3a],
  [B3 - MV, K.p3b],
  [B3 + MV, K.p4a],
  [0.765, K.p4b],
  [0.835, K.stA],
  [0.95, K.stB],
  [1.0, K.stC],
]
/** segments that are slow drifts (linear), the rest are eased moves */
const HOLDS = new Set([0, 2, 4, 6, 8, 10, 11])

interface Resolved {
  t: THREE.Vector3
  yaw: number
  pitch: number
  w: number
  h: number
  cx: number
  cy: number
  fx: number
  fy: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const B = beat(0, PROCESS.length, A0, A1)
  const clock = new StoryClock({ rate: RATE })

  // DOM
  let head: HTMLElement
  let title: HTMLElement
  /** one step card (a constant plate: no dip to the bright glass between steps), four pages */
  let card: HTMLElement
  const pages: HTMLElement[] = []
  let statsBox: HTMLElement
  const statEls: HTMLElement[] = []
  const statT = ['', '', '']

  // scene
  const sheets: LightSlab[] = []
  const spills: ReturnType<typeof floorSpill>[] = []
  let sketchU: ReturnType<typeof etchedFrost>['u']
  let sketchL: ReturnType<typeof etchLight>
  let glint: ReturnType<typeof glintBevel>
  let barSpill: ReturnType<typeof floorSpill>
  let wide: THREE.Group
  let stack: THREE.Group
  const tubeDim = new Dimmer(0.9, 0.5)
  const bankDim = new Dimmer(1.2, 0.7)
  let bankOn = false
  let portraitScene: boolean | null = null

  // camera
  const pose = { position: V(0, 1.2, 6), target: V(0, 1.1, 0), fov: 36, parallax: 0.12 }
  const cam = new THREE.PerspectiveCamera(36, 1, 0.05, 200)
  const regions = { key: '', cardRight: 0, cardTop: 0, headBottom: 0, labelH: 64, labelW: 260, stackLabelW: 300 }
  const rA: Resolved = { t: V(0, 0, 0), yaw: 0, pitch: 0, w: 1, h: 1, cx: 0, cy: 0, fx: 1, fy: 1 }
  const rB: Resolved = { t: V(0, 0, 0), yaw: 0, pitch: 0, w: 1, h: 1, cx: 0, cy: 0, fx: 1, fy: 1 }
  const tA = V(0, 0, 0)
  const dir = V(0, 0, 0)
  const fwd = V(0, 0, 0)
  const vR = V(0, 0, 0)
  const vU = V(0, 0, 0)
  const tmp = V(0, 0, 0)
  const Y1 = V(0, 1, 0)
  const tc = new THREE.Color()
  const tc2 = new THREE.Color()
  const sx = [0, 0, 0]

  const gutter = (W: number) => clamp(W * 0.034, 16, 48)
  const bands = (W: number, H: number) =>
    W > H && H <= 500 ? { top: 52, bot: 52 } : { top: clamp(H * 0.105, 80, 112), bot: clamp(H * 0.105, 82, 110) }

  /** landscape stats: the bar's scale (px per world unit) for the label row height given */
  function statScale(W: number, H: number, labelH: number) {
    const g = gutter(W)
    const b = bands(W, H)
    const fx = W - 2 * g
    const fy = Math.max(H * 0.2, H - b.top - b.bot - labelH - 26)
    return Math.min(fx / (BAR.w + 0.3), fy / BAR.h)
  }

  /** layout reads, only when the viewport changes (and once fonts land) */
  function measure(frame: Frame) {
    const W = frame.width
    const H = frame.height
    const key = `${W}x${H}`
    if (regions.key === key) return
    regions.key = key
    const cb = card.getBoundingClientRect()
    regions.cardRight = cb.right
    regions.cardTop = cb.top
    regions.headBottom = head.getBoundingClientRect().bottom
    const g = gutter(W)
    if (H > W) {
      // portrait: one label per short bar, as wide as the bar (or the screen)
      const s = Math.min((W - 2 * g) / (SB.w + 0.2), (H - bands(W, H).top - bands(W, H).bot) / STACK_H)
      regions.stackLabelW = Math.round(Math.min(W - 2 * g, Math.max(220, SB.w * s + 24)))
      for (const d of statEls) {
        d.style.width = `${regions.stackLabelW}px`
        d.style.minHeight = ''
      }
      return
    }
    // landscape: three labels in columns of the figures' pitch, never wider
    // (no overlaps at any size); same height so their tops and bottoms line up
    for (let pass = 0; pass < 2; pass++) {
      const pitchPx = PITCH * statScale(W, H, regions.labelH)
      regions.labelW = Math.round(clamp(Math.min(300, pitchPx - 22, (W - 2 * g - 44) / 3), 140, 300))
      let lh = 0
      for (const d of statEls) {
        d.style.width = `${regions.labelW}px`
        d.style.minHeight = ''
        lh = Math.max(lh, d.offsetHeight)
      }
      for (const d of statEls) d.style.minHeight = `${lh}px`
      regions.labelH = lh
    }
  }

  function resolve(k: Key, portrait: boolean, frame: Frame, headOn: boolean, out: Resolved) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const t = portrait && k.pt ? k.pt : k.t
    out.t.set(t[0], t[1], t[2])
    out.yaw = portrait && k.pyaw != null ? k.pyaw : k.yaw
    out.pitch = portrait && k.ppitch != null ? k.ppitch : k.pitch
    out.w = portrait && k.pw != null ? k.pw : k.w
    out.h = portrait && k.ph != null ? k.ph : k.h
    const g = gutter(W)
    const b = bands(W, H)
    let x0 = g
    let x1 = W - g
    let y0 = b.top
    let y1 = H - b.bot
    if (!portrait) {
      if (k.mode === 'card') {
        x0 = regions.cardRight + 24
      } else if (k.mode === 'head') {
        x0 = W * 0.3
        y0 = b.top + (H - b.top - b.bot) * 0.12
      } else {
        // the bar, then its label row, the pair centred between the bands
        const s = statScale(W, H, regions.labelH)
        const block = out.h * s + 26 + regions.labelH
        y0 = b.top + Math.max(0, (H - b.top - b.bot - block) / 2)
        y1 = y0 + out.h * s
      }
    } else if (k.mode === 'card') {
      y1 = regions.cardTop - 14
      if (headOn) y0 = regions.headBottom + 10
    } else if (k.mode === 'head') {
      y0 = regions.headBottom + 10
    }
    if (x1 - x0 < W * 0.3) x0 = x1 - W * 0.3
    if (y1 - y0 < H * 0.22) y0 = y1 - H * 0.22
    out.cx = (x0 + x1) / W - 1
    out.cy = 1 - (y0 + y1) / H
    out.fx = (x1 - x0) / W
    out.fy = (y1 - y0) / H
  }

  function computePose(q: number, frame: Frame) {
    const portrait = frame.height > frame.width
    const headOn = q < HEAD[3]
    let i = 0
    while (i < TRACK.length - 2 && q > TRACK[i + 1][0]) i++
    const [a0, ka] = TRACK[i]
    const [a1, kb] = TRACK[i + 1]
    let f = clamp((q - a0) / Math.max(1e-6, a1 - a0))
    f = HOLDS.has(i) ? f : ease.inOutCubic(f)
    resolve(ka, portrait, frame, headOn, rA)
    resolve(kb, portrait, frame, headOn, rB)
    const L = (a: number, b: number) => a + (b - a) * f
    tA.lerpVectors(rA.t, rB.t, f)
    const yaw = THREE.MathUtils.degToRad(L(rA.yaw, rB.yaw))
    const pitch = THREE.MathUtils.degToRad(L(rA.pitch, rB.pitch))
    const w = L(rA.w, rB.w)
    const h = L(rA.h, rB.h)
    const cx = L(rA.cx, rB.cx)
    const cy = L(rA.cy, rB.cy)
    const fx = L(rA.fx, rB.fx)
    const fy = L(rA.fy, rB.fy)
    const fov = portrait ? 42 : 34
    const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const tanH = tanV * Math.max(0.2, frame.width / Math.max(1, frame.height))
    const dist = Math.max(w / 2 / (tanH * fx), h / 2 / (tanV * fy))
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    fwd.copy(dir).negate()
    vR.crossVectors(fwd, Y1).normalize()
    vU.crossVectors(vR, fwd)
    const hw = dist * tanH
    const hh = dist * tanV
    pose.target.copy(tA).addScaledVector(vR, -cx * hw).addScaledVector(vU, -cy * hh)
    pose.position.copy(pose.target).addScaledVector(dir, dist)
    pose.fov = fov
    pose.parallax = q > 0.8 ? 0 : 0.1
    return { cx, cy }
  }

  /** landscape: a label under each figure; portrait: under each short bar. Tops shared, no overlaps. */
  function placeLabels(frame: Frame, portrait: boolean) {
    const W = frame.width
    const H = frame.height
    cam.fov = pose.fov
    cam.aspect = W / Math.max(1, H)
    cam.position.copy(pose.position)
    cam.lookAt(pose.target)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    const write = (i: number, x: number, y: number) => {
      const t = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
      if (statT[i] !== t) {
        statT[i] = t
        statEls[i].style.transform = t
      }
    }
    if (portrait) {
      const w = regions.stackLabelW
      for (let k = 0; k < 3; k++) {
        tmp.set(BAR.x, stackY(k) - SB.h / 2, 0.05).project(cam)
        const cxp = (tmp.x * 0.5 + 0.5) * W
        const y = (0.5 - tmp.y * 0.5) * H + 12
        write(k, clamp(cxp - w / 2, gutter(W), W - gutter(W) - w), y)
      }
      return
    }
    const w = regions.labelW
    let top = 0
    for (let k = 0; k < 3; k++) {
      tmp.set(BAR.x + (k - 1) * PITCH, BAR.y, 0.05).project(cam)
      sx[k] = (tmp.x * 0.5 + 0.5) * W
      tmp.set(BAR.x + (k - 1) * PITCH, BAR.y - BAR.h / 2, 0.05).project(cam)
      top = Math.max(top, (0.5 - tmp.y * 0.5) * H)
    }
    const g = gutter(W)
    for (let k = 1; k < 3; k++) sx[k] = Math.max(sx[k], sx[k - 1] + w + 12)
    const over = sx[2] + w / 2 - (W - g)
    if (over > 0) for (let k = 0; k < 3; k++) sx[k] -= over
    const under = g - (sx[0] - w / 2)
    if (under > 0) for (let k = 0; k < 3; k++) sx[k] += under
    for (let k = 0; k < 3; k++) write(k, sx[k] - w / 2, top + 22)
  }

  return {
    id: 'process',
    group,
    // the four steps, then the stats beat (srContent makes the first stat a keyboard stop)
    anchors: [...B.centers, 0.88],
    busy: () => clock.busy || tubeDim.busy || bankDim.busy,
    onEnter() {
      clock.reset()
    },
    async init(ctx) {
      const mobile = ctx.mobile
      const res = mobile ? 512 : 1024
      const env = ctx.world.envMap

      // ---------------- floor
      // big enough that its far edge never shows as a horizon
      const floor = stoneFloor(240, 160, env)
      floor.position.set(8, 0, -50)
      group.add(floor)

      // ---------------- the four sheets (one slab geometry, two etch materials)
      const geo = slabGeometry(PW, PH, DEPTH, 0.04, mobile)
      const whole: Cell[] = [{ cx: 0, cy: 0, w: PW, h: PH, atlas: [0, 0, 1, 1] }]
      const sketchTex = etchTexture(sketchCanvas(PW, PH, res, DESIGN, { guide: 0.006, line: 0.012 }))
      const sketch = etchedFrost(sketchTex, whole, { frost: 0.58 })
      sketchU = sketch.u
      sketchU.uEtchDraw.value = 0
      const design = etchedFrost(etchTexture(designCanvas(PW, PH, res, DESIGN)), whole, { frost: 0.58 })
      glint = glintBevel(PW, PH)
      await nextFrame()
      const shoeMat = new THREE.MeshStandardMaterial({ color: 0x0b0a0e, roughness: 0.34, metalness: 0.6, envMap: env, envMapIntensity: 0.55 })
      const shoeGeo = new THREE.BoxGeometry(PW * 0.96, LIFT + 0.03, 0.5)
      for (let i = 0; i < 4; i++) {
        const s = lightSlab({
          w: PW,
          h: PH,
          depth: DEPTH,
          gap: 0.3,
          mobile,
          geometry: geo,
          caps: i === 0 ? sketch.material : design.material,
          sides: i === 3 ? glint.material : undefined,
          a: i < 2 ? DUSK.warm : DUSK.rose,
          b: i < 2 ? DUSK.blush : DUSK.lilac,
          angle: 1.25,
          hdr: i === 1 ? 0.26 : 0.5,
          tubes: i === 0 ? undefined : i === 1 ? { n: 1, dir: 'v', color: DUSK.warm, hdr: 1.7 } : { n: BANK.length, dir: 'v', at: BANK.map(k => k * PW * 0.8), hdr: 2.2 },
          envMap: env,
        })
        s.group.position.set(PX[i], PY, 0)
        group.add(s.group)
        sheets.push(s)
        if (i === 0) {
          // sheet one is lit by its own sketch, drawn in light just behind the glass
          s.card.visible = false
          sketchL = etchLight(PW * 0.94, PH * 0.94, sketchTex, whole, { a: DUSK.warm, b: DUSK.blush, line: DUSK.warm, base: 0.2, hdr: mobile ? 1.45 : 1.25, soft: 0.22 })
          sketchL.u.uDraw.value = 0
          sketchL.mesh.position.z = -DEPTH / 2 - 0.016
          s.group.add(sketchL.mesh)
        }
        const shoe = new THREE.Mesh(shoeGeo, shoeMat)
        shoe.position.set(PX[i], (LIFT + 0.03) / 2, -0.19)
        group.add(shoe)
        const sp = floorSpill(PW * 1.5, 2.4, 0.5)
        sp.mesh.position.set(PX[i], 0.002, 0.04)
        group.add(sp.mesh)
        spills.push(sp)
        await nextFrame()
      }

      // ---------------- the stats: thin numerals polished into glass
      try {
        await document.fonts.load(`260 120px ${FIGURE_FONT}`)
        await document.fonts.load(`330 120px ${FIGURE_FONT}`)
      } catch {
        /* drawn with the fallback until fonts.ready redraws */
      }
      const figC = statCanvas(res)
      const tex = etchTexture(figC)
      const cells: Cell[] = [0, 1, 2].map(k => ({ cx: (k - 1) * PITCH, cy: 0, w: CELL_W, h: CELL_H, atlas: statRow(k) }))
      const barMat = etchedFrost(tex, cells, { frost: 0.6 })
      const bar = lightSlab({
        w: BAR.w,
        h: BAR.h,
        depth: DEPTH,
        gap: 0.24,
        radius: 0.05,
        mobile,
        caps: barMat.material,
        a: DUSK.lilac,
        b: DUSK.periwinkle,
        envMap: env,
      })
      // lit from behind by the figures themselves, drawn in light just behind the glass
      bar.card.visible = false
      const barLight = etchLight(BAR.w * 0.97, BAR.h * 0.9, tex, cells, { a: DUSK.lilac, b: DUSK.periwinkle, line: FIG_LIGHT, base: FIG_BASE, hdr: FIG_HDR, soft: 0.3 })
      barLight.mesh.position.z = -DEPTH / 2 - 0.016
      bar.group.add(barLight.mesh)
      wide = new THREE.Group()
      bar.group.position.set(BAR.x, BAR.y, 0)
      wide.add(bar.group)
      // two slim steel legs to the floor
      const legMat = shoeMat
      const legH = BAR.y - BAR.h / 2
      const legGeo = new THREE.BoxGeometry(0.05, legH, 0.05)
      for (const lx of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat)
        leg.position.set(BAR.x + lx * (BAR.w / 2 - 0.7), legH / 2, -0.2)
        wide.add(leg)
      }
      barSpill = floorSpill(BAR.w * 1.1, 2.6, 0.6)
      barSpill.mesh.position.set(BAR.x, 0.002, 0.04)
      wide.add(barSpill.mesh)
      group.add(wide)
      await nextFrame()

      stack = new THREE.Group()
      const sbGeo = slabGeometry(SB.w, SB.h, DEPTH, 0.04, mobile)
      for (let k = 0; k < 3; k++) {
        const m = etchedFrost(tex, [{ cx: 0, cy: 0, w: CELL_W, h: CELL_H, atlas: statRow(k) }], { frost: 0.6 })
        const s = lightSlab({
          w: SB.w,
          h: SB.h,
          depth: DEPTH,
          gap: 0.22,
          radius: 0.04,
          mobile,
          geometry: sbGeo,
          caps: m.material,
          a: DUSK.lilac,
          envMap: env,
        })
        s.card.visible = false
        const sa = k === 0 ? DUSK.lilac : k === 1 ? '#b3a3ff' : DUSK.violet
        const sb = k === 0 ? '#b3a3ff' : k === 1 ? DUSK.violet : DUSK.periwinkle
        const sl = etchLight(SB.w * 0.96, SB.h * 0.88, tex, [{ cx: 0, cy: 0, w: CELL_W, h: CELL_H, atlas: statRow(k) }], { a: sa, b: sb, line: FIG_LIGHT, base: FIG_BASE, hdr: FIG_HDR, soft: 0.2 })
        sl.mesh.position.z = -DEPTH / 2 - 0.016
        s.group.add(sl.mesh)
        s.group.position.set(BAR.x, stackY(k), 0)
        stack.add(s.group)
      }
      // a slim mast behind the stack
      const mastH = STACK_TOP + SB.h / 2 + 0.1
      const mast = new THREE.Mesh(new THREE.BoxGeometry(0.05, mastH, 0.05), legMat)
      mast.position.set(BAR.x, mastH / 2, -0.33)
      stack.add(mast)
      const stackSpill = floorSpill(SB.w * 1.4, 2.2, 0.5)
      stackSpill.mesh.position.set(BAR.x, 0.002, 0.04)
      stackSpill.set(C.violet, C.peri, 0.1)
      stack.add(stackSpill.mesh)
      group.add(stack)

      // redraw the figures once every face is in (a late font swap)
      document.fonts?.ready.then(() => {
        const c2 = statCanvas(res)
        const g = figC.getContext('2d')!
        g.clearRect(0, 0, figC.width, figC.height)
        g.drawImage(c2, 0, 0)
        tex.needsUpdate = true
        regions.key = ''
      })

      // ---------------- DOM
      head = el('div', 'pc-head', undefined, ctx.stage)
      el('p', 'hud-eyebrow', SECTIONS.process.eyebrow, head)
      title = rise(el('h2', 'hud-h2 pc-h2', undefined, head), 'We listen first. Then we <em>build.</em>')
      card = el('div', 'pc-card hud-panel', undefined, ctx.stage)
      PROCESS.forEach((p, i) => {
        const c = el('div', 'pc-page', undefined, card)
        const num = el('p', 'pc-num', undefined, c)
        el('span', 'pc-n', String(i + 1).padStart(2, '0'), num)
        el('span', 'pc-of', `/ ${String(PROCESS.length).padStart(2, '0')}`, num)
        el('h3', 'pc-title', p.title, c)
        el('p', 'hud-body pc-text', p.text, c)
        el('p', 'pc-tag', TAGS[i], c)
        reveal(c, 0, 0)
        pages.push(c)
      })
      reveal(card, 0, 0)
      statsBox = el('div', 'pc-stats', undefined, ctx.stage)
      for (const s of SHOW) {
        const d = el('div', 'pc-stat', undefined, statsBox)
        el('p', 'pc-stat-v', s.value, d)
        el('p', 'pc-stat-l', s.label, d)
        reveal(d, 0, 0)
        statEls.push(d)
      }
      reveal(head, 0, 0)
      document.fonts?.ready.then(() => (regions.key = ''))
    },

    update(local, frame, ctx) {
      const dt = frame.dt
      const q = clock.update(local, dt)
      const portrait = frame.height > frame.width
      measure(frame)
      if (portraitScene !== portrait) {
        portraitScene = portrait
        wide.visible = !portrait
        stack.visible = portrait
        for (const d of statEls) d.classList.toggle('is-stack', portrait)
        statT.fill('')
        regions.key = ''
        measure(frame)
      }

      // ---------------- the sheets
      // 01: the sketch polishes itself in over step 01
      const draw = ease.inOutQuad(segment(q, A0 - 0.02, B1 - 0.03))
      sketchU.uEtchDraw.value = draw
      sketchL.u.uDraw.value = draw
      spills[0].set(C.warm, C.blush, 0.05)
      // 02: one test tube, lit dimly (a little brighter once we arrive)
      const tl = tubeDim.update(q > B1 - 0.01 ? 0.62 : 0.32, dt)
      sheets[1].tubes[0].setLevel(tl)
      sheets[1].card.setLevel(1)
      spills[1].set(C.warm, C.blush, 0.04 + 0.06 * tl)
      // 03: the bank dims up as we arrive (hysteresis: never toggles on a jitter)
      if (!bankOn && q > B2 + 0.012) bankOn = true
      else if (bankOn && q < B2 - 0.012) bankOn = false
      const bl = bankDim.update(bankOn ? 1 : 0, dt)
      // colour settles from the tubes' raw warm white into the dusk gradient
      const settle = smoothstep(B2 + 0.02, B2 + SLOT * 0.8, q)
      const s3 = sheets[2]
      s3.tubes.forEach((t, i) => {
        const k = i / (s3.tubes.length - 1)
        tc.copy(C.rose).lerp(C.lilac, k)
        tc2.copy(C.warm).lerp(tc, settle)
        t.setColor('#' + tc2.getHexString())
        t.setLevel(bl)
      })
      tc.copy(C.warm).lerp(C.rose, settle)
      tc2.copy(C.blush).lerp(C.lilac, settle)
      s3.card.setColors('#' + tc.getHexString(), '#' + tc2.getHexString())
      s3.card.setLevel(0.22 + 0.78 * bl)
      spills[2].set(tc, tc2, 0.03 + 0.15 * bl)
      // 04: finished, always on
      sheets[3].tubes.forEach(t => t.setLevel(1))
      sheets[3].card.setLevel(1)
      spills[3].set(C.rose, C.lilac, 0.18)
      // the stats
      barSpill.set(C.lilac, C.peri, 0.1)
      // 04: a hairline of light travels once around the finished piece's bevel
      const p4 = segment(q, B3 + 0.015, A1 - 0.01)
      glint.u.uGlintAt.value = 0.77 + ease.inOutQuad(p4)
      glint.u.uGlint.value.copy(GLINT).multiplyScalar(Math.sin(Math.PI * clamp(p4 * 1.15 - 0.05)))

      // ---------------- camera (written in camera())
      const { cx, cy } = computePose(q, frame)

      // ---------------- world + post
      const W = ctx.world.params
      const aspect = frame.width / Math.max(1, frame.height)
      W.focus.set(cx * aspect, cy)
      W.fieldSize = 0.85
      W.slits = 0.12
      W.key = 0.5
      W.fill = 0.07
      const inStats = q > 0.8
      const at = inStats ? 4 : clamp(Math.floor((q - A0) / SLOT), 0, 3)
      if (inStats) {
        W.fieldA = DUSK.lilac
        W.fieldB = DUSK.periwinkle
        W.field = 0.4
      } else if (at >= 2) {
        W.fieldA = DUSK.rose
        W.fieldB = DUSK.lilac
        W.field = 0.35
      } else {
        W.fieldA = DUSK.blush
        W.fieldB = DUSK.lilac
        W.field = 0.25
      }
      // 04: the studio's reflections turn slowly across the finished piece too
      W.envTurn = q > B3 - 0.03 && q < 0.8 ? lerp(-0.5, 0.5, ease.inOutQuad(p4)) : 0
      ctx.post.params.bloomStrength = 0.55

      // ---------------- DOM
      reveal(head, smoothstep(HEAD[0], HEAD[1], q) * (1 - smoothstep(HEAD[2], HEAD[3], q)), 0)
      setRise(title, q > HEAD[0] + 0.004 && q < HEAD[3])
      reveal(card, window01(q, A0 + 0.004, A1 - 0.004, 0.012), 0)
      pages.forEach((c, i) => {
        const a = A0 + i * SLOT
        // first/last pages ride the plate's own fade; between steps they cross over
        reveal(c, window01(q, i === 0 ? A0 - 0.01 : a, i === 3 ? A1 + 0.01 : a + SLOT, 0.008), 0)
      })
      const sv = window01(q, 0.815, 0.968, 0.016)
      statEls.forEach((d, i) => reveal(d, sv * smoothstep(0.815 + i * 0.012, 0.83 + i * 0.012, q), 0))
      if (sv > 0) placeLabels(frame, portrait)
    },

    camera(_local, _frame, out) {
      out.position.copy(pose.position)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.parallax = pose.parallax
    },
  }
}
