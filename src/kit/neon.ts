import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { logoOutlines, logoParts } from '../logo/logo'
import { textStrokes, type Stroke, type TextOptions } from './type'

/*
 * NEON — the shared primitive every chapter speaks in.
 *
 *   TUBE / TUBE_CHART        the house tube colours (display sRGB; no green)
 *   neonFromStrokes(...)     glass tubes bent along strokes, lit by one level:
 *                            HDR core (the bloom pass is the glow), painted
 *                            black "blockout" jumpers behind the glass
 *                            between strokes, electrode returns at the ends
 *   neonText(...)            textStrokes() + neonFromStrokes() in one call
 *   markStrokes(...)         the Hark mark's outlines as closed strokes, per part
 *   Striker                  time-based level driver: a tube strikes on with
 *                            at most two stutters, inside a SITE-WIDE flash
 *                            budget (WCAG 2.3.1), smooth under calm modes
 *   neonSpill(...)           the tube's light on the wall/backer behind it:
 *                            a blurred copy of the strokes on an additive plane
 *
 * A NeonPart is one independently-lit tube (a word, a loop of the mark, a
 * frame). Drive it every frame:  part.setLevel(striker.update(on, frame))
 * and optionally part.setDraw(0..1) to light it progressively along its
 * length (the sign "writing itself"; 1 = whole tube).
 *
 * Rules (from the look lab):
 *   - tubes are thin (radius ~1/28–1/40 of the letter height) — bloom turns
 *     fat emissives into white balls
 *   - coloured tubes HDR ~3.5–5; WHITE tubes cross the bloom threshold on all
 *     three channels, so they glow ~3x harder: HDR ~2.2–3 for white
 *   - dense parallel outlines (the mark's inner + outer contours) merge into
 *     one glow: keep them small on screen, or lower HDR
 *   - never toggle a tube by visibility for a flicker: use levels through a
 *     Striker so the site-wide flash budget holds
 *   - a long coloured frame round a screenshot (or any flat content) veils it
 *     through bloom's wide mips at any strength: raise the chapter's
 *     bloomThreshold (~1.2) and set HDR per colour so only the tube CORE
 *     crosses it (work/index.ts hdrFor() is the worked example)
 *   - small lettering: caps: false (sphere caps cost ~96 tris per stroke end
 *     and sparkle as dots through bloom on phones)
 *   - a sign's RectAreaLight IN FRONT of a glossy backer blows it out into a
 *     white lightbox: put wall lights between the backer and the wall (a halo
 *     round its edge), and floor lights low, facing down
 */

/** House tube colours (sRGB hex). Pink leads; argon blue is the counterpoint. */
export const TUBE = {
  /** neon in rose phosphor: the house accent */
  pink: '#ff2e97',
  /** argon + blue phosphor */
  blue: '#2cb4ff',
  /** pure neon in clear glass: the true orange-red */
  red: '#ff4220',
  /** argon in purple glass / UV */
  violet: '#9b5cff',
  /** "snow white" phosphor (the Hark mark is always this) */
  white: '#fff3ea',
  /** neon in gold glass */
  amber: '#ffa126',
  ice: '#a8e8ff',
  magenta: '#ff38e1',
  coral: '#ff6f5e',
  lavender: '#c7a4ff',
  gold: '#ffd35c',
  turquoise: '#3fe0ff',
} as const
export type TubeColor = keyof typeof TUBE

/** Eleven tube colours in chart order (the services rack: one per service). */
export const TUBE_CHART: TubeColor[] = ['red', 'coral', 'amber', 'gold', 'pink', 'magenta', 'violet', 'lavender', 'blue', 'turquoise', 'white']

const tmpC = new THREE.Color()

// ------------------------------------------------------------------ tubes

export interface NeonOptions {
  /** tube colour: a TUBE key or any hex */
  color?: TubeColor | string
  /** glass radius in world units (default 0.02) */
  radius?: number
  /** HDR multiplier at full level (default 4) */
  hdr?: number
  /** join consecutive strokes with painted-black jumpers behind the glass (default true) */
  blockout?: boolean
  /** how far behind the glass the jumpers run (default 6 radii) */
  depth?: number
  /** electrode returns + housings at the tube's two ends (default true) */
  electrodes?: boolean
  /** radial segments (default 8; phones 6) */
  radial?: number
  /** Catmull-Rom smoothing of the strokes (default true; false keeps hard corners) */
  smooth?: boolean
  /** round glass caps on open stroke ends (default true; ~96 tris each — skip for small lettering) */
  caps?: boolean
}

