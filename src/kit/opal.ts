import * as THREE from 'three'
import { logoParts } from '../logo/logo'
import { frosted, pane, polished } from './glass'
import { neonFromStrokes, type NeonPart } from './neon'

/*
 * OPAL — coloured light seen through glass. The shared primitives:
 *
 *   DUSK                        the palette (sRGB hex): rose → lilac → violet →
 *                               periwinkle → ice, warm white; alarm red for the
 *                               shield only. No green, no saturated "sign" pink.
 *   lightCard(w, h, o)          an emissive gradient plane: the light SOURCE a
 *                               frosted pane diffuses (cheap, soft, any colours)
 *   lightTube(len, o)           a straight glass tube (a Flavin-style fixture),
 *                               built on the neon kit; setLevel()
 *   etchMap(w, h, draw)         a roughness map for a frosted pane: white =
 *                               frosted, black = POLISHED CLEAR. Draw the mark,
 *                               a line, a word into it: those parts turn into
 *                               crisp windows onto the light behind.
 *   etchMark(g, S, o)           draw the Hark mark into an etch canvas
 *   opalBox(o)                  the signature unit: a light card behind a thick
 *                               frosted slab (optionally etched), polished edges.
 *                               { group, card, glass, setLevel(v), setColors(a, b) }
 *   Dimmer                      time-based level (ease in/out, no flicker —
 *                               Opal lights never stutter)
 *
 * Rules:
 *   - glass needs light BEHIND it: every frosted pane gets a lightCard (or
 *     tubes) behind it, or the world's light field. Frost on black = a hole.
 *   - light is always diffused: never show a bare saturated tube to camera
 *     except as a thin line through a POLISHED (etched) window.
 *   - keep the light cards below ~2.5 HDR: frosted glass passes them soft;
 *     through an etched window they're crisp and may just touch bloom.
 *   - transmission renders the opaque scene once per frame for all glass:
 *     keep glass objects few and big. Phones get half-res glass (engine).
 *   - etch UVs: pane() caps use world-unit UVs; etchMap sets repeat/offset so
 *     the canvas maps exactly onto a w × h pane centred on the origin.
 *   - an etch only READS if what's behind has structure: polished glass in
 *     front of a uniform card looks like the frost around it. opalBox's
 *     `tubes` bank is what the polished mark shows crisp.
 *   - envMapIntensity only counts on a material with its OWN envMap: pass
 *     ctx.world.envMap (built in the World constructor) to anything glossy
 *     that must not take the full studio reflection (floors!).
 *   - polished lines over a PLAIN light card vanish (clear glass shows the
 *     same colour as the frost around it): put structure behind them — a
 *     tube bank, or the design itself drawn in light just behind the glass
 *     (process/studio.ts etchLight() is the worked example).
 *   - evenly spaced tube banks shimmer (wagon-wheel) under a sliding camera:
 *     space them unevenly (opalBox does).
 *   - a small floor's far edge reads as a horizon band: stoneFloor defaults
 *     to 240 × 160.
 *   - …and a material with its own envMap ignores world.params.envTurn (three
 *     uses material.envMapRotation then): set material.envMapRotation.y to
 *     the same angle yourself when you sweep highlights (hero does this).
 */

export const DUSK = {
  rose: '#ff7aa8',
  blush: '#ffb0c8',
  lilac: '#c7a8ff',
  violet: '#8f7bff',
  periwinkle: '#7f9cff',
  ice: '#cfe6ff',
  warm: '#fff1e4',
  amber: '#ffb36b',
  /** shield only */
  alarm: '#ff4d5e',
} as const
export type DuskColor = keyof typeof DUSK
const hex = (c: string) => (c in DUSK ? DUSK[c as DuskColor] : c)

// ------------------------------------------------------------------ light card

const CARD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const CARD_FRAG = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uLevel, uHdr, uAngle, uSoft;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    vec2 dir = vec2(sin(uAngle), cos(uAngle));
    float g = smoothstep(-0.5, 0.5, dot(p, dir));
    vec3 c = mix(uA, uB, g);
    // soft edges so the card never reads as a hard rectangle through frost
    vec2 e = smoothstep(vec2(0.0), vec2(uSoft), 0.5 - abs(p));
    float a = e.x * e.y;
    gl_FragColor = vec4(c * uHdr * uLevel * a, 1.0);
  }
