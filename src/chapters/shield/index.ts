import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECURITY, STATS } from '../../content'
import { DUSK, Dimmer, etchMap, stoneFloor } from '../../kit/opal'
import { frosted, pane } from '../../kit/glass'
import { StoryClock } from '../../kit/pace'
import { breachCard, breachUniforms, floorSpill, tubeSet, type TubeSet } from './rig'
import { crackStroke, etchPadlock, etchSlot, etchStrokes, numeralStrokes, padlockStrokes } from './etch'
import './shield.css'

/*
 * SHIELD · NIGHT WATCH — "Hacked? Breathe." told with light and glass.
 *
 * A partition of three tall frosted glass panels, the front wall of a lit
 * room in the dark gallery. Behind the frost: a back wall of light, a bank
 * of thin tubes, and a light line behind every polished etch (the padlock
 * on the right panel, 24/7 on the middle one, one indicator slot per panel).
 *
 *   0.03–0.36  BREACH   the watch light is calm and low; alarm red seeps in
 *                       from the right edge and spreads across the whole
 *                       wall; a crack of hard light runs through the lock
 *                       (crisp red through its polished window). The alarm
 *                       pulses slowly (0.25 Hz, ≤ 18 %); steady when calm.
 *   0.36–0.62  BREATHE  the red cools through violet back to periwinkle/ice,
 *                       the crack goes dark, the glass CLEARS (roughness
 *                       0.6 → 0.3) and 24/7 comes up behind its etch; the
 *                       light breathes (0.12 Hz, 85–100 %). Copy panel:
 *                       eyebrow, "Hacked? Breathe.", body, 24/7 label, CTA
 *                       (landing / intro / anchor 0.45).
 *   0.64–0.97  WATCH    the camera eases back to the whole wall; the three
 *                       indicator lines come up one by one, labelled
 *                       Hardening / Monitoring / Backups; steady light
 *                       through the cut.
 *
 * Lighting and camera follow a StoryClock (≤ 0.6 local/s): a fast scroll
 * can't swing the wall's light faster than that. DOM follows `local`.
 */

const PW = 1.2
const PH = 3.0
const GAP = 0.03
const DEPTH = 0.1
const XS = [-(PW + GAP), 0, PW + GAP]
const FLOOR_Y = -1.42
const Y0 = FLOOR_Y + 0.05
const CY = Y0 + PH / 2
const WT = 3 * PW + 2 * GAP
const ROOM = 0.62
/** the light lines right behind the etched windows */
const NEAR_Z = -DEPTH / 2 - 0.06
const IND_Y = Y0 + 0.36
const LOCK = { x: 0, y: 0.12, w: 0.44 }
const NUM = { size: 0.34, y: 0.1 }
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]
const INDICATORS = ['Hardening', 'Monitoring', 'Backups']

const T = {
  seep0: 0.05,
  seep1: 0.27,
  crack0: 0.1,
  crack1: 0.25,
  cool0: 0.33,
  cool1: 0.53,
  clear0: 0.38,
  clear1: 0.56,
  num: 0.37,
  copyIn: 0.325,
  copyOut: 0.64,
  watch: 0.665,
  out: 0.955,
}

// ------------------------------------------------------------------ camera

