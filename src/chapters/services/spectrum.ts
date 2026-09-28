import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { flattenCaps, frosted, pane, polished, smoothSides } from '../../kit/glass'
import { DUSK } from '../../kit/opal'
import { SERVICES } from '../../content'
import { drawIcon } from './icons'

/*
 * SERVICES · "Spectrum" — the installation.
 *
 * Eleven tall frosted glass FINS standing on black stone in a gentle arc
 * (concave to the visitor: every fin faces the arc's center, so a camera
 * gliding round the inner arc always meets the active fin square on). Each
 * fin is backlit by its own LIGHT CARD: a pair of vertical tubes (drawn in
 * the card shader) in two neighboring colors of one dusk spectrum, blush →
 * rose → lilac → violet → periwinkle → ice → warm white, so the row reads as
 * ONE gradient, never a rainbow.
 *
 * The service icon and its number are POLISHED CLEAR into the frost (the
 * etch atlas' G channel is the glass' roughness), and the card draws the same
 * lines LIT (R channel, thicker and soft) right where the polished window
 * shows them: the card projects the atlas from the camera onto itself, so
 * the lit lines stay registered with the etch at any viewing angle (the
 * glass is 0.13 thick; plain parallax would slide them out of the windows).
 *
 * Budget: ALL eleven fins are ONE transmissive mesh (caps frosted + etched,
 * bevels polished: two draws); the cards are one opaque mesh, the floor
 * pools one additive mesh. No lights of its own.
 *
 * Etch atlas: a 4 × 3 grid of ZONES (the part of a fin that carries the icon
 * and number). Outside its zone a fin samples the zone's clamped border,
 * which is plain frost — so the atlas spends every texel on the icons.
 */

export const N = SERVICES.length
/** fin: width, height, extrusion depth (+ bevel each side), bevel */
export const FW = 0.62
export const FH = 2.7
const FD = 0.05
const BEVEL = 0.03
/** the front cap's z (fin-local) and the card's z behind the back cap */
const Z_FRONT = FD / 2 + BEVEL
const Z_CARD = -(FD / 2 + BEVEL) - 0.03
/** the frosted caps' optical thickness (the card follows the same refraction) */
const GLASS_THICKNESS = 0.1
/** fins stand on the stone (y = 0); fin center height */
export const FY = FH / 2 + 0.012
/** the arc: radius, and the angle between neighboring fins (a pitch of ~1.02) */
export const R = 12
export const STEP = 1.02 / R
/** the arc's center: fin 5 stands at the origin, facing +z */
export const CENTER = new THREE.Vector3(0, 0, R)
/** icon + number zone in fin-local coords (x0, y0, x1, y1) */
const ZONE = new THREE.Vector4(-0.25, -0.24, 0.25, 0.6)
const GRID = new THREE.Vector2(4, 3)
/** icon box (half size) and center height, fin-local */
const ICON_HALF = 0.2
const ICON_Y = 0.3
const NUM_Y = -0.1
const NUM_H = 0.072
const RULE_Y = 0.03
/** card: size, tube x, tube half-length */
const CW = 0.54
const CH = 2.56
const TUBE_X = 0.205
const TUBE_HALF = 1.16

// ------------------------------------------------------------------ color

/** the dusk spectrum, sampled 0..1 (linear-light interpolation between the palette stops) */
const STOPS: [number, string][] = [
  [0, DUSK.blush],
  [0.13, DUSK.rose],
  [0.37, DUSK.lilac],
  [0.54, DUSK.violet],
  [0.69, DUSK.periwinkle],
  [0.86, DUSK.ice],
  [1, DUSK.warm],
]
const _ca = new THREE.Color()
const _cb = new THREE.Color()
export function spectrum(t: number, out = new THREE.Color()) {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0] || i === STOPS.length - 1) {
      const [t0, c0] = STOPS[i - 1]
      const [t1, c1] = STOPS[i]
      const k = (x - t0) / Math.max(1e-6, t1 - t0)
      return out.copy(_ca.set(c0)).lerp(_cb.set(c1), Math.max(0, Math.min(1, k)))
    }
  }
  return out.set(DUSK.warm)
}
/** fin i's spectrum position */
export const finT = (i: number) => i / (N - 1)
/**
 * Light output per fin: pale colors (ice, warm white) cross the bloom
 * threshold on all three channels and read ~3x brighter than violet at the
 * same level — scale each fin by its color's luminance so the eleven lights
 * read as one even row.
 */
