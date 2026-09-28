import * as THREE from 'three'
import { DUSK } from '../../kit/opal'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { frosted, pane, polished, smoothExtrude } from '../../kit/glass'
import { placeholderTexture } from '../../kit/images'

/*
 * LIGHT BOXES — the set pieces of the work chapter (see index.ts for the story).
 *
 *   lightBox()   a museum light box in glass: a thick FROSTED slab held off the
 *                wall on four polished steel standoffs, a window cut clean
 *                through it (its polished inner walls catch a hairline of
 *                light), the print on a black mount board just behind the
 *                window, and inside the shallow black case two tubes of the
 *                box's light along its long edges — two soft bars through the
 *                frost, dimmer glass between them, the polished outer bevels
 *                lit by them and by the studio. A faint spill on the wall, a
 *                pool on the floor, and a small glass wall label under it with
 *                the name and industry POLISHED into it (bars of light behind
 *                each line: the frost glows soft, the letters show the bar crisp).
 *   board()      the long frosted wall-text panel at the end of the wall: the
 *                nine other sites polished into it, one bar of light per name
 *                (decoration: the chapter's card lists them as real links).
 *
 * Glass buffer rules (three's transmission pass renders the OPAQUE list once):
 *   - prints, mounts, standoffs and cases are hidden from it (frameOnly): the
 *     frost round a print must see the light BEHIND it, not what's in front
 *   - the tubes' light cards are drawn ONLY into it (glassOnly): never seen
 *     bare, only through glass
 *   - halos and pools are opaque-list (additive), so the frost picks them up
 *   - one shared material set for the six box faces; the labels and the
 *     board each carry their own roughness (etch) map
 */

export type Light = { a: string; b: string; angle: number }
type IsFrame = (rt: THREE.WebGLRenderTarget | null) => boolean

export const hex = (c: string) => (c in DUSK ? DUSK[c as keyof typeof DUSK] : c)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// ---- dimensions (world units ≈ metres; wall face z = 0, floor y = 0)
export const PRINT_W = 2.2
export const PRINT_H = 1.375 // 16:10, the screenshots' aspect
const MOUNT = 0.045 // the black mount board seen round the print, inside the window
/** the window cut through the glass (the print sits behind it) */
const WIN_W = PRINT_W + 2 * MOUNT
const WIN_H = PRINT_H + 2 * MOUNT
const BAND = 0.2 // frosted glass round the window
const BAND_B = 0.24 // a little more below (a gallery mat is bottom-weighted)
const GD = 0.08 // glass slab depth, cap to cap (+ the bevels on both faces)
const GB = 0.04
/** the bevel's reach past the slab's outline (kit smoothExtrude: 0.85 × bevel) */
const GBS = GB * 0.85
/** the glass's outer size, bevels included */
export const GW = WIN_W + 2 * BAND + 2 * GBS
export const GH = WIN_H + BAND + BAND_B + 2 * GBS
/** the window's centre sits above the glass's centre (bottom-weighted band) */
const WIN_Y = (BAND_B - BAND) / 2
const TRAY_Z0 = 0.02
const TRAY_D = 0.13
const GLASS_Z = TRAY_Z0 + TRAY_D + GD / 2 + GB + 0.03
/** front face of a box's glass */
export const FACE_Z = GLASS_Z + GD / 2 + GB
/** back face of a box's glass (the print is mounted just behind it) */
const BACK_Z = GLASS_Z - GD / 2 - GB
/** the wall label */
export const LABEL_W = 1.12
export const LABEL_H = 0.32
export const LABEL_GAP = 0.13
const LABEL_D = 0.026
const LABEL_B = 0.014
const LABEL_TRAY = 0.05
const LABEL_Z = TRAY_Z0 + LABEL_TRAY + LABEL_D / 2 + LABEL_B + 0.003
export const LABEL_FACE_Z = LABEL_Z + LABEL_D / 2 + LABEL_B
/** label centre, relative to its box's centre (right-aligned under the glass) */
export const LABEL_X = GW / 2 - LABEL_W / 2
export const LABEL_Y = -GH / 2 - LABEL_GAP - LABEL_H / 2

/** screenshots stay under the bloom threshold */
const PRINT_MAX = 0.85
/** a dimmed box ahead keeps its print faintly readable and a breath of glow… */
export const PRINT_DIM = 0.3
/** …one the camera has passed (it sits behind the card) all but goes dark */
export const PRINT_BEHIND = 0.025
const CARD_DIM = 0.05
/** the light inside a box: its tubes' luminance at full light (linear) */
const TUBE_LUM = 0.28

export const FONT_SANS = "'Hanken Grotesk Variable', 'Hanken Grotesk', system-ui, sans-serif"
export const FONT_MONO = "'Red Hat Mono Variable', 'Red Hat Mono', ui-monospace, monospace"

let fontsP: Promise<void> | null = null
/** The etch faces, loaded (or 2.5 s, whichever first). */
export function etchFonts(): Promise<void> {
  if (fontsP) return fontsP
  const f = typeof document !== 'undefined' ? document.fonts : undefined
  if (!f || typeof f.load !== 'function') return (fontsP = Promise.resolve())
  fontsP = Promise.race([
    Promise.all([f.load(`500 64px ${FONT_SANS}`), f.load(`500 32px ${FONT_MONO}`)]).then(() => undefined),
    new Promise<void>(r => window.setTimeout(r, 2500)),
  ]).catch(() => undefined)
  return fontsP
}

