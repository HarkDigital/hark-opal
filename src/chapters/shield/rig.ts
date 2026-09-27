import * as THREE from 'three'
import type { Stroke } from '../../kit/type'

/*
 * NIGHT WATCH — the light room behind the partition.
 *
 * One shared "breach" field drives every light behind the glass, so the
 * alarm reads as ONE light seeping across the whole wall:
 *
 *   u = partition space (0..1 left→right, 0..1 bottom→top)
 *   mask(u) = how far the alarm has reached (a soft, slightly wandering
 *             front that enters from the RIGHT edge as uFront goes 0 → 1)
 *   calm(u) = the watch light: periwinkle (low) → ice (high)
 *   hot(u)  = calm, re-gelled by uHot (alarm → violet → back to calm as
 *             uHeat falls 1 → 0)
 *
 * The card (the room's back wall), the tube bank and the floor spill all
 * read the same uniforms (one object, shared by reference).
 */

export interface BreachUniforms {
  [k: string]: THREE.IUniform
  uOrigin: THREE.IUniform<THREE.Vector2>
  uSize: THREE.IUniform<THREE.Vector2>
  uFront: THREE.IUniform<number>
  uFeather: THREE.IUniform<number>
  uSeep: THREE.IUniform<number>
  uHeat: THREE.IUniform<number>
  uCalmA: THREE.IUniform<THREE.Color>
  uCalmB: THREE.IUniform<THREE.Color>
  uHot: THREE.IUniform<THREE.Color>
  uCalmLevel: THREE.IUniform<number>
  uHotLevel: THREE.IUniform<number>
  /** multiplier for the calm light (the slow breath) */
  uBreath: THREE.IUniform<number>
  /** multiplier for the alarm light (the slow pulse) */
  uPulse: THREE.IUniform<number>
}

export function breachUniforms(origin: THREE.Vector2, size: THREE.Vector2): BreachUniforms {
  return {
    uOrigin: { value: origin },
    uSize: { value: size },
    uFront: { value: 0 },
    uFeather: { value: 0.16 },
    uSeep: { value: 0 },
    uHeat: { value: 1 },
    uCalmA: { value: new THREE.Color() },
    uCalmB: { value: new THREE.Color() },
    uHot: { value: new THREE.Color() },
    uCalmLevel: { value: 0.6 },
    uHotLevel: { value: 1 },
    uBreath: { value: 1 },
    uPulse: { value: 1 },
  }
}

const BREACH_GLSL = /* glsl */ `
  uniform vec2 uOrigin, uSize;
  uniform float uFront, uFeather, uSeep, uHeat, uCalmLevel, uHotLevel, uBreath, uPulse;
  uniform vec3 uCalmA, uCalmB, uHot;
  vec2 wallSpace(vec2 world) { return (world - uOrigin) / uSize + 0.5; }
  float breachMask(vec2 u) {
    // the front wanders a little along its height (it seeps, it doesn't wipe)
    float wob = 0.055 * sin(u.y * 4.7 + uSeep * 2.3) + 0.03 * sin(u.y * 10.9 - uSeep * 3.7 + 1.3);
    float edge = mix(1.0 + uFeather + 0.12, -uFeather - 0.12, clamp(uFront, 0.0, 1.0));
    return smoothstep(edge - uFeather, edge + uFeather, u.x + wob * (1.0 - uFront * 0.6));
  }
  // the watch light rises from a channel at the foot of the wall: ice low, deepening to periwinkle high
  float rise(vec2 u) { return 0.2 + 0.8 * exp(-2.4 * clamp(u.y, 0.0, 1.0)); }
  vec3 calmLight(vec2 u) {
    return mix(uCalmA, uCalmB, smoothstep(0.0, 0.85, u.y)) * rise(u);
  }
  /** light colour x level at u (no breath/pulse) and the alarm weight */
  vec3 breachLight(vec2 u, out float hotW) {
    float m = breachMask(u);
    vec3 calm = calmLight(u);
    // alarm → violet (heat 1 → 0.5) is uHot; below 0.5 it melts back into the calm gradient
    vec3 hot = mix(calm, uHot * mix(0.8, 1.15, rise(u)), clamp(uHeat * 2.0, 0.0, 1.0));
    // while hot, the light is strongest where it came in (the right edge) and dies off across the wall
    float sx = smoothstep(0.0, 1.0, u.x);
    float src = mix(1.0, 0.08 + 1.05 * sx * sx, uHeat);
    hotW = m * uHeat;
    return mix(calm * uCalmLevel, hot * uHotLevel * src, m);
  }
  float breachMul(float hotW) { return mix(uBreath, uPulse, hotW); }
`