interface Key {
  l: number
  /** subject centre (world) and the rect to frame (world units) */
  cx: number
  cy: number
  sw: number
  sh: number
  yaw: number
  pitch: number
}
const KEYS: Key[] = [
  { l: 0.0, cx: 0.25, cy: 0.0, sw: 4.1, sh: 3.35, yaw: 0.24, pitch: 0.07 },
  { l: 0.28, cx: 0.62, cy: 0.04, sw: 2.9, sh: 3.25, yaw: 0.16, pitch: 0.065 },
  { l: 0.42, cx: 0.62, cy: 0.02, sw: 2.75, sh: 3.25, yaw: 0.11, pitch: 0.06 },
  { l: 0.62, cx: 0.6, cy: 0.0, sw: 2.75, sh: 3.25, yaw: 0.07, pitch: 0.06 },
  { l: 0.82, cx: 0.0, cy: -0.14, sw: 4.1, sh: 3.7, yaw: -0.02, pitch: 0.08 },
  { l: 1.0, cx: -0.02, cy: -0.14, sw: 4.2, sh: 3.7, yaw: -0.07, pitch: 0.08 },
]
const KEYS_TALL: Key[] = [
  { l: 0.0, cx: 0.85, cy: 0.1, sw: 2.6, sh: 2.9, yaw: 0.2, pitch: 0.06 },
  { l: 0.28, cx: 1.05, cy: 0.18, sw: 1.85, sh: 2.2, yaw: 0.15, pitch: 0.05 },
  { l: 0.42, cx: 0.6, cy: 0.14, sw: 2.3, sh: 1.35, yaw: 0.08, pitch: 0.05 },
  { l: 0.62, cx: 0.58, cy: 0.12, sw: 2.3, sh: 1.35, yaw: 0.05, pitch: 0.05 },
  { l: 0.82, cx: 0.0, cy: -0.14, sw: 4.0, sh: 3.5, yaw: -0.02, pitch: 0.07 },
  { l: 1.0, cx: -0.02, cy: -0.14, sw: 4.1, sh: 3.5, yaw: -0.05, pitch: 0.07 },
]

interface Layout {
  w: number
  h: number
  top: number
  bottom: number
  gutter: number
  /** the copy panel's rect (px, stage space) */
  px0: number
  py0: number
  px1: number
  py1: number
  ok: boolean
}
interface Region {
  cx: number
  cy: number
  fw: number
  fh: number
}

const tall = (w: number, h: number) => h > w * 1.05

function copyRegion(L: Layout, out: Region, withCopy: number) {
  const w = L.w
  const h = L.h
  let x0 = L.gutter
  let x1 = w - L.gutter
  let y0 = L.top
  let y1 = h - L.bottom
  const fx0 = x0
  const fy1 = y1
  if (L.ok) {
    if (tall(w, h)) y1 = Math.min(y1, L.py0 - 16)
    else x0 = Math.max(x0, L.px1 + 28)
  } else if (tall(w, h)) y1 = h * 0.5
  else x0 = w * 0.42
  if (y1 - y0 < h * 0.2) y1 = y0 + h * 0.2
  if (x1 - x0 < w * 0.3) x0 = x1 - w * 0.3
  x0 = lerp(fx0, x0, withCopy)
  y1 = lerp(fy1, y1, withCopy)
  // the chrome sits in the top band: keep the subject a touch low on wide screens
  if (!tall(w, h)) y0 += Math.min(16, h * 0.02)
  out.cx = (x0 + x1) / w - 1
  out.cy = 1 - (y0 + y1) / h
  out.fw = (x1 - x0) / w
  out.fh = (y1 - y0) / h
}

const _r: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _dir = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _Y = new THREE.Vector3(0, 1, 0)

function copyWeight(l: number) {
  return smoothstep(0.27, 0.37, l) * (1 - smoothstep(0.62, 0.72, l))
}