/** Canvas letterSpacing is missing in Safari 15: draw glyph by glyph. Returns the width. */
function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number, measureOnly = false) {
  let cx = x
  const chars = Array.from(text)
  chars.forEach((ch, i) => {
    if (!measureOnly) g.fillText(ch, cx, y)
    cx += g.measureText(ch).width + (i < chars.length - 1 ? tracking : 0)
  })
  return cx - x
}

/**
 * Hide a mesh from three's glass (transmission) buffer: it draws only into
 * the frame. Frost next to a print must see the light behind, not the print.
 */
export function frameOnly(mesh: THREE.Mesh, isFrame: IsFrame) {
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]
  mesh.onBeforeRender = renderer => {
    const on = isFrame(renderer.getRenderTarget())
    for (const m of mats) {
      m.colorWrite = on
      m.depthWrite = on
    }
  }
}

/**
 * The inverse: a mesh drawn ONLY into the glass buffer. The light cards are
 * never seen directly, only through glass — so they can reach past the
 * glass's edge (the frost's blur then sees light all the way to the rim, not
 * the black beyond it) without ever showing round it.
 */
export function glassOnly(mesh: THREE.Mesh, isFrame: IsFrame) {
  const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]
  mesh.onBeforeRender = renderer => {
    const on = !isFrame(renderer.getRenderTarget())
    for (const m of mats) {
      m.colorWrite = on
      m.depthWrite = on
    }
  }
}

/**
 * The optical thickness that keeps a polished letter on its own light at any
 * viewing angle. three's transmission reads the glass buffer where the
 * refracted ray EXITS (front point + refracted direction × thickness), and
 * the buffer shows the lettering's light card `depth` behind the front face
 * along the camera ray through that point. Their offsets cancel when
 * t·sin θr + (depth − t·cos θr)·tan θ = 0, i.e. t = depth·tan θ / (cos θr·tan θ − sin θr)
 * with sin θr = sin θ / 1.5 — 3·depth head-on, ~2.8·depth at 20°, ~2.4·depth at 45°.
 */
const registerThickness = (depth: number) => depth * 2.85

/**
 * An etch (roughness) canvas for a w × h pane() cap: white = frosted, BLACK =
 * polished clear (kit/opal etchMap's mapping). Bound blank now, drawn later
 * (fonts) into the same texture: no program change, no recompile.
 */
export function etchCanvas(w: number, h: number, res: number) {
  const W = w >= h ? res : Math.max(16, Math.round((res * w) / h))
  const H = w >= h ? Math.max(16, Math.round((res * h) / w)) : res
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, W, H)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  tex.repeat.set(1 / w, 1 / h)
  tex.offset.set(0.5, 0.5)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  const s = W / w
  return {
    tex,
    g,
    /** canvas pixels per world unit */
    s,
    /** world (pane-local, y up) → canvas px */
    px: (x: number, y: number): [number, number] => [(x + w / 2) * s, (h / 2 - y) * s],
    clear() {
      g.fillStyle = '#fff'
      g.fillRect(0, 0, W, H)
      g.fillStyle = '#000'
      g.strokeStyle = '#000'
    },
    commit() {
      tex.needsUpdate = true
    },
    /** give a released canvas its size back before a redraw (same size: the GPU texture is reused) */
    open() {
      tex.onUpdate = null
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }
    },
    /**
     * free the canvas once this drawing is on the GPU (perf-05: the etch
     * canvases held MBs after upload); open() before drawing again
     */
    release() {
      tex.onUpdate = () => {
        tex.onUpdate = null
        canvas.width = canvas.height = 1
      }
      tex.needsUpdate = true
    },
  }
}
type Etch = ReturnType<typeof etchCanvas>

// ------------------------------------------------------------------ light cards with bars

const CARD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
/*
 * The light inside a box: two lit tubes laid along its long edges, behind the
 * band above and below the window (a real light box's fixtures), in the
 * box's gel (A → B across the angle), each with a near-white core, over a low
 * floor of light that falls away past the glass's rim. Through the frost the
 * tubes read as two soft bars of light with dimmer glass between them — light
 * WITH A SOURCE behind the glass, not an even pastel band; through the
 * polished bevels and the window's inner walls they read crisper. Only ever
 * seen through the glass (glassOnly).
 */
