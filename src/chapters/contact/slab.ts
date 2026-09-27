import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { DUSK, etchMap, stoneFloor } from '../../kit/opal'
import { frosted, pane } from '../../kit/glass'

/*
 * THE FOYER SLAB — one long, low light box: a thick frosted glass front with
 * "Say hello." POLISHED clear into it, a bank of thin horizontal tubes and a
 * soft gradient card inside a satin-black housing, standing on black stone.
 *
 * Why horizontal tubes: the etch is an italic serif; horizontal lines cross
 * every stroke at nearly a right angle, so each letter shows the same crisp
 * rules of light (vertical tubes would run along some slanted strokes and
 * miss others). The frost blurs the same bank into an even glow around them.
 *
 * One custom gradient (blush → lilac → periwinkle, left → right) is shared by
 * the card, the tubes and the light the slab spills onto the floor; a single
 * `sweep` (0..1 across the slab, soft front) lights all three from left to
 * right, so the words come alive letter by letter. `front` adds a moving
 * brighter band at the sweep's edge (the light passing behind the letters).
 *
 * Floor at y = 0; the slab's glass front faces +z, centred on x = 0.
 */

export const SLAB = {
  /** glass width / height / thickness (world units) */
  W: 6,
  H: 1.62,
  D: 0.16,
  /** air between the glass and the card */
  GAP: 0.3,
  /** the glass's bottom edge above the floor (a slim black plinth) */
  LIFT: 0.08,
}
/** the glass's centre height above the floor */
export const SLAB_CY = SLAB.LIFT + SLAB.H / 2

const GRAD = [DUSK.blush, DUSK.lilac, DUSK.periwinkle] as const
const WORD = 'Say hello.'
export const ETCH_FONT_FAMILY = '"Cormorant Garamond Variable"'
const ETCH_WEIGHT = 500
/** how much light the frost passes relative to the polished letters */
const FROST_T = 0.7

const GRAD_GLSL = /* glsl */ `
  uniform vec3 uA, uB, uC;
  vec3 grad(float x) {
    x = clamp(x, 0.0, 1.0);
    return x < 0.5 ? mix(uA, uB, smoothstep(0.0, 0.5, x)) : mix(uB, uC, smoothstep(0.5, 1.0, x));
  }
  // lit where x is behind the sweep's front (soft edge uSoft wide)
  float swept(float x, float sweep, float soft) { return 1.0 - smoothstep(sweep - soft, sweep, x); }
`

const gradUniforms = () => ({
  uA: { value: new THREE.Color(GRAD[0]) },
  uB: { value: new THREE.Color(GRAD[1]) },
  uC: { value: new THREE.Color(GRAD[2]) },
})

// ------------------------------------------------------------------ the card

const CARD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const CARD_FRAG = /* glsl */ `
  ${GRAD_GLSL}
  uniform float uLevel, uHdr, uSweep, uSoft, uStandby, uFront, uFrontX;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float x = vUv.x;
    float lv = mix(uStandby, 1.0, swept(x, uSweep, uSoft));
    // a brighter band riding the sweep's edge (and the copy glint)
    float d = (x - uFrontX) / 0.045;
    float front = exp(-d * d) * uFront;
    // soft edges: the card never reads as a hard rectangle through the frost
    vec2 e = smoothstep(vec2(0.0), vec2(0.05, 0.16), 0.5 - abs(p));
    // a little more light through the middle (where the words are)
    float band = 0.78 + 0.32 * exp(-(p.y * p.y) / 0.035);
    gl_FragColor = vec4(grad(x) * uHdr * uLevel * (lv * band + front) * e.x * e.y, 1.0);
  }
`

// ------------------------------------------------------------------ the tubes

const TUBE_VERT = /* glsl */ `
  uniform float uW;
  varying float vX;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vX = position.x / uW + 0.5;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`
const TUBE_FRAG = /* glsl */ `
  ${GRAD_GLSL}
  uniform float uLevel, uHdr, uSweep, uSoft, uFront, uFrontX, uStandby;
  varying float vX;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
    float d = (vX - uFrontX) / 0.03;
    float lit = clamp(uLevel * mix(uStandby, 1.0, swept(vX, uSweep, uSoft)) + exp(-d * d) * uFront * 0.6, 0.0, 1.4);
    vec3 hot = grad(vX) * uHdr;
    // the gas column: saturated at the glass edge, a touch whiter through the core
    float m = max(hot.r, max(hot.g, hot.b));
    hot = mix(hot, vec3(m) * 0.9, facing * facing * 0.3);
    hot *= 0.7 + 0.3 * facing;
    vec3 off = grad(vX) * 0.025 + 0.008;
    gl_FragColor = vec4(mix(off, hot, lit), 1.0);
  }
`