export function gainOf(c: THREE.Color) {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  return Math.max(0.48, Math.min(1.1, 0.3 / Math.max(0.05, lum)))
}
export function finGain(i: number) {
  return gainOf(spectrum(finT(i)))
}
/** fin i's color as sRGB hex (for the DOM) */
export const finHex = (i: number) => '#' + spectrum(finT(i)).getHexString()

// ------------------------------------------------------------------ arc

/** fin angle on the arc (fractional index ok) */
export const finAngle = (f: number) => (f - (N - 1) / 2) * STEP
/** a point on a circle of radius r round the arc's center, at fin position f */
export function arcPoint(f: number, r: number, y: number, out: THREE.Vector3) {
  const a = finAngle(f)
  return out.set(CENTER.x + Math.sin(a) * r, y, CENTER.z - Math.cos(a) * r)
}
/** the fin's outward tangent (its local +x) */
export function finTangent(f: number, out: THREE.Vector3) {
  const a = finAngle(f)
  return out.set(Math.cos(a), 0, Math.sin(a))
}

// ------------------------------------------------------------------ etch atlas

/** zone-local → atlas uv (shared by the glass and the card) */
const ATLAS_GLSL = /* glsl */ `
  uniform vec4 uZone;
  uniform vec2 uGrid;
  vec2 atlasUv(vec2 l, float fin) {
    vec2 z = clamp(l, uZone.xy, uZone.zw);
    float fi = floor(fin + 0.5);
    float col = mod(fi, uGrid.x);
    float row = floor(fi / uGrid.x + 0.001);
    return (vec2(col, uGrid.y - 1.0 - row) + (z - uZone.xy) / (uZone.zw - uZone.xy)) / uGrid;
  }
`

export interface Atlas {
  texture: THREE.CanvasTexture
  redraw(): void
}

/**
 * The etch atlas. G = frost (1) / POLISHED (0): the glass' roughness.
 * R = the lit lines the card draws behind the polish (thicker, soft).
 */