const BOX_FRAG = /* glsl */ `
  uniform vec3 uA, uB, uCore;
  uniform float uLevel, uHdr, uAngle;
  uniform vec2 uSize, uGlass;
  /** the two tubes: y (top, bottom) and their half length */
  uniform vec3 uTube;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    vec2 dir = vec2(sin(uAngle), cos(uAngle));
    float g = smoothstep(-0.5, 0.5, dot(p / uGlass * 0.5, dir));
    vec3 col = mix(uA, uB, g);
    float along = 1.0 - smoothstep(uTube.z - 0.22, uTube.z + 0.02, abs(p.x));
    float d0 = p.y - uTube.x;
    float d1 = p.y - uTube.y;
    // (no hairline: a polished bevel refracts a thin bright line into dashes)
    float core = (exp(-d0 * d0 * 420.0) + exp(-d1 * d1 * 420.0)) * along;
    float spill = (exp(-d0 * d0 * 30.0) + exp(-d1 * d1 * 30.0)) * mix(0.35, 1.0, along);
    // a low floor inside the box, gone a little past the glass's rim
    vec2 q = max(abs(p) - uGlass + 0.12, 0.0);
    float floorL = 0.1 * exp(-dot(q, q) * 40.0);
    vec3 c = col * (floorL + 0.42 * spill) + mix(col, uCore, 0.25) * 1.0 * core;
    gl_FragColor = vec4(c * uHdr * uLevel, 1.0);
  }
`
interface BoxLight extends THREE.Mesh {
  setLevel(v: number): void
}
/** a box's two colours, a breath of milk (opal glass is never a pure gel) */
const OPAL_MILK = 0.08
function boxColors(light: Light) {
  const warm = new THREE.Color(hex('warm'))
  return [new THREE.Color(hex(light.a)).lerp(warm, OPAL_MILK), new THREE.Color(hex(light.b)).lerp(warm, OPAL_MILK)]
}
/** The light inside a box: two tubes along its long edges in the box's gel (only ever seen through the glass). */
function boxLight(w: number, h: number, light: Light, hdr: number): BoxLight {
  const [ca, cb] = boxColors(light)
  const top = WIN_Y + WIN_H / 2
  const bot = WIN_Y - WIN_H / 2
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: ca },
      uB: { value: cb },
      uCore: { value: new THREE.Color(hex('warm')) },
      uLevel: { value: 1 },
      uHdr: { value: hdr },
      uAngle: { value: light.angle },
      uSize: { value: new THREE.Vector2(w, h) },
      uGlass: { value: new THREE.Vector2(GW / 2, GH / 2) },
      // in the band above and below the window, nearer the rim than the window
      // (the window's polished inner walls would refract a near tube into a
      // flare over the print's edge); they stop short of the standoffs
      uTube: { value: new THREE.Vector3(lerp(top, GH / 2 - GBS, 0.64), lerp(bot, -GH / 2 + GBS, 0.64), GW / 2 - 0.2) },
    },
    vertexShader: CARD_VERT,
    fragmentShader: BOX_FRAG,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat) as unknown as BoxLight
  mesh.setLevel = v => (mat.uniforms.uLevel.value = Math.max(0, v))
  return mesh
}

const textFrag = (nb: number) => /* glsl */ `
  #define NB ${nb}
  uniform vec3 uA, uB, uText;
  uniform float uLevel, uBase, uAngle, uEdge, uBias;
  uniform vec2 uSize, uEtchSize;
  uniform vec4 uRect[NB];
  uniform float uK[NB];
  uniform sampler2D uEtch;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    vec2 dir = vec2(sin(uAngle), cos(uAngle));
    float g = smoothstep(-0.5, 0.5, dot(vUv - 0.5, dir));
    vec3 base = mix(uA, uB, g);
    vec2 e = smoothstep(vec2(0.0), vec2(uEdge), 0.5 * uSize - abs(p));
    // the lettering as light: the etch's polished strokes (black), read from a
    // blurrier mip so the light reaches a hair past every stroke (parallax)
    float ink = 1.0 - texture2D(uEtch, p / uEtchSize + 0.5, uBias).g;
    ink = smoothstep(0.02, 0.3, ink);
    // each line's own strength
    float k = 0.0;
    for (int i = 0; i < NB; i++) {
      vec4 r = uRect[i];
      vec2 d = max(r.xy - p, p - r.zw);
      k += uK[i] * (1.0 - smoothstep(-0.01, 0.01, max(d.x, d.y)));
    }
    vec3 c = base * uBase * e.x * e.y + uText * ink * k;
    gl_FragColor = vec4(c * uLevel, 1.0);
  }
`

export interface TextLight extends THREE.Mesh {
  material: THREE.ShaderMaterial
  setLevel(v: number): void
  /** line i's rect in the card's local units: x0, y0, x1, y1 (where its strength applies) */
  setRect(i: number, x0: number, y0: number, x1: number, y1: number): void
  setK(i: number, k: number): void
}

/**
 * The light behind an etched pane: a gradient glow (A → B, soft edges, `base`
 * strength) plus the pane's own lettering drawn in LIGHT (colour `text`),
 * registered under the polished strokes and a hair bolder. Through the
 * polished letters it shows crisp and bright; the frost round them spreads
 * it into a faint haze — so the letters read at high contrast. Line i's
 * strength (setK) lets one name burn brighter. The card is centred on the
 * pane and may be larger (it's only ever seen through the glass).
 */
function textLight(w: number, h: number, etch: Etch, pane: { w: number; h: number }, nb: number, o: { a: string; b: string; angle: number; base: number; text: string; hdr: number; edge?: number; bias?: number }): TextLight {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Color(hex(o.a)) },
      uB: { value: new THREE.Color(hex(o.b)) },
      uText: { value: new THREE.Color(hex(o.text)).multiplyScalar(o.hdr) },
      uLevel: { value: 1 },
      uBase: { value: o.base },
      uAngle: { value: o.angle },
      uEdge: { value: o.edge ?? 0.06 },
      uBias: { value: o.bias ?? 1.6 },
      uSize: { value: new THREE.Vector2(w, h) },
      uEtchSize: { value: new THREE.Vector2(pane.w, pane.h) },
      uEtch: { value: etch.tex },
      uRect: { value: Array.from({ length: nb }, () => new THREE.Vector4(9, 9, 9, 9)) },
      uK: { value: new Array<number>(nb).fill(0) },
    },
    vertexShader: CARD_VERT,
    fragmentShader: textFrag(nb),
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat) as unknown as TextLight
  mesh.setLevel = v => (mat.uniforms.uLevel.value = Math.max(0, v))
  mesh.setRect = (i, x0, y0, x1, y1) => (mat.uniforms.uRect.value as THREE.Vector4[])[i]?.set(x0, y0, x1, y1)
  mesh.setK = (i, k) => {
    ;(mat.uniforms.uK.value as number[])[i] = k
  }
  return mesh
}

