import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { flattenCaps, frosted, polished, smoothSides } from '../../kit/glass'
import { lightCard, type LightCard } from '../../kit/opal'
import { neonFromStrokes, type NeonPart } from '../../kit/neon'
import { logoOutlines, logoParts } from '../../logo/logo'

/*
 * THE STUDIO's pieces (process chapter only).
 *
 *   slabGeometry(w, h, depth, r)   a rounded glass slab: group 0 = the two
 *                                  flat caps (frosted + etched), group 1 = the
 *                                  deep round bevel (POLISHED — it carries the
 *                                  hairline sweep)
 *   etchedFrost(tex, cells)        the caps material: kit frost + an etch read
 *                                  through CELLS (pane rects mapped onto rows
 *                                  of one atlas), with a DRAW ORDER channel so
 *                                  a sketch can polish itself in, line by line
 *   lightSlab(o)                   slab + light card + tube bank + a satin
 *                                  black housing: one standing light piece
 *   sketchCanvas / designCanvas    the design: the Hark mark inside a fine ring
 *   statCanvas                     the three figures in thin Hanken Grotesk
 *   floorSpill(w, d)               a soft additive pool of the piece's light
 *                                  on the black stone floor
 *
 * Etch texture channels (NoColorSpace): G = 1 frosted / 0 polished; R = the
 * stroke's draw order (0..1). The background is (255, 255, 0): its R = 1, so
 * a stroke's anti-aliased edge only polishes once the front has passed its
 * core (no ghost of the path ahead). Static designs paint black (order 0).
 */

// ------------------------------------------------------------------ glass