// ------------------------------------------------------------------ floor light

const SPILL_VERT = CARD_VERT
const SPILL_FRAG = /* glsl */ `
  ${GRAD_GLSL}
  uniform float uLevel, uK, uSweep, uSoft, uStandby, uSpan;
  varying vec2 vUv;
  void main() {
    // plane u → slab x fraction (the plane is wider than the slab)
    float x = (vUv.x - 0.5) * uSpan + 0.5;
    float lv = mix(uStandby, 1.0, swept(x, uSweep, uSoft + 0.08));
    float ex = smoothstep(-0.08, 0.3, x) * (1.0 - smoothstep(0.7, 1.08, x));
    // distance from the slab's foot (v = 1 at the slab, 0 toward the camera)
    float z = 1.0 - vUv.y;
    // a tight bright 'reflection' at the foot + a long soft pool (eased in at
    // the plinth so it has no hard edge)
    // … and fully out before the plane's near edge (a 1% tail still shows on
    // black once the output curve lifts it)
    float fall = (exp(-z * 16.0) * 0.5 + exp(-z * 3.8) * 0.5) * smoothstep(0.0, 0.025, z) * (1.0 - smoothstep(0.45, 0.95, z));
    gl_FragColor = vec4(grad(x) * uK * uLevel * lv * ex * fall, 1.0);
  }
`

/** A radial fade for the floor (alphaMap reads GREEN: grey on opaque black). */
function floorFade() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  // 40-unit plane: solid to ~7 units from the slab, gone by ~17
  r.addColorStop(0, '#fff')
  r.addColorStop(0.35, '#fff')
  r.addColorStop(0.62, '#555')
  r.addColorStop(0.86, '#000')
  r.addColorStop(1, '#000')
  g.fillStyle = r
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}

// ------------------------------------------------------------------ the cove line

const COVE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLevel;
  varying vec2 vUv;
  void main() {
    // a hairline of warm light along the back wall, fading out at both ends
    float x = abs(vUv.x - 0.5) * 2.0;
    float ends = 1.0 - smoothstep(0.35, 1.0, x);
    gl_FragColor = vec4(uColor * uLevel * ends, 1.0);
  }