// ------------------------------------------------------------------ halo + pool

const HALO_FRAG = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uLevel, uAngle, uSigma;
  uniform vec2 uSize, uHalf;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    vec2 q = max(abs(p) - uHalf, 0.0);
    float d = length(q);
    float glow = exp(-d * d / (uSigma * uSigma)) * 0.75 + exp(-d / (uSigma * 2.2)) * 0.25;
    vec2 dir = vec2(sin(uAngle), cos(uAngle));
    float t = smoothstep(-0.5, 0.5, dot(vUv - 0.5, dir));
    vec2 e = smoothstep(vec2(0.0), vec2(0.1), 0.5 - abs(vUv - 0.5));
    gl_FragColor = vec4(mix(uA, uB, t) * glow * e.x * e.y * uLevel, 1.0);
  }
`
/**
 * A soft halo of the box's light on the black wall round it (an additive
 * plane in the OPAQUE list, so the frost sees it too). Its core hides behind
 * the tray; only the spill round the edge shows.
 */
function halo(w: number, h: number, light: Light, sigma: number, pad: number) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Color(hex(light.a)) },
      uB: { value: new THREE.Color(hex(light.b)) },
      uLevel: { value: 0 },
      uAngle: { value: light.angle },
      uSigma: { value: sigma },
      uSize: { value: new THREE.Vector2(w + pad * 2, h + pad * 2) },
      uHalf: { value: new THREE.Vector2(w / 2, h / 2) },
    },
    vertexShader: CARD_VERT,
    fragmentShader: HALO_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w + pad * 2, h + pad * 2), mat)
  mesh.renderOrder = 1
  return { mesh, setLevel: (v: number) => (mat.uniforms.uLevel.value = v) }
}

const POOL_FRAG = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uLevel;
  varying vec2 vUv;
  void main() {
    // u across the wall, v from the wall (v = 1) out into the room (v = 0)
    float u = vUv.x * 2.0 - 1.0;
    float v = 1.0 - vUv.y;
    float a = exp(-u * u * 3.2) * (1.0 - v) * (1.0 - v) * smoothstep(0.0, 0.06, v);
    gl_FragColor = vec4(mix(uA, uB, vUv.x) * a * uLevel, 1.0);
  }
`
/** Its light pooled on the polished stone under it (additive, opaque list). */
function pool(w: number, d: number, light: Light) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: new THREE.Color(hex(light.a)) }, uB: { value: new THREE.Color(hex(light.b)) }, uLevel: { value: 0 } },
    vertexShader: CARD_VERT,
    fragmentShader: POOL_FRAG,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.renderOrder = 1
  return { mesh, setLevel: (v: number) => (mat.uniforms.uLevel.value = v) }
}

// ------------------------------------------------------------------ shared materials

export interface Shared {
  isFrame: IsFrame
  envMap: THREE.Texture | null
  mobile: boolean
  /** open black trays */
  tray: THREE.MeshStandardMaterial
  /**
   * a cheap stand-in for the glass of boxes two or more stations away (dim,
   * small or off-screen): keeps ≤ 3–4 real glass panes in view at a time
   */
  far: THREE.MeshStandardMaterial
  /** the black mount board behind each print (satin, seen round it in the window) */
  mount: THREE.MeshStandardMaterial
  /** polished steel standoffs holding the glass off the wall */
  steel: THREE.MeshStandardMaterial
  /** the six box faces: frosted caps, polished outer bevels, the window's polished inner walls */
  face: [THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial]
  /**
   * frosted caps for etched panes (clone per etch map) + their polished bevels
   * (thin: a longer optical path refracts the lettering below into a row of
   * dots along the top bevel)
   */
  etchCaps: THREE.MeshPhysicalMaterial
  edges: THREE.MeshPhysicalMaterial
  /**
   * every material with its own envMap: they ignore the world's envTurn, so
   * the chapter turns their envMapRotation itself (highlights glide along the
   * bevels and standoffs as you walk)
   */
  envMats: (THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial)[]
}

export function sharedMaterials(isFrame: IsFrame, envMap: THREE.Texture | null, mobile: boolean): Shared {
  const black = new THREE.MeshStandardMaterial({ color: 0x050407, roughness: 0.55, metalness: 0.1, envMap, envMapIntensity: 0.25 })
  const far = new THREE.MeshStandardMaterial({ color: 0x0c0a10, roughness: 0.42, metalness: 0, envMap, envMapIntensity: 0.3 })
  const mount = new THREE.MeshStandardMaterial({ color: 0x08070b, roughness: 0.6, metalness: 0, envMap, envMapIntensity: 0.15 })
  // satin steel: broad enough a sheen to read at a dozen pixels (polished reads as a black hole)
  const steel = new THREE.MeshStandardMaterial({ color: 0xe4e0ea, roughness: 0.26, metalness: 1, envMap, envMapIntensity: 2 })
  // a clearer frost than the labels: the tubes behind read as soft bars
  const caps = frosted({ frost: 0.4, thickness: 0.16 }).clone()
  caps.envMap = envMap
  caps.envMapIntensity = 0.3
  const faceEdges = polished({ thickness: 0.075 }).clone()
  faceEdges.envMap = envMap
  faceEdges.envMapIntensity = 3
  const winEdges = polished({ thickness: 0.05 }).clone()
  winEdges.envMap = envMap
  winEdges.envMapIntensity = 0.7
  const edges = polished({ thickness: 0.035 }).clone()
  edges.envMap = envMap
  edges.envMapIntensity = 1
  const etchCaps = frosted({ frost: 0.48, thickness: 0.05 }).clone()
  etchCaps.envMap = envMap
  etchCaps.envMapIntensity = 0.2
  return {
    isFrame,
    envMap,
    mobile,
    tray: black,
    far,
    mount,
    steel,
    face: [caps, faceEdges, winEdges],
    etchCaps,
    edges,
    // (not the labels' and board's thin bevels: a strip swept onto a sub-pixel
    // bevel breaks into a row of dots)
    envMats: [caps, faceEdges, winEdges, steel, black, far],
  }
}