export function slabGeometry(w: number, h: number, depth: number, radius: number, mobile: boolean) {
  // a deep round bevel (~0.72 of its thickness): the edge is one continuous
  // round that catches a clean hairline, never a dashed strip (Frost)
  const bevT = Math.min(0.036, depth * 0.4)
  const bevS = bevT * 0.72
  const iw = w - 2 * bevS
  const ih = h - 2 * bevS
  const r = Math.max(0.002, Math.min(radius, iw / 2, ih / 2) - bevS * 0.5)
  const s = new THREE.Shape()
  const x = -iw / 2
  const y = -ih / 2
  s.moveTo(x + r, y)
  s.lineTo(x + iw - r, y)
  s.quadraticCurveTo(x + iw, y, x + iw, y + r)
  s.lineTo(x + iw, y + ih - r)
  s.quadraticCurveTo(x + iw, y + ih, x + iw - r, y + ih)
  s.lineTo(x + r, y + ih)
  s.quadraticCurveTo(x, y + ih, x, y + ih - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  const core = Math.max(0.004, depth - 2 * bevT)
  const g = new THREE.ExtrudeGeometry(s, {
    depth: core,
    bevelEnabled: true,
    bevelThickness: bevT,
    bevelSize: bevS,
    bevelSegments: mobile ? 4 : 7,
    curveSegments: 8,
    steps: 1,
  })
  g.translate(0, 0, -core / 2)
  const out = toCreasedNormals(g, Math.PI / 4.5)
  g.dispose()
  smoothSides(out)
  flattenCaps(out)
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/** A pane rect (center + size, pane units) and the atlas rect it reads (u0, v0, u1, v1). */
export interface Cell {
  cx: number
  cy: number
  w: number
  h: number
  atlas: [number, number, number, number]
}

export interface EtchUniforms {
  uEtchDraw: { value: number }
  uEtchPolish: { value: number }
  uEtchCell: { value: THREE.Vector4[] }
  uEtchAtlas: { value: THREE.Vector4[] }
}

const ETCH_PARS = /* glsl */ `
uniform float uEtchDraw;
uniform float uEtchPolish;
uniform vec4 uEtchCell[3];
uniform vec4 uEtchAtlas[3];
`
// every cell is sampled unconditionally (uniform control flow keeps the
// texture's implicit derivatives valid), then masked
const ETCH_FRAG = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  float etchK = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 c = uEtchCell[i];
    vec2 q = (vRoughnessMapUv - c.xy) / max(c.zw, vec2(1e-4));
    vec4 a = uEtchAtlas[i];
    vec4 t = texture2D(roughnessMap, mix(a.xy, a.zw, q * 0.5 + 0.5));
    float inside = step(abs(q.x), 1.0) * step(abs(q.y), 1.0) * step(1e-4, c.z);
    float drawn = 1.0 - smoothstep(uEtchDraw - 0.012, uEtchDraw, t.r);
    etchK = max(etchK, inside * (1.0 - t.g) * drawn);
  }
  roughnessFactor = mix(roughness, uEtchPolish, etchK);
#endif
`

/**
 * Frosted caps with an etched design read through `cells` of one atlas texture.
 * Pass `env` (ctx.world.envMap): the frost then takes only a trace of the
 * studio (envK) — at the scene's full reflection a rough cap wears a grey veil
 * that turns dim light behind it to taupe; the polished bevels carry the studio.
 */
export function etchedFrost(tex: THREE.Texture, cells: Cell[], o: { frost?: number; thickness?: number; env?: THREE.Texture | null; envK?: number } = {}) {
  const m = frosted({ frost: o.frost ?? 0.56, thickness: o.thickness ?? 0.14 }).clone()
  m.roughnessMap = tex
  if (o.env) {
    m.envMap = o.env
    m.envMapIntensity = o.envK ?? 0.12
  }
  const u: EtchUniforms = {
    uEtchDraw: { value: 1.02 },
    uEtchPolish: { value: 0.02 },
    uEtchCell: { value: [0, 1, 2].map(() => new THREE.Vector4()) },
    uEtchAtlas: { value: [0, 1, 2].map(() => new THREE.Vector4()) },
  }
  setCells(u, cells)
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u)
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <roughnessmap_pars_fragment>', '#include <roughnessmap_pars_fragment>\n' + ETCH_PARS)
      .replace('#include <roughnessmap_fragment>', ETCH_FRAG)
  }
  m.customProgramCacheKey = () => 'opal-process-etch'
  return { material: m, u }
}

export function setCells(u: EtchUniforms, cells: Cell[]) {
  for (let i = 0; i < 3; i++) {
    const c = cells[i]
    if (c) {
      u.uEtchCell.value[i].set(c.cx, c.cy, c.w / 2, c.h / 2)
      u.uEtchAtlas.value[i].set(...c.atlas)
    } else {
      u.uEtchCell.value[i].set(0, 0, 0, 0)
      u.uEtchAtlas.value[i].set(0, 0, 1, 1)
    }
  }
}

/** A canvas texture for an etch atlas (never color-managed). */
export function etchTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = 4
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  return t
}

// ------------------------------------------------------------------ the light piece

let housingMat: THREE.MeshStandardMaterial | null = null
let sidesMat: THREE.MeshPhysicalMaterial | null = null

/** the studio's reflection on a polished bevel (its own envMap, so it counts): crisp hairlines along every edge */
export const BEVEL_ENV = 1.4

/** A polished bevel that carries the studio's hairlines (own envMap: sweep it with envMapRotation, not world envTurn). */
export function polishedBevel(env: THREE.Texture | null) {
  const m = polished({ thickness: 0.06 }).clone()
  if (env) {
    m.envMap = env
    m.envMapIntensity = BEVEL_ENV
  }
  return m
}

export interface LightSlabOptions {
  w: number
  h: number
  depth?: number
  /** card distance behind the glass */
  gap?: number
  radius?: number
  mobile: boolean
  geometry?: THREE.BufferGeometry
  caps: THREE.Material
  /** the polished bevel (default: a shared polished glass) */
  sides?: THREE.Material
  /** light card */
  a: string
  b?: string
  angle?: number
  hdr?: number
  /** tubes: 'v' = a vertical bank across the width; 'h' = rows across the height */
  tubes?: { n: number; dir: 'v' | 'h'; span?: number; len?: number; at?: number[]; hdr?: number; color?: string; radius?: number }
  envMap: THREE.Texture | null
}

export interface LightSlab {
  group: THREE.Group
  glass: THREE.Mesh
  card: LightCard
  tubes: NeonPart[]
  /** the tubes' x (v) or y (h) positions */
  tubeAt: number[]
}

/**
 * One standing light piece: the glass slab in front, a light card at `gap`
 * behind it, tubes between them, all inside a satin-black housing whose open
 * face the glass covers. Local origin = the glass center; the glass faces +z.
 */
export function lightSlab(o: LightSlabOptions): LightSlab {
  const group = new THREE.Group()
  const depth = o.depth ?? 0.09
  const gap = o.gap ?? 0.3
  const geo = o.geometry ?? slabGeometry(o.w, o.h, depth, o.radius ?? 0.035, o.mobile)
  sidesMat ??= polishedBevel(o.envMap)
  const glass = new THREE.Mesh(geo, [o.caps, o.sides ?? sidesMat])
  group.add(glass)

  // the light card, and a black backing so nothing behind it shows through
  const card = lightCard(o.w * 0.9, o.h * 0.9, { a: o.a, b: o.b ?? o.a, angle: o.angle ?? 0, hdr: o.hdr ?? 0.5, soft: 0.16 })
  card.position.z = -depth / 2 - gap
  group.add(card)

  // the housing: an open box behind the glass (satin, so it never reads as a hole)
  housingMat ??= new THREE.MeshStandardMaterial({ color: 0x07060a, roughness: 0.42, metalness: 0.3, envMap: o.envMap, envMapIntensity: 0.3, side: THREE.DoubleSide })
  const hw = o.w * 0.975
  const hh = o.h * 0.975
  const hd = gap + 0.06
  const box = new THREE.BoxGeometry(hw, hh, hd)
  const invisible = new THREE.MeshBasicMaterial({ visible: false })
  const housing = new THREE.Mesh(box, [housingMat, housingMat, housingMat, housingMat, invisible, housingMat])
  housing.position.z = -depth / 2 - hd / 2 + 0.004
  group.add(housing)

  const tubes: NeonPart[] = []
  const tubeAt: number[] = []
  if (o.tubes && o.tubes.n > 0) {
    const t = o.tubes
    const n = t.n
    const vertical = t.dir === 'v'
    const span = t.span ?? (vertical ? o.w * 0.8 : o.h * 0.7)
    const len = t.len ?? (vertical ? o.h * 0.86 : o.w * 0.9)
    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0.5 : i / (n - 1)
      const at = t.at?.[i] ?? -span / 2 + span * k
      const a = vertical ? new THREE.Vector3(0, -len / 2, 0) : new THREE.Vector3(-len / 2, 0, 0)
      const b = vertical ? new THREE.Vector3(0, len / 2, 0) : new THREE.Vector3(len / 2, 0, 0)
      const part = neonFromStrokes([{ pts: [a, b] }], {
        color: t.color ?? o.a,
        radius: t.radius ?? 0.012,
        hdr: t.hdr ?? 2.2,
        blockout: false,
        electrodes: false,
        smooth: false,
        caps: false,
        radial: o.mobile ? 6 : 8,
      })
      if (vertical) part.group.position.set(at, 0, -depth / 2 - gap * 0.45)
      else part.group.position.set(0, at, -depth / 2 - gap * 0.45)
      group.add(part.group)
      tubes.push(part)
      tubeAt.push(at)
    }
  }
  return { group, glass, card, tubes, tubeAt }
}

// ------------------------------------------------------------------ etch light

const ETCH_LIGHT_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uBaseA, uBaseB, uLine;
  uniform float uDraw, uLevel, uBias, uGain, uSoft;
  uniform vec2 uSize;
  uniform vec4 uCell[3];
  uniform vec4 uAtlas[3];
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * uSize;
    float halo = 0.0;
    float core = 0.0;
    for (int i = 0; i < 3; i++) {
      vec4 c = uCell[i];
      vec2 q = (p - c.xy) / max(c.zw, vec2(1e-4));
      vec4 a = uAtlas[i];
      vec2 st = mix(a.xy, a.zw, q * 0.5 + 0.5);
      // a softened read (a coarser mip): the light line is wider than the
      // polished line in front, so the window always sees it
      vec4 t = texture2D(uMap, st, uBias);
      vec4 k = texture2D(uMap, st);
      float inside = step(abs(q.x), 1.0) * step(abs(q.y), 1.0) * step(1e-4, c.z);
      halo = max(halo, inside * clamp((1.0 - t.g) * uGain, 0.0, 1.0) * (1.0 - smoothstep(uDraw - 0.02, uDraw, t.r)));
      core = max(core, inside * (1.0 - k.g) * (1.0 - smoothstep(uDraw - 0.012, uDraw, k.r)));
    }
    vec2 e = smoothstep(vec2(0.0), vec2(uSoft), (0.5 - abs(vUv - 0.5)) * uSize);
    vec3 base = mix(uBaseA, uBaseB, vUv.x) * e.x * e.y;
    gl_FragColor = vec4((base + uLine * max(halo * 0.6, core)) * uLevel, 1.0);
  }
`

/**
 * The design drawn in LIGHT, right behind the glass (sheet one's sketch, the
 * stats' figures): a faint field plus the etch's own strokes, read through
 * the same cells as the glass in front. The frost spreads it into a soft halo
 * that follows the strokes; the polished strokes show it crisp. (A uniform
 * card behind a polished line reads exactly like the frost around it.)
 * w × h is the plane's size in pane units (centered on the pane).
 */
export function etchLight(w: number, h: number, map: THREE.Texture, cells: Cell[], o: { a: string; b?: string; line: string; base: number; hdr: number; soft?: number; gain?: number; bias?: number }) {
  const cellV = [0, 1, 2].map(i => (cells[i] ? new THREE.Vector4(cells[i].cx, cells[i].cy, cells[i].w / 2, cells[i].h / 2) : new THREE.Vector4()))
  const atlasV = [0, 1, 2].map(i => (cells[i] ? new THREE.Vector4(...cells[i].atlas) : new THREE.Vector4(0, 0, 1, 1)))
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uBaseA: { value: new THREE.Color(o.a).multiplyScalar(o.base) },
      uBaseB: { value: new THREE.Color(o.b ?? o.a).multiplyScalar(o.base) },
      uLine: { value: new THREE.Color(o.line).multiplyScalar(o.hdr) },
      uDraw: { value: 1.02 },
      uLevel: { value: 1 },
      uBias: { value: o.bias ?? 1.6 },
      uGain: { value: o.gain ?? 2.2 },
      uSoft: { value: o.soft ?? 0.2 },
      uSize: { value: new THREE.Vector2(w, h) },
      uCell: { value: cellV },
      uAtlas: { value: atlasV },
    },
    vertexShader: SPILL_VERT,
    fragmentShader: ETCH_LIGHT_FRAG,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  return { mesh, u: mat.uniforms as { uDraw: { value: number }; uLevel: { value: number } } }
}