`

export interface SlabState {
  /** overall light level 0..1 */
  level: number
  /** the lit front, 0..1 across the slab (values past 1 = fully lit) */
  sweep: number
  /** level of the unswept part (the slab's standby glow) */
  standby: number
  /** brightness of the moving band at x = frontX */
  front: number
  frontX: number
}

export interface Slab {
  group: THREE.Group
  glass: THREE.Mesh
  /** world-space centre of the glass (the subject) */
  centre: THREE.Vector3
  set(s: SlabState): void
  /** the cove hairline on the back wall: 0..1 */
  setCove(v: number): void
  /** repaint the etch (fonts.ready) */
  redraw(): void
  /** true once the etch was drawn with the real font */
  fontOk: boolean
}

/** Load the etch font (never blocks init for long). */
export async function loadEtchFont(timeout = 2500) {
  if (!document.fonts?.load) return false
  try {
    const spec = `italic ${ETCH_WEIGHT} 200px ${ETCH_FONT_FAMILY}`
    await Promise.race([document.fonts.load(spec, WORD), new Promise(r => setTimeout(r, timeout))])
    return document.fonts.check(spec, WORD)
  } catch {
    return false
  }
}

export function buildSlab(o: { mobile: boolean; envMap: THREE.Texture | null }): Slab {
  const { W, H, D, GAP, LIFT } = SLAB
  const group = new THREE.Group()
  const cy = SLAB_CY
  const zGlass = 0
  const zCard = zGlass - D / 2 - GAP
  const zTubes = zGlass - D / 2 - GAP * 0.42

  // ---- the etch: "Say hello." polished clear, centred on the glass
  const res = 1024
  let paint: (() => void) | null = null
  const slab: Partial<Slab> = { fontOk: false }
  const tex = etchMap(
    W,
    H,
    (g, cw, ch, toPx, scale) => {
      paint = () => {
        // two maps in one canvas: G = roughness (frost 1, letters 0), R =
        // transmission (frost FROST_T, letters 1) — sandblasting scatters some
        // light back, so the polished words pass more of it than the frost
        g.fillStyle = `rgb(${Math.round(FROST_T * 255)},255,255)`
        g.fillRect(0, 0, cw, ch)
        g.fillStyle = 'rgb(255,0,0)'
        const spec = (px: number) => `italic ${ETCH_WEIGHT} ${px}px ${ETCH_FONT_FAMILY}, Georgia, serif`
        g.font = spec(100)
        const m = g.measureText(WORD)
        const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width
        const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 100
        // fit: ~78% of the width, ~66% of the height (ascender to descender)
        const px = Math.min((W * 0.78 * scale) / (inkW / 100), (H * 0.66 * scale) / (inkH / 100))
        g.font = spec(px)
        const n = g.measureText(WORD)
        const left = n.actualBoundingBoxLeft ?? 0
        const right = n.actualBoundingBoxRight ?? n.width
        const asc = n.actualBoundingBoxAscent ?? px * 0.7
        const desc = n.actualBoundingBoxDescent ?? px * 0.25
        const [cx0, cy0] = toPx(0, 0.02)
        // centre the INK box (italics overhang their advance)
        const x = cx0 - (right - left) / 2 + left
        const y = cy0 + (asc - desc) / 2
        g.textBaseline = 'alphabetic'
        g.textAlign = 'left'
        g.fillText(WORD, x, y)
        slab.fontOk = !!document.fonts?.check?.(spec(px).split(',')[0], WORD)
      }
      paint()
    },
    res,
  )
  // the canvas's own filtering: keep the polished letter edges crisp
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter

  // ---- the glass
  const mat = frosted({ frost: 0.62, thickness: D * 2 }).clone()
  mat.roughnessMap = tex
  mat.transmissionMap = tex
  // its OWN envMap so envMapIntensity counts: a low studio sheen keeps the
  // frost from going milky and the polished letters from reading as dark
  // embossed windows (mid-roughness letter edges catch less of the sheen)
  mat.envMap = o.envMap
  mat.envMapIntensity = 0.42
  mat.needsUpdate = true
  const glass = pane(W, H, { depth: D, radius: 0.05, bevel: 0.035, material: mat })
  glass.position.set(0, cy, zGlass)
  group.add(glass)

  // ---- the light: a soft gradient card + the tube bank
  const cardMat = new THREE.ShaderMaterial({
    uniforms: {
      ...gradUniforms(),
      uLevel: { value: 0 },
      uHdr: { value: 0.58 },
      uSweep: { value: 0 },
      uSoft: { value: 0.28 },
      uStandby: { value: 0.35 },
      uFront: { value: 0 },
      uFrontX: { value: -1 },
    },
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
  })
  const card = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.99, H * 0.99), cardMat)
  card.position.set(0, cy, zCard)
  group.add(card)

  const n = o.mobile ? 15 : 19
  const radius = o.mobile ? 0.0095 : 0.0085
  const len = W * 0.94
  const geos: THREE.BufferGeometry[] = []
  const span = H * 0.8
  for (let i = 0; i < n; i++) {
    const y = -span / 2 + (span * i) / (n - 1)
    const g = new THREE.CylinderGeometry(radius, radius, len, o.mobile ? 6 : 8, 1, true)
    g.rotateZ(Math.PI / 2)
    g.translate(0, y, 0)
    g.deleteAttribute('uv')
    geos.push(g)
  }
  const tubeGeo = mergeGeometries(geos, false)!
  geos.forEach(g => g.dispose())
  const tubeMat = new THREE.ShaderMaterial({
    uniforms: {
      ...gradUniforms(),
      uW: { value: W },
      uLevel: { value: 0 },
      uStandby: { value: 0.15 },
      uHdr: { value: 2.6 },
      uSweep: { value: 0 },
      uSoft: { value: 0.1 },
      uFront: { value: 0 },
      uFrontX: { value: -1 },
    },
    vertexShader: TUBE_VERT,
    fragmentShader: TUBE_FRAG,
  })
  const tubes = new THREE.Mesh(tubeGeo, tubeMat)
  tubes.position.set(0, cy, zTubes)
  group.add(tubes)

  // ---- the housing: satin black, slightly inset behind the glass so its
  // polished bevel reads all round; closes the light box from the sides
  const satin = new THREE.MeshStandardMaterial({ color: 0x060509, roughness: 0.42, metalness: 0, envMap: o.envMap, envMapIntensity: 0.32 })
  // the inner faces are only ever seen blurred through the frost: plain black
  const ink = new THREE.MeshBasicMaterial({ color: 0x000000 })
  const depthBox = GAP + D / 2 + 0.06
  const hz = zGlass - D / 2 - depthBox / 2 - 0.004
  // satin outside, black inside: `inner` = the face index (+x -x +y -y +z -z)
  // that faces in. All the housing's outer faces (and the plinth) merge into
  // ONE satin mesh and the inner faces into ONE black mesh (2 draws, not 30)
  const outer: THREE.BufferGeometry[] = []
  const inside: THREE.BufferGeometry[] = []
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, inner = -1) => {
    const g = new THREE.BoxGeometry(w, h, d)
    g.translate(x, y, z)
    const idx = g.index!.array
    const a: number[] = []
    const b: number[] = []
    for (const gr of g.groups) for (let i = gr.start; i < gr.start + gr.count; i++) (gr.materialIndex === inner ? b : a).push(idx[i])
    const out = g.clone()
    out.setIndex(a)
    out.clearGroups()
    outer.push(out)
    if (b.length) {
      const inn = g.clone()
      inn.setIndex(b)
      inn.clearGroups()
      inside.push(inn)
    }
    g.dispose()
  }
  const t = 0.02
  const iw = W - 0.03
  const ih = H - 0.03
  box(iw, t, depthBox, 0, cy + ih / 2 - t / 2, hz, 3)
  box(iw, t, depthBox, 0, cy - ih / 2 + t / 2, hz, 2)
  box(t, ih, depthBox, -iw / 2 + t / 2, cy, hz, 0)
  box(t, ih, depthBox, iw / 2 - t / 2, cy, hz, 1)
  box(iw, ih, t, 0, cy, hz - depthBox / 2 + t / 2, 4)

  // ---- the plinth: a slim black stone base the slab stands in
  const plinthD = depthBox + D + 0.14
  const plinthZ = zGlass + D / 2 + 0.05 - plinthD / 2
  box(W + 0.24, LIFT + 0.02, plinthD, 0, (LIFT + 0.02) / 2 - 0.01, plinthZ)
  const shell = new THREE.Mesh(mergeGeometries(outer, false)!, satin)
  const lining = new THREE.Mesh(mergeGeometries(inside, false)!, ink)
  outer.forEach(g => g.dispose())
  inside.forEach(g => g.dispose())
  group.add(shell, lining)

  // ---- the floor + the slab's light on it
  // polished black stone that dissolves into the dark (no hard horizon where
  // it meets the backdrop): the kit's stone, with a soft radial alpha
  const floor = stoneFloor(40, 40, o.envMap)
  const fm = floor.material as THREE.MeshStandardMaterial
  fm.alphaMap = floorFade()
  fm.transparent = true
  fm.depthWrite = false
  floor.renderOrder = 1
  group.add(floor)
  const spillSpan = 1.3
  const spillMat = new THREE.ShaderMaterial({
    uniforms: {
      ...gradUniforms(),
      uLevel: { value: 0 },
      uK: { value: 0.46 },
      uSweep: { value: 0 },
      uSoft: { value: 0.28 },
      uStandby: { value: 0.35 },
      uSpan: { value: spillSpan },
    },
    vertexShader: SPILL_VERT,
    fragmentShader: SPILL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const spillD = 2.6
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(W * spillSpan, spillD), spillMat)
  spill.rotation.x = -Math.PI / 2
  const plinthFront = plinthZ + plinthD / 2
  spill.position.set(0, 0.004, plinthFront + spillD / 2)
  spill.renderOrder = 2
  group.add(spill)

  // ---- the gallery's own architecture: one long warm hairline where the back
  // wall meets the ceiling (it dims out with the room at closing)
  const coveMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(DUSK.warm).multiplyScalar(0.95) }, uLevel: { value: 1 } },
    vertexShader: CARD_VERT,
    fragmentShader: COVE_FRAG,
  })
  const cove = new THREE.Mesh(new THREE.PlaneGeometry(44, 0.016), coveMat)
  cove.position.set(0, 2.85, -9)
  group.add(cove)

  const centre = new THREE.Vector3(0, cy, zGlass)

  const set = (s: SlabState) => {
    const cu = cardMat.uniforms
    cu.uLevel.value = s.level
    cu.uSweep.value = s.sweep
    cu.uStandby.value = s.standby
    cu.uFront.value = s.front
    cu.uFrontX.value = s.frontX
    const tu = tubeMat.uniforms
    tu.uLevel.value = s.level
    tu.uSweep.value = s.sweep
    tu.uFront.value = s.front
    tu.uFrontX.value = s.frontX
    tu.uStandby.value = s.standby * 0.4
    const su = spillMat.uniforms
    su.uLevel.value = s.level
    su.uSweep.value = s.sweep
    su.uStandby.value = s.standby
  }

  Object.assign(slab, {
    group,
    glass,
    centre,
    set,
    setCove(v: number) {
      coveMat.uniforms.uLevel.value = v
      cove.visible = v > 0.002
    },
    redraw() {
      paint?.()
      tex.needsUpdate = true
    },
  })
  return slab as Slab
}