/** A frosted slab with a window cut clean through it (w × h outline, bevels added round it; window hw × hh at y = wy). */
function windowPane(w: number, h: number, hw: number, hh: number, wy: number, o: { depth: number; bevel: number; radius: number }) {
  const rect = (p: THREE.Path, x: number, y: number, rw: number, rh: number, r: number, cw: boolean) => {
    const pts: [number, number][] = [
      [x + r, y],
      [x + rw - r, y],
      [x + rw, y + r],
      [x + rw, y + rh - r],
      [x + rw - r, y + rh],
      [x + r, y + rh],
      [x, y + rh - r],
      [x, y + r],
    ]
    const ctl: [number, number][] = [
      [x + rw, y],
      [x + rw, y + rh],
      [x, y + rh],
      [x, y],
    ]
    const seq = cw ? [...pts].reverse() : pts
    const cseq = cw ? [ctl[2], ctl[1], ctl[0], ctl[3]] : ctl
    p.moveTo(seq[0][0], seq[0][1])
    for (let i = 0; i < 4; i++) {
      p.lineTo(seq[i * 2 + 1][0], seq[i * 2 + 1][1])
      const next = seq[(i * 2 + 2) % 8]
      p.quadraticCurveTo(cseq[i][0], cseq[i][1], next[0], next[1])
    }
  }
  const s = new THREE.Shape()
  rect(s, -w / 2, -h / 2, w, h, o.radius, false)
  const hole = new THREE.Path()
  rect(hole, -hw / 2, wy - hh / 2, hw, hh, 0.006, true)
  s.holes.push(hole)
  const g = smoothExtrude(s, { depth: o.depth, bevel: o.bevel, curveSegments: 6 })
  // split the side walls: the outer rim (group 1) and the window's inner walls
  // (group 2, their own quieter material: a hot glint there sits over the print)
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const side = g.groups.find(gr => gr.materialIndex === 1)
  if (!side || g.index) return g
  const inner = (i: number) => {
    let cx = 0
    let cy = 0
    for (let k = 0; k < 3; k++) {
      cx += pos.getX(i + k) / 3
      cy += pos.getY(i + k) / 3
    }
    return Math.abs(cx) < hw / 2 + 0.005 && Math.abs(cy - wy) < hh / 2 + 0.005
  }
  const names = Object.keys(g.attributes)
  const src = names.map(n => g.getAttribute(n) as THREE.BufferAttribute)
  const copy = src.map(a => (a.array as Float32Array).slice())
  const outerTris: number[] = []
  const innerTris: number[] = []
  for (let i = side.start; i < side.start + side.count; i += 3) (inner(i) ? innerTris : outerTris).push(i)
  let w0 = side.start
  for (const i of [...outerTris, ...innerTris]) {
    src.forEach((a, n) => {
      const sz = a.itemSize
      for (let k = 0; k < 3 * sz; k++) (a.array as Float32Array)[w0 * sz + k] = copy[n][i * sz + k]
    })
    w0 += 3
  }
  src.forEach(a => (a.needsUpdate = true))
  const others = g.groups.filter(gr => gr !== side)
  g.clearGroups()
  for (const gr of others) g.addGroup(gr.start, gr.count, gr.materialIndex)
  g.addGroup(side.start, outerTris.length * 3, 1)
  g.addGroup(side.start + outerTris.length * 3, innerTris.length * 3, 2)
  return g
}

/** four polished standoff caps on the glass (their barrels run back to the wall behind it): one geometry */
let standoffGeo: THREE.BufferGeometry | null = null
function standoffs(z0: number, z1: number) {
  if (standoffGeo) return standoffGeo
  const parts: THREE.BufferGeometry[] = []
  const inset = 0.105
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x = sx * (GW / 2 - inset)
      const y = sy * (GH / 2 - inset)
      // the cap: a low steel dome on a thin collar (a dome catches the studio
      // strips as a highlight; a flat disc reads as a hole)
      const collar = new THREE.CylinderGeometry(0.036, 0.036, 0.008, 24, 1)
      collar.rotateX(Math.PI / 2)
      collar.translate(x, y, z1 + 0.004)
      const cap = new THREE.SphereGeometry(0.034, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2)
      cap.rotateX(Math.PI / 2)
      cap.scale(1, 1, 0.55)
      cap.translate(x, y, z1 + 0.008)
      const barrel = new THREE.CylinderGeometry(0.014, 0.014, z1 - z0, 10, 1, true)
      barrel.rotateX(Math.PI / 2)
      barrel.translate(x, y, (z0 + z1) / 2)
      for (const g of [collar, cap, barrel]) {
        parts.push(g.toNonIndexed())
        g.dispose()
      }
    }
  standoffGeo = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return standoffGeo
}

/**
 * Small etched lettering far from the camera minifies its roughness map: a
 * thin polished stroke (an l, an i) averages with the frost round it into a
 * mid grey — half-rough, so it blurs away. Curve the map so anything darker
 * than mid grey is polished: strokes stay crisp windows at any size (and a
 * hair bolder up close, which the lettering's light allows for).
 */
