import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { whenRevealed } from '../../kit/images'
import { DUSK, Dimmer, stoneFloor } from '../../kit/opal'
import { neonFromStrokes, type NeonPart } from '../../kit/neon'
import { buildSlab, type Slab } from './slab'
import { floorLight, type FloorLight } from './floor'
import './hero.css'

/*
 * HERO · "Threshold" — the gallery's entrance: one monumental slab of
 * frosted glass (taller than a person, thick, razor-polished bevels) standing
 * in black stone, the Hark mark polished CLEAR through it. Through the mark
 * the Flavin bank behind it is crisp; everywhere else the slab is a soft
 * opal glow. Architectural, still.
 *
 *   0.00–0.155 landing: eyebrow, the h1 (BRAND.tagline), manifesto, scroll
 *              hint. The slab's light dims up once after the reveal (Dimmer,
 *              ~1.2 s) and then simply stays lit. Slab right of the copy
 *              (portrait: between the title plate and the manifesto plate).
 *   0.155–0.60 a slow arc around the slab: the camera swings past its right
 *              edge (the polished bevel catches the traveling highlight, the
 *              tubes stand bare behind the glass) and settles on a 3/4 view;
 *              the gels shift rose → violet → ice with local (continuous).
 *              The eyebrow + h1 leave as the arc starts; the manifesto and
 *              the hint stay with the slab through the first half of it (a
 *              quiet caption beat — the arc is never copy-less for long).
 *   0.48–0.93  payoff: composed 3/4 frame, the locale label + the two CTAs;
 *              the Flavin floor piece dims up once the manifesto has gone.
 *   0.935–1.00 out: a push into the lit face (light in frame for the cut).
 *
 * Copy fades by TIME (Dimmer) once the scroll crosses its threshold, so a
 * parked frame never shows a half-faded headline over a still slab.
 *
 * Framing is computed, not hand-posed: each key pose orbits the slab at a
 * fixed yaw/pitch and fits the slab's world box into the screen space the
 * copy leaves free (measured from the DOM once a second and on resize).
 * Between keys the orbit parameters (not the positions) are interpolated, so
 * the camera travels on a true arc.
 *
 * The hero publishes where its mark sits on the landing frame (local 0) as
 * CSS vars on <html> for the loader's match cut:
 *   --hark-mark-x, --hark-mark-y  center of the mark's SVG viewBox, CSS px
 *   --hark-mark-size              side of that (square) viewBox, CSS px
 */

const FLOOR_Y = -2.0
/** slab geometry (world units ≈ meters: 3.9 m of glass, a person is 1.8) */
const SLAB = { w: 2.2, h: 3.86, depth: 0.12, bevel: 0.05, gap: 0.34, markH: 1.34, markY: 0.4, plinthH: 0.16 }
/** camera keys: landing hold → arc (past the edge) → payoff → the out push */
const ARC = { hold: 0.155, mid: 0.41, pay: 0.6, out: 0.935 }
/**
 * copy thresholds (each block fades by time on crossing): the eyebrow + h1
 * leave as the arc starts; the manifesto + hint stay through its first half;
 * the payoff (locale + CTAs) is on over PAY_IN..PAY_OUT
 */
const HEAD_OUT = ARC.hold
const FOOT_OUT = 0.37
const PAY_IN = 0.48
const PAY_OUT = 0.93

/** gels: the dominant light travels rose → violet → ice (A left, B right) */
const GELS = [
  { a: new THREE.Color(DUSK.rose), b: new THREE.Color(DUSK.lilac) },
  { a: new THREE.Color(DUSK.lilac), b: new THREE.Color(DUSK.violet) },
  { a: new THREE.Color(DUSK.violet), b: new THREE.Color(DUSK.ice) },
]

type Orbit = { th: number; ph: number; d: number; nx: number; ny: number; fov: number }
const orbit = (th = 0, ph = 0, fov = 36): Orbit => ({ th, ph, d: 9, nx: 0, ny: 0, fov })

const easeSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)

