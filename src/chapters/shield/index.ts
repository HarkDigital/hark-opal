import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECURITY, STATS } from '../../content'
import { DUSK, Dimmer, stoneFloor } from '../../kit/opal'
import { frosted, polished } from '../../kit/glass'
import { StoryClock } from '../../kit/pace'
import { floorSpill, lampFall, nightCard, nightUniforms, panelGeometry, tubeBank, windowLight, type WindowLight } from './rig'
import { NUM_FONT, NUM_WEIGHT, etchNumerals, etchPadlock, etchSlot, padlockTop, regionEtch, type RegionEtch } from './etch'
import './shield.css'

/*
 * SHIELD · NIGHT WATCH — "Hacked? Breathe." told with light and glass.
 *
 * A partition of three tall panels of thick sandblasted glass (polished
 * round bevels that catch the studio's hairlines, a seam of the light
 * behind between them), the front wall of a lit room in the dark gallery.
 * Polished CLEAR into the frost: 24/7 (the middle panel), a padlock (the
 * right one), one indicator slot per panel, each a window onto its own
 * light drawn right behind the glass (rig.ts windowLight). Behind: the
 * watch light (a cove at the wall's foot, a few thin tubes) and, off the
 * wall's right end, an alarm lamp.
 *
 *   0.03–0.36  BREACH   the watch light is low; it dims to standby as a
 *                       warm red lamp comes up behind the right of the
 *                       wall: a glow with a real falloff (hot core, crimson
 *                       tail, the left of the wall stays night), pooling on
 *                       the floor round the wall's end. The padlock's window
 *                       burns red. The lamp pulses slowly (0.25 Hz, ≤ 14 %).
 *   0.36–0.62  BREATHE  the lamp cools through violet and goes out, the
 *                       watch light comes back up, the glass CLEARS
 *                       (roughness 0.62 → 0.42), 24/7 lights up in its
 *                       window; the light breathes (0.12 Hz). Copy panel:
 *                       eyebrow, "Hacked? Breathe.", body, 24/7 label, CTA
 *                       (landing / intro / anchor 0.45). The whole wall
 *                       stays clear of the panel at every aspect.
 *   0.64–0.97  WATCH    the camera walks round to face the wall; the three
 *                       indicator slots come up one by one, labelled
 *                       Hardening / Monitoring / Backups; steady light
 *                       through the cut.
 *
 * Lighting and camera follow a StoryClock (≤ 0.6 local/s): a fast scroll
 * can't swing the wall's light faster than that. DOM follows `local`.
 */

const PW = 1.2
const PH = 3.0
const GAP = 0.03
const DEPTH = 0.12
const XS = [-(PW + GAP), 0, PW + GAP]
const FLOOR_Y = -1.42
const Y0 = FLOOR_Y + 0.05
const CY = Y0 + PH / 2
const WT = 3 * PW + 2 * GAP
const ROOM = 0.62
/** the designs' light, just behind the glass's back face */
const Z_LIGHT = -DEPTH / 2 - 0.018
/**
 * the caps' optical thickness: a polished window lines up with the light
 * `dz` behind the front face when thickness ≈ dz / (1 − 1/ior) ≈ 3·dz (at any
 * view angle), so the clear numerals are filled with their light, not offset
 */
const OPT_T = 3 * (DEPTH + 0.018)
/** panel-local heights: the indicator slot, the designs */
const SLOT_Y = Y0 + 0.36 - CY
const NUM = { y: 0.14, cap: 0.34, maxW: 0.92 }
/** the padlock is drawn with the numerals' pen (Hanken Grotesk 360's stem at this size) */
const LOCK = { x: 0, y: 0.1, w: 0.4, stroke: 0.04 }
const TOP = Math.max(padlockTop(LOCK.y, LOCK.w, LOCK.stroke), NUM.y + NUM.cap * 0.75) + 0.1
const REGION = [
  { y0: SLOT_Y - 0.1, y1: SLOT_Y + 0.1 },
  { y0: SLOT_Y - 0.1, y1: TOP },
  { y0: SLOT_Y - 0.1, y1: TOP },
]
/** the watch light's tubes (world x): near each panel's edges, unevenly, clear of the designs and the seams */
const TUBES = [-1.67, -0.77, -0.52, 0.5, 0.74, 1.69]
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]
const INDICATORS = ['Hardening', 'Monitoring', 'Backups']