const TUBE_VERT = /* glsl */ `
  attribute float aArc;
  varying float vArc;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vArc = aArc;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`
const TUBE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uOff;
  uniform float uHdr, uLevel, uDraw, uHide;
  varying float vArc;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
    // light runs along the tube up to uDraw (1 = the whole tube)
    float drawn = 1.0 - smoothstep(uDraw - 0.015, uDraw + 0.0001, vArc);
    // hidden-until-drawn: the tube only exists as far as it's been drawn
    if (uHide > 0.5 && drawn < 0.02) discard;
    float lit = clamp(uLevel, 0.0, 1.0) * drawn;
    // the gas column: saturated at the glass edge, hotter (whiter) through the middle
    vec3 hot = uColor * uHdr;
    float m = max(hot.r, max(hot.g, hot.b));
    hot = mix(hot, vec3(m) * 0.85, facing * facing * 0.28);
    hot *= 0.72 + 0.28 * facing;
    // unlit: coated glass with a cool sheen at the silhouette
    float rim = 1.0 - facing;
    vec3 off = uOff + vec3(0.09, 0.085, 0.1) * rim * rim * rim;
    gl_FragColor = vec4(mix(off, hot, lit), 1.0);
  }
`

/** One independently lit tube (possibly many strokes), with its jumpers and electrodes. */
export class NeonPart {
  group = new THREE.Group()
  tube: THREE.Mesh
  material: THREE.ShaderMaterial
  /** the black jumpers / electrode returns (may be null) */
  blockout: THREE.Mesh | null = null
  level = 0
  /** total lit length in world units */
  length = 0
  private spills: { setLevel(v: number): void }[] = []

  constructor(geo: THREE.BufferGeometry, color: string, hdr: number, block: THREE.BufferGeometry | null, blockMat: THREE.Material) {
    tmpC.set(color)
    const off = tmpC.clone().multiplyScalar(0.035).addScalar(0.012)
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: tmpC.clone() },
        uOff: { value: off },
        uHdr: { value: hdr },
        uLevel: { value: 0 },
        uDraw: { value: 1.02 },
        uHide: { value: 0 },
      },
      vertexShader: TUBE_VERT,
      fragmentShader: TUBE_FRAG,
    })
    this.tube = new THREE.Mesh(geo, this.material)
    this.group.add(this.tube)
    if (block) {
      this.blockout = new THREE.Mesh(block, blockMat)
      this.group.add(this.blockout)
    }
  }

  /** 0..1 — call every frame you drive it (cheap; no-op when unchanged). */
  setLevel(v: number) {
    const x = Math.max(0, Math.min(1, v))
    if (x === this.level) return
    this.level = x
    this.material.uniforms.uLevel.value = x
    for (const s of this.spills) s.setLevel(x)
  }

  /** 0..1 how far along its length the tube is lit (the sign writing itself). */
  setDraw(v: number) {
    this.material.uniforms.uDraw.value = v >= 1 ? 1.02 : Math.max(0, v)
  }

  /** true: the part beyond setDraw() doesn't exist (a tube being bent/drawn), instead of showing as unlit glass */
  setHideUndrawn(on: boolean) {
    this.material.uniforms.uHide.value = on ? 1 : 0
  }

  setColor(color: TubeColor | string) {
    const c = color in TUBE ? TUBE[color as TubeColor] : color
    ;(this.material.uniforms.uColor.value as THREE.Color).set(c)
    ;(this.material.uniforms.uOff.value as THREE.Color).set(c).multiplyScalar(0.035).addScalar(0.012)
  }

  setHdr(v: number) {
    this.material.uniforms.uHdr.value = v
  }

  /** let a spill (or anything with setLevel) follow this tube's level */
  follow(s: { setLevel(v: number): void }) {
    this.spills.push(s)
    s.setLevel(this.level)
    return s
  }
}

let blockMat: THREE.MeshStandardMaterial | null = null
/** shared black blockout paint / electrode housing material */
export function blockoutMaterial() {
  return (blockMat ??= new THREE.MeshStandardMaterial({ color: 0x070608, roughness: 0.32, metalness: 0.0 }))
}

function curveFor(s: Stroke, smooth: boolean): THREE.Curve<THREE.Vector3> {
  const pts = s.pts
  if (!smooth || pts.length < 3) {
    const path = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]))
    if (s.closed && pts.length > 2) path.add(new THREE.LineCurve3(pts[pts.length - 1], pts[0]))
    return path
  }
  return new THREE.CatmullRomCurve3(pts, !!s.closed, 'centripetal', 0.5)
}

function tubeGeometry(curve: THREE.Curve<THREE.Vector3>, radius: number, radial: number, closed: boolean, arc0 = 0, arc1 = 1) {
  const len = curve.getLength()
  const segs = Math.max(4, Math.min(1400, Math.round(len / Math.max(radius * 1.6, 0.004))))
  const g = new THREE.TubeGeometry(curve, segs, radius, radial, closed)
  const n = g.attributes.position.count
  const arc = new Float32Array(n)
  for (let i = 0; i <= segs; i++) {
    const a = arc0 + ((arc1 - arc0) * i) / segs
    for (let j = 0; j <= radial; j++) arc[i * (radial + 1) + j] = a
  }
  g.setAttribute('aArc', new THREE.BufferAttribute(arc, 1))
  // keep the attribute set identical for merging (uv unused)
  g.deleteAttribute('uv')
  return { g, len }
}

/** a round glass end-cap (so an open tube doesn't show a hole) */
function capGeometry(p: THREE.Vector3, radius: number, arc: number) {
  const g = new THREE.SphereGeometry(radius, 8, 6)
  g.translate(p.x, p.y, p.z)
  g.deleteAttribute('uv')
  g.setAttribute('aArc', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(arc), 1))
  return g
}

/**
 * Glass tubes along strokes, as ONE lit part. Strokes are joined in order by
 * black jumpers that duck behind the glass (like a real sign bent from one
 * length of tube). aArc runs 0..1 along the lit length, for setDraw().
 */
export function neonFromStrokes(strokes: Stroke[], opts: NeonOptions = {}): NeonPart {
  const { color = 'pink', radius = 0.02, hdr = 4, blockout = true, electrodes = true, radial = 8, smooth = true, caps = true } = opts
  const depth = opts.depth ?? radius * 6
  const hex = color in TUBE ? TUBE[color as TubeColor] : color
  const curves = strokes.filter(s => s.pts.length >= 2).map(s => ({ s, c: curveFor(s, smooth) }))
  const lens = curves.map(({ c }) => c.getLength())
  const total = lens.reduce((a, b) => a + b, 0) || 1
  const geos: THREE.BufferGeometry[] = []
  let acc = 0
  curves.forEach(({ s, c }, i) => {
    const a0 = acc / total
    acc += lens[i]
    const a1 = acc / total
    geos.push(tubeGeometry(c, radius, radial, !!s.closed, a0, a1).g)
    if (!s.closed && caps) {
      geos.push(capGeometry(c.getPoint(0), radius, a0))
      geos.push(capGeometry(c.getPoint(1), radius, a1))
    }
  })
  const blocks: THREE.BufferGeometry[] = []
  const back = new THREE.Vector3(0, 0, -depth)
  const jr = radius * 0.95
  if (blockout) {
    for (let i = 0; i < curves.length - 1; i++) {
      const a = curves[i].c.getPoint(curves[i].s.closed ? 0 : 1)
      const b = curves[i + 1].c.getPoint(0)
      const path = new THREE.CurvePath<THREE.Vector3>()
      const a2 = a.clone().add(back)
      const b2 = b.clone().add(back)
      path.add(new THREE.LineCurve3(a, a2))
      if (a2.distanceTo(b2) > 1e-4) path.add(new THREE.LineCurve3(a2, b2))
      path.add(new THREE.LineCurve3(b2, b))
      const g = new THREE.TubeGeometry(path, 12, jr, Math.max(5, radial - 2), false)
      g.deleteAttribute('uv')
      blocks.push(g)
    }
  }
  if (electrodes && curves.length) {
    const ends = [curves[0].c.getPoint(0), curves[curves.length - 1].c.getPoint(curves[curves.length - 1].s.closed ? 0 : 1)]
    for (const e of ends) {
      const g = new THREE.CylinderGeometry(jr, jr, depth, Math.max(5, radial - 2))
      g.rotateX(Math.PI / 2)
      g.translate(e.x, e.y, e.z - depth / 2)
      g.deleteAttribute('uv')
      blocks.push(g)
      const h = new THREE.CylinderGeometry(radius * 2.2, radius * 2.2, radius * 7, 10)
      h.rotateX(Math.PI / 2)
      h.translate(e.x, e.y, e.z - depth - radius * 3.5)
      h.deleteAttribute('uv')
      blocks.push(h)
    }
  }
  const geo = geos.length ? mergeGeometries(geos, false)! : new THREE.BufferGeometry()
  geos.forEach(g => g.dispose())
  let block: THREE.BufferGeometry | null = null
  if (blocks.length) {
    block = mergeGeometries(blocks, false)
    blocks.forEach(g => g.dispose())
  }
  const part = new NeonPart(geo, hex, hdr, block, blockoutMaterial())
  part.length = total
  return part
}

/**
 * Tube lettering in one call (see kit/type.ts for the text options). Radius
 * defaults to 1/28 of the cap height.
 *   const { part, text } = neonText('Open late', { font: 'script', size: 0.6 }, { color: 'pink' })
 */
export function neonText(str: string, text: TextOptions = {}, neon: NeonOptions = {}) {
  const t = textStrokes(str, text)
  const part = neonFromStrokes(t.strokes, { radius: (text.size ?? 1) / 28, ...neon })
  return { part, text: t }
}
export { textStrokes }

// ------------------------------------------------------------------ the mark

/**
 * The Hark mark's outlines as closed strokes, per part (loopA, loopB,
 * diamond), scaled to `height` world units and centered. Outline neon, the
 * way a sign shop bends a logo. The mark is always TUBE.white.
 */
export function markStrokes(height = 1, z = 0) {
  const parts = logoParts()
  const toStrokes = (shapes: THREE.Shape[]) =>
    logoOutlines(shapes, 140).map(line => {
      const pts = line.map(p => new THREE.Vector3(p.x * height, p.y * height, z))
      if (pts.length > 2 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop()
      return { pts, closed: true } as Stroke
    })
  return { loopA: toStrokes(parts.loopA), loopB: toStrokes(parts.loopB), diamond: toStrokes(parts.diamond) }
}

// ------------------------------------------------------------------ strike driver

/**
 * Site-wide flash budget. Every visible stutter (a tube dipping dark and
 * coming back) is a flash; across the whole site we allow at most 2 in any
 * rolling second (WCAG 2.3.1 allows 3). A strike that can't get budget just
 * ramps on cleanly.
 */
const flashLog: number[] = []
const FLASH_WINDOW = 1.0
const FLASH_MAX = 2
function takeFlashes(n: number, now: number) {
  // prewarm runs chapter updates before the reveal: those strikes are invisible,
  // don't let them spend the budget (ramp instead)
  if (typeof document !== 'undefined' && document.documentElement.dataset.ready !== '1') return false
  while (flashLog.length && now - flashLog[0] > FLASH_WINDOW) flashLog.shift()
  if (flashLog.length + n > FLASH_MAX) return false
  for (let i = 0; i < n; i++) flashLog.push(now + i * 0.12)
  return true
}

/** keyframes of a strike: [time s, level] — the gas catching, dipping, holding */
const STRIKES: [number, number][][] = [
  // one stutter
  [
    [0, 0],
    [0.04, 0.85],
    [0.1, 0.12],
    [0.2, 0.7],
    [0.3, 1],
  ],
  // two stutters
  [
    [0, 0],
    [0.03, 0.7],
    [0.08, 0.05],
    [0.18, 0.95],
    [0.24, 0.2],
    [0.36, 0.85],
    [0.46, 1],
  ],
]

export interface StrikerOptions {
  /** stutters when striking on: 0, 1 or 2 (default 1) */
  stutters?: 0 | 1 | 2
  /** seconds to ramp when no stutter is allowed (default 0.22) */
  ramp?: number
  /** seconds to go dark (default 0.12 — neon cuts out fast) */
  off?: number
  /** how deep a stutter dips, 0..1 (1 = fully dark; fluorescent room lights use ~0.5) */
  depth?: number
}

/**
 * Follows an on/off target with time. Screenshots that jump straight to a
 * local value settle within ~0.5 s. Calm (reduced motion, Motion off, a fast
 * scroll) never stutters: it ramps.
 */
export class Striker {
  level = 0
  private t = -1
  private seq: [number, number][] | null = null
  private on = false
  constructor(private opts: StrikerOptions = {}) {}

  /**
   * target: boolean or 0..1 (a partial level is followed smoothly). calm: no stutter.
   * Returns the level to feed NeonPart.setLevel().
   */
  update(target: boolean | number, dt: number, calm = false): number {
    const tgt = typeof target === 'number' ? Math.max(0, Math.min(1, target)) : target ? 1 : 0
    const { stutters = 1, ramp = 0.22, off = 0.12, depth = 1 } = this.opts
    const wantOn = tgt > 0.5
    if (wantOn && !this.on && this.level < 0.3) {
      // a fresh strike
      const now = performance.now() / 1000
      if (!calm && stutters > 0 && takeFlashes(stutters, now)) {
        this.seq = STRIKES[stutters - 1]
        this.t = 0
      } else this.seq = null
    }
    this.on = wantOn
    if (this.seq) {
      this.t += dt
      const s = this.seq
      const end = s[s.length - 1][0]
      if (!wantOn || this.t >= end) this.seq = null
      else {
        let i = 0
        while (i < s.length - 2 && this.t > s[i + 1][0]) i++
        const [t0, v0] = s[i]
        const [t1, v1] = s[i + 1]
        const k = Math.max(0, Math.min(1, (this.t - t0) / Math.max(1e-3, t1 - t0)))
        const v = v0 + (v1 - v0) * k
        // shallow dips for room lights (depth < 1)
        this.level = (1 - depth) * Math.min(1, this.t / 0.05) + depth * v
        return (this.level = Math.min(this.level, 1) * tgt)
      }
    }
    const rate = tgt > this.level ? 1 / Math.max(0.01, ramp) : 1 / Math.max(0.01, off)
    const step = rate * dt
    this.level = this.level < tgt ? Math.min(tgt, this.level + step) : Math.max(tgt, this.level - step)
    return this.level
  }

  /** jump straight to a level (e.g. on a nav jump) */
  set(v: number) {
    this.level = v
    this.on = v > 0.5
    this.seq = null
  }
}

// ------------------------------------------------------------------ spill

export interface SpillOptions {
  color?: TubeColor | string
  /** plane size in world units; strokes are drawn in the same XY space centered on (cx, cy) */
  width: number
  height: number
  cx?: number
  cy?: number
  /** canvas resolution along the longer side (default 256) */
  res?: number
  /** glow radius in world units (default 6% of the plane's longer side) */
  blur?: number
  /** additive strength at full level (default 0.9) */
  strength?: number
}

/**
 * The tube's light thrown on the surface behind it: the strokes drawn soft
 * into a small canvas (shadowBlur, not ctx.filter: Safari < 18), on an
 * additive plane. Put it ~1 mm in front of the backer/wall and let the part
 * drive it: part.follow(spill).
 */
export function neonSpill(strokes: Stroke[], o: SpillOptions) {
  const { width, height, cx = 0, cy = 0, res = 256, strength = 0.9 } = o
  const hex = o.color ? (o.color in TUBE ? TUBE[o.color as TubeColor] : o.color) : TUBE.pink
  const aspect = width / height
  const W = aspect >= 1 ? res : Math.max(16, Math.round(res * aspect))
  const H = aspect >= 1 ? Math.max(16, Math.round(res / aspect)) : res
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')!
  const sx = W / width
  const blurPx = (o.blur ?? Math.max(width, height) * 0.06) * sx
  const X = (x: number) => (x - cx + width / 2) * sx
  const Y = (y: number) => (height / 2 - (y - cy)) * sx
  const trace = () => {
    g.beginPath()
    for (const s of strokes) {
      s.pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y))))
      if (s.closed) g.closePath()
    }
  }
  g.lineCap = 'round'
  g.lineJoin = 'round'
  // wide soft halo, then a tighter one: shadowBlur draws the blur of the stroke
  // itself offset off-canvas, so only the shadow lands
  const passes: [number, number, number][] = [
    [blurPx * 1.6, blurPx * 0.9, 0.55],
    [blurPx * 0.6, blurPx * 0.35, 0.7],
  ]
  for (const [blur, lw, a] of passes) {
    g.save()
    g.shadowColor = `rgba(255,255,255,${a})`
    g.shadowBlur = blur
    g.shadowOffsetX = W * 4
    g.translate(-W * 4, 0)
    g.lineWidth = Math.max(1, lw)
    g.strokeStyle = '#fff'
    trace()
    g.stroke()
    g.restore()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(hex).multiplyScalar(strength),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    opacity: 0,
    toneMapped: false,
    // an additive plane that fogs adds the fog colour over its whole rectangle
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat)
  mesh.position.set(cx, cy, 0)
  mesh.renderOrder = 1
  return Object.assign(mesh, {
    setLevel(v: number) {
      mat.opacity = v
      mesh.visible = v > 0.003
    },
  })
}