function solvePose(q: number, frame: Frame, L: Layout, out: CameraPose): Region {
  const w = L.ok ? L.w : frame.width
  const h = L.ok ? L.h : frame.height
  const isTall = tall(w, h)
  const keys = isTall ? KEYS_TALL : KEYS
  let k = 0
  while (k < keys.length - 2 && q > keys[k + 1].l) k++
  const a = keys[k]
  const b = keys[k + 1]
  const t = ease.inOutCubic(segment(q, a.l, b.l))
  copyRegion(L.ok ? L : { ...L, w, h }, _r, copyWeight(q))
  const yaw = lerp(a.yaw, b.yaw, t)
  const pitch = lerp(a.pitch, b.pitch, t)
  const sx = lerp(a.cx, b.cx, t)
  const sy = lerp(a.cy, b.cy, t)
  const sw = lerp(a.sw, b.sw, t) * Math.cos(yaw)
  const sh = lerp(a.sh, b.sh, t)
  const fov = isTall ? 36 : 30
  const aspect = w / Math.max(1, h)
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const tanX = tanV * aspect
  const fill = 0.94
  const D = Math.max(sw / (2 * tanX * _r.fw * fill), sh / (2 * tanV * _r.fh * fill))
  _dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  _fwd.copy(_dir).negate()
  _right.crossVectors(_fwd, _Y).normalize()
  _up.crossVectors(_right, _fwd)
  out.position
    .set(sx, sy, 0)
    .addScaledVector(_dir, D)
    .addScaledVector(_right, -_r.cx * D * tanX)
    .addScaledVector(_up, -_r.cy * D * tanV)
  out.target.copy(out.position).addScaledVector(_fwd, D)
  out.fov = fov
  out.roll = 0
  out.parallax = frame.reducedMotion || frame.still ? 0 : 0.1
  return _r
}

// ------------------------------------------------------------------ colours

const C = {
  alarm: new THREE.Color(DUSK.alarm),
  violet: new THREE.Color(DUSK.violet),
  peri: new THREE.Color(DUSK.periwinkle),
  ice: new THREE.Color(DUSK.ice),
  lilac: new THREE.Color(DUSK.lilac),
}