function crispEtch(m: THREE.MeshPhysicalMaterial) {
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      THREE.ShaderChunk.roughnessmap_fragment.replace('roughnessFactor *= texelRoughness.g;', 'roughnessFactor *= smoothstep( 0.6, 0.95, texelRoughness.g );'),
    )
  }
  m.customProgramCacheKey = () => 'opal-crisp-etch'
}

/** a box with no front face and no groups (one draw) */
function trayGeometry(w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  const front = g.groups[4] // +x, -x, +y, -y, +z, -z
  const idx = Array.from(g.index!.array as ArrayLike<number>)
  idx.splice(front.start, front.count)
  g.setIndex(idx)
  g.clearGroups()
  return g
}

/** an open black tray behind a pane (seen round its edges; hidden from the glass buffer) */
function tray(w: number, h: number, d: number, S: Shared) {
  const m = new THREE.Mesh(trayGeometry(w, h, d), S.tray)
  m.position.z = TRAY_Z0 + d / 2
  frameOnly(m, S.isFrame)
  return m
}

// ------------------------------------------------------------------ the light box

export interface LightBox {
  root: THREE.Group
  print: THREE.MeshBasicMaterial
  /** the label's etch (drawn once the fonts are in; `release` frees its canvas after the upload) */
  drawLabel(release?: boolean): void
  /**
   * 0..1 how lit the box is; `floor` = how much of the print (and label) a
   * dark box keeps (PRINT_DIM ahead of the camera, PRINT_BEHIND once passed)
   */
  setLevel(v: number, floor?: number): void
  /** set the print texture */
  setPrint(t: THREE.Texture): void
  /** far from the camera: cheap stand-in glass */
  setFar(far: boolean): void
}

/**
 * A light box centred at height `y` (the caller places root.x; root.y = y):
 * a thick frosted glass slab held off the wall on four polished standoffs,
 * a window cut clean through it, the print on a black mount board behind the
 * window, two tubes of the box's light behind the glass.
 */
export function lightBox(o: { name: string; industry: string; light: Light; S: Shared; y: number }): LightBox {
  const { S, light } = o
  const root = new THREE.Group()
  // the shallow black case behind the glass (a shadow round it) + the light inside
  root.add(tray(GW - 0.16, GH - 0.16, TRAY_D, S))
  // every box glows at about the same brightness whatever its colours (ice is
  // nearly white, violet deep): scale the light to a common tube luminance
  const [ca, cb] = boxColors(light)
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  const hdr = Math.min(1.2, TUBE_LUM / Math.max(0.1, (lum(ca) + lum(cb)) / 2))
  const card = boxLight(GW + 0.9, GH + 0.9, light, hdr)
  card.position.z = TRAY_Z0 + 0.03
  glassOnly(card, S.isFrame)
  root.add(card)
  // the frosted glass: polished bevels outside and round the window
  const face: THREE.Mesh = new THREE.Mesh(windowPane(GW - 2 * GBS, GH - 2 * GBS, WIN_W, WIN_H, WIN_Y, { depth: GD, bevel: GB, radius: 0.03 }), S.face)
  face.position.z = GLASS_Z
  root.add(face)
  // the print on its black mount board, just behind the window
  const mount = new THREE.Mesh(new THREE.PlaneGeometry(WIN_W + 0.12, WIN_H + 0.12), S.mount)
  mount.position.set(0, WIN_Y, BACK_Z - 0.012)
  frameOnly(mount, S.isFrame)
  root.add(mount)
  const printMat = new THREE.MeshBasicMaterial({ map: placeholderTexture('#0e0c13'), toneMapped: false, color: new THREE.Color().setScalar(PRINT_MAX * PRINT_DIM) })
  const print = new THREE.Mesh(new THREE.PlaneGeometry(PRINT_W, PRINT_H), printMat)
  print.position.set(0, WIN_Y, BACK_Z - 0.006)
  frameOnly(print, S.isFrame)
  root.add(print)
  // four polished standoffs
  const so = new THREE.Mesh(standoffs(0, FACE_Z), S.steel)
  frameOnly(so, S.isFrame)
  root.add(so)
  // a faint spill on the wall round it (restraint: it's glass, not a screen), a pool on the floor
  const h = halo(GW, GH, light, 0.09, 0.4)
  h.mesh.position.z = 0.004
  root.add(h.mesh)
  const p = pool(GW * 1.2, 2.4, light)
  p.mesh.position.set(0, -o.y + 0.004, 1.25)
  root.add(p.mesh)
  root.position.y = o.y

  // ---- the wall label (right-aligned under the box): name + industry polished into frosted glass
  const L = new THREE.Group()
  L.position.set(LABEL_X, LABEL_Y, 0)
  root.add(L)
  L.add(tray(LABEL_W - 0.03, LABEL_H - 0.03, LABEL_TRAY, S))
  // (a finer map sharpens the lettering's light enough for the top bevel to refract it into dots)
  const etch = etchCanvas(LABEL_W, LABEL_H, S.mobile ? 384 : 512)
  const lcard = textLight(LABEL_W + 0.4, LABEL_H + 0.06, etch, { w: LABEL_W, h: LABEL_H }, 2, { a: light.a, b: light.b, angle: light.angle, base: 0.2, text: 'warm', hdr: 1.1, edge: 0.05, bias: 2 })
  // close behind the glass: little parallax between a letter and its light
  lcard.position.z = LABEL_Z - LABEL_D / 2 - LABEL_B - 0.003
  glassOnly(lcard, S.isFrame)
  L.add(lcard)
  const caps = S.etchCaps.clone()
  crispEtch(caps) // (clone() drops onBeforeCompile)
  caps.roughnessMap = etch.tex
  caps.thickness = registerThickness(LABEL_D + 2 * LABEL_B + 0.003)
  S.envMats.push(caps)
  const lglass = pane(LABEL_W, LABEL_H, { depth: LABEL_D, bevel: LABEL_B, radius: 0.012 })
  lglass.material = [caps, S.edges]
  lglass.position.z = LABEL_Z
  L.add(lglass)
  const lh = halo(LABEL_W, LABEL_H, light, 0.08, 0.3)
  lh.mesh.position.z = 0.004
  L.add(lh.mesh)

  // phones: the industry line would etch ~5 px tall (the card carries it) — the name alone
  const drawLabel = (release = false) => {
    etch.open()
    drawLabelEtch(etch, lcard, o.name, S.mobile ? '' : o.industry)
    if (release) etch.release()
  }
  drawLabel()

  let level = -1
  let floorAt = -1
  let isFar = false
  return {
    root,
    print: printMat,
    drawLabel,
    setLevel(v: number, floor = PRINT_DIM) {
      if (Math.abs(v - level) < 1e-4 && Math.abs(floor - floorAt) < 1e-4) return
      level = v
      floorAt = floor
      card.setLevel(CARD_DIM + (1 - CARD_DIM) * v)
      printMat.color.setScalar(PRINT_MAX * (floor + (1 - floor) * v))
      h.setLevel(0.004 + 0.016 * v)
      p.setLevel(0.01 + 0.07 * v)
      // the label keeps a little light ahead, next to none once passed
      const lf = (0.2 * floor) / PRINT_DIM
      lcard.setLevel(lf + (1 - lf) * v)
      lh.setLevel(0.006 + 0.022 * v)
    },
    setPrint(t: THREE.Texture) {
      printMat.map?.dispose()
      printMat.map = t
      printMat.needsUpdate = true
    },
    setFar(far: boolean) {
      if (isFar === far) return
      isFar = far
      face.material = far ? S.far : S.face
      lglass.material = far ? S.far : [caps, S.edges]
    },
  }
}