export function buildAtlas(res: number): Atlas {
  const zw = ZONE.z - ZONE.x
  const zh = ZONE.w - ZONE.y
  const aw = zw * GRID.x
  const ah = zh * GRID.y
  const W = aw >= ah ? res : Math.round((res * aw) / ah)
  const H = aw >= ah ? Math.round((res * ah) / aw) : res
  const sx = W / aw
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.NoColorSpace
  texture.anisotropy = 4
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping

  const draw = () => {
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = 'rgb(0, 255, 0)'
    g.fillRect(0, 0, W, H)
    const font = (wt: number, px: number) => `${wt} ${px.toFixed(1)}px "Hanken Grotesk Variable", "Hanken Grotesk", system-ui, sans-serif`
    for (let i = 0; i < N; i++) {
      const col = i % GRID.x
      const row = Math.floor(i / GRID.x)
      // fin-local (x, y) → canvas px inside this cell
      const fx = (x: number, y: number): [number, number] => [(col * zw + (x - ZONE.x)) * sx, (row * zh + (ZONE.w - y)) * sx]
      const icon = (x: number, y: number): [number, number] => fx(x * ICON_HALF, ICON_Y + y * ICON_HALF)
      const unit = ICON_HALF * sx
      const [nx, ny] = fx(0, NUM_Y)
      const num = SERVICES[i].num
      const numPx = (NUM_H / 0.72) * sx
      const [r0x, ry] = fx(-0.045, RULE_Y)
      const [r1x] = fx(0.045, RULE_Y)
      // --- R: the lit lines (added): a soft wide stroke, then a core
      g.globalCompositeOperation = 'lighter'
      g.strokeStyle = 'rgba(255, 0, 0, 0.3)'
      g.fillStyle = 'rgba(255, 0, 0, 0.3)'
      drawIcon(g, i, icon, 0.3 * unit, 0.07 * unit)
      g.strokeStyle = 'rgba(255, 0, 0, 1)'
      g.fillStyle = 'rgba(255, 0, 0, 1)'
      drawIcon(g, i, icon, 0.17 * unit, 0.035 * unit)
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = font(700, numPx)
      g.lineJoin = 'round'
      g.lineWidth = numPx * 0.08
      g.fillText(num, nx, ny)
      g.strokeText(num, nx, ny)
      g.lineCap = 'round'
      g.lineWidth = 0.1 * unit
      g.beginPath()
      g.moveTo(r0x, ry)
      g.lineTo(r1x, ry)
      g.stroke()
      // --- G: polish the thin lines clear (multiply G to 0, keep R/B)
      g.globalCompositeOperation = 'multiply'
      g.strokeStyle = 'rgb(255, 0, 255)'
      g.fillStyle = 'rgb(255, 0, 255)'
      drawIcon(g, i, icon, 0.085 * unit)
      g.font = font(420, numPx)
      g.fillText(num, nx, ny)
      g.lineWidth = 0.05 * unit
      g.beginPath()
      g.moveTo(r0x, ry)
      g.lineTo(r1x, ry)
      g.stroke()
    }
    g.globalCompositeOperation = 'source-over'
    texture.needsUpdate = true
  }
  draw()
  return { texture, redraw: draw }
}

// ------------------------------------------------------------------ fins (glass)

/** copy the triangles of the groups with materialIndex m into a new geometry */
function pickGroups(src: THREE.BufferGeometry, m: number) {
  const out = new THREE.BufferGeometry()
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name) as THREE.BufferAttribute
    const parts: number[] = []
    for (const gr of src.groups) {
      if (gr.materialIndex !== m) continue
      for (let v = gr.start; v < gr.start + gr.count; v++) for (let k = 0; k < a.itemSize; k++) parts.push(a.array[v * a.itemSize + k])
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(parts, a.itemSize))
  }
  return out
}

export interface Fins {
  mesh: THREE.Mesh
  caps: THREE.MeshPhysicalMaterial
  sides: THREE.MeshPhysicalMaterial
}

