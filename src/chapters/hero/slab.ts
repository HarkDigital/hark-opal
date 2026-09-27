import * as THREE from 'three'
import { frosted, polished, smoothExtrude } from '../../kit/glass'
import { etchMap, etchMark } from '../../kit/opal'
import { neonFromStrokes, type NeonPart } from '../../kit/neon'

/*
 * THE THRESHOLD SLAB — one monumental block of frosted glass standing in a
 * black stone plinth, the Hark mark polished clear through it, lit from
 * behind by a bank of thin vertical tubes over a gradient light card.
 *
 *   glass     rounded slab (smoothExtrude): caps sandblasted (roughness map:
 *             the mark is polished CLEAR, a window onto the tubes), bevels +
 *             sides POLISHED (they catch the studio strips as the world's
 *             envTurn sweeps). Both materials carry their own envMap, so the
 *             chapter syncs their envMapRotation with the world's sweep.
 *   card      the light source the frost diffuses: drawn bright in the glass
 *             (transmission) buffer and black in the frame, so from the side
 *             it reads as the piece's black back panel, never a glowing sheet
 *   tubes     the Flavin bank between card and glass: soft bands through the
 *             frost, razor lines through the polished mark, bare hairlines
 *             when the camera arcs past the slab's edge
 *   plinth    satin black stone the glass stands in
 *
 * Everything sits in slab space: glass centred on x = 0, standing on
 * y = 0 (the floor), front face toward +z. The etch map covers only the
 * mark's square (sharper window edges than a whole-slab map at the same
 * resolution); ClampToEdge keeps the rest of the face frosted.
 */

export interface SlabOptions {
  /** glass width / height / straight-side depth (world units) */
  w: number
  h: number
  depth: number
  /** rounded bevel (adds to the depth on both faces and to the outline) */
  bevel: number
  /** gap between the glass's back face and the light card */
  gap: number
  tubes: number
  /** the mark's SVG viewBox side (world) and its centre height above the glass's centre */
  markH: number
  markY: number
  plinthH: number
  envMap: THREE.Texture | null
  mobile: boolean
  isFrameTarget: (rt: THREE.WebGLRenderTarget | null) => boolean
}

const CARD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
// the gradient light card: A (left) → B (right), a gentle lift through the
// middle and soft edges so it never reads as a hard rectangle through frost
const CARD_FRAG = /* glsl */ `
  uniform vec3 uA, uB;
  uniform float uK;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv - 0.5;
    float g = smoothstep(-0.55, 0.55, p.x + p.y * 0.35);
    vec3 c = mix(uA, uB, g);
    float mid = 0.78 + 0.22 * (1.0 - 4.0 * p.y * p.y);
    vec2 e = smoothstep(vec2(0.0), vec2(0.06, 0.05), 0.5 - abs(p));
    gl_FragColor = vec4(c * uK * mid * e.x * e.y, 1.0);
  }
`

export interface Slab {
  group: THREE.Group
  glass: THREE.Mesh
  caps: THREE.MeshPhysicalMaterial
  sides: THREE.MeshPhysicalMaterial
  tubes: NeonPart[]
  /** every material with its own envMap (sync envMapRotation with the world) */
  envMats: THREE.MeshStandardMaterial[]
  /** z of the glass's front face (slab space) */
  frontZ: number
  /** y of the glass's centre (slab space; the floor is 0) */
  centerY: number
  /** outer size of the glass incl. bevel */
  outerW: number
  outerH: number
  /** the card's strength in the glass buffer / in the frame (per pass) */
  cardK: { trans: number; main: number }
  setColors(a: THREE.Color, b: THREE.Color): void
  setLevel(v: number): void
  /** tube HDR at full level */
  tubeHdr: number
}

function roundedRect(w: number, h: number, r: number) {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  return s
}