// ------------------------------------------------------------------ bevel glint

const GLINT_PARS = /* glsl */ `
uniform vec3 uGlint;
uniform float uGlintAt, uGlintW;
uniform vec2 uGlintSize;
varying vec3 vGlintPos;
`
const GLINT_FRAG = /* glsl */ `
  {
    // where this bit of bevel sits around the perimeter (0..1, from the
    // bottom-left corner, counter-clockwise)
    vec2 hs = uGlintSize * 0.5;
    vec2 p = vGlintPos.xy;
    float P = 2.0 * (uGlintSize.x + uGlintSize.y);
    float s;
    if (hs.x - abs(p.x) < hs.y - abs(p.y)) s = p.x > 0.0 ? uGlintSize.x + (p.y + hs.y) : 2.0 * uGlintSize.x + uGlintSize.y + (hs.y - p.y);
    else s = p.y < 0.0 ? (p.x + hs.x) : uGlintSize.x + uGlintSize.y + (hs.x - p.x);
    float d = s / P - uGlintAt;
    d -= floor(d + 0.5);
    float g = exp(-d * d / (uGlintW * uGlintW));
    outgoingLight += uGlint * g;
  }
`

/**
 * A polished bevel with a hairline of light that travels around the piece's
 * perimeter (uGlintAt 0..1): the finished piece being looked after.
 */
