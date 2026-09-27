import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext } from '../../core/types'
import { reveal, setRise } from '../../core/dom'
import { damp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { StoryClock } from '../../kit/pace'
import { DUSK } from '../../kit/opal'
import { buildHud, measureHud, type Hud, type Layout } from './hud'
import { buildSlab, loadEtchFont, SLAB, SLAB_CY, type Slab } from './slab'
import './contact.css'

/*
 * CONTACT · "Foyer" — the gallery's foyer at closing. One long, low light
 * box of frosted glass stands on black stone with "Say hello." POLISHED into
 * its frost; through the letters the tube bank inside reads crisp and bright
 * while the slab glows soft around them, and its light pools on the floor.
 *
 *   0.00–0.06  the colour-field cut resolves: the slab at its standby glow
 *   0.02–0.28  the camera walks up and round to it; the light inside comes up
 *              LEFT → RIGHT behind the words (a soft front with a brighter
 *              band riding it), so "Say hello." lights letter by letter
 *   0.30–0.85  settled (landing / heading stop 0.3): the panel — eyebrow,
 *              "Say hello.", body, the address, Copy email, other concepts,
 *              Back to top, colophon — beside (landscape) or under (portrait)
 *              the slab. Short screens split the panel into two beats (the
 *              address first, then the other concepts) at 0.575
 *   0.85–1.00  closing: the panel goes, the gallery's other lights (the light
 *              field, the hairline slits, the key) dim down, and the camera
 *              comes round to face the slab square — the only light left in
 *              the room — over the sign-off (Back to top + colophon)
 *
 * The camera and the copy derive from `local`; the LIGHTS follow a StoryClock
 * (paced view of local), so a fast scroll can't swing the slab dark ↔ lit
 * several times a second (WCAG 2.3.1). Copying the address sends one soft
 * glint across the letters.
 */

const SPLIT_AT = 0.575
/** the slab's glow before its lights come up (keeps light in the cut's field) */
const STANDBY = 0.5

interface Shot {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
}
const shot = (): Shot => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 32 })

interface Box {
  cx: number
  cy: number
  hw: number
  hh: number
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

/**
 * Frame a box on the plane z = 0 (centre cx,cy; half extents hw,hh) inside a
 * screen rect (u across, v down, 0..1). The camera stands `d` from the box,
 * raised by an elevation angle `elev` (it looks down at the slab and its
 * light on the floor); the box is placed ACROSS by sliding the rig sideways
 * and UP/DOWN by pitching the view (never by lowering the camera: a portrait
 * frame would put it under the floor). Then the rig orbits by `yaw` about the
 * box's vertical axis (+ = camera to the right).
 */
function fit(out: Shot, aspect: number, fov: number, b: Box, r: { u0: number; u1: number; v0: number; v1: number }, elev: number, yaw: number) {
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const halfH = Math.max(b.hh / Math.max(0.05, r.v1 - r.v0), b.hw / Math.max(0.05, (r.u1 - r.u0) * aspect))
  const halfW = halfH * aspect
  const d = halfH / tanV
  const sx = -((r.u0 + r.u1) / 2 - 0.5) * 2 * halfW
  // where the box centre should sit on screen (ndc y), and the extra pitch that puts it there
  const ny = 1 - (r.v0 + r.v1)
  const delta = Math.atan(ny * tanV)
  const e = THREE.MathUtils.degToRad(elev)
  _b.set(sx, d * Math.sin(e), d * Math.cos(e))
  _a.set(0, -Math.sin(e + delta), -Math.cos(e + delta)).multiplyScalar(d).add(_b)
  _a.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw)
  _b.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw)
  out.tgt.set(b.cx + _a.x, b.cy + _a.y, _a.z)
  out.pos.set(b.cx + _b.x, b.cy + _b.y, _b.z)
  out.fov = fov
  return out
}

function mix(out: Shot, a: Shot, b: Shot, t: number) {
  out.pos.lerpVectors(a.pos, b.pos, t)
  out.tgt.lerpVectors(a.tgt, b.tgt, t)
  out.fov = lerp(a.fov, b.fov, t)
  return out
}

const toRect = (x0: number, y0: number, x1: number, y1: number, W: number, H: number) => ({ u0: x0 / W, u1: x1 / W, v0: y0 / H, v1: y1 / H })