`

export interface LightCard extends THREE.Mesh {
  setLevel(v: number): void
  setColors(a: string, b?: string): void
  material: THREE.ShaderMaterial
}

/** An emissive gradient plane (A → B along angle). Put it BEHIND frosted glass. */
export function lightCard(w: number, h: number, o: { a?: string; b?: string; angle?: number; hdr?: number; soft?: number } = {}): LightCard {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Color(hex(o.a ?? 'rose')) },
      uB: { value: new THREE.Color(hex(o.b ?? 'violet')) },
      uLevel: { value: 1 },
      uHdr: { value: o.hdr ?? 1.8 },
      uAngle: { value: o.angle ?? 0 },
      uSoft: { value: o.soft ?? 0.12 },
    },
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat) as unknown as LightCard
  mesh.setLevel = (v: number) => {
    mat.uniforms.uLevel.value = Math.max(0, Math.min(1, v))
  }
  mesh.setColors = (a: string, b?: string) => {
    ;(mat.uniforms.uA.value as THREE.Color).set(hex(a))
    ;(mat.uniforms.uB.value as THREE.Color).set(hex(b ?? a))
  }
  return mesh
}

// ------------------------------------------------------------------ tubes

/**
 * A straight lit glass tube along +y (a gallery fixture, not a sign): thin,
 * no blockout, no electrodes. Levels through setLevel(). Default HDR is
 * gentle — it's meant to be seen through glass or at the edge of frame.
 */
export function lightTube(length = 2, o: { color?: string; radius?: number; hdr?: number } = {}): NeonPart {
  return neonFromStrokes([{ pts: [new THREE.Vector3(0, -length / 2, 0), new THREE.Vector3(0, length / 2, 0)] }], {
    color: hex(o.color ?? 'warm'),
    radius: o.radius ?? 0.018,
    hdr: o.hdr ?? 2.4,
    blockout: false,
    electrodes: false,
    smooth: false,
    caps: false,
  })
}

// ------------------------------------------------------------------ etching

/**
 * A roughness map for a frosted pane w × h (world units) centred on the
 * origin. `draw(g, S, toPx)` paints BLACK where the glass should be polished
 * clear (the canvas starts white = frosted). toPx(x, y) maps world units on
 * the pane to canvas pixels. res = pixels along the longer side.
 */
export function etchMap(w: number, h: number, draw: (g: CanvasRenderingContext2D, W: number, H: number, toPx: (x: number, y: number) => [number, number], scale: number) => void, res = 1024) {
  const W = w >= h ? res : Math.max(16, Math.round((res * w) / h))
  const H = w >= h ? Math.max(16, Math.round((res * h) / w)) : res
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, W, H)
  const sx = W / w
  const toPx = (x: number, y: number): [number, number] => [(x + w / 2) * sx, (h / 2 - y) * sx]
  g.fillStyle = '#000'
  g.strokeStyle = '#000'
  draw(g, W, H, toPx, sx)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  // pane() caps carry world-unit UVs (x, y): map them onto the canvas
  tex.repeat.set(1 / w, 1 / h)
  tex.offset.set(0.5, 0.5)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

/** Paint the Hark mark (filled, black = polished) into an etch canvas: centre (cx, cy), height in world units. */
export function etchMark(g: CanvasRenderingContext2D, toPx: (x: number, y: number) => [number, number], o: { cx?: number; cy?: number; height?: number; line?: number } = {}) {
  const { cx = 0, cy = 0, height = 1 } = o
  const parts = logoParts()
  const shapes = [...parts.loopA, ...parts.loopB, ...parts.diamond]
  g.beginPath()
  for (const s of shapes) {
    const pts = s.getPoints(64)
    pts.forEach((p, i) => {
      const [x, y] = toPx(cx + p.x * height, cy + p.y * height)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    g.closePath()
    for (const hole of s.holes) {
      const hp = hole.getPoints(32)
      hp.forEach((p, i) => {
        const [x, y] = toPx(cx + p.x * height, cy + p.y * height)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      })
      g.closePath()
    }
  }
  if (o.line) {
    g.lineWidth = o.line
    g.stroke()
  } else g.fill('evenodd')
}

// ------------------------------------------------------------------ the opal box

export interface OpalBoxOptions {
  w: number
  h: number
  /** slab thickness (default 0.08) */
  depth?: number
  /** gap between the card and the glass (default 0.25): more gap = softer glow */
  gap?: number
  /** light card colours + gradient angle + HDR */
  a?: string
  b?: string
  angle?: number
  hdr?: number
  /** frost roughness 0.3 (satin) … 0.65 (heavy sandblast); default 0.55 */
  frost?: number
  /**
   * a bank of thin vertical tubes between the card and the glass, coloured
   * a → b across the bank. Frost blurs them into soft bands; an ETCHED
   * (polished) window shows them crisp — this is what makes an etch read.
   * default 0 (card only). ~5–9 reads well.
   */
  tubes?: number
  /** tube HDR (default 2.4) */
  tubeHdr?: number
  /** etch: a roughness map from etchMap() (black = polished clear) */
  etch?: THREE.Texture
  radius?: number
}

/**
 * THE SIGNATURE UNIT: a gradient light card behind a thick frosted slab.
 * From the front it's a luminous opal panel; anything etched into it is a
 * crisp window onto the colour behind. setLevel dims the light (the glass
 * stays), setColors re-gels it.
 */
export function opalBox(o: OpalBoxOptions) {
  const group = new THREE.Group()
  const depth = o.depth ?? 0.08
  const gap = o.gap ?? 0.25
  const card = lightCard(o.w * 0.98, o.h * 0.98, { a: o.a, b: o.b, angle: o.angle, hdr: o.hdr })
  card.position.z = -depth / 2 - gap
  group.add(card)
  // a black backing so nothing behind the card shows through the glass
  const back = new THREE.Mesh(new THREE.PlaneGeometry(o.w * 1.02, o.h * 1.02), new THREE.MeshBasicMaterial({ color: 0x000000 }))
  back.position.z = card.position.z - 0.01
  group.add(back)
  const bank: NeonPart[] = []
  if (o.tubes && o.tubes > 0) {
    const n = Math.round(o.tubes)
    const ca = new THREE.Color(hex(o.a ?? 'rose'))
    const cb = new THREE.Color(hex(o.b ?? 'violet'))
    const span = o.w * 0.84
    // UNEVEN, symmetric spacing: an evenly spaced bank strobes like a wagon
    // wheel when the camera slides past at ~half its pitch per frame (process
    // measured 3 flashes/s on phones from that alone)
    const pos = (k: number) => 0.5 + 0.5 * Math.sign(k - 0.5) * Math.pow(Math.abs(k - 0.5) * 2, 0.82)
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0.5 : pos(i / (n - 1))
      const col = '#' + ca.clone().lerp(cb, k).getHexString()
      const t = lightTube(o.h * 0.86, { color: col, hdr: o.tubeHdr ?? 2.4, radius: Math.min(0.022, o.w * 0.006) })
      t.group.position.set(-span / 2 + span * k, 0, -depth / 2 - gap * 0.45)
      group.add(t.group)
      bank.push(t)
    }
  }
  const mat = frosted({ frost: o.frost ?? 0.55, thickness: depth * 2 }).clone()
  if (o.etch) {
    mat.roughnessMap = o.etch
    mat.needsUpdate = true
  }
  const glass = pane(o.w, o.h, { depth, radius: o.radius ?? Math.min(o.w, o.h) * 0.03, material: mat })
  group.add(glass)
  return {
    group,
    card,
    glass,
    tubes: bank,
    material: mat,
    setLevel(v: number) {
      card.setLevel(v)
      for (const t of bank) t.setLevel(v)
    },
    setColors(a: string, b?: string) {
      card.setColors(a, b)
      const ca = new THREE.Color(hex(a))
      const cb = new THREE.Color(hex(b ?? a))
      bank.forEach((t, i) => t.setColor('#' + ca.clone().lerp(cb, bank.length === 1 ? 0.5 : i / (bank.length - 1)).getHexString()))
    },
  }
}

// ------------------------------------------------------------------ floor

/**
 * Polished black stone: a dark mirror-ish floor that catches soft coloured
 * reflections of the glass without going grey under the studio env.
 */
export function stoneFloor(w = 240, d = 160, envMap: THREE.Texture | null = null) {
  // pass ctx.world.envMap: envMapIntensity is IGNORED on materials that only
  // see scene.environment (then scene.environmentIntensity rules), and a
  // glossy floor at grazing angles reflects the studio strips grey
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ color: 0x030304, roughness: 0.3, metalness: 0, envMap, envMapIntensity: 0.12 }),
  )
  m.rotation.x = -Math.PI / 2
  return m
}

export { polished }

// ------------------------------------------------------------------ dimmer

/**
 * A time-based level that eases toward its target (smoothstep in time, no
 * flicker). Opal lights come up like a theatre dimmer: ~0.6 s up, ~0.4 s down.
 * Settles fast enough for screenshots; calm modes use the same curve.
 */
export class Dimmer {
  level = 0
  private from = 0
  private to = 0
  private t = 1
  constructor(private up = 0.6, private down = 0.4) {}
  update(target: number | boolean, dt: number): number {
    const tgt = typeof target === 'boolean' ? (target ? 1 : 0) : Math.max(0, Math.min(1, target))
    if (Math.abs(tgt - this.to) > 1e-4) {
      this.from = this.level
      this.to = tgt
      this.t = 0
    }
    const dur = this.to > this.from ? this.up : this.down
    this.t = Math.min(1, this.t + dt / Math.max(0.01, dur))
    const k = this.t * this.t * (3 - 2 * this.t)
    this.level = this.from + (this.to - this.from) * k
    return this.level
  }
  set(v: number) {
    this.level = this.from = this.to = v
    this.t = 1
  }
  get busy() {
    return this.t < 1
  }
}
