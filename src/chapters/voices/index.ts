import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { lerp, smoothstep } from '../../core/math'
import { StoryClock } from '../../kit/pace'
import { DUSK, type DuskColor } from '../../kit/opal'
import { buildRoom, ROOM, type Room } from './room'
import './voices.css'

/*
 * VOICES · "Afterglow" — a James Turrell room. A black gallery, one knife-edged
 * rectangular APERTURE in the far wall: a field of even, coloured light whose
 * depth you can't judge (room.ts). A low bench of black stone for scale, the
 * polished floor holding a soft reflection of the field. Quiet.
 *
 * The eight testimonials are gallery wall text beside the aperture (DOM:
 * .hud-quote in Cormorant, "— Name, Company", an NN / 08 index). For each
 * voice the field slowly shifts to a new pair of dusk colours — the sky after
 * sunset, from afterglow (blush, amber) through rose and violet to blue hour
 * (periwinkle, ice) — and the viewing angle and the opening's proportion
 * change by a hair.
 *
 *   0.00–0.14  intro: the room, the aperture glowing; eyebrow + "We listen.
 *              They talk." held ~0.35 vh clear of the cut; a slow push in
 *              (landing 0.1, intro 0.08)
 *   0.14–0.95  eight voices, one at a time (anchors = slot centres)
 *   0.95–1.00  out: a slow push toward the field for the colour-field cut
 *
 * PACING (WCAG 2.3.1): the voice, the field colours and the camera all follow
 * a StoryClock in slot units (≤ 1.1 voice changes a second; the intro counts
 * as 0.7 of a slot so the clock doesn't linger on it), and on top of it the colours
 * cross-fade by TIME (≥ 1.5 s, luminance-balanced: a hue change, never a
 * brightness step) and the camera's angle / the opening's proportion glide
 * on critically damped springs (~1.5 s). Everything snaps on teleports (nav,
 * keyboard stops, screenshots). Reduced motion: no camera moves at all.
 */

const N = TESTIMONIALS.length
const A0 = 0.14
const A1 = 0.95
const SPAN = (A1 - A0) / N
/** a slot boundary must be passed by this much (slot units) before the voice changes */
const HYST = 0.06
/**
 * The story clock runs in SLOT units (q): the intro is compressed to INTRO_Q
 * slots and the out beat to OUT_Q, so a paced clock leaves the headline as
 * soon as a voice would, instead of spending 1.4 slots of time on it.
 */
const INTRO_Q = 0.7
const OUT_Q = 0.45
/** voices a second, at most (the clock's pace) */
const PACE = 1.1
const toQ = (local: number) =>
  local < A0 ? -INTRO_Q * (1 - local / A0) : local <= A1 ? (local - A0) / SPAN : N + (OUT_Q * (local - A1)) / (1 - A1)

/** field (top, bottom) per state: 0 = intro, 1..N = voices — dusk into blue hour */
const FIELDS: [DuskColor, DuskColor][] = [
  ['blush', 'amber'],
  ['rose', 'blush'],
  ['lilac', 'rose'],
  ['violet', 'rose'],
  ['violet', 'lilac'],
  ['periwinkle', 'lilac'],
  ['periwinkle', 'violet'],
  ['ice', 'periwinkle'],
  ['ice', 'lilac'],
]
/** camera yaw about the opening (radians; negative = from the left) and the opening's proportion (w / h), per state */
const YAW = [-0.2, -0.13, -0.08, -0.16, -0.1, -0.18, -0.07, -0.14, -0.11]
const ASPECT = [1.56, 1.5, 1.38, 1.6, 1.44, 1.34, 1.58, 1.42, 1.52]
const AREA = ROOM.apW * ROOM.apH
/** the field's luminance (linear) and how strongly colours are pulled toward it (1 = exactly equal) */
const FIELD_L = 0.44
const BALANCE = 0.72
/** colour cross-fade (s) */
const FADE = 1.6

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
/** a touch of grey in every gel: a calm field, not a sign */
const MUTE = 0.1
function balanced(name: DuskColor) {
  const c = new THREE.Color(DUSK[name])
  c.multiplyScalar(Math.pow(FIELD_L / Math.max(0.02, lum(c)), BALANCE))
  const l = lum(c)
  return c.lerp(new THREE.Color(l, l, l), MUTE)
}
const PALETTE = FIELDS.map(([a, b]) => [balanced(a), balanced(b)] as const)