/** All eleven fins as ONE mesh: [frosted + etched caps, polished bevels]. */
export function buildFins(atlas: THREE.Texture, envMap: THREE.Texture | null): Fins {
  const base = pane(FW, FH, { radius: 0.035, depth: FD, bevel: BEVEL }).geometry
  // clean normals: exactly flat caps (no 'spoke' shading in the frost), smooth bevels
  smoothSides(base)
  flattenCaps(base)
  const caps: THREE.BufferGeometry[] = []
  const sides: THREE.BufferGeometry[] = []
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < N; i++) {
    const g = base.clone()
    g.setAttribute('aFin', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(i), 1))
    arcPoint(i, R, FY, p)
    q.setFromAxisAngle(up, -finAngle(i))
    g.applyMatrix4(m.compose(p, q, new THREE.Vector3(1, 1, 1)))
    caps.push(pickGroups(g, 0))
    sides.push(pickGroups(g, 1))
    g.dispose()
  }
  base.dispose()
  const capG = mergeGeometries(caps)
  const sideG = mergeGeometries(sides)
  const geo = mergeGeometries([capG, sideG], true)
  for (const x of [...caps, ...sides, capG, sideG]) x.dispose()
  geo.computeBoundingSphere()

  // caps: sandblasted, the etch polishes the icon clear. Low env on the frost
  // (bright env on frost reads as pewter); the light behind does the work.
  const capM = frosted({ frost: 0.5, thickness: GLASS_THICKNESS, env: 0.35 }).clone()
  capM.envMap = envMap
  capM.envMapIntensity = 0.35
  capM.roughnessMap = atlas
  capM.onBeforeCompile = shader => {
    shader.uniforms.uZone = { value: ZONE }
    shader.uniforms.uGrid = { value: GRID }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFin;\nvarying float vFin;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFin = aFin;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFin;\n' + ATLAS_GLSL)
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= texture2D( roughnessMap, atlasUv( vRoughnessMapUv, vFin ) ).g;
        #endif
        `,
      )
  }
  capM.customProgramCacheKey = () => 'opal-spectrum-fins'
  const sideM = polished({ thickness: 0.06 }).clone()
  sideM.envMap = envMap
  sideM.envMapIntensity = 1
  const mesh = new THREE.Mesh(geo, [capM, sideM])
  return { mesh, caps: capM, sides: sideM }
}

// ------------------------------------------------------------------ light cards

const CARD_VERT = /* glsl */ `
  attribute float aFin;
  attribute vec3 aColA;
  attribute vec3 aColB;
  attribute float aGain;
  /** fin center x, z and its arc angle */
  attribute vec3 aFrame;
  uniform float uLevel[${N}];
  uniform float uZFront, uZCard, uFinY, uThick, uIor;
  varying vec2 vL;
  varying vec2 vEtch;
  varying float vFin, vLevel;
  varying vec3 vColA, vColB;
  varying float vFacing;
  varying float vGain;
  void main() {
    vGain = aGain;
    vec4 w = modelMatrix * vec4(position, 1.0);
    float a = aFrame.z;
    vec3 n = vec3(-sin(a), 0.0, cos(a));
    vec3 t = vec3(cos(a), 0.0, sin(a));
    vec3 o = vec3(aFrame.x, uFinY, aFrame.y);
    vL = vec2(dot(w.xyz - o, t), w.y - uFinY);
    // where the camera ray through this point crosses the FRONT cap: the card
    // lights the lines the polished window shows from here (parallel planes →
    // an affine map, exact under linear interpolation)
    float h = dot(cameraPosition - w.xyz, n);
    float k = (h - (uZFront - uZCard)) / max(h, 1e-3);
    vec3 x = cameraPosition + (w.xyz - cameraPosition) * k;
    // three's transmission bends the ray through the glass (refract × thickness)
    // before it reads what's behind: the front point that shows THIS card point
    // sits a little off the straight line — follow the same bend back
    vec3 d = normalize(x - cameraPosition);
    vec3 r = refract(d, n, 1.0 / uIor);
    float s = uThick * dot(r, -n) / max(dot(d, -n), 1e-3);
    vec3 pf = x + d * s - r * uThick;
    vEtch = vec2(dot(pf - o, t), pf.y - uFinY);
    vFin = aFin;
    vLevel = uLevel[int(aFin + 0.5)];
    vColA = aColA * aGain;
    vColB = aColB * aGain;
    vFacing = abs(dot(normalize(cameraPosition - w.xyz), n));
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`
const CARD_FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uHdr, uIconHdr, uFill, uTubeX, uTubeHalf, uCW, uCH;
  varying vec2 vL;
  varying vec2 vEtch;
  varying float vFin, vLevel;
  varying vec3 vColA, vColB;
  varying float vFacing;
  varying float vGain;
  ${ATLAS_GLSL}
  float sq(float x) { return x * x; }
  void main() {
    float ax = abs(vL.x);
    // the tube pair: a fine core (seen crisp only through a polished line) and its bloom in the frost
    float core = exp(-sq((ax - uTubeX) / 0.012));
    float halo = exp(-sq((ax - uTubeX) / 0.085));
    float len = 1.0 - smoothstep(uTubeHalf - 0.1, uTubeHalf, abs(vL.y));
    vec3 tubeCol = vL.x < 0.0 ? vColA : vColB;
    vec3 fillCol = mix(vColA, vColB, smoothstep(-uTubeX, uTubeX, vL.x));
    // a card seen very obliquely (past the glass edge) shows no bare core
    float coreK = smoothstep(0.55, 0.8, vFacing);
    float fill = exp(-sq(vL.y / 1.05)) * exp(-sq(vL.x / 0.22));
    // a quieter field behind the icon, so its polished lines read against the frost
    fill *= 1.0 - 0.6 * exp(-sq((vL.y - 0.2) / 0.4)) * exp(-sq(vL.x / 0.3));
    vec3 c = tubeCol * (core * coreK * 1.1 + halo * 0.5) * len * uHdr + fillCol * fill * uFill;
    // soft card edges
    vec2 e = smoothstep(vec2(0.0), vec2(0.035), vec2(uCW, uCH) * 0.5 - abs(vL));
    c *= e.x * e.y;
    // the icon's lit lines, registered with the etch (hot: whiter at the core)
    float icon = texture2D(uAtlas, atlasUv(vEtch, vFin)).r;
    vec3 hot = mix(fillCol, vec3(vGain), 0.3);
    float lv = vLevel;
    c = c * lv + hot * icon * uIconHdr * lv * lv;
    gl_FragColor = vec4(c, 1.0);
  }
`

export interface Cards {
  mesh: THREE.Mesh
  levels: Float32Array
  uniforms: Record<string, THREE.IUniform>
}

export function buildCards(atlas: THREE.Texture): Cards {
  const geos: THREE.BufferGeometry[] = []
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const m = new THREE.Matrix4()
  const up = new THREE.Vector3(0, 1, 0)
  const ca = new THREE.Color()
  const cb = new THREE.Color()
  for (let i = 0; i < N; i++) {
    const g = new THREE.PlaneGeometry(CW, CH, 4, 24)
    g.deleteAttribute('uv')
    g.deleteAttribute('normal')
    const n = g.getAttribute('position').count
    const t = finT(i)
    spectrum(t - 0.035, ca)
    spectrum(t + 0.035, cb)
    const fin = new Float32Array(n).fill(i)
    const A = new Float32Array(n * 3)
    const B = new Float32Array(n * 3)
    const F = new Float32Array(n * 3)
    arcPoint(i, R, FY, p)
    for (let v = 0; v < n; v++) {
      A.set([ca.r, ca.g, ca.b], v * 3)
      B.set([cb.r, cb.g, cb.b], v * 3)
      F.set([p.x, p.z, finAngle(i)], v * 3)
    }
    g.setAttribute('aFin', new THREE.Float32BufferAttribute(fin, 1))
    g.setAttribute('aColA', new THREE.Float32BufferAttribute(A, 3))
    g.setAttribute('aColB', new THREE.Float32BufferAttribute(B, 3))
    g.setAttribute('aFrame', new THREE.Float32BufferAttribute(F, 3))
    g.setAttribute('aGain', new THREE.Float32BufferAttribute(new Float32Array(n).fill(finGain(i)), 1))
    // behind the fin's back cap
    const a = finAngle(i)
    const off = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(Z_CARD)
    q.setFromAxisAngle(up, -a)
    g.applyMatrix4(m.compose(p.clone().add(off), q, new THREE.Vector3(1, 1, 1)))
    geos.push(g)
  }
  const geo = mergeGeometries(geos)
  for (const g of geos) g.dispose()
  geo.computeBoundingSphere()
  const levels = new Float32Array(N)
  const uniforms: Record<string, THREE.IUniform> = {
    uLevel: { value: Array.from(levels) },
    uAtlas: { value: atlas },
    uZone: { value: ZONE },
    uGrid: { value: GRID },
    uZFront: { value: Z_FRONT },
    uZCard: { value: Z_CARD },
    uFinY: { value: FY },
    uThick: { value: GLASS_THICKNESS },
    uIor: { value: 1.5 },
    uHdr: { value: 1.7 },
    uIconHdr: { value: 2.4 },
    uFill: { value: 0.32 },
    uTubeX: { value: TUBE_X },
    uTubeHalf: { value: TUBE_HALF },
    uCW: { value: CW },
    uCH: { value: CH },
  }
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: CARD_VERT, fragmentShader: CARD_FRAG })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  return { mesh, levels, uniforms }
}