const T = {
  seep0: 0.05,
  seep1: 0.27,
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
// wide screens: from the right (the lamp's side) → the breach close on the
// middle and right panels → the WHOLE wall beside the copy panel (it never
// slips behind it, at any aspect) → round to face the wall
const KEYS: Key[] = [
  { l: 0.0, cx: 0.3, cy: 0.02, sw: 4.25, sh: 3.4, yaw: 0.27, pitch: 0.07 },
  { l: 0.28, cx: 0.72, cy: 0.05, sw: 3.0, sh: 3.3, yaw: 0.2, pitch: 0.065 },
  { l: 0.42, cx: 0.02, cy: 0.02, sw: 4.3, sh: 3.35, yaw: 0.13, pitch: 0.06 },
  { l: 0.62, cx: 0.0, cy: 0.0, sw: 4.3, sh: 3.35, yaw: 0.08, pitch: 0.06 },
  { l: 0.82, cx: 0.0, cy: -0.14, sw: 4.3, sh: 3.75, yaw: -0.02, pitch: 0.08 },
  { l: 1.0, cx: -0.02, cy: -0.14, sw: 4.4, sh: 3.75, yaw: -0.07, pitch: 0.08 },
]
// portrait: the middle and right panels whole (24/7 always entirely in or
// entirely out of frame), the partition inside the chrome bands; the
// BREATHE close-up frames the band with 24/7 and the lock above the copy
const KEYS_TALL: Key[] = [
  { l: 0.0, cx: 0.62, cy: 0.05, sw: 2.62, sh: 3.42, yaw: 0.22, pitch: 0.06 },
  { l: 0.28, cx: 0.68, cy: 0.05, sw: 2.62, sh: 3.42, yaw: 0.15, pitch: 0.055 },
  { l: 0.42, cx: 0.6, cy: 0.2, sw: 2.3, sh: 1.4, yaw: 0.08, pitch: 0.05 },
  { l: 0.62, cx: 0.58, cy: 0.18, sw: 2.3, sh: 1.4, yaw: 0.05, pitch: 0.05 },
  { l: 0.82, cx: 0.0, cy: -0.14, sw: 4.0, sh: 3.55, yaw: -0.02, pitch: 0.07 },
  { l: 1.0, cx: -0.02, cy: -0.14, sw: 4.1, sh: 3.55, yaw: -0.05, pitch: 0.07 },
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
  /** the lamp: a warm core (alarm, a breath of amber) and a deep crimson tail */
  hotCore: new THREE.Color(DUSK.alarm).lerp(new THREE.Color(DUSK.amber), 0.2),
  hotEdge: new THREE.Color('#b8122f'),
  coolCore: new THREE.Color(DUSK.violet),
  coolEdge: new THREE.Color('#4b33b8'),
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const U = nightUniforms(new THREE.Vector2(0, CY), new THREE.Vector2(WT, PH))
  const clock = new StoryClock({ rate: 0.6 })
  // the cooling and the clearing are long, smooth changes: each follows its
  // scroll target at ≤ 1.1 / s (≥ 0.9 s end to end), snapping on teleports
  const cooling = new StoryClock({ rate: 1.1, snap: 0.4 })
  const clearing = new StoryClock({ rate: 1.1, snap: 0.4 })
  const numDim = new Dimmer(1.4, 0.7)
  const indDims = [new Dimmer(0.9, 0.5), new Dimmer(0.9, 0.5), new Dimmer(0.9, 0.5)]
  const caps: THREE.MeshPhysicalMaterial[] = []
  const envMats: THREE.MeshStandardMaterial[] = []
  const lights: WindowLight[] = []
  const etches: RegionEtch[] = []
  const lockU = new THREE.Vector2((XS[2] + LOCK.x) / WT + 0.5, (LOCK.y + PH / 2) / PH)

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
      const env = ctx.world.envMap
      // etch maps cover only the designs' region of each pane; 512 on phones (their glass buffer is half-res anyway)
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
      const card = nightCard(WT - 0.01, PH - 0.01, U, { hdr: 0.9, soft: 0.02, frameK: 0.28, isFrameTarget: rt => ctx.post.isFrameTarget(rt) })
      card.position.set(0, CY, -ROOM)
      room.add(card)
      group.add(room)

      // the watch light's tubes (the frost turns them into soft bands)
      group.add(tubeBank(TUBES, Y0 + 0.12, Y0 + PH - 0.12, -0.3, U, { radius: 0.012, hdr: 1.7, color: '#b4c4ff', radial: mobile ? 6 : 8 }))
      await nextFrame()

      // ---------------- the partition: three panels of thick frosted glass, etched
      try {
        await document.fonts.load(`${NUM_WEIGHT} 64px ${NUM_FONT.split(',')[0]}`, '24/7')
      } catch {
        /* drawn with the fallback until fonts.ready repaints */
      }
      let fontOk = false
      const geo = panelGeometry(PW, PH, DEPTH, 0.02, mobile)
      const sides = polished({ thickness: 0.07 }).clone()
      sides.envMap = env
      sides.envMapIntensity = 1.35
      envMats.push(sides)
      for (let i = 0; i < 3; i++) {
        const R = REGION[i]
        const ry = (R.y0 + R.y1) / 2
        const rh = R.y1 - R.y0
        const etch = regionEtch(
          PW,
          rh,
          ry,
          (g, toPx, scale) => {
            etchSlot(g, toPx, 0, SLOT_Y, 0.5, 0.03)
            if (i === 1) fontOk = etchNumerals(g, toPx, scale, '24/7', 0, NUM.y, NUM.cap, NUM.maxW)
            if (i === 2) etchPadlock(g, toPx, scale, LOCK.x, LOCK.y, LOCK.w, LOCK.stroke)
          },
          res,
        )
        etches.push(etch)
        const mat = frosted({ frost: 0.62, thickness: OPT_T }).clone()
        mat.roughnessMap = etch.tex
        // the same map as a bump: the sandblasted field sits a hair below the polished windows, so every
        // window has an edge that glints and bends the light like real engraved glass
        mat.bumpMap = etch.tex
        mat.bumpScale = -0.55
        // its own env (low): the frost glows with the light behind, never reads as pewter
        mat.envMap = env
        mat.envMapIntensity = 0.16
        mat.needsUpdate = true
        caps.push(mat)
        envMats.push(mat)
        const p = new THREE.Mesh(geo, [mat, sides])
        p.position.set(XS[i], CY, 0)
        group.add(p)
        // the design's own light, right behind the glass
        const wl = windowLight(PW, rh, etch.tex, { regionY: ry, slotY: SLOT_Y })
        wl.mesh.position.set(XS[i], CY + ry, Z_LIGHT)
        lights.push(wl)
        group.add(wl.mesh)
        await nextFrame()
      }
      // a late font swap repaints the numerals; then every etch canvas is freed once it's on the GPU
      const settle = () => {
        if (!fontOk) etches[1].repaint()
        for (const e of etches) e.release()
      }
      if (document.fonts?.ready) document.fonts.ready.then(settle, settle)
      else settle()

      // ---------------- floor: polished stone, a satin track under the glass, the wall's light on the stone
      const floor = stoneFloor(40, 26, env)
      floor.position.y = FLOOR_Y
      group.add(floor)
      const trackMat = new THREE.MeshStandardMaterial({ color: 0x08070a, roughness: 0.34, metalness: 0.2, envMap: env, envMapIntensity: 0.6 })
      envMats.push(trackMat)
      const track = new THREE.Mesh(new THREE.BoxGeometry(WT + 0.12, 0.05, 0.22), trackMat)
      track.position.set(0, FLOOR_Y + 0.025, 0)
      group.add(track)
      const spill = floorSpill(WT + 2.4, 2.6, 0.55, U, 0.3)
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

      // ---------------- the light (all from the paced clock)
      const front = ease.inOutQuad(segment(q, T.seep0, T.seep1))
      const cool = cooling.update(smoothstep(T.cool0, T.cool1, q), frame.dt)
      const heat = 1 - cool
      const clarity = clearing.update(smoothstep(T.clear0, T.clear1, q), frame.dt)
      const day = smoothstep(0.1, 1, cool)
      // the watch light: a low night glow → standby while the lamp is up → back up (clearer) as it cools
      U.uCalmLevel.value = lerp(lerp(0.36, 0.13, front), 0.42, day)
      U.uCalmA.value.copy(C.peri).lerp(C.ice, 0.22 * day)
      U.uCalmB.value.copy(C.violet).multiplyScalar(0.8).lerp(C.peri, 0.55 * day)
      // the lamp: grows and spreads as the breach does, cools through violet, goes out
      const lampOn = front * smoothstep(0.0, 0.62, heat)
      U.uLampLevel.value = 1.55 * lampOn
      U.uLampH.value = lerp(0.55, 1.15, front)
      const gel = clamp(heat * 2 - 1)
      U.uLampCore.value.copy(C.coolCore).lerp(C.hotCore, gel)
      U.uLampEdge.value.copy(C.coolEdge).lerp(C.hotEdge, gel)
      // alarm: a slow pulse (0.25 Hz, ≤ 14 %); watch: a slower breath (0.12 Hz). Steady when calm.
      const pulse = calm ? 1 : 1 - 0.14 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 0.25 * t))
      U.uPulse.value = pulse
      const amp = lerp(0.12, 0.06, smoothstep(T.watch - 0.04, T.watch + 0.06, q))
      const breath = calm ? 0.96 : 1 - amp + amp * (0.5 + 0.5 * Math.cos(2 * Math.PI * 0.12 * t))
      U.uBreath.value = breath

      for (const m of caps) m.roughness = lerp(0.62, 0.42, clarity)

      // the designs' light: the padlock is the watch's own light re-gelled by the lamp where it reaches; 24/7 comes up in the calm
      const lockHot = lampFall(lockU, U) * U.uLampLevel.value * pulse * 1.5
      const lockCalm = lerp(lerp(0.55, 0.12, front), 1.0, day) * breath * 1.05
      lights[2]?.design.copy(C.ice).multiplyScalar(lockCalm).add(tmpC.copy(U.uLampCore.value).multiplyScalar(lockHot))
      const num = numDim.update(q > T.num, frame.dt)
      lights[1]?.design.copy(C.ice).multiplyScalar(1.25 * num * breath)
      lights.forEach((wl, i) => wl.slot.copy(C.ice).multiplyScalar(0.85 * indDims[i].update(q > T.watch + i * 0.025, frame.dt)))

      // the studio strips glide along the polished bevels as the glass clears
      const turn = lerp(-0.35, 0.85, ease.inOutCubic(segment(q, 0.4, 0.66))) + (q > 0.66 ? (q - 0.66) * 0.4 : 0)
      for (const m of envMats) m.envMapRotation.y = turn

      // ---------------- world + post
      const reg = solvePose(q, frame, layout, scratch)
      const aspect = frame.width / Math.max(1, frame.height)
      wp.focus.set(reg.cx * aspect, reg.cy)
      wp.fieldSize = 1.3
      wp.field = 0.3
      // the gallery around: the watch colours, and the lamp's red on the right while it's up
      const warm = lampOn * gel
      wp.fieldA = '#' + tmpC.copy(C.peri).lerp(C.violet, 0.4 * (1 - day)).getHexString()
      wp.fieldB = '#' + tmpC2.copy(C.lilac).lerp(C.alarm, 0.85 * warm).getHexString()
      wp.fieldAngle = 1.35
      wp.slits = 0.08
      wp.slitColor = DUSK.ice
      wp.env = 0.42
      wp.envTurn = turn
      wp.key = 0.6
      wp.fill = 0.06
      pp.bloomStrength = 0.38
      pp.bloomThreshold = 1.0
      pp.vignette = 0.52
      // a soft focus pull as the headline arrives ("breathe")
      pp.glitch = 0.2 * Math.sin(Math.PI * segment(q, T.cool0 - 0.02, T.cool0 + 0.09))

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
