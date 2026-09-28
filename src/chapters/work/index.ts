import * as THREE from 'three'
import type { CameraPose, Chapter, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { SECTIONS, WORK, workImage } from '../../content'
import { clamp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { loadScreenshot, whenRevealed } from '../../kit/images'
import { Dimmer, stoneFloor } from '../../kit/opal'
import { StoryClock } from '../../kit/pace'
import { board, etchFonts, FACE_Z, GH, GW, hex, LABEL_H, LABEL_Y, lightBox, PRINT_BEHIND, PRINT_DIM, sharedMaterials, wall, type Board, type Light, type LightBox } from './gallery'
import './work.css'

/*
 * WORK · LIGHT BOXES. A long black gallery wall, lit only by the works. Each
 * of the six featured projects is a museum light box in glass: a thick
 * frosted slab held off the wall on four polished standoffs, a window cut
 * clean through it, the screenshot on a black mount board behind the window,
 * and two tubes of the box's own light behind the glass (one or two dusk
 * colours, varied along the wall) — soft bars through the frost, crisp lines
 * along the polished bevels, which catch the studio strips as you walk. A
 * faint spill on the wall, a pool on the stone floor, and a small glass label
 * under it with the name and industry polished into it. The camera walks the
 * wall; each box dims up as you arrive and down as you leave (nothing bright
 * slides across the frame at full light; a box you've passed goes all but
 * dark, so nothing reads through the card over it). At the end of the wall, a
 * long frosted wall-text panel with the nine other sites polished into it
 * (decoration: the card lists the nine as real links, the one you're on
 * marked; its etched line lifts a touch).
 *
 * PACING (WCAG 2.3.1): the camera, the lit box and the card follow a
 * StoryClock, not the raw scroll. The clock runs on a warped copy of `local`
 * in which every box-to-box walk is one unit and a hold a little over half
 * one, at most RATE units a second: a walk takes ≥ 0.55 s of time and a new
 * box lights at most ~1.2 times a second however fast the page moves.
 * Teleports (nav jumps, anchors, screenshots) snap. Dimmers are time-based.
 */
const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const isPreview = (url: string) => /harktest\.com/i.test(url)
const N = FEATURED.length

/** each box's light: one or two dusk colours, warm and cool alternating along the wall */
const LIGHTS: Light[] = [
  { a: 'blush', b: 'rose', angle: -0.9 },
  { a: 'periwinkle', b: 'ice', angle: -0.8 },
  { a: 'lilac', b: 'rose', angle: 1.1 },
  { a: 'violet', b: 'periwinkle', angle: -1.2 },
  { a: 'amber', b: 'blush', angle: 0.8 },
  { a: 'lilac', b: 'violet', angle: -1.0 },
]
const BOARD_LIGHT: Light = { a: 'lilac', b: 'periwinkle', angle: 2.6 }

// ---- the wall (world units ≈ metres; wall face z = 0, floor y = 0)
const SP = 4.6 // box spacing along the wall
const BOX_Y = 1.95 // box centre height
const BOARD_X = (N - 1) * SP + 7.6
const BOARD_Y = 1.95

// ---- the story schedule, written in viewport heights of scroll so every beat
// keeps its reading distance: LEN must match this chapter's `length` in
// src/chapters/index.ts.
// Reading pace (250 px/s of wheel ≈ 0.28 vh/s): the headline holds ≥ 1.5 s,
// each card is fully up ≥ 2 s, the nine names ~2.5 s.
const LEN = 6.1
const V = (vh: number) => vh / LEN
/** the headline comes into focus as the cut clears… */
const RISE = V(0.06)
/** …and holds, settled, until here (~0.5 vh of reading once the words have risen) */
const INTRO_OUT = V(0.74)
/** box 1 settled */
const A = V(0.94)
/** half a walk between two boxes */
const T = V(0.1)
/** the walk from the last box to the board is centred here (a box's hold + walk: 0.7 vh) */
const E = V(5.14)
/** one box: its hold + one walk */
const SPAN = (E - A) / N
/** travel k runs from station k to k+1; stations: 0 intro, 1..N boxes, N+1 the board */
const TRAVEL: [number, number][] = [[INTRO_OUT, A]]
for (let i = 1; i < N; i++) TRAVEL.push([A + SPAN * i - T, A + SPAN * i + T])
TRAVEL.push([E - T, E + T])
const BOARD = N + 1
/** the board's nine names: one keyboard stop (and brighter bar) each */
const SLOT0 = E + T + V(0.02)
const SLOT = V(0.07)
const OUTRO = SLOT0 + SLOT * REST.length + V(0.02)
/** each box's settled hold (anchors land mid-hold) */
const holdMid = (i: number) => ((i === 0 ? A : TRAVEL[i][1]) + TRAVEL[i + 1][0]) / 2

/*
 * The story clock's warp: a walk weighs 1 unit (the first swings the view
 * round from down the wall: a little more), a hold HOLD_W, the board and the
 * pull-back about one each. At RATE units/s a walk takes ≥ 0.55 s and a box
 * cycle (hold + walk) ≥ 0.86 s: ≤ 1.2 new boxes a second.
 */
const HOLD_W = 0.55
const RATE = 1.8
const WB: number[] = [0]
const WW: number[] = []
TRAVEL.forEach(([s, e], k) => {
  WB.push(s, e)
  WW.push(k === 0 ? 0.45 : HOLD_W, k === 0 ? 1.2 : 1)
})
WB.push(OUTRO, 1)
WW.push(1.2, 0.6)
const WU = WW.reduce((acc, w) => (acc.push(acc[acc.length - 1] + w), acc), [0])
function warp(local: number) {
  const l = clamp(local)
  let i = 0
  while (i < WW.length - 1 && l >= WB[i + 1]) i++
  return WU[i] + (WW[i] * (l - WB[i])) / Math.max(1e-6, WB[i + 1] - WB[i])
}
function unwarp(u: number) {
  const v = clamp(u, 0, WU[WU.length - 1])
  let i = 0
  while (i < WW.length - 1 && v >= WU[i + 1]) i++
  return WB[i] + ((WB[i + 1] - WB[i]) * (v - WU[i])) / WW[i]
}

/** where the story is: station k, travel progress t (0 = holding), hold progress h */
function where(local: number) {
  for (let k = 0; k < TRAVEL.length; k++) {
    const [s, e] = TRAVEL[k]
    if (local < s) {
      const hs = k === 0 ? 0 : TRAVEL[k - 1][1]
      return { k, t: 0, h: clamp((local - hs) / (s - hs)) }
    }
    if (local < e) return { k, t: (local - s) / (e - s), h: 1 }
  }
  const hs = TRAVEL[TRAVEL.length - 1][1]
  return { k: BOARD, t: 0, h: clamp((local - hs) / (OUTRO - hs)) }
}
/**
 * 0..1 visibility of station k's copy: full while the camera holds on it —
 * in by the time the eased camera reads as arrived (≈ 90% of the walk: t
 * 0.72), out only once it visibly leaves (t 0.18 → 0.4: 2% → 25% of the
 * walk), never ghosted over a box at rest; the copy swaps mid-walk, unseen
 */
function holdVis(local: number, k: number) {
  const inT = TRAVEL[k - 1]
  const outT = TRAVEL[k] as [number, number] | undefined
  const tin = clamp((local - inT[0]) / (inT[1] - inT[0]))
  const tout = outT ? clamp((local - outT[0]) / (outT[1] - outT[0])) : clamp((local - OUTRO) / V(0.1))
  return smoothstep(0.55, 0.72, tin) * (1 - smoothstep(0.18, 0.4, tout))
}

type Pose = { p: THREE.Vector3; t: THREE.Vector3 }
const pose = (): Pose => ({ p: new THREE.Vector3(), t: new THREE.Vector3() })

/** fit a world box (on the wall plane) into an NDC region [x0, y0, x1, y1] (y up), camera square to the wall */
function fit(out: Pose, cx: number, cy: number, bw: number, bh: number, r: number[], fov: number, aspect: number, z: number) {
  const tan = Math.tan((fov * Math.PI) / 360)
  const rw = r[2] - r[0]
  const rh = r[3] - r[1]
  const d = Math.max(bw / (rw * tan * aspect), bh / (rh * tan))
  const halfH = d * tan
  const halfW = halfH * aspect
  out.t.set(cx - ((r[0] + r[2]) / 2) * halfW, cy - ((r[1] + r[3]) / 2) * halfH, z)
  out.p.set(out.t.x, out.t.y, z + d)
  return d
}

const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
/** aim a camera at `p` so the world point `s` lands at NDC (nx, ny) */
function aim(out: Pose, p: THREE.Vector3, s: THREE.Vector3, nx: number, ny: number, fov: number, aspect: number) {
  const tv = Math.tan((fov * Math.PI) / 360)
  _d.subVectors(s, p).normalize()
  _r.crossVectors(_d, THREE.Object3D.DEFAULT_UP).normalize()
  _u.crossVectors(_r, _d)
  const ox = Math.atan(nx * tv * aspect)
  const oy = Math.atan(ny * tv)
  _d.applyAxisAngle(_u, ox).applyAxisAngle(_r, -oy)
  out.p.copy(p)
  out.t.copy(p).addScaledVector(_d, p.distanceTo(s))
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const _v = new THREE.Vector3()

export default function create(): Chapter {
  const group = new THREE.Group()
  const boxes: LightBox[] = []
  const dims: Dimmer[] = []
  let wallText: Board | null = null
  const boardDim = new Dimmer(0.7, 0.45)
  /** 0..1 per box: the camera has walked past it (time-damped: its print sinks to PRINT_BEHIND) */
  const behind = new Array<number>(N).fill(0)
  let S: ReturnType<typeof sharedMaterials> | null = null
  /** the studio's turn on the glass's own envMaps (damped like the world's) */
  let turn = NaN
  /** 0..1 how lit each board name is (time-damped); hover adds */
  const hl = REST.map(() => 0)
  let hover = -1
  let intro: HTMLElement, introTitle: HTMLElement
  let card: HTMLElement, meta: HTMLElement, name: HTMLElement, blurb: HTMLElement, tags: HTMLElement, visit: HTMLAnchorElement
  let rest: HTMLElement
  let hitsBox: HTMLElement
  const hits: HTMLAnchorElement[] = []
  const listItems: HTMLElement[] = []
  let shown = -1
  let restOn = -1
  let settling = false
  let snap = true
  const clock = new StoryClock({ rate: RATE, snap: 1.5 })
  let q = NaN
  let cardW = 400
  let cardH = 330
  let restW = 360
  let restH = 160
  const poses = {
    key: '',
    fov: 36,
    introFov: 42,
    introA: pose(),
    introB: pose(),
    boxes: Array.from({ length: N }, pose),
    dist: new Array<number>(N).fill(8),
    board: pose(),
    boardD: 8,
    outro: pose(),
    /** px per world unit on the board face at its hold (legibility of the etched names) */
    boardPx: 100,
  }
  const tmpA = pose()
  const tmpB = pose()

  function buildPoses(frame: Frame) {
    const W = frame.width || 1440
    const H = frame.height || 900
    const portrait = H > W
    const key = `${W}x${H}:${cardW},${cardH},${restW},${restH}`
    if (key === poses.key) return
    poses.key = key
    const aspect = W / H
    const gutter = clamp(W * 0.034, 16, 48)
    // the chrome bands (base.css --safe-top/--safe-bottom; short landscape shrinks them)
    const short = !portrait && H <= 500
    const safeTop = short ? 52 : clamp(H * 0.105, 80, 112)
    const safeBot = short ? 52 : clamp(H * 0.105, 82, 110)
    const nx = (px: number) => (px / W) * 2 - 1
    const ny = (py: number) => 1 - (py / H) * 2
    const region = (pw: number, ph: number) =>
      portrait
        ? [nx(gutter + 2), ny(H - safeBot - ph - 16), nx(W - gutter - 2), ny(safeTop + 6)]
        : [nx(gutter + pw + (short ? 28 : 64)), ny(H - safeBot - (short ? 4 : 24)), nx(W - gutter - (short ? 16 : 64)), ny(safeTop + (short ? 4 : 16))]
    const fov = portrait ? 40 : 36
    poses.fov = fov
    const rc = region(cardW, cardH)
    // box + its label under it
    const top = GH / 2 + 0.06
    const bottom = LABEL_Y - LABEL_H / 2 - 0.06
    for (let i = 0; i < N; i++) {
      const P = poses.boxes[i]
      poses.dist[i] = fit(P, i * SP, BOX_Y + (top + bottom) / 2, GW + 0.14, top - bottom, rc, fov, aspect, FACE_Z)
      // a touch left of square and a little above: the wall recedes to the right
      P.p.x -= 0.34
      P.p.y += 0.1
    }
    const rr = region(restW, restH)
    const bw = (wallText?.w ?? 3.7) + 0.3
    const bh = (wallText?.h ?? 3.8) + 0.3
    poses.boardD = fit(poses.board, BOARD_X, BOARD_Y, bw, bh, rr, fov, aspect, FACE_Z)
    poses.boardPx = H / (2 * poses.boardD * Math.tan((fov * Math.PI) / 360))
    poses.board.p.x -= 0.28
    poses.board.p.y += 0.08
    // intro: down the wall from its near end, the first box glowing ahead
    const c = new THREE.Vector3(0, BOX_Y, FACE_Z)
    if (portrait) {
      // phones: the headline owns the top; the first box glows below it, seen
      // a little from the left so the wall still reads in perspective
      poses.introFov = fov
      const z = clamp(5.2 / aspect, 6.2, 11)
      aim(poses.introA, new THREE.Vector3(-z * 0.5, 2.3, z), c, 0.04, -0.2, fov, aspect)
      aim(poses.introB, new THREE.Vector3(-z * 0.44, 2.25, z * 0.95), c, 0.04, -0.2, fov, aspect)
    } else {
      // the headline over the dark near wall on the left, box 1 lit right of
      // it, the rest receding down the wall toward the vanishing point
      const f0 = (poses.introFov = 42)
      const nx0 = aspect < 1.45 ? 0.36 : 0.3
      aim(poses.introA, new THREE.Vector3(-6.6, 1.85, 3.9), c, nx0, 0.02, f0, aspect)
      aim(poses.introB, new THREE.Vector3(-5.9, 1.85, 3.8), c, nx0, 0.02, f0, aspect)
    }
    // outro: ease back off the board (it stays lit for the cut)
    poses.outro.p.copy(poses.board.p).add(new THREE.Vector3(-0.6, 0.1, poses.boardD * 0.18))
    poses.outro.t.copy(poses.board.t).add(new THREE.Vector3(-0.3, 0, 0))
  }

  /** the pose held at station k, hold progress h (a slow truck right + a slight push-in) */
  function holdPose(out: Pose, k: number, h: number) {
    if (k === 0) {
      out.p.lerpVectors(poses.introA.p, poses.introB.p, h)
      out.t.lerpVectors(poses.introA.t, poses.introB.t, h)
      return
    }
    const P = k === BOARD ? poses.board : poses.boxes[k - 1]
    const d = k === BOARD ? poses.boardD : poses.dist[k - 1]
    const x = (h - 0.5) * 0.2
    out.p.copy(P.p)
    out.t.copy(P.t)
    out.p.x += x
    out.t.x += x * 0.8
    out.p.z -= d * 0.04 * h
  }

  return {
    id: 'work',
    group,
    // featured first (mid-hold), then the nine others (srContent / WORK order),
    // each its own slot on the board (its name burns brighter)
    anchors: [...FEATURED.map((_, i) => holdMid(i)), ...REST.map((_, j) => SLOT0 + (j + 0.5) * SLOT)],
    async init(ctx) {
      S = sharedMaterials(rt => ctx.post.isFrameTarget(rt), ctx.world.envMap, ctx.mobile)
      group.add(wall(-26, BOARD_X + 40, ctx.world.envMap))
      const floor = stoneFloor(BOARD_X + 70, 22, ctx.world.envMap)
      floor.position.set(BOARD_X / 2, 0, 11)
      group.add(floor)
      for (let i = 0; i < N; i++) {
        const w = FEATURED[i]
        const b = lightBox({ name: w.name, industry: w.industry, light: LIGHTS[i], S, y: BOX_Y })
        b.root.position.x = i * SP
        group.add(b.root)
        boxes.push(b)
        dims.push(new Dimmer(0.6, 0.4))
        if (i % 2) await nextFrame()
      }
      wallText = board(
        REST.map(w => w.name),
        BOARD_LIGHT,
        S,
        BOARD_Y,
      )
      wallText.root.position.x = BOARD_X
      group.add(wallText.root)

      // ---- copy
      intro = el('div', 'wk-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, intro)
      introTitle = rise(el('h2', 'hud-h2 wk-title', undefined, intro), 'Built to be <em>heard.</em>')
      card = el('div', 'wk-card hud-panel', undefined, ctx.stage)
      meta = el('p', 'hud-label wk-meta', '', card)
      name = el('h3', 'wk-name', '', card)
      blurb = el('p', 'hud-body wk-blurb', '', card)
      tags = el('ul', 'hud-tags wk-tags', undefined, card)
      visit = el('a', 'hud-btn hud-btn--ghost wk-visit', '', card)
      visit.target = '_blank'
      visit.rel = 'noopener'
      rest = el('div', 'wk-card wk-rest hud-panel', undefined, ctx.stage)
      el('h3', 'wk-name wk-rest-title', 'Nine more, all live.', rest)
      // the names as real text (links) on every screen: they hold contrast and
      // grow with zoom; the etched board on the wall is decoration
      const list = el('ul', 'wk-list', undefined, rest)
      REST.forEach((w, j) => {
        const li = el('li', '', undefined, list)
        listItems.push(li)
        const a = el('a', '', w.name, li)
        el('span', 'wk-arrow', ' ↗', a).setAttribute('aria-hidden', 'true')
        a.href = w.url
        a.target = '_blank'
        a.rel = 'noopener'
        // pointing at a name lifts its line on the wall
        a.addEventListener('pointerenter', () => (hover = j))
        a.addEventListener('pointerleave', () => hover === j && (hover = -1))
      })
      const hello = el('button', 'hud-btn wk-hello', 'Say hello', rest)
      hello.type = 'button'
      hello.addEventListener('click', () => window.__hark?.land('contact'))
      // pointer targets laid over the etched names too (positioned each frame from the board)
      hitsBox = el('div', 'wk-hits', undefined, ctx.stage)
      REST.forEach((w, j) => {
        const a = el('a', 'wk-hit', w.name, hitsBox)
        a.href = w.url
        a.target = '_blank'
        a.rel = 'noopener'
        a.addEventListener('pointerenter', () => (hover = j))
        a.addEventListener('pointerleave', () => hover === j && (hover = -1))
        hits.push(a)
      })
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
          cardW = card.offsetWidth || cardW
          cardH = card.offsetHeight || cardH
        }).observe(card)
        new ResizeObserver(() => {
          restW = rest.offsetWidth || restW
          restH = rest.offsetHeight || restH
        }).observe(rest)
      }

      // first screenshot right away, the rest after the reveal (decoded off the main thread)
      // phones: the print is ~410 device px wide — 640 is plenty (1024 cost ~20 MB of GPU texture)
      const shotW = ctx.mobile ? 640 : 1024
      const load = (i: number) =>
        loadScreenshot(workImage(FEATURED[i].id), { width: shotW })
          .then(t => boxes[i].setPrint(t))
          .catch(() => {})
      load(0)
      whenRevealed().then(async () => {
        for (let i = 1; i < N; i++) await load(i)
      })
      // the etched lettering once the faces are in (bound blank-ish now: no recompile
      // later); then each canvas is freed once it's on the GPU
      etchFonts().then(async () => {
        for (const b of boxes) {
          b.drawLabel(true)
          await nextFrame()
        }
        wallText?.draw(true)
      })
    },
    busy: () => settling || clock.busy,
    onEnter() {
      clock.reset()
      snap = true
    },
    update(local, frame, ctx) {
      const dt = frame.dt
      const uT = warp(local)
      const uC = clock.update(uT, dt)
      q = unwarp(uC)
      // still catching up with a fast scroll: a steady walk, the boxes burn lower
      const catching = Math.abs(uT - uC) > 0.35
      const outro = q >= OUTRO
      const w = where(q)
      const track = w.k + ease.inOutCubic(w.t) // 0 intro, 1..N boxes, N+1 board
      settling = false
      const drive = catching ? 0.6 : 1
      const wasSnap = snap
      const kB = snap ? 1 : 1 - Math.exp(-dt / 0.25)

      for (let i = 0; i < N; i++) {
        const k = i + 1
        const inT = TRAVEL[k - 1]
        const outT = TRAVEL[k]
        // dims up late in the walk that brings it in (box 1: lit from the start);
        // dims down early in the walk away
        const upAt = i === 0 ? -1 : lerp(inT[0], inT[1], 0.62)
        const downAt = lerp(outT[0], outT[1], 0.22)
        const on = q >= upAt && q < downAt
        const d = dims[i]
        if (snap) d.set(on ? 1 : 0)
        const v = d.update(on ? drive : 0, dt)
        if (d.busy) settling = true
        // once the camera is well on its way past a box, its print sinks almost
        // to black: it's the box the card sits over (landscape) — nothing reads through
        const bt = track - 1 > i + 0.35 ? 1 : 0
        behind[i] += (bt - behind[i]) * kB
        if (Math.abs(bt - behind[i]) > 0.002) settling = true
        boxes[i].setLevel(v, lerp(PRINT_DIM, PRINT_BEHIND, behind[i]))
      }
      const boardOn = q >= lerp(TRAVEL[N][0], TRAVEL[N][1], 0.6)
      if (snap) boardDim.set(boardOn ? 1 : 0)
      const bl = boardDim.update(boardOn ? drive : 0, dt)
      if (boardDim.busy) settling = true
      snap = false
      // real glass only within a station of the camera (≤ 3–4 panes in view);
      // the swap happens two stations away, dim and off to the side
      const cur = Math.max(0, track - 1)
      boxes.forEach((b, i) => b.setFar(Math.abs(i - cur) > 1.6))
      wallText?.setFar(N - cur > 1.6)
      if (wallText) {
        wallText.setLevel(0.14 + 0.86 * bl)
        // the name you're on (keyboard stop / scroll slot) is marked in the card's
        // list; its etched line lifts a touch (under the bloom threshold: a lift,
        // never a halo); not while catching up
        const inSlot = w.k === BOARD && !catching && q >= SLOT0 && q < SLOT0 + SLOT * REST.length
        const slot = inSlot ? Math.min(REST.length - 1, Math.floor((q - SLOT0) / SLOT)) : -1
        const lift = hover >= 0 ? hover : slot
        const kHl = 1 - Math.exp(-dt / 0.12)
        for (let j = 0; j < REST.length; j++) {
          const tgt = j === lift ? 1 : 0
          const h = (hl[j] += (tgt - hl[j]) * kHl)
          if (Math.abs(tgt - h) > 0.002) settling = true
          wallText.setRow(j, 0.62 + 0.14 * h)
        }
        if (slot !== restOn) {
          restOn = slot
          listItems.forEach((li, j) => li.classList.toggle('is-on', j === slot))
        }
      }

      // the room: black, the studio strips sweep the bevels as you walk (the
      // glass and steel carry their own envMap, so they're turned here too)
      const p = ctx.world.params
      const ci = clamp(Math.round(track - 1), 0, N - 1)
      const L = w.k === BOARD || track > N + 0.5 ? BOARD_LIGHT : LIGHTS[ci]
      p.fieldA = hex(L.a)
      p.fieldB = hex(L.b)
      // a breath of the box's light in the room (a big glow round a box reads as a
      // TV's ambient light); a little more at the chapter's ends for the colour-field cut
      p.field = 0.05 + 0.07 * (1 - smoothstep(0.03, 0.08, Math.min(local, 1 - local)))
      p.slits = 0
      p.env = 0.85
      p.envTurn = 0.45 + track * 0.32
      const tt = p.envTurn
      if (wasSnap || !Number.isFinite(turn)) turn = tt
      else {
        let dd = tt - turn
        dd = Math.atan2(Math.sin(dd), Math.cos(dd))
        turn += dd * (1 - Math.exp(-4 * dt))
      }
      if (S) for (const m of S.envMats) m.envMapRotation.y = turn
      p.key = 0.45
      p.fill = 0.05
      const post = ctx.post.params
      post.bloomStrength = 0.42
      post.bloomRadius = 0.32
      post.bloomThreshold = 1.0

      // ---- copy
      reveal(intro, 1 - smoothstep(INTRO_OUT + V(0.01), INTRO_OUT + V(0.07), q), 0)
      setRise(introTitle, q > RISE && q < INTRO_OUT + V(0.07))
      const si = clamp(track - 1, 0, N - 1)
      const idx = clamp(Math.round(si), 0, N - 1)
      reveal(card, holdVis(q, idx + 1), 0)
      const rv = holdVis(q, BOARD) * (outro ? 1 - smoothstep(OUTRO, OUTRO + V(0.12), q) : 1)
      reveal(rest, rv, 0)
      if (idx !== shown) {
        shown = idx
        const it = FEATURED[shown]
        meta.textContent = `${pad2(shown + 1)} / ${pad2(N)} · ${it.industry}`
        name.textContent = it.name
        blurb.textContent = it.blurb
        tags.replaceChildren(...it.tags.map(t => Object.assign(document.createElement('li'), { className: 'hud-tag', textContent: t })))
        visit.href = it.url
        visit.textContent = isPreview(it.url) ? 'Preview site ↗' : 'Visit site ↗'
        card.style.setProperty('--wk-a', hex(LIGHTS[shown].a))
        card.style.setProperty('--wk-b', hex(LIGHTS[shown].b))
      }

      // small on screen: a heavier etch (thin strokes survive); cap height in px
      wallText?.setBold(poses.boardPx * 0.122 < 12.5)
      // pointer targets over the etched names (last frame's camera: a frame of lag is invisible at rest)
      reveal(hitsBox, rv, 0)
      if (rv > 0.01 && wallText) {
        const cam = ctx.camera
        const Wd = frame.width
        const Hd = frame.height
        const z = wallText.faceZ
        wallText.rows.forEach((r, j) => {
          let x0 = Infinity
          let y0 = Infinity
          let x1 = -Infinity
          let y1 = -Infinity
          for (const [lx, ly] of [
            [r.x, r.y],
            [r.z, r.y],
            [r.x, r.w],
            [r.z, r.w],
          ]) {
            _v.set(BOARD_X + lx, BOARD_Y + ly, z).project(cam)
            const sx = (_v.x * 0.5 + 0.5) * Wd
            const sy = (-_v.y * 0.5 + 0.5) * Hd
            x0 = Math.min(x0, sx)
            x1 = Math.max(x1, sx)
            y0 = Math.min(y0, sy)
            y1 = Math.max(y1, sy)
          }
          if (!Number.isFinite(x0 + y0 + x1 + y1)) return
          const a = hits[j]
          a.style.transform = `translate3d(${x0.toFixed(1)}px, ${y0.toFixed(1)}px, 0)`
          a.style.width = `${(x1 - x0).toFixed(1)}px`
          a.style.height = `${(y1 - y0).toFixed(1)}px`
        })
      }
    },
    camera(local, frame, out: CameraPose) {
      buildPoses(frame)
      const at = Number.isFinite(q) ? q : local
      const w = where(at)
      if (w.t > 0) {
        holdPose(tmpA, w.k, 1)
        holdPose(tmpB, w.k + 1, 0)
        const e = ease.inOutCubic(w.t)
        // the eye goes to the next box first
        const et = ease.inOutCubic(clamp(w.t * 1.12))
        out.position.lerpVectors(tmpA.p, tmpB.p, e)
        out.target.lerpVectors(tmpA.t, tmpB.t, et)
        // step back off the wall mid-walk
        const bump = Math.sin(Math.PI * w.t)
        out.position.z += bump * (w.k === 0 ? 0.2 : 0.8)
        out.position.y += bump * 0.06
      } else {
        holdPose(tmpA, w.k, w.h)
        out.position.copy(tmpA.p)
        out.target.copy(tmpA.t)
      }
      if (at > OUTRO) {
        const o = ease.inOutCubic(clamp((at - OUTRO) / (1 - OUTRO)))
        out.position.lerp(poses.outro.p, o)
        out.target.lerp(poses.outro.t, o)
      }
      out.fov = w.k === 0 ? lerp(poses.introFov, poses.fov, w.t > 0 ? ease.inOutCubic(w.t) : 0) : poses.fov
      out.parallax = 0.2
    },
  }
}