// ------------------------------------------------------------------ floor pools

const POOL_VERT = /* glsl */ `
  attribute float aFin;
  attribute vec3 aCol;
  attribute vec2 aL;
  attribute float aGain;
  uniform float uLevel[${N}];
  varying vec2 vL;
  varying vec3 vCol;
  varying float vLevel;
  void main() {
    vL = aL;
    vCol = aCol * aGain;
    vLevel = uLevel[int(aFin + 0.5)];
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const POOL_FRAG = /* glsl */ `
  uniform float uK;
  varying vec2 vL;
  varying vec3 vCol;
  varying float vLevel;
  float sq(float x) { return x * x; }
  void main() {
    // vL.x across the fin (world units), vL.y out from its foot toward the viewer (0..1)
    float z = vL.y;
    // the fin's reflection in polished stone: a soft vertical streak from its foot
    float streak = exp(-sq(vL.x / 0.2)) * exp(-z * 3.2) * (1.0 - exp(-z * 40.0));
    // and the light pooling on the floor round it
    float pool = exp(-sq(vL.x / 0.5) - sq(z / 0.45));
    // (1 - smoothstep(a, b, x), never reversed edges: undefined in GLSL ES)
    float edge = (1.0 - smoothstep(0.2, 0.5, abs(vL.x) / 1.4)) * (1.0 - smoothstep(0.7, 1.0, z));
    gl_FragColor = vec4(vCol * (streak * 0.55 + pool * 0.22) * edge * vLevel * uK, 1.0);
  }