/** the alarm's gel at heat h: alarm (1) → violet (0.5); below 0.5 the shader melts it into the calm gradient */
function hotTint(h: number, out: THREE.Color) {
  return out.copy(C.violet).lerp(C.alarm, clamp(h * 2 - 1))
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const U = breachUniforms(new THREE.Vector2(0, CY), new THREE.Vector2(WT, PH))
  U.uCalmA.value.set(DUSK.ice)
  U.uCalmB.value.set(DUSK.periwinkle)
  const clock = new StoryClock({ rate: 0.6 })
  // the cooling and the clearing are long, smooth changes: each follows its
  // scroll target at ≤ 1.1 / s (≥ 0.9 s end to end), snapping on teleports
  const cooling = new StoryClock({ rate: 1.1, snap: 0.4 })
  const clearing = new StoryClock({ rate: 1.1, snap: 0.4 })
  const numDim = new Dimmer(1.4, 0.7)
  const indDims = [new Dimmer(0.9, 0.5), new Dimmer(0.9, 0.5), new Dimmer(0.9, 0.5)]
  const panes: THREE.MeshPhysicalMaterial[] = []
  let bank: TubeSet | null = null
  let numerals: TubeSet | null = null
  let crack: TubeSet | null = null
  let lock: TubeSet | null = null
  const inds: TubeSet[] = []

  // DOM
  let frameEl: HTMLElement
  let copy: HTMLElement
  let title: HTMLElement
  let watch: HTMLElement
  const labels: HTMLElement[] = []
  const layout: Layout = { w: 1, h: 1, top: 90, bottom: 90, gutter: 32, px0: 0, py0: 0, px1: 0, py1: 0, ok: false }
  const scratch: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30, roll: 0, parallax: 0 }
  const tmpC = new THREE.Color()
  const tmpC2 = new THREE.Color()
  const proj = new THREE.Vector3()

  function measure(stage: HTMLElement) {
    const sr = stage.getBoundingClientRect()
    const cs = getComputedStyle(frameEl)
    layout.w = sr.width || window.innerWidth
    layout.h = sr.height || window.innerHeight
    layout.top = parseFloat(cs.paddingTop) || 90
    layout.bottom = parseFloat(cs.paddingBottom) || 90
    layout.gutter = parseFloat(cs.paddingLeft) || 32
    const pr = copy.getBoundingClientRect()
    layout.px0 = pr.left - sr.left
    layout.py0 = pr.top - sr.top
    layout.px1 = pr.right - sr.left
    layout.py1 = pr.bottom - sr.top
    layout.ok = layout.w > 0 && layout.h > 0 && pr.width > 0
  }

  return {
    id: 'shield',
    group,
    anchors: [0.45],

    async init(ctx: ChapterContext) {
      const stage = ctx.stage
      const mobile = ctx.mobile
      const res = mobile ? 512 : 1024

      // ---------------- DOM (the visual layer; the accessible copy is srContent)
      frameEl = el('div', 'shield-frame', undefined, stage)
      copy = el('div', 'hud-panel shield-copy', undefined, frameEl)
      el('p', 'hud-eyebrow', SECURITY.eyebrow, copy)
      title = rise(el('h2', 'hud-h2 shield-title', undefined, copy), 'Hacked? <em>Breathe.</em>')
      el('p', 'hud-body shield-body', SECURITY.body, copy)
      const stat = el('div', 'shield-stat', undefined, copy)
      el('span', 'shield-stat-k', STAT.value, stat)
      el('p', 'shield-stat-l', STAT.label, stat)
      const cta = el('a', 'hud-btn shield-cta', SECURITY.cta, copy)
      cta.href = SECURITY.href
      watch = el('div', 'shield-watch', undefined, stage)
      for (const w of INDICATORS) labels.push(el('span', 'hud-label shield-ind', w, watch))
      reveal(copy, 0)
      for (const l of labels) reveal(l, 0, 0)
      measure(stage)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measure(stage))
        ro.observe(stage)
        ro.observe(copy)
      } else window.addEventListener('resize', () => measure(stage))
      document.fonts?.ready.then(() => measure(stage))

      // ---------------- the room behind the partition (opaque: glass refracts it)
      const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })
      const room = new THREE.Group()
      const back = new THREE.Mesh(new THREE.PlaneGeometry(WT + 0.2, PH + 0.2), black)
      back.position.set(0, CY, -ROOM - 0.02)
      const wallGeoV = new THREE.PlaneGeometry(ROOM, PH)
      const wallGeoH = new THREE.PlaneGeometry(WT, ROOM)
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(wallGeoV, black)
        side.rotation.y = Math.PI / 2
        side.position.set((s * WT) / 2, CY, -ROOM / 2 - DEPTH / 2)
        const cap = new THREE.Mesh(wallGeoH, black)
        cap.rotation.x = Math.PI / 2
        cap.position.set(0, CY + (s * PH) / 2, -ROOM / 2 - DEPTH / 2)
        room.add(side, cap)
      }
      room.add(back)
      const card = breachCard(WT, PH, U, { hdr: 0.78, soft: 0.02 })
      card.position.set(0, CY, -ROOM)
      room.add(card)
      group.add(room)

      // the tube bank: two thin tubes behind each panel, near its edges (the frost turns them into soft bands)
      const bankStrokes = XS.flatMap(x =>
        [-1, 1].map(s => ({ pts: [new THREE.Vector3(x + s * (PW / 2 - 0.1), Y0 + 0.06, -0.3), new THREE.Vector3(x + s * (PW / 2 - 0.1), Y0 + PH - 0.06, -0.3)] })),
      )
      bank = tubeSet(bankStrokes, U, { radius: 0.014, hdr: 1.35, field: true, calm: '#a9bcff', hot: DUSK.alarm })
      bank.setLevel(1)
      group.add(bank.mesh)

      // 24/7: a thin ice line behind its etched numerals
      const numS = numeralStrokes(NUM.size, XS[1], CY + NUM.y, NEAR_Z)
      numerals = tubeSet(numS, U, { radius: 0.0105, hdr: 2.1, color: DUSK.ice, radial: 6 })
      group.add(numerals.mesh)

      // the crack of hard light: through the lock, crisp in its polished window
      const cs = crackStroke(new THREE.Vector2(XS[2] + 0.6, CY + 1.18), new THREE.Vector2(XS[2] - 0.62, CY - 0.92), NEAR_Z - 0.01, 11, 0.075, 5)
      crack = tubeSet([cs], U, { radius: 0.0115, hdr: 3.2, color: '#ff6a78', hide: true })
      group.add(crack.mesh)
      // the padlock's own light line (ice while calm, alarm where the red has reached)
      lock = tubeSet(padlockStrokes(LOCK.x, LOCK.y, LOCK.w, XS[2], CY, NEAR_Z), U, { radius: 0.0105, hdr: 2.1, field: true, calm: DUSK.ice, hot: '#ff5a6a' })
      lock.setLevel(1)
      group.add(lock.mesh)

      // one indicator line behind each panel's slot
      for (const x of XS) {
        const t = tubeSet([{ pts: [new THREE.Vector3(x - 0.25, IND_Y, NEAR_Z), new THREE.Vector3(x + 0.25, IND_Y, NEAR_Z)] }], U, {
          radius: 0.0085,
          hdr: 2.0,
          color: DUSK.ice,
        })
        inds.push(t)
        group.add(t.mesh)
      }
      await nextFrame()

      // ---------------- the partition: three frosted panels, etched
      const toLocal = (px: number) => (s: { pts: THREE.Vector3[] }) => ({ pts: s.pts.map(p => new THREE.Vector3(p.x - px, p.y - CY, 0)) })
      const numLocal = numS.map(toLocal(XS[1]))
      for (let i = 0; i < 3; i++) {
        const etch = etchMap(
          PW,
          PH,
          (g, _W, _H, toPx, scale) => {
            etchSlot(g, toPx, 0, IND_Y - CY, 0.56, 0.032)
            if (i === 1) etchStrokes(g, toPx, numLocal, 0.052, scale)
            if (i === 2) etchPadlock(g, toPx, scale, LOCK.x, LOCK.y, LOCK.w)
          },
          res,
        )
        const mat = frosted({ frost: 0.62, thickness: DEPTH * 2 }).clone()
        mat.roughnessMap = etch
        mat.needsUpdate = true
        panes.push(mat)
        const p = pane(PW, PH, { depth: DEPTH, radius: 0.014, material: mat })
        p.position.set(XS[i], CY, 0)
        group.add(p)
        await nextFrame()
      }

      // ---------------- floor: polished stone, a satin track under the glass, the wall's light on the stone
      const floor = stoneFloor(40, 26, ctx.world.envMap)
      floor.position.y = FLOOR_Y
      group.add(floor)
      const track = new THREE.Mesh(
        new THREE.BoxGeometry(WT + 0.12, 0.05, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x08070a, roughness: 0.34, metalness: 0.2, envMap: ctx.world.envMap, envMapIntensity: 0.6 }),
      )
      track.position.set(0, FLOOR_Y + 0.025, 0)
      group.add(track)
      const spill = floorSpill(WT + 0.8, 2.6, U, 0.3)
      spill.position.y = FLOOR_Y + 0.003
      group.add(spill)
    },

    onEnter() {
      clock.reset()
      cooling.reset()
      clearing.reset()
    },

    busy() {
      return clock.busy || cooling.busy || clearing.busy || numDim.busy || indDims.some(d => d.busy)
    },

    update(l: number, frame: Frame, ctx: ChapterContext) {
      const q = clock.update(l, frame.dt)
      const calm = ctx.reducedMotion || !!frame.still
      const wp = ctx.world.params
      const pp = ctx.post.params
      const t = frame.time

      // ---------------- the breach field (all from the paced clock)
      const front = ease.inOutQuad(segment(q, T.seep0, T.seep1))
      const cool = cooling.update(smoothstep(T.cool0, T.cool1, q), frame.dt)
      const heat = 1 - cool
      const clarity = clearing.update(smoothstep(T.clear0, T.clear1, q), frame.dt)
      U.uFront.value = front
      U.uHeat.value = heat
      U.uSeep.value = q * 3
      U.uFeather.value = lerp(0.12, 0.2, front)
      // the watch light: a deep night gel (periwinkle → violet) before, clearer after (ice → periwinkle)
      const day = smoothstep(0.1, 1, cool)
      U.uCalmLevel.value = lerp(0.7, 0.95, day)
      U.uCalmA.value.copy(C.peri).lerp(C.ice, day)
      U.uCalmB.value.copy(C.violet).lerp(C.peri, day)
      U.uHotLevel.value = 0.82
      hotTint(heat, U.uHot.value)
      // alarm: a slow pulse (0.25 Hz, ≤ 18 %); calm: a slower breath (0.12 Hz, 85–100 %). Steady when calm.
      U.uPulse.value = calm ? 1 : 1 - 0.18 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 0.25 * t))
      // the breath settles to a quieter 92–100 % once the watch is set
      const amp = lerp(0.15, 0.08, smoothstep(T.watch - 0.04, T.watch + 0.06, q))
      U.uBreath.value = calm ? 0.95 : 1 - amp + amp * (0.5 + 0.5 * Math.cos(2 * Math.PI * 0.12 * t))

      for (const m of panes) m.roughness = lerp(0.62, 0.4, clarity)

      if (crack) {
        crack.setDraw(ease.outQuad(segment(q, T.crack0, T.crack1)))
        crack.setLevel(smoothstep(T.crack0 - 0.02, T.crack0 + 0.03, q) * (1 - smoothstep(T.cool0, T.cool0 + 0.07, q)) * U.uPulse.value)
      }
      if (numerals) numerals.setLevel(numDim.update(q > T.num, frame.dt) * U.uBreath.value)
      inds.forEach((ind, i) => ind.setLevel(indDims[i].update(q > T.watch + i * 0.025, frame.dt)))

      // ---------------- world + post
      const reg = solvePose(q, frame, layout, scratch)
      const aspect = frame.width / Math.max(1, frame.height)
      wp.focus.set(reg.cx * aspect, reg.cy)
      wp.fieldSize = 1.25
      wp.field = 0.32
      const warm = front * heat
      wp.fieldA = '#' + tmpC.copy(C.peri).lerp(U.uHot.value, warm).getHexString()
      wp.fieldB = '#' + tmpC2.copy(C.lilac).lerp(C.alarm, warm * 0.7).getHexString()
      wp.fieldAngle = 1.2
      wp.slits = 0.1
      wp.slitColor = DUSK.ice
      wp.env = 0.42
      // the studio strips glide along the polished bevels as the glass clears
      wp.envTurn = lerp(-0.35, 0.85, ease.inOutCubic(segment(q, 0.4, 0.66))) + (q > 0.66 ? (q - 0.66) * 0.4 : 0)
      wp.key = 0.7
      wp.fill = 0.08
      pp.bloomStrength = 0.42
      pp.bloomThreshold = 0.95
      pp.vignette = 0.5
      // a soft focus pull as the headline arrives ("breathe")
      pp.glitch = 0.22 * Math.sin(Math.PI * segment(q, T.cool0 - 0.02, T.cool0 + 0.09))

      // ---------------- DOM (from local)
      reveal(copy, smoothstep(T.copyIn, T.copyIn + 0.03, l) * (1 - smoothstep(T.copyOut, T.copyOut + 0.03, l)))
      setRise(title, l > T.copyIn + 0.005 && l < T.copyOut + 0.02)
      // indicator labels ride under their panels (projected with last frame's camera)
      const cam = ctx.camera
      const W = frame.width
      const H = frame.height
      labels.forEach((lab, i) => {
        const v = smoothstep(T.watch + i * 0.025, T.watch + i * 0.025 + 0.025, l) * (1 - smoothstep(T.out, T.out + 0.02, l))
        proj.set(XS[i], Y0 - 0.12, 0.14).project(cam)
        const x = (proj.x * 0.5 + 0.5) * W
        const y = (-proj.y * 0.5 + 0.5) * H
        const ok = Number.isFinite(x) && Number.isFinite(y) && proj.z < 1
        reveal(lab, ok ? v : 0, 0)
        if (ok && v > 0) lab.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`
      })
    },

    camera(l: number, frame: Frame, out: CameraPose) {
      const q = Number.isFinite(clock.value) ? clock.value : l
      solvePose(q, frame, layout, out)
    },
  }
}