/**
 * name + industry polished into the label (its light card draws the same
 * strokes in light). No industry (phones): the name alone, centred.
 */
function drawLabelEtch(etch: Etch, card: TextLight, name: string, industry: string) {
  const { g, s, px } = etch
  etch.clear()
  const x0 = -LABEL_W / 2 + 0.075
  const maxW = LABEL_W - 0.15
  // the name: Hanken Grotesk, polished; long names narrow to fit
  let cap = industry ? 0.064 : 0.07
  const fontFor = (c: number) => `540 ${Math.round((c / 0.7) * s)}px ${FONT_SANS}`
  g.font = fontFor(cap)
  const w = g.measureText(name).width / s
  if (w > maxW) {
    cap *= maxW / w
    g.font = fontFor(cap)
  }
  const nameBase = industry ? 0.012 : -cap / 2
  g.textBaseline = 'alphabetic'
  const [nx, ny] = px(x0, nameBase)
  g.fillText(name, nx, ny)
  // the industry: Red Hat Mono caps, bold and lightly tracked (thin strokes
  // at this size drop out of the frost: "INDUS TRIAL", "ESTA E")
  const mcap = 0.037
  const indBase = -0.102
  if (industry) {
    g.font = `700 ${Math.round((mcap / 0.7) * s)}px ${FONT_MONO}`
    const trk = 0.1 * mcap * s
    const ind = industry.toUpperCase()
    const mw = spaced(g, ind, 0, 0, trk, true) / s
    const [ix, iy] = px(x0, indBase)
    if (mw > maxW) {
      g.save()
      g.translate(ix, iy)
      g.scale(maxW / mw, 1)
      spaced(g, ind, 0, 0, trk)
      g.restore()
    } else spaced(g, ind, ix, iy, trk)
  }
  etch.commit()
  // each line's strength applies over its own band
  const split = industry ? (nameBase - cap * 0.3 + indBase + mcap) / 2 : -LABEL_H
  card.setRect(0, -LABEL_W, split, LABEL_W, LABEL_H)
  card.setRect(1, -LABEL_W, -LABEL_H, LABEL_W, split)
  card.setK(0, 1)
  card.setK(1, 0.9)
}

// ------------------------------------------------------------------ the board

export const BOARD_W = 3.7
const ROW = 0.37
const BCAP = 0.122
const BOARD_PAD = 0.32
// a thin pane: the lettering's light sits close behind the polished strokes
const BD = 0.03
const BB = 0.014

export interface Board {
  root: THREE.Group
  w: number
  h: number
  /** front face z (local) */
  faceZ: number
  /** row rects (local, y up): x0, y0, x1, y1 */
  rows: THREE.Vector4[]
  /** row j's light (0..1+), and the whole board's level */
  setRow(j: number, k: number): void
  setLevel(v: number): void
  /** (re)draw the etch; `release` frees its canvas after the upload from now on */
  draw(release?: boolean): void
  /** a heavier etch where the board shows small on screen (thin strokes survive) */
  setBold(b: boolean): void
  setFar(far: boolean): void
}