export function buildSlab(o: SlabOptions): Slab {
  const group = new THREE.Group()
  const bevelSize = o.bevel * 0.85
  const outerW = o.w + bevelSize * 2
  const outerH = o.h + bevelSize * 2
  const half = o.depth / 2 + o.bevel
  const centerY = o.plinthH * 0.55 + outerH / 2
  const frontZ = half

  // ---------------------------------------------------------------- glass
  const geo = smoothExtrude(roundedRect(o.w, o.h, 0.035), { depth: o.depth, bevel: o.bevel, bevelSegments: o.mobile ? 4 : 7, curveSegments: 6 })
  // the etch: the mark's square only, sharp; clamp keeps the rest frosted
  const S = o.markH * 1.08
  const etch = etchMap(S, S, (g, _W, _H, toPx) => etchMark(g, toPx, { cx: 0, cy: 0, height: o.markH }), o.mobile ? 512 : 1024)
  etch.repeat.set(1 / S, 1 / S)
  etch.offset.set(0.5, 0.5 - o.markY / S)
  etch.anisotropy = 8
  const caps = frosted({ frost: 0.5, thickness: 0.36 }).clone()
  caps.roughnessMap = etch
  caps.envMap = o.envMap
  caps.envMapIntensity = 0.1
  caps.needsUpdate = true
  const sides = polished({ thickness: 0.12 }).clone()
  sides.envMap = o.envMap
  sides.envMapIntensity = 1.5
  const glass = new THREE.Mesh(geo, [caps, sides])
  glass.position.y = centerY
  group.add(glass)

  // ---------------------------------------------------------------- the card (per pass)
  const cardK = { trans: 0, main: 0 }
  const cardMat = new THREE.ShaderMaterial({
    uniforms: {
      uA: { value: new THREE.Color() },
      uB: { value: new THREE.Color() },
      uK: { value: 0 },
    },
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
  })
  const card = new THREE.Mesh(new THREE.PlaneGeometry(o.w * 0.97, o.h * 0.97), cardMat)
  card.position.set(0, centerY, -half - o.gap)
  card.onBeforeRender = renderer => {
    const rt = renderer.getRenderTarget() as THREE.WebGLRenderTarget | null
    cardMat.uniforms.uK.value = rt === null || o.isFrameTarget(rt) ? cardK.main : cardK.trans
    cardMat.uniformsNeedUpdate = true
  }
  group.add(card)
  // the back panel's own back (black satin), so from behind it's a slab of stone, not a hole
  const backMat = new THREE.MeshStandardMaterial({ color: 0x060508, roughness: 0.4, metalness: 0.1, envMap: o.envMap, envMapIntensity: 0.35 })
  const back = new THREE.Mesh(new THREE.BoxGeometry(o.w * 0.99, o.h * 0.99, 0.03), backMat)
  back.position.set(0, centerY, card.position.z - 0.02)
  group.add(back)

  // ---------------------------------------------------------------- tubes (Flavin bank)
  const tubes: NeonPart[] = []
  const n = Math.max(1, Math.round(o.tubes))
  const span = o.w * 0.8
  const tubeHdr = 3.2
  const tubeLen = o.h * 0.9
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0.5 : i / (n - 1)
    const t = neonFromStrokes([{ pts: [new THREE.Vector3(0, -tubeLen / 2, 0), new THREE.Vector3(0, tubeLen / 2, 0)] }], {
      color: '#ffffff',
      radius: 0.012,
      hdr: tubeHdr,
      blockout: false,
      electrodes: false,
      smooth: false,
      caps: false,
      radial: o.mobile ? 6 : 8,
    })
    t.group.position.set(-span / 2 + span * k, centerY, -half - o.gap * 0.42)
    group.add(t.group)
    tubes.push(t)
  }

  // ---------------------------------------------------------------- plinth
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x050407, roughness: 0.32, metalness: 0.15, envMap: o.envMap, envMapIntensity: 0.55 })
  const pd = half * 2 + o.gap + 0.34
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(outerW + 0.26, o.plinthH, pd), plinthMat)
  // the glass stands in the front third; the light bank rises from the back
  plinth.position.set(0, o.plinthH / 2, half + 0.14 - pd / 2)
  group.add(plinth)

  const ca = new THREE.Color()
  const tmp = new THREE.Color()
  const hexes: string[] = []
  return {
    group,
    glass,
    caps,
    sides,
    tubes,
    envMats: [caps, sides, backMat, plinthMat],
    frontZ,
    centerY,
    outerW,
    outerH,
    cardK,
    tubeHdr,
    setColors(a, b) {
      ;(cardMat.uniforms.uA.value as THREE.Color).copy(a)
      ;(cardMat.uniforms.uB.value as THREE.Color).copy(b)
      tubes.forEach((t, i) => {
        // tubes take the gradient across the bank (display hex; only re-set on change)
        ca.copy(a).lerp(b, n === 1 ? 0.5 : i / (n - 1))
        const hx = '#' + tmp.copy(ca).getHexString()
        if (hexes[i] !== hx) {
          hexes[i] = hx
          t.setColor(hx)
        }
      })
    },
    setLevel(v) {
      for (const t of tubes) t.setLevel(v)
    },
  }
}