/** time-based cross-fade of the field's two colours */
class FieldFade {
  top = new THREE.Color()
  bot = new THREE.Color()
  private fT = new THREE.Color()
  private fB = new THREE.Color()
  private t = 1
  state = -1
  go(state: number, snap: boolean) {
    if (snap || this.state < 0) {
      this.state = state
      this.top.copy(PALETTE[state][0])
      this.bot.copy(PALETTE[state][1])
      this.t = 1
      return
    }
    if (state === this.state) return
    this.state = state
    this.fT.copy(this.top)
    this.fB.copy(this.bot)
    this.t = 0
  }
  update(dt: number) {
    if (this.t >= 1) return
    this.t = Math.min(1, this.t + dt / FADE)
    const x = this.t
    const k = x * x * x * (x * (x * 6 - 15) + 10)
    this.top.lerpColors(this.fT, PALETTE[this.state][0], k)
    this.bot.lerpColors(this.fB, PALETTE[this.state][1], k)
  }
  get busy() {
    return this.t < 1
  }
}

/** a critically damped follower (time-based; snaps on demand) */
class Spring {
  x = NaN
  v = 0
  constructor(private omega = 2.8) {}
  update(target: number, dt: number, snap = false) {
    if (snap || !Number.isFinite(this.x)) {
      this.x = target
      this.v = 0
      return this.x
    }
    const w = this.omega
    const f = 1 + 2 * dt * w
    const oo = w * w
    const hoo = dt * oo
    const hhoo = dt * hoo
    const det = 1 / (f + hhoo)
    const x = (f * this.x + dt * this.v + hhoo * target) * det
    this.v = (this.v + hoo * (target - this.x)) * det
    this.x = x
    return x
  }
  settled(target: number) {
    return Math.abs(this.x - target) < 1e-4 && Math.abs(this.v) < 1e-4
  }
}

type Mode = 'wide' | 'tall' | 'short'
interface Layout {
  W: number
  H: number
  mode: Mode
  /** the opening's centre on screen (px) and its width there (px) at the quote framing */
  cx: number
  cy: number
  apW: number
  fov: number
  /** eye height (m) */
  eye: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let room: Room
  const clock = new StoryClock({ rate: PACE, snap: 1 })
  const fade = new FieldFade()
  const yaw = new Spring(2.6)
  const aspect = new Spring(2.2)
  let state = -1
  let lastQ = NaN
  let entering = true
  let settled = true
  let yawT = 0
  let aspT = 1.5

  // DOM
  let copy: HTMLElement
  let probe: HTMLElement
  let intro: HTMLElement
  let introTitle: HTMLElement
  let wall: HTMLElement
  let idxN: HTMLElement
  const figs: HTMLElement[] = []
  let shown = -99

  const lay: Layout = { W: 0, H: 0, mode: 'wide', cx: 0, cy: 0, apW: 1, fov: 36, eye: 1.3 }
  let dirty = true

  // the pose (computed in update, written in camera)
  const pos = new THREE.Vector3()
  const tgt = new THREE.Vector3()
  let fov = 36

  /* ---------------------------------------------------------------- state */

  /** 0 = intro, 1..N = voice i - 1, from the clock (slot units); hysteresis round the previous state */
  function stateFor(x: number, prev: number, snap: boolean) {
    const raw = x < 0 ? 0 : Math.min(N, Math.floor(x) + 1)
    if (snap || prev < 0 || raw === prev) return raw
    const lo = prev === 0 ? -Infinity : prev - 1
    const hi = prev === 0 ? 0 : prev >= N ? Infinity : prev
    return x > lo - HYST && x < hi + HYST ? prev : raw
  }

  /* ---------------------------------------------------------------- layout */