`

export interface Pools {
  mesh: THREE.Mesh
  uniforms: Record<string, THREE.IUniform>
}

export function buildPools(): Pools {
  const geos: THREE.BufferGeometry[] = []
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  const up = new THREE.Vector3(0, 1, 0)
  const W = 1.4
  const D = 2.6
  for (let i = 0; i < N; i++) {
    // a floor quad in front of fin i: x across, z toward the arc's center
    const g = new THREE.PlaneGeometry(W, D)
    g.rotateX(-Math.PI / 2)
    g.translate(0, 0, D / 2 + 0.02)
    g.deleteAttribute('normal')
    const pos = g.getAttribute('position')
    const n = pos.count
    const L = new Float32Array(n * 2)
    for (let v = 0; v < n; v++) L.set([pos.getX(v), (pos.getZ(v) - 0.02) / D], v * 2)
    spectrum(finT(i), c)
    const C = new Float32Array(n * 3)
    for (let v = 0; v < n; v++) C.set([c.r, c.g, c.b], v * 3)
    g.setAttribute('aL', new THREE.Float32BufferAttribute(L, 2))
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3))
    g.setAttribute('aFin', new THREE.Float32BufferAttribute(new Float32Array(n).fill(i), 1))
    g.setAttribute('aGain', new THREE.Float32BufferAttribute(new Float32Array(n).fill(finGain(i)), 1))
    g.deleteAttribute('uv')
    arcPoint(i, R, 0.004, p)
    q.setFromAxisAngle(up, -finAngle(i))
    g.applyMatrix4(m.compose(p, q, new THREE.Vector3(1, 1, 1)))
    geos.push(g)
  }
  const geo = mergeGeometries(geos)
  for (const g of geos) g.dispose()
  geo.computeBoundingSphere()
  const uniforms: Record<string, THREE.IUniform> = { uLevel: { value: new Array(N).fill(0) }, uK: { value: 1 } }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 1
  return { mesh, uniforms }
}