export function glintBevel(w: number, h: number, env: THREE.Texture | null) {
  const m = polishedBevel(env)
  const u = {
    uGlint: { value: new THREE.Color(0, 0, 0) },
    uGlintAt: { value: 0 },
    uGlintW: { value: 0.028 },
    uGlintSize: { value: new THREE.Vector2(w, h) },
  }
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'varying vec3 vGlintPos;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlintPos = position;')
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', GLINT_PARS + '\nvoid main() {')
      .replace('#include <opaque_fragment>', GLINT_FRAG + '\n#include <opaque_fragment>')
  }
  m.customProgramCacheKey = () => 'opal-process-glint'
  return { material: m, u }
}

// ------------------------------------------------------------------ floor spill

const SPILL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const SPILL_FRAG = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uLevel, uFoot;
  varying vec2 vUv;
  void main() {
    // x across the piece; y from behind the piece (0) toward the viewer (1),
    // brightest at its foot (uFoot), soft on both sides
    float fx = smoothstep(0.0, 0.32, vUv.x) * (1.0 - smoothstep(0.68, 1.0, vUv.x));
    float d = vUv.y - uFoot;
    float fy = d < 0.0 ? exp(-d * d / 0.004) : exp(-d * 3.0);
    fy *= 1.0 - smoothstep(0.8, 1.0, vUv.y);
    vec3 c = mix(uA, uB, vUv.x);
    gl_FragColor = vec4(c * uLevel * fx * fy, 1.0);
  }