  function measure(W: number, H: number) {
    lay.W = W
    lay.H = H
    const portrait = W / Math.max(1, H) <= 1
    const short = !portrait && H <= 500
    lay.mode = portrait ? 'tall' : short ? 'short' : 'wide'
    const band = probe.getBoundingClientRect()
    const top = band.height > 0 ? band.top : H * 0.105
    const bottom = band.height > 0 ? band.bottom : H * 0.895
    const c = copy.getBoundingClientRect()
    const asp0 = ASPECT[1]
    if (lay.mode === 'tall') {
      const regionB = c.height > 0 ? c.top - 14 : H * 0.6
      const rh = Math.max(120, regionB - top)
      lay.fov = 32
      lay.eye = 1.25
      lay.cx = W / 2
      lay.cy = top + rh * 0.4
      lay.apW = Math.min(W * 0.72, rh * 0.5 * asp0)
    } else {
      const left = c.width > 0 ? c.right + W * 0.03 : W * 0.46
      const right = W - Math.max(20, W * 0.035)
      const rw = Math.max(160, right - left)
      const rh = Math.max(120, bottom - top)
      lay.fov = short ? 28 : 26
      lay.eye = 1.3
      lay.cx = (left + right) / 2
      lay.cy = top + rh * (short ? 0.42 : 0.4)
      lay.apW = Math.min(rw * (short ? 0.72 : 0.7), rh * (short ? 0.52 : 0.46) * asp0)
    }
    dirty = false
  }

  /**
   * The camera that puts the opening's centre at (lay.cx, lay.cy) with the
   * rest-width lay.apW (px), pulled back by `dScale`, then swung round the
   * opening by `yawA` (the opening stays put on screen). The eye stays at a
   * standing height (lay.eye) and pitches a few degrees to place the opening
   * vertically — a level camera would sink under the floor on tall screens.
   */
  function pose(dScale: number, yawA: number) {
    const W = lay.W
    const H = lay.H
    const tanV = Math.tan(THREE.MathUtils.degToRad(lay.fov / 2))
    const D = ((ROOM.apW * H) / (2 * tanV * Math.max(40, lay.apW))) * dScale
    const nx = (lay.cx / W) * 2 - 1
    const ny = 1 - (lay.cy / H) * 2
    const ox = -nx * D * tanV * (W / H)
    const s = Math.sin(yawA)
    const c = Math.cos(yawA)
    const px = ROOM.apX + ox * c + D * s
    const pz = -ox * s + D * c
    const pitch = Math.atan2(ROOM.apY - lay.eye, D) - Math.atan(ny * tanV)
    const cp = Math.cos(pitch)
    pos.set(px, lay.eye, pz)
    tgt.set(px - s * cp * D, lay.eye + Math.sin(pitch) * D, pz - c * cp * D)
    fov = lay.fov
  }

  /* ---------------------------------------------------------------- DOM */

  function buildDom(stage: HTMLElement) {
    probe = el('div', 'vo-probe', undefined, stage)
    copy = el('div', 'vo-copy', undefined, stage)
    intro = el('div', 'vo-intro', undefined, copy)
    el('p', 'hud-eyebrow vo-eyebrow', SECTIONS.voices.eyebrow, intro)
    introTitle = rise(el('h2', 'hud-h2 vo-title', undefined, intro), 'We listen. They <em>talk.</em>')
    wall = el('div', 'vo-wall', undefined, copy)
    const idx = el('p', 'hud-label vo-idx', undefined, wall)
    idxN = el('span', 'vo-n', '01', idx)
    idx.append(` / ${String(N).padStart(2, '0')}`)
    const stack = el('div', 'vo-stack', undefined, wall)
    TESTIMONIALS.forEach(t => {
      const f = el('figure', 'vo-fig', undefined, stack)
      if (t.quote.length > 170) f.classList.add('vo-fig--long')
      el('blockquote', 'hud-quote vo-q', `“${t.quote}”`, f)
      el('figcaption', 'hud-label vo-who', `— ${t.name}, ${t.company}`, f)
      figs.push(f)
    })
    const mark = () => (dirty = true)
    window.addEventListener('resize', mark)
    document.fonts?.ready.then(mark)
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(mark).observe(copy)
  }