export default function create(): Chapter {
  const group = new THREE.Group()
  let hud: Hud
  let slab: Slab
  let lay: Layout | null = null
  let lastW = 0
  let lastH = 0
  let showB = false
  // the lights follow a paced view of local (≥ ~0.5 s for the whole sweep;
  // a dark ↔ lit swing can't repeat faster than ~1/s)
  const clock = new StoryClock({ rate: 0.45 })
  let hoverAmt = 0
  let glint = 0

  // camera scratch
  const A = shot()
  const S1 = shot()
  const S2 = shot()
  const F = shot()
  const OUT = shot()
  const proj = new THREE.Vector3()

  const relayout = (W: number, H: number) => {
    lay = measureHud(hud, W, H)
    lastW = W
    lastH = H
    showB = false
  }

  return {
    id: 'contact',
    group,
    anchors: [],

    async init(ctx: ChapterContext) {
      hud = buildHud(ctx.stage)
      // the etch is drawn with the DOM's Cormorant italic: load it first
      await loadEtchFont()
      await nextFrame()
      slab = buildSlab({ mobile: ctx.mobile, envMap: ctx.world.envMap })
      group.add(slab.group)
      slab.set({ level: 1, sweep: 0, standby: STANDBY, front: 0, frontX: -1 })
      // a late font (or a swap) repaints the etch
      document.fonts?.ready
        .then(() => {
          if (!slab.fontOk) slab.redraw()
        })
        .catch(() => {})
      await nextFrame()
    },

    onEnter() {
      clock.reset()
    },

    busy() {
      return clock.busy || glint > 0 || Math.abs(hoverAmt - (hud?.hover ? 1 : 0)) > 0.004
    },

    update(local, frame, ctx) {
      const W = frame.width
      const H = frame.height
      if (hud.dirty || W !== lastW || H !== lastH || !lay) relayout(W, H)
      const L = lay!

      // ------------------------------------------------ the light (paced)
      const q = clock.update(local, frame.dt)
      const calm = ctx.reducedMotion || frame.reducedMotion || !!frame.still
      // left → right behind the words; before it, the standby glow
      const sweep = lerp(-0.32, 1.36, ease.inOutQuad(segment(q, 0.05, 0.25)))
      const riding = smoothstep(-0.25, 0.02, sweep) * (1 - smoothstep(1.0, 1.3, sweep))
      let front = (calm ? 0.35 : 0.75) * riding
      let frontX = sweep - 0.03
      // the address answers: hovering it warms the slab a touch; copying it
      // sends one soft glint across the letters
      const hoverTo = hud.hover ? 1 : 0
      hoverAmt = damp(hoverAmt, hoverTo, 5, frame.dt)
      const since = (performance.now() - hud.copiedAt) / 1000
      glint = since >= 0 && since < 1.5 ? since / 1.5 : 0
      if (glint > 0) {
        const g = Math.sin(glint * Math.PI) * (calm ? 0.3 : 0.55)
        if (g > front) {
          front = g
          frontX = lerp(-0.12, 1.12, ease.inOutQuad(glint))
        }
      }
      slab.set({ level: 1 + 0.07 * hoverAmt, sweep, standby: STANDBY, front, frontX })

      // ------------------------------------------------ the room
      const lit = smoothstep(0.04, 0.24, q)
      const close = smoothstep(0.86, 0.95, q)
      const wp = ctx.world.params
      wp.top = '#030205'
      wp.bottom = '#000000'
      // the light field sits behind the slab (screen units: x = ndc.x·aspect)
      const aspect = W / Math.max(1, H)
      proj.copy(slab.centre).project(ctx.camera)
      const fx = Number.isFinite(proj.x) ? proj.x * aspect : 0.3
      const fy = Number.isFinite(proj.y) ? proj.y : 0
      _a.set(-SLAB.W / 2, SLAB_CY, 0).project(ctx.camera)
      _b.set(SLAB.W / 2, SLAB_CY, 0).project(ctx.camera)
      const halfW = Number.isFinite(_a.x + _b.x) ? Math.abs(_b.x - _a.x) * 0.5 * aspect : 0.6
      wp.focus.set(fx, fy - 0.02)
      wp.fieldSize = Math.max(0.35, Math.min(1.4, halfW * 1.25))
      wp.field = lerp(0.5, 0.62, lit) * (1 - 0.9 * close)
      wp.fieldA = DUSK.blush
      wp.fieldB = DUSK.periwinkle
      wp.fieldAngle = Math.PI / 2
      // no world slits: vertical hairlines behind the slab read as cables
      // hanging it (and a rotated slit angle is damped: it would visibly turn
      // after the cut). The foyer's hairline is its own cove line instead
      // (portrait and short screens: none — it would sit right under the chrome)
      wp.slits = 0
      slab.setCove(L.stack || H <= 500 ? 0 : (1 - close) * smoothstep(0.02, 0.12, q))
      // a highlight glides along the bevels on the walk up, and once more as the room closes
      wp.env = lerp(1, 0.62, close)
      wp.envTurn = -0.7 + 0.55 * ease.inOutCubic(segment(local, 0.02, 0.3)) + 0.4 * ease.inOutCubic(segment(local, 0.85, 0.98))
      // the key comes from above and BEHIND: it glints along the top bevel and
      // the housing, never lights the frost's face (that would grey it)
      wp.keyDir.set(-0.25, 0.9, -0.4)
      wp.key = lerp(1.0, 0.3, close)
      wp.fill = lerp(0.08, 0.03, close)

      const pp = ctx.post.params
      // only the crisp rules of light through the letters cross the threshold
      // (the frost around them sits just under it): the words glow, the slab doesn't haze
      pp.bloomStrength = 0.7
      pp.bloomRadius = 0.42
      pp.bloomThreshold = 1.1
      pp.vignette = lerp(0.5, 0.68, close)

      // ------------------------------------------------ copy
      let pv = smoothstep(0.2, 0.265, local) * (1 - smoothstep(0.85, 0.88, local))
      const b = L.split && local >= SPLIT_AT
      if (b !== showB) hud.root.classList.toggle('show-b', (showB = b))
      // the split: dip out for a moment while the panel changes part
      if (L.split) pv *= 1 - smoothstep(SPLIT_AT - 0.03, SPLIT_AT - 0.008, local) * (1 - smoothstep(SPLIT_AT + 0.008, SPLIT_AT + 0.03, local))
      reveal(hud.panel, pv)
      setRise(hud.title, local > 0.21 && local < (L.split ? SPLIT_AT : 0.87))
      reveal(hud.end, smoothstep(0.9, 0.95, local), 0)
    },

    camera(local, frame, out: CameraPose) {
      const W = Math.max(1, frame.width)
      const H = Math.max(1, frame.height)
      const aspect = W / H
      const L = lay
      const stack = L ? L.stack : H > W
      const fov = stack ? 38 : 32
      const { W: sw, H: sh } = SLAB
      // the subject: the slab, its plinth and a little of its light on the floor
      const box: Box = { cx: 0, cy: SLAB_CY - 0.24, hw: sw / 2 + 0.55, hh: sh / 2 + 0.36 }
      const wide: Box = { cx: 0, cy: SLAB_CY - 0.1, hw: sw / 2 + 1.0, hh: sh / 2 + 0.6 }
      const fin: Box = { cx: 0, cy: SLAB_CY - 0.1, hw: sw / 2 + (stack ? 0.3 : 2.2), hh: sh / 2 + 0.6 }
      const band = L ? L.band : { x0: 0.04 * W, x1: 0.96 * W, y0: 0.11 * H, y1: 0.89 * H }
      const art = L ? L.art : stack ? { x0: band.x0, x1: band.x1, y0: band.y0, y1: H * 0.45 } : { x0: W * 0.45, x1: band.x1, y0: band.y0, y1: band.y1 }
      const fr = L ? L.fin : { x0: band.x0, x1: band.x1, y0: band.y0, y1: band.y1 - 70 }
      const rBand = toRect(band.x0, band.y0, band.x1, band.y1, W, H)
      const rArt = toRect(art.x0, art.y0, art.x1, art.y1, W, H)
      const rFin = toRect(fr.x0, fr.y0, fr.x1, fr.y1, W, H)

      // arrival: further out and round to the right, lower; settled: a slow
      // quarter-step round toward square; closing: square on, over the sign-off
      fit(A, aspect, fov, wide, rBand, 5, stack ? 0.42 : 0.62)
      fit(S1, aspect, fov, box, rArt, stack ? 5 : 8, stack ? 0.2 : 0.3)
      fit(S2, aspect, fov, box, rArt, stack ? 4.5 : 7, stack ? 0.14 : 0.2)
      fit(F, aspect, fov, fin, rFin, 6, 0)
      if (local < 0.28) mix(OUT, A, S1, ease.inOutCubic(segment(local, 0.02, 0.28)))
      else if (local < 0.85) mix(OUT, S1, S2, ease.inOutQuad(segment(local, 0.28, 0.85)))
      else mix(OUT, S2, F, ease.inOutCubic(segment(local, 0.85, 0.975)))
      out.position.copy(OUT.pos)
      out.target.copy(OUT.tgt)
      out.fov = OUT.fov
      out.roll = 0
      // the closing frame holds still
      out.parallax = 0.18 * (1 - smoothstep(0.86, 0.96, local))
    },
  }
}