`

/** A soft pool of the piece's light on the stone floor, from under it toward the viewer. */
export function floorSpill(w: number, d: number, back = 0.4) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uLevel: { value: 0 }, uFoot: { value: back / (back + d) } },
    vertexShader: SPILL_VERT,
    fragmentShader: SPILL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const geo = new THREE.PlaneGeometry(w, d + back)
  // uv.y = 0 at the back edge (behind the glass), 1 toward the viewer
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0, (d - back) / 2)
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 2
  return {
    mesh,
    set(a: THREE.Color, b: THREE.Color, level: number) {
      mat.uniforms.uA.value.copy(a)
      mat.uniforms.uB.value.copy(b)
      mat.uniforms.uLevel.value = level
    },
  }
}

// ------------------------------------------------------------------ floor fade

/**
 * Dissolve the stone floor into the dark outside a world-space box (x0..x1,
 * z0..z1; soft = fade width in x and z): no hard horizon where its far edge
 * meets the backdrop. In the shader (world xz), so no alpha canvas to hold.
 */
export function fadeFloor(floor: THREE.Mesh, box: { x0: number; x1: number; z0: number; z1: number; softX: number; softZ: number }) {
  const m = floor.material as THREE.MeshStandardMaterial
  m.transparent = true
  const u = {
    uFloorBox: { value: new THREE.Vector4(box.x0, box.x1, box.z0, box.z1) },
    uFloorSoft: { value: new THREE.Vector2(box.softX, box.softZ) },
  }
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u)
    sh.vertexShader = 'varying vec2 vFloorW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloorW = (modelMatrix * vec4(position, 1.0)).xz;')
    sh.fragmentShader =
      'varying vec2 vFloorW;\nuniform vec4 uFloorBox;\nuniform vec2 uFloorSoft;\n' +
      sh.fragmentShader.replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
        {
          vec2 w = vFloorW;
          float ax = smoothstep(uFloorBox.x - uFloorSoft.x, uFloorBox.x, w.x) * (1.0 - smoothstep(uFloorBox.y, uFloorBox.y + uFloorSoft.x, w.x));
          float az = smoothstep(uFloorBox.z - uFloorSoft.y, uFloorBox.z, w.y) * (1.0 - smoothstep(uFloorBox.w, uFloorBox.w + uFloorSoft.y, w.y));
          diffuseColor.a *= ax * az;
        }`,
      )
  }
  m.customProgramCacheKey = () => 'opal-process-floor'
  m.needsUpdate = true
}