/** The wall-text board centred at height `y` (the caller places root.x). */
export function board(names: string[], light: Light, S: Shared, y: number): Board {
  const n = names.length
  const h = n * ROW + BOARD_PAD * 2 - (ROW - BCAP * 1.4)
  const w = BOARD_W
  const root = new THREE.Group()
  const trayD = 0.12
  root.add(tray(w - 0.05, h - 0.05, trayD, S))
  const etch = etchCanvas(w, h, S.mobile ? 512 : 1024)
  const card = textLight(w + 0.9, h + 0.9, etch, { w, h }, n, { a: light.a, b: light.b, angle: light.angle, base: 0.2, text: 'warm', hdr: 1.2, edge: 0.3, bias: S.mobile ? 1.2 : 2 })
  const gz = TRAY_Z0 + trayD + BD / 2 + BB + 0.004
  card.position.z = gz - BD / 2 - BB - 0.003
  glassOnly(card, S.isFrame)
  root.add(card)
  const caps = S.etchCaps.clone()
  crispEtch(caps) // (clone() drops onBeforeCompile)
  caps.roughnessMap = etch.tex
  caps.thickness = registerThickness(BD + 2 * BB + 0.003)
  // a heavier frost than the labels: the lettering's light behind blurs into a
  // faint haze (the polished strokes show it crisp)
  caps.roughness = 0.62
  const glass = pane(w, h, { depth: BD, bevel: BB, radius: 0.03 })
  glass.material = [caps, S.edges]
  glass.position.z = gz
  root.add(glass)
  const hl = halo(w, h, light, 0.24, 0.9)
  hl.mesh.position.z = 0.004
  root.add(hl.mesh)
  const pl = pool(w * 1.3, 2.4, light)
  pl.mesh.position.set(0, -y + 0.004, 1.25)
  root.add(pl.mesh)
  root.position.y = y
  const rows = names.map(() => new THREE.Vector4())
  const rowY = (j: number) => h / 2 - BOARD_PAD - BCAP * 0.7 - j * ROW
  const x0 = -w / 2 + 0.34
  const maxW = w - 0.68
  const k = new Array<number>(n).fill(0.7)
  let level = 1
  let bold = false
  let isFar = false

  /** once the fonts are in, the canvas is freed after each upload (a bold switch reopens it) */
  let freed = false
  const draw = (release = false) => {
    const { g, s, px } = etch
    freed = freed || release
    etch.open()
    etch.clear()
    g.textBaseline = 'alphabetic'
    const fontFor = (c: number) => `${bold ? 660 : 540} ${Math.round((c / 0.7) * s)}px ${FONT_SANS}`
    const arrow = BCAP * 0.62
    names.forEach((name, j) => {
      const base = rowY(j) - BCAP / 2
      let cap = BCAP
      g.font = fontFor(cap)
      let tw = g.measureText(name).width / s
      const room = maxW - arrow - 0.1
      if (tw > room) {
        cap *= room / tw
        g.font = fontFor(cap)
        tw = g.measureText(name).width / s
      }
      const [x, y] = px(x0, base)
      g.fillText(name, x, y)
      // a small etched arrow: it's a link
      const ax = x0 + tw + 0.08
      const lw = Math.max(1.5, 0.011 * s)
      g.lineWidth = lw
      g.lineCap = 'round'
      g.beginPath()
      const [a0x, a0y] = px(ax, base + 0.004)
      const [a1x, a1y] = px(ax + arrow, base + arrow + 0.004)
      g.moveTo(a0x, a0y)
      g.lineTo(a1x, a1y)
      const [b0x, b0y] = px(ax + arrow * 0.3, base + arrow + 0.004)
      const [b1x, b1y] = px(ax + arrow, base + arrow * 0.3 + 0.004)
      g.moveTo(b0x, b0y)
      g.lineTo(a1x, a1y)
      g.lineTo(b1x, b1y)
      g.stroke()
      // the link's rect (hit area); its line's strength applies over its row band
      const m = 0.03
      rows[j].set(x0 - m, base - cap * 0.3 - m, ax + arrow + m, base + cap + m)
      card.setRect(j, -w, rowY(j) - ROW / 2, w, rowY(j) + ROW / 2)
    })
    etch.commit()
    if (freed) etch.release()
  }
  draw()
  const apply = () => {
    for (let j = 0; j < n; j++) card.setK(j, k[j])
    card.setLevel(level)
  }
  apply()
  return {
    root,
    w,
    h,
    faceZ: gz + BD / 2 + BB,
    rows,
    setRow(j, v) {
      k[j] = v
      card.setK(j, v)
    },
    setLevel(v) {
      level = v
      card.setLevel(v)
      hl.setLevel(0.07 * v)
      pl.setLevel(0.08 * v)
    },
    draw,
    setBold(b) {
      if (b === bold) return
      bold = b
      draw()
    },
    setFar(far) {
      if (far === isFar) return
      isFar = far
      glass.material = far ? S.far : [caps, S.edges]
    },
  }
}

// ------------------------------------------------------------------ the room

/** The long black wall, a hairline of light where it meets the polished floor. */
export function wall(x0: number, x1: number, envMap: THREE.Texture | null) {
  const g = new THREE.Group()
  const len = x1 - x0
  const w = new THREE.Mesh(
    new THREE.PlaneGeometry(len, 9),
    new THREE.MeshStandardMaterial({ color: 0x040306, roughness: 0.92, metalness: 0, envMap, envMapIntensity: 0.04 }),
  )
  w.position.set((x0 + x1) / 2, 4.5, 0)
  g.add(w)
  // a shadow-gap reveal at the foot of the wall, faintly lit (architectural hairline)
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(len, 0.012),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(hex('warm')).multiplyScalar(0.3), toneMapped: false }),
  )
  line.position.set((x0 + x1) / 2, 0.05, 0.003)
  g.add(line)
  return g
}