export default function create(): Chapter {
  const group = new THREE.Group()
  let slab: Slab
  let fl: FloorLight
  /**
   * the room's one piece: a Flavin-style corner — a standing ice tube (thick
   * enough to read as a lit fluorescent with its own soft halo, never a stray
   * hairline) and a warm hairline lying on the floor from its foot.
   * Off at the landing (the entrance is the slab alone); it dims up once the
   * manifesto has left the arc, placed per layout so the payoff frame shows
   * it in the gap between the CTAs and the slab.
   */
  const corner = { group: new THREE.Group(), post: null as NeonPart | null, run: null as NeonPart | null, x: -5.2, show: true, color: new THREE.Color(DUSK.ice), runColor: new THREE.Color(DUSK.warm) }
  const CORNER = { z: -5.4, top: 4.2, run: 3.2 }
  const cornerDim = new Dimmer(1.1, 0.6)
  const dim = new Dimmer(1.2, 0.5)
  /** the copy blocks fade by time once the scroll crosses their thresholds */
  const headDim = new Dimmer(0.45, 0.35)
  const footDim = new Dimmer(0.45, 0.35)
  const payDim = new Dimmer(0.5, 0.35)
  /** snap the copy to its targets on the next update (entering, teleports) */
  let snapCopy = true
  let lastLocal = NaN
  let revealed = false
  let portrait: boolean | null = null

  let stage: HTMLElement
  let intro: HTMLElement
  let head: HTMLElement
  let foot: HTMLElement
  let payoff: HTMLElement
  let payInner: HTMLElement
  let title: HTMLElement
  let dy = 12

  // the slab's pivot (world) and its framing box
  const pivot = new THREE.Vector3()
  const corners: THREE.Vector3[] = []
  const markAt = new THREE.Vector3()

  /** the free screen space the copy leaves (CSS px), measured from the DOM */
  const lay = { w: 0, h: 0, at: -1, safeT: 96, safeB: 804, landR: 560, footR: 560, payR: 420, headB: 260, footT: 600, payT: 560 }
  const K = { land: orbit(), land2: orbit(), mid: orbit(), pay: orbit(), pay2: orbit(), out: orbit() }
  let posesKey = ''
  let markKey = ''

  const probe = new THREE.PerspectiveCamera(36, 1, 0.1, 200)
  const pv = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const right = new THREE.Vector3()
  const camUp = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  const cur = orbit()
  const gA = new THREE.Color()
  const gB = new THREE.Color()

  /** camera position / target for an orbit (target shifted so the pivot lands at NDC (nx, ny)) */
  function place(o: Orbit, aspect: number, outP: THREE.Vector3, outT: THREE.Vector3) {
    const cp = Math.cos(o.ph)
    dir.set(Math.sin(o.th) * cp, Math.sin(o.ph), Math.cos(o.th) * cp)
    fwd.copy(dir).negate()
    right.crossVectors(fwd, UP).normalize()
    camUp.crossVectors(right, fwd)
    const tv = Math.tan((o.fov * Math.PI) / 360)
    const sx = -o.nx * o.d * tv * aspect
    const sy = -o.ny * o.d * tv
    outT.copy(pivot).addScaledVector(right, sx).addScaledVector(camUp, sy)
    outP.copy(outT).addScaledVector(dir, o.d)
  }

  function aimProbe(o: Orbit, aspect: number) {
    probe.fov = o.fov
    probe.aspect = aspect
    probe.updateProjectionMatrix()
    place(o, aspect, probe.position, pv)
    probe.lookAt(pv)
    probe.updateMatrixWorld()
  }

  /** fit the slab's box into NDC [X0, X1] × [Y0, Y1] (y up) at this orbit's yaw / pitch / fov */
  function fit(o: Orbit, aspect: number, X0: number, X1: number, Y0: number, Y1: number) {
    o.nx = (X0 + X1) / 2
    o.ny = (Y0 + Y1) / 2
    o.d = 9
    for (let i = 0; i < 6; i++) {
      aimProbe(o, aspect)
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (const c of corners) {
        pv.copy(c).project(probe)
        x0 = Math.min(x0, pv.x)
        x1 = Math.max(x1, pv.x)
        y0 = Math.min(y0, pv.y)
        y1 = Math.max(y1, pv.y)
      }
      const s = Math.max((x1 - x0) / Math.max(0.05, X1 - X0), (y1 - y0) / Math.max(0.05, Y1 - Y0))
      o.d *= s
      // after the dolly the box shrinks about the pivot's screen point by 1/s
      const cx = o.nx + ((x0 + x1) / 2 - o.nx) / s
      const cy = o.ny + ((y0 + y1) / 2 - o.ny) / s
      o.nx += (X0 + X1) / 2 - cx
      o.ny += (Y0 + Y1) / 2 - cy
    }
    return o
  }

  const toNdc = (u0: number, u1: number, v0: number, v1: number) => [u0 * 2 - 1, u1 * 2 - 1, 1 - v1 * 2, 1 - v0 * 2] as const

  function poses(frame: Frame) {
    const w = Math.max(1, frame.width)
    const h = Math.max(1, frame.height)
    const key = `${w}x${h}:${lay.safeT}:${lay.safeB}:${lay.landR}:${lay.footR}:${lay.payR}:${lay.headB}:${lay.footT}:${lay.payT}:${portrait}`
    if (key === posesKey) return K
    posesKey = key
    const a = w / h
    const vT = lay.safeT / h
    const vB = lay.safeB / h
    const set = (o: Orbit, th: number, ph: number, fov: number) => {
      o.th = th
      o.ph = ph
      o.fov = fov
      return o
    }
    if (!portrait) {
      // landing: nearly frontal (the loader's flat mark lands on it), right of the copy
      const u0 = clamp(lay.landR / w + 0.07, 0.5, 0.66)
      fit(set(K.land, -0.14, 0, 34), a, ...toNdc(u0, 0.955, vT + 0.015, vB - 0.1))
      // the arc: past the right edge, close — the slab fills the height,
      // right of the manifesto (it stays through the first half of the arc)
      const m0 = clamp(lay.footR / w + 0.05, 0.26, 0.5)
      fit(set(K.mid, 0.92, -0.04, 36), a, ...toNdc(m0, Math.max(0.8, m0 + 0.44), 0.05, 0.97))
      // payoff: a 3/4 view right of the CTAs
      const p0 = clamp(lay.payR / w + 0.08, 0.5, 0.64)
      fit(set(K.pay, 0.42, 0, 34), a, ...toNdc(p0, 0.955, vT + 0.015, vB - 0.1))
    } else {
      fit(set(K.land, -0.1, 0, 44), a, ...toNdc(0.1, 0.9, lay.headB / h + 0.02, lay.footT / h - 0.05))
      // the arc: the slab fills the frame above the manifesto plate
      fit(set(K.mid, 0.8, -0.04, 46), a, ...toNdc(-0.04, 1.04, 0.06, lay.footT / h - 0.03))
      fit(set(K.pay, 0.34, 0, 44), a, ...toNdc(0.1, 0.9, vT + 0.02, lay.payT / h - 0.06))
    }
    placeCorner(a)
    // the landing's hold: a barely-there step toward the slab while the copy reads
    Object.assign(K.land2, K.land)
    K.land2.d = K.land.d * 0.975
    Object.assign(K.pay2, K.pay)
    K.pay2.d = K.pay.d * 0.955
    Object.assign(K.out, K.pay)
    K.out.th = K.pay.th * 0.5
    K.out.ph = 0
    K.out.d = portrait ? 2.9 : 2.3
    K.out.nx = 0
    K.out.ny = -0.1
    return K
  }

  /** put the corner piece in the payoff frame's gap between the CTAs and the slab (or hide it) */
  function placeCorner(aspect: number) {
    aimProbe(K.pay, aspect)
    let sx0 = Infinity
    for (const c of corners) sx0 = Math.min(sx0, pv.copy(c).project(probe).x)
    const left = portrait ? -0.96 : ((lay.payR + 24) / Math.max(1, lay.w)) * 2 - 1
    const gap = sx0 - left
    // portrait: the slab owns the frame's width; the piece would only clip at the edge
    corner.show = !portrait && gap > 0.16
    // the gap's center, on the horizon: cast to the corner's depth
    const nx = left + gap * 0.5
    pv.set(nx, 0, 0.5).unproject(probe).sub(probe.position).normalize()
    const t = (CORNER.z - probe.position.z) / (pv.z || -1e-3)
    corner.x = probe.position.x + pv.x * t
    corner.group.position.set(corner.x, FLOOR_Y, CORNER.z)
  }

  function mix(a: Orbit, b: Orbit, k: number, out: Orbit) {
    out.th = lerp(a.th, b.th, k)
    out.ph = lerp(a.ph, b.ph, k)
    out.d = Math.exp(lerp(Math.log(a.d), Math.log(b.d), k))
    out.nx = lerp(a.nx, b.nx, k)
    out.ny = lerp(a.ny, b.ny, k)
    out.fov = lerp(a.fov, b.fov, k)
    return out
  }

  /** the orbit along the story (no allocation) */
  function orbitAt(local: number, P: typeof K, out: Orbit) {
    if (local < ARC.hold) return mix(P.land, P.land2, segment(local, 0, ARC.hold), out)
    if (local < ARC.mid) return mix(P.land2, P.mid, easeSine(segment(local, ARC.hold, ARC.mid)), out)
    if (local < ARC.pay) return mix(P.mid, P.pay, easeSine(segment(local, ARC.mid, ARC.pay)), out)
    if (local < ARC.out) return mix(P.pay, P.pay2, segment(local, ARC.pay, ARC.out), out)
    return mix(P.pay2, P.out, ease.inOutCubic(segment(local, ARC.out, 1)), out)
  }

  /** the gel at this local: rose → violet over 0.15–0.36, violet → ice over 0.36–0.57 */
  function gelAt(local: number) {
    const k1 = easeSine(segment(local, 0.15, 0.36))
    const k2 = easeSine(segment(local, 0.36, 0.57))
    gA.copy(GELS[0].a).lerp(GELS[1].a, k1).lerp(GELS[2].a, k2)
    gB.copy(GELS[0].b).lerp(GELS[1].b, k1).lerp(GELS[2].b, k2)
  }

  function offsetBox(n: HTMLElement) {
    let x = 0
    let y = 0
    for (let e: HTMLElement | null = n; e && e !== stage && e !== document.body; e = e.offsetParent as HTMLElement | null) {
      x += e.offsetLeft
      y += e.offsetTop
    }
    return { l: x, t: y, r: x + n.offsetWidth, b: y + n.offsetHeight }
  }

  function measure(frame: Frame) {
    lay.w = frame.width
    lay.h = frame.height
    lay.at = performance.now()
    if (!intro || !intro.offsetParent) return
    const pb = offsetBox(intro)
    if (pb.b - pb.t > 40) {
      lay.safeT = pb.t
      lay.safeB = pb.b
    }
    // the right edge of what's written (words, not the column box)
    let r = 0
    for (const wd of title.querySelectorAll<HTMLElement>('.rise-w')) r = Math.max(r, offsetBox(wd).r)
    if (head.firstElementChild) r = Math.max(r, offsetBox(head.firstElementChild as HTMLElement).r)
    let fr = 0
    for (const c of Array.from(foot.children) as HTMLElement[]) {
      if (getComputedStyle(c).display !== 'none') fr = Math.max(fr, offsetBox(c).r)
    }
    r = Math.max(r, fr)
    if (r > 0) lay.landR = r
    if (fr > 0) lay.footR = fr
    let pr = 0
    for (const c of payInner.children) pr = Math.max(pr, offsetBox(c as HTMLElement).r)
    if (pr > 0) lay.payR = pr
    lay.headB = offsetBox(head).b
    lay.footT = offsetBox(foot).t
    lay.payT = offsetBox(payInner).t
  }

  /** the mark's landing-frame screen rect → CSS vars for the loader's match cut */
  function publishMark(frame: Frame) {
    poses(frame)
    if (markKey === posesKey) return
    markKey = posesKey
    const w = frame.width
    const h = frame.height
    aimProbe(K.land, w / Math.max(1, h))
    const px = (x: number, y: number) => {
      pv.set(x, y, markAt.z).project(probe)
      return [(pv.x * 0.5 + 0.5) * w, (0.5 - pv.y * 0.5) * h]
    }
    const s = SLAB.markH
    const [sx, sy] = px(markAt.x, markAt.y)
    const [lx] = px(markAt.x - s / 2, markAt.y)
    const [rx] = px(markAt.x + s / 2, markAt.y)
    const [, ty] = px(markAt.x, markAt.y + s / 2)
    const [, by] = px(markAt.x, markAt.y - s / 2)
    const size = (rx - lx + (by - ty)) / 2
    if (!Number.isFinite(sx + sy + size)) return
    const st = document.documentElement.style
    st.setProperty('--hark-mark-x', `${sx.toFixed(1)}px`)
    st.setProperty('--hark-mark-y', `${sy.toFixed(1)}px`)
    st.setProperty('--hark-mark-size', `${size.toFixed(1)}px`)
  }

  return {
    id: 'hero',
    group,
    // the CTAs (sr copy item 0): the settled payoff
    anchors: [0.76],
    busy: () => dim.busy || cornerDim.busy || headDim.busy || footDim.busy || payDim.busy || !revealed,
    async init(ctx) {
      stage = ctx.stage
      whenRevealed().then(() => (revealed = true))

      // ---------------------------------------------------------------- the slab
      slab = buildSlab({ ...SLAB, tubes: ctx.mobile ? 9 : 11, envMap: ctx.world.envMap, mobile: ctx.mobile, isFrameTarget: rt => ctx.post.isFrameTarget(rt) })
      slab.group.position.y = FLOOR_Y
      group.add(slab.group)
      pivot.set(0, FLOOR_Y + slab.centerY - 0.08, 0)
      markAt.set(0, FLOOR_Y + slab.centerY + SLAB.markY, slab.frontZ)
      const hw = slab.outerW / 2 + 0.13
      const zb = -slab.frontZ - SLAB.gap - 0.05
      for (const x of [-hw, hw]) for (const y of [FLOOR_Y, FLOOR_Y + slab.centerY + slab.outerH / 2]) for (const z of [zb, slab.frontZ + 0.1]) corners.push(new THREE.Vector3(x, y, z))
      await nextFrame()

      // ---------------------------------------------------------------- the room
      const floor = stoneFloor(80, 60, ctx.world.envMap)
      floor.position.set(0, FLOOR_Y, -6)
      group.add(floor)
      // the stone's own reflections turn with the studio too
      slab.envMats.push(floor.material as THREE.MeshStandardMaterial)
      fl = floorLight(30, 0, 0, FLOOR_Y)
      // trace the reflection from the camera actually rendering (no one-frame lag)
      fl.mesh.onBeforeRender = (_r, _s, cam) => fl.u.uCam.value.setFromMatrixPosition(cam.matrixWorld)
      group.add(fl.mesh)
      // the corner piece: a standing lit tube + a hairline lying on the floor from its foot
      // (the floor run stays thin and just under the bloom threshold: a slanted
      // hairline that crosses it beads into dots)
      const hair = (a: THREE.Vector3, b: THREE.Vector3, color: string, radius: number, hdr: number) =>
        neonFromStrokes([{ pts: [a, b] }], { color, radius, hdr, blockout: false, electrodes: false, smooth: false, caps: false, radial: 8 })
      corner.post = hair(new THREE.Vector3(0, 0.02, 0), new THREE.Vector3(0, CORNER.top, 0), DUSK.ice, 0.02, 1.7)
      corner.run = hair(new THREE.Vector3(-0.06, 0.012, 0), new THREE.Vector3(-0.06 - CORNER.run, 0.012, 0), DUSK.warm, 0.011, 1.25)
      corner.group.add(corner.post.group, corner.run.group)
      group.add(corner.group)

      // ---------------------------------------------------------------- DOM
      // landing: eyebrow + the h1, then the manifesto and the scroll hint
      intro = el('div', 'hero-intro', undefined, ctx.stage)
      const introInner = el('div', 'hero-intro-inner', undefined, intro)
      head = el('div', 'hero-head', undefined, introInner)
      const eyebrow = el('p', 'hud-eyebrow hero-eyebrow', undefined, head)
      const eb = el('span', 'hero-eyebrow-text', undefined, eyebrow)
      MICROCOPY.signalEyebrow.split(' · ').forEach((part, i) => {
        if (i) eb.append(' · ')
        el('span', 'hero-nowrap', part, eb)
      })
      title = rise(el('h1', 'hud-title hero-title', undefined, head), BRAND.tagline.replace(/(\S+)$/, '<em>$1</em>'))
      foot = el('div', 'hero-foot', undefined, introInner)
      el('p', 'hud-body hero-manifesto', BRAND.manifesto, foot)
      el('p', 'hud-label hero-hint', MICROCOPY.scrollHint + ' ↓', foot)

      // payoff: the lit slab is the headline; the locale line and the two CTAs
      payoff = el('div', 'hero-payoff', undefined, ctx.stage)
      payInner = el('div', 'hero-pay-inner', undefined, payoff)
      const loc = el('span', 'hero-eyebrow-text', undefined, el('p', 'hud-eyebrow hero-locale', undefined, payInner))
      BRAND.locale.split(' · ').forEach((part, i) => {
        if (i) loc.append(' · ')
        el('span', 'hero-nowrap', part, loc)
      })
      const ctas = el('div', 'hero-ctas', undefined, payInner)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })
    },

    onEnter() {
      snapCopy = true
    },

    update(local, frame, ctx) {
      // the same test as the CSS (max-aspect-ratio: 1/1): a square frame is portrait
      const p = frame.height >= frame.width
      if (p !== portrait) {
        portrait = p
        posesKey = ''
        // portrait plates sit against the chrome bands: fade in place, never slide into them
        dy = p ? 0 : 12
      }
      if (frame.width !== lay.w || frame.height !== lay.h || performance.now() - lay.at > 1000) measure(frame)
      publishMark(frame)

      // the light: dims up once after the reveal, then simply lit
      const lvl = dim.update(revealed, frame.dt)
      gelAt(local)
      slab.setColors(gA, gB)
      slab.setLevel(lvl)
      slab.cardK.trans = 0.24 * lvl
      slab.cardK.main = 0

      // the traveling highlight: the studio turns as the camera arcs
      const turn = lerp(-0.35, 1.25, easeSine(segment(local, 0.1, ARC.pay))) + 0.25 * easeSine(segment(local, ARC.pay, 1))
      for (const m of slab.envMats) m.envMapRotation.y = turn

      // the floor piece dims up once the manifesto has gone (never at the landing)
      const cl = cornerDim.update(corner.show && local > FOOT_OUT ? lvl : 0, frame.dt)
      corner.post!.setLevel(cl)
      corner.run!.setLevel(cl)
      corner.group.visible = cl > 0.001
      const u = fl.u
      orbitAt(clamp(local), poses(frame), cur)
      const hw = slab.outerW / 2
      u.uFace.value.set(-hw, hw, FLOOR_Y + slab.centerY - slab.outerH / 2, FLOOR_Y + slab.centerY + slab.outerH / 2)
      u.uFaceZ.value = slab.frontZ
      u.uA.value.copy(gA)
      u.uB.value.copy(gB)
      u.uRefl.value = 0.55 * lvl
      u.uPool.value = 0.05 * lvl
      u.uPoolAt.value.set(0, slab.frontZ + 0.6, 1.9, 1.1)
      u.uLine0.value.set(corner.x, CORNER.z, FLOOR_Y + CORNER.top, 0.9 * cl)
      u.uLineC0.value.copy(corner.color)
      u.uRun.value.set(corner.x - 0.06 - CORNER.run, corner.x - 0.06, CORNER.z, 0.5 * cl)
      u.uRunC.value.copy(corner.runColor)

      // the world: a soft field of the gel behind the slab, low slits, the studio turning
      const W = ctx.world.params
      const aspect = frame.width / Math.max(1, frame.height)
      W.fieldA = gA
      W.fieldB = gB
      W.field = 0.5 * lvl
      W.fieldSize = portrait ? 0.75 : 0.95
      W.focus.set(cur.nx * aspect - Math.sin(cur.th) * 0.25, cur.ny + 0.1 - cur.ph * 0.2)
      W.slits = 0
      W.envTurn = turn
      W.key = 0.6
      W.fill = 0.06

      const PP = ctx.post.params
      PP.bloomRadius = 0.35
      PP.bloomThreshold = 1.0
      PP.bloomStrength = lerp(0.55, 0.35, segment(local, 0.935, 1))

      // copy: each block fades by time once the scroll crosses its threshold
      // (snapped on entering and on teleports: jumps land on settled copy)
      const lc = clamp(local)
      const snap = snapCopy || !Number.isFinite(lastLocal) || Math.abs(lc - lastLocal) > 0.12
      snapCopy = false
      lastLocal = lc
      const onHead = lc < HEAD_OUT
      const onFoot = lc < FOOT_OUT
      const onPay = lc > PAY_IN && lc < PAY_OUT
      if (snap) {
        headDim.set(onHead ? 1 : 0)
        footDim.set(onFoot ? 1 : 0)
        payDim.set(onPay ? 1 : 0)
      }
      const hl = headDim.update(onHead, frame.dt)
      const ftl = footDim.update(onFoot, frame.dt)
      // a hard stop inside the cut window: a fling never carries the CTAs into the push
      const pl = payDim.update(onPay, frame.dt) * (1 - smoothstep(0.945, 0.965, lc))
      reveal(intro, ftl, dy)
      reveal(head, ftl > 0.001 ? hl / ftl : 0, 0)
      setRise(title, revealed && onHead)
      reveal(payoff, pl, dy)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const P = poses(frame)
      orbitAt(clamp(local), P, cur)
      const aspect = frame.width / Math.max(1, frame.height)
      place(cur, aspect, out.position, out.target)
      out.fov = cur.fov
      out.parallax = 0.18
    },
  }
}