// ------------------------------------------------------------------ the design

/** Where the design sits on a W × H panel (pane units). */
export interface DesignSpec {
  cy: number
  /** the mark's height */
  mark: number
  /** the ring's radius and line width */
  ring: number
  ringLine: number
}

function makeCanvas(w: number, h: number, res: number) {
  const s = res / Math.max(w, h)
  const c = document.createElement('canvas')
  c.width = Math.max(16, Math.round(w * s))
  c.height = Math.max(16, Math.round(h * s))
  const g = c.getContext('2d')!
  g.fillStyle = 'rgb(255,255,0)'
  g.fillRect(0, 0, c.width, c.height)
  const sx = c.width / w
  const sy = c.height / h
  const toPx = (x: number, y: number): [number, number] => [(x + w / 2) * sx, (h / 2 - y) * sy]
  return { c, g, s: sx, toPx }
}

/** The finished design: the Hark mark polished clear inside a fine polished ring (static). */
export function designCanvas(w: number, h: number, res: number, d: DesignSpec) {
  const { c, g, s, toPx } = makeCanvas(w, h, res)
  g.fillStyle = '#000'
  g.strokeStyle = '#000'
  // the ring
  const [cx, cy] = toPx(0, d.cy)
  g.lineWidth = d.ringLine * s
  g.beginPath()
  g.arc(cx, cy, d.ring * s, 0, Math.PI * 2)
  g.stroke()
  // the mark, filled (holes even-odd)
  const parts = logoParts()
  g.beginPath()
  for (const sh of [...parts.loopA, ...parts.loopB, ...parts.diamond]) {
    const trace = (pts: THREE.Vector2[]) => {
      pts.forEach((p, i) => {
        const [x, y] = toPx(p.x * d.mark, d.cy + p.y * d.mark)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      })
      g.closePath()
    }
    trace(sh.getPoints(64))
    for (const hole of sh.holes) trace(hole.getPoints(32))
  }
  g.fill('evenodd')
  return c
}

/**
 * The first sketch: construction lines (a vertical and a horizontal axis,
 * then the ring), then the mark's contour, each stroke painted with its draw
 * order in R so the glass polishes it in as uEtchDraw runs 0 → 1.
 */
export function sketchCanvas(w: number, h: number, res: number, d: DesignSpec, o: { guide: number; line: number }) {
  const { c, g, s, toPx } = makeCanvas(w, h, res)
  type Line = { pts: THREE.Vector2[]; width: number; closed?: boolean }
  const V = (x: number, y: number) => new THREE.Vector2(x, y)
  const guides: Line[] = []
  const ext = d.ring * 1.22
  guides.push({ pts: [V(0, d.cy + ext), V(0, d.cy - ext)], width: o.guide })
  guides.push({ pts: [V(-ext, d.cy), V(ext, d.cy)], width: o.guide })
  const ring: THREE.Vector2[] = []
  for (let i = 0; i <= 160; i++) {
    const a = Math.PI / 2 + (i / 160) * Math.PI * 2
    ring.push(V(Math.cos(a) * d.ring, d.cy + Math.sin(a) * d.ring))
  }
  guides.push({ pts: ring, width: d.ringLine })
  const contour: Line[] = logoOutlines(undefined, 140).map(pl => ({
    pts: pl.map(p => V(p.x * d.mark, d.cy + p.y * d.mark)),
    width: o.line,
    closed: true,
  }))
  const len = (l: Line) => {
    let t = 0
    for (let i = 1; i < l.pts.length; i++) t += l.pts[i].distanceTo(l.pts[i - 1])
    if (l.closed) t += l.pts[0].distanceTo(l.pts[l.pts.length - 1])
    return t
  }
  // guides take the first 30% of the drawing, the contour the rest
  const paint = (lines: Line[], o0: number, o1: number) => {
    const total = lines.reduce((a, l) => a + len(l), 0) || 1
    let acc = 0
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const l of lines) {
      const pts = l.closed ? [...l.pts, l.pts[0]] : l.pts
      g.lineWidth = Math.max(1.2, l.width * s)
      for (let i = 1; i < pts.length; i++) {
        const seg = pts[i].distanceTo(pts[i - 1])
        const ord = o0 + ((acc + seg * 0.5) / total) * (o1 - o0)
        acc += seg
        const r = Math.round(Math.min(1, Math.max(1 / 255, ord)) * 255)
        g.strokeStyle = `rgb(${r},0,0)`
        const [x0, y0] = toPx(pts[i - 1].x, pts[i - 1].y)
        const [x1, y1] = toPx(pts[i].x, pts[i].y)
        g.beginPath()
        g.moveTo(x0, y0)
        g.lineTo(x1, y1)
        g.stroke()
      }
    }
  }
  paint(guides, 0, 0.3)
  paint(contour, 0.3, 1)
  return c
}