// ------------------------------------------------------------------ card

/** The room's back wall: an emissive plane w × h lit by the breach field (soft edges). */
export function breachCard(w: number, h: number, u: BreachUniforms, o: { hdr?: number; soft?: number } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uHdr: { value: o.hdr ?? 1 }, uSoft: { value: o.soft ?? 0.06 }, uCardSize: { value: new THREE.Vector2(w, h) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${BREACH_GLSL}
      uniform float uHdr, uSoft;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec2 u = wallSpace(vWorld.xy);
        float hotW;
        vec3 c = breachLight(u, hotW) * breachMul(hotW);
        vec2 e = smoothstep(vec2(0.0), vec2(uSoft), 0.5 - abs(vUv - 0.5));
        gl_FragColor = vec4(c * uHdr * e.x * e.y, 1.0);
      }
    `,
  })
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
}

// ------------------------------------------------------------------ tubes

const TUBE_VERT = /* glsl */ `
  attribute float aArc;
  varying float vArc;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vWorld;
  void main() {
    vArc = aArc;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`

/** A straight or bent glass tube's gas column (shared look with kit/neon, coloured by the breach field or a fixed colour). */
const TUBE_FRAG = /* glsl */ `
  ${BREACH_GLSL}
  uniform vec3 uTubeCalm, uTubeHot, uFixed;
  uniform float uHdr, uLevel, uDraw, uUseField, uOff, uHide;
  varying float vArc;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vWorld;
  void main() {
    float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
    float drawn = 1.0 - smoothstep(uDraw - 0.02, uDraw + 0.0001, vArc);
    if (uHide > 0.5 && drawn < 0.02) discard;
    vec3 col = uFixed;
    float mul = 1.0;
    if (uUseField > 0.5) {
      vec2 u = wallSpace(vWorld.xy);
      float m = breachMask(u);
      // tubes cool first (a line of light reads its colour more than a glow)
      vec3 hot = mix(uTubeCalm, uTubeHot, smoothstep(0.35, 0.9, uHeat));
      col = mix(uTubeCalm * uCalmLevel, hot * uHotLevel, m);
      mul = breachMul(m * uHeat);
    }
    vec3 hotc = col * uHdr;
    float mx = max(hotc.r, max(hotc.g, hotc.b));
    hotc = mix(hotc, vec3(mx) * 0.85, facing * facing * 0.25);
    hotc *= 0.72 + 0.28 * facing;
    float lit = clamp(uLevel, 0.0, 1.0) * drawn * mul;
    vec3 off = col * 0.02 * uOff + vec3(0.01);
    gl_FragColor = vec4(mix(off, hotc, lit), 1.0);
  }
`

export interface TubeSet {
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  setLevel(v: number): void
  setDraw(v: number): void
}

/** Merge polylines into one tube mesh (no caps, no blockout: it all lives behind glass). aArc runs 0..1 along the whole set. */
export function tubeSet(strokes: Stroke[], u: BreachUniforms, o: { radius?: number; hdr?: number; radial?: number; field?: boolean; color?: string; calm?: string; hot?: string; hide?: boolean }): TubeSet {
  const radius = o.radius ?? 0.012
  const radial = o.radial ?? 6
  const curves = strokes.filter(s => s.pts.length >= 2).map(s => {
    const path = new THREE.CurvePath<THREE.Vector3>()
    for (let i = 0; i < s.pts.length - 1; i++) path.add(new THREE.LineCurve3(s.pts[i], s.pts[i + 1]))
    return path
  })
  const lens = curves.map(c => c.getLength())
  const total = lens.reduce((a, b) => a + b, 0) || 1
  const geos: THREE.BufferGeometry[] = []
  let acc = 0
  curves.forEach((c, i) => {
    const a0 = acc / total
    acc += lens[i]
    const a1 = acc / total
    // one segment per straight run is enough for a straight tube; bent strokes get more
    const segs = Math.max(c.curves.length * 2, Math.min(600, Math.round(lens[i] / (radius * 3))))
    const g = new THREE.TubeGeometry(c, segs, radius, radial, false)
    const n = g.attributes.position.count
    const arc = new Float32Array(n)
    for (let s = 0; s <= segs; s++) for (let j = 0; j <= radial; j++) arc[s * (radial + 1) + j] = a0 + ((a1 - a0) * s) / segs
    g.setAttribute('aArc', new THREE.BufferAttribute(arc, 1))
    g.deleteAttribute('uv')
    geos.push(g)
  })
  const geo = mergeAll(geos)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...u,
      uTubeCalm: { value: new THREE.Color(o.calm ?? '#cfe6ff') },
      uTubeHot: { value: new THREE.Color(o.hot ?? '#ff4d5e') },
      uFixed: { value: new THREE.Color(o.color ?? '#cfe6ff') },
      uHdr: { value: o.hdr ?? 2 },
      uLevel: { value: 0 },
      uDraw: { value: 1.05 },
      uUseField: { value: o.field ? 1 : 0 },
      uOff: { value: 1 },
      uHide: { value: o.hide ? 1 : 0 },
    },
    vertexShader: TUBE_VERT,
    fragmentShader: TUBE_FRAG,
  })
  const mesh = new THREE.Mesh(geo, material)
  return {
    mesh,
    material,
    setLevel(v: number) {
      const x = Math.max(0, Math.min(1, v))
      material.uniforms.uLevel.value = x
      // a tube that only exists while lit (the crack) disappears when dark
      if (o.hide) mesh.visible = x > 0.002
    },
    setDraw(v: number) {
      material.uniforms.uDraw.value = v >= 1 ? 1.05 : Math.max(0, v)
    },
  }
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // small local merge (indexed tube geometries with identical attributes)
  let vCount = 0
  let iCount = 0
  for (const g of geos) {
    vCount += g.attributes.position.count
    iCount += g.index ? g.index.count : g.attributes.position.count
  }
  const pos = new Float32Array(vCount * 3)
  const nrm = new Float32Array(vCount * 3)
  const arc = new Float32Array(vCount)
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount)
  let vo = 0
  let io = 0
  for (const g of geos) {
    const p = g.attributes.position.array as Float32Array
    const n = g.attributes.normal.array as Float32Array
    const a = g.attributes.aArc.array as Float32Array
    pos.set(p, vo * 3)
    nrm.set(n, vo * 3)
    arc.set(a, vo)
    if (g.index) {
      const src = g.index.array
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo
      io += src.length
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i
      io += g.attributes.position.count
    }
    vo += g.attributes.position.count
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.setAttribute('aArc', new THREE.BufferAttribute(arc, 1))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  out.computeBoundingSphere()
  return out
}

// ------------------------------------------------------------------ floor spill

/**
 * The wall's light on the polished stone in front of it: an additive band
 * along the partition's foot, coloured by the same field, fading with
 * distance (a soft reflection, not a pool with ripples).
 */
export function floorSpill(w: number, d: number, u: BreachUniforms, strength = 0.2) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uStrength: { value: strength }, uDepth: { value: d } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${BREACH_GLSL}
      uniform float uStrength, uDepth;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        // sample the wall's light near its foot (u.y ~ 0.2), a little softened
        vec2 u = vec2(wallSpace(vWorld.xy).x, 0.25);
        float hotW;
        vec3 c = breachLight(u, hotW) * breachMul(hotW);
        float z = clamp(vWorld.z / uDepth, 0.0, 1.0);
        float fall = exp(-z * 4.0) * (1.0 - z);
        float side = smoothstep(0.0, 0.14, vUv.x) * smoothstep(0.0, 0.14, 1.0 - vUv.x);
        gl_FragColor = vec4(c * uStrength * fall * side, 1.0);
      }
    `,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
  m.rotation.x = -Math.PI / 2
  m.position.z = d / 2
  return m
}