  function show(next: number, local: number) {
    setRise(introTitle, next === 0 && local > 0.012)
    if (next === shown) return
    shown = next
    intro.classList.toggle('is-on', next === 0)
    wall.classList.toggle('is-on', next >= 1)
    figs.forEach((f, i) => f.classList.toggle('is-on', i === next - 1))
    if (next >= 1) idxN.textContent = String(next).padStart(2, '0')
  }

  /* ---------------------------------------------------------------- chapter */

  return {
    id: 'voices',
    group,
    anchors: TESTIMONIALS.map((_, i) => A0 + SPAN * (i + 0.5)),

    init(ctx: ChapterContext) {
      room = buildRoom({ lite: ctx.mobile })
      group.add(room.group)
      buildDom(ctx.stage)
    },

    onEnter() {
      clock.reset()
      entering = true
      shown = -99
    },

    onLeave() {
      entering = true
    },

    busy() {
      return !settled
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (dirty || lay.W !== frame.width || lay.H !== frame.height) measure(frame.width, frame.height)
      const dt = frame.dt
      const calm = frame.reducedMotion
      const q0 = toQ(local)
      const snap = entering || !Number.isFinite(lastQ) || Math.abs(q0 - lastQ) > clock.snap
      lastQ = q0
      const x = clock.update(q0, dt)
      state = stateFor(x, state, snap)
      entering = false

      /* ---- the field ---- */
      fade.go(state, snap)
      fade.update(dt)
      const u = room.u
      u.uTop.value.copy(fade.top)
      u.uBot.value.copy(fade.bot)
      // the sky's slant drifts a hair (idle)
      u.uTilt.value = calm || frame.still ? 0.04 : 0.04 + Math.sin(frame.time * 0.09) * 0.05

      /* ---- the opening's proportion and the viewing angle (springs) ---- */
      aspT = calm ? ASPECT[1] : ASPECT[state]
      yawT = calm ? YAW[1] : YAW[state]
      const a = aspect.update(aspT, dt, snap)
      const hw = Math.sqrt(AREA * a) / 2
      const hh = Math.sqrt(AREA / a) / 2
      // the opening keeps its sill height; it grows / shrinks about its centre line
      room.setAperture(ROOM.apX, ROOM.apY, hw, hh)
      const y = yaw.update(yawT, dt, snap)

      /* ---- the camera ---- */
      // intro: a slow push in from the room; out: toward the field for the cut
      // (both follow the clock, so a fling can't rush them)
      const inSlot = x < 0 ? 0 : x >= N ? 1 : x - Math.floor(x)
      let dScale = 1
      let drift = 0
      if (!calm) {
        dScale = lerp(1.24, 1, smoothstep(-0.56, 0.25, x)) * lerp(1, 0.86, smoothstep(N - 0.05, N + OUT_Q, x))
        // a hair of drift through each voice
        dScale *= 1 - 0.018 * inSlot * (x >= 0 ? 1 : 0)
        drift = x >= 0 && x < N ? 0.016 * (inSlot - 0.5) : 0
      }
      pose(dScale, y + drift)
      if (!calm && !frame.still) {
        pos.x += Math.sin(frame.time * 0.11) * 0.035
        pos.y += Math.sin(frame.time * 0.083 + 1.3) * 0.018
      }

      /* ---- world + post ---- */
      const w = ctx.world.params
      w.top = '#000000'
      w.bottom = '#000000'
      w.field = 0
      w.slits = 0
      const post = ctx.post.params
      post.bloomStrength = 0
      post.vignette = 0.5
      post.grain = 0.02
      post.saturation = 1

      /* ---- copy ---- */
      show(state, local)

      settled = !clock.busy && !fade.busy && yaw.settled(yawT) && aspect.settled(aspT)
    },

    camera(_local: number, frame: Frame, out: CameraPose) {
      out.position.copy(pos)
      out.target.copy(tgt)
      out.fov = fov
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.12
    },
  }
}