// ------------------------------------------------------------------ the figures

export const FIGURE_FONT = '"Hanken Grotesk Variable", "Hanken Grotesk", system-ui, sans-serif'

/**
 * The three stat figures, one per atlas row (row k spans [k/3, (k+1)/3) of
 * the canvas height, top to bottom). A cell's aspect must match its row:
 * cellW / cellH = canvas.width / rowHeight. Thin sans numerals (Hanken
 * Grotesk: plain zero, open 5); "years" is set small on the numerals'
 * baseline, and the $ and + of $1M+ ride at the numerals' mid height.
 */
export function statCanvas(res: number, weight = 260) {
  const c = document.createElement('canvas')
  c.width = res
  c.height = res
  const g = c.getContext('2d')!
  g.fillStyle = 'rgb(255,255,0)'
  g.fillRect(0, 0, res, res)
  g.fillStyle = '#000'
  g.textBaseline = 'alphabetic'
  const row = res / 3
  const big = row * 0.84
  const font = (px: number, w = weight) => `${w} ${px}px ${FIGURE_FONT}`
  // measure the cap height of the numerals at this size
  g.font = font(big)
  const m1 = g.measureText('10')
  const cap = m1.actualBoundingBoxAscent || big * 0.7
  // mid: the glyph's own center sits at the numerals' mid height
  const runs: { t: string; px: number; w?: number; mid?: boolean; gap?: number }[][] = [
    [{ t: '10', px: big }, { t: 'years', px: big * 0.36, w: weight + 70, gap: big * 0.12 }],
    [{ t: '$', px: big * 0.6, mid: true, gap: 0 }, { t: '1M', px: big, gap: big * 0.03 }, { t: '+', px: big * 0.6, mid: true, gap: big * 0.05 }],
    [{ t: '15', px: big }],
  ]
  runs.forEach((rs, k) => {
    let total = 0
    const widths = rs.map(r => {
      g.font = font(r.px, r.w)
      const wd = g.measureText(r.t).width + (r.gap ?? 0)
      total += wd
      return wd
    })
    let x = (res - total) / 2
    // baseline: the numerals' cap centered in the row
    const base = k * row + row / 2 + cap / 2
    rs.forEach((r, i) => {
      g.font = font(r.px, r.w)
      x += r.gap ?? 0
      let y = base
      if (r.mid) {
        const m = g.measureText(r.t)
        y = base - cap / 2 + ((m.actualBoundingBoxAscent || 0) - (m.actualBoundingBoxDescent || 0)) / 2
      }
      g.fillText(r.t, x, y)
      x += widths[i] - (r.gap ?? 0)
    })
  })
  return c
}

const ROW_PAD = 0.004
/** Atlas rect (u0, v0, u1, v1) of stat row k in a flipY canvas texture. */
export function statRow(k: number): [number, number, number, number] {
  return [0, 1 - (k + 1) / 3 + ROW_PAD, 1, 1 - k / 3 - ROW_PAD]
}
/** width / height of a stat cell (it must match its atlas row, or the figures stretch) */
export const STAT_ASPECT = 1 / (1 / 3 - 2 * ROW_PAD)
