import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { flattenCaps, smoothSides } from '../../kit/glass'

/*
 * NIGHT WATCH — the lit room behind the partition.
 *
 * Two lights share one field (uniforms shared by reference), so the back
 * wall, the tube bank, the floor and the chapter's own maths agree:
 *
 *   the WATCH light  a cove at the foot of the back wall rising into a dusk
 *                    gradient (dark at the top), plus a few thin tubes that
 *                    the frost turns into soft vertical bands. It dims to a
 *                    standby glow while the alarm is up.
 *   the ALARM lamp   a warm red lamp standing in the room behind the wall,
 *                    off its RIGHT end. Its light on the back wall falls off
 *                    like a real point light on a wall, E ~ (1 + d²/h²)^-1.5:
 *                    `h` (how far the lamp stands from the wall) is how soft
 *                    it is, so the glow has depth, a hot core and a long
 *                    crimson tail, and the left of the wall stays night.
 *
 *   u = wall space (0..1 left→right, 0..1 bottom→top); uLampPos may sit
 *   outside it (the lamp is beyond the wall's end).
 *
 * The designs polished into the glass (24/7, the padlock, the indicator
 * slots) get their own light right behind the glass (windowLight): the
 * window shows it crisp, the frost around spreads its halo.
 */

export interface NightUniforms {
  [k: string]: THREE.IUniform
  uOrigin: THREE.IUniform<THREE.Vector2>
  uSize: THREE.IUniform<THREE.Vector2>
  uCalmA: THREE.IUniform<THREE.Color>
  uCalmB: THREE.IUniform<THREE.Color>
  uCalmLevel: THREE.IUniform<number>
  uLampPos: THREE.IUniform<THREE.Vector2>
  uLampH: THREE.IUniform<number>
  uLampLevel: THREE.IUniform<number>
  uLampCore: THREE.IUniform<THREE.Color>
  uLampEdge: THREE.IUniform<THREE.Color>
  /** multiplier for the watch light (the slow breath) */
  uBreath: THREE.IUniform<number>
  /** multiplier for the alarm lamp (the slow pulse) */
  uPulse: THREE.IUniform<number>
}

export function nightUniforms(origin: THREE.Vector2, size: THREE.Vector2): NightUniforms {
  return {
    uOrigin: { value: origin },
    uSize: { value: size },
    uCalmA: { value: new THREE.Color() },
    uCalmB: { value: new THREE.Color() },
    uCalmLevel: { value: 0.3 },
    uLampPos: { value: new THREE.Vector2(1.1, 0.34) },
    uLampH: { value: 1 },
    uLampLevel: { value: 0 },
    uLampCore: { value: new THREE.Color() },
    uLampEdge: { value: new THREE.Color() },
    uBreath: { value: 1 },
    uPulse: { value: 1 },
  }
}

const NIGHT_GLSL = /* glsl */ `
  uniform vec2 uOrigin, uSize, uLampPos;
  uniform float uCalmLevel, uLampH, uLampLevel, uBreath, uPulse;
  uniform vec3 uCalmA, uCalmB, uLampCore, uLampEdge;
  vec2 wallSpace(vec2 world) { return (world - uOrigin) / uSize + 0.5; }
  // the watch light: a cove at the foot of the wall, rising into a dusk gradient
  vec3 calmLight(vec2 u) {
    float y = clamp(u.y, 0.0, 1.0);
    float lift = 0.12 + 0.88 * exp(-3.1 * y);
    // a slow swell across the wall (brighter a little right of centre) so the frost is never one flat tone
    float dx = u.x - 0.56;
    float across = 0.72 + 0.28 * exp(-dx * dx * 3.2);
    return mix(uCalmA, uCalmB, smoothstep(0.0, 0.8, y)) * lift * across;
  }
  // the lamp on the back wall: a point light at distance h, (1 + d²/h²)^-1.5 (no pow on a base that could go negative)
  float lampFall(vec2 u) {
    vec2 d = (u - uLampPos) * uSize;
    float q = 1.0 / (1.0 + dot(d, d) / max(uLampH * uLampH, 1e-4));
    return q * sqrt(q);
  }
  vec3 lampLight(vec2 u) {
    float e = lampFall(u);
    // a warm core, a deep crimson tail
    return mix(uLampEdge, uLampCore, smoothstep(0.08, 0.8, e)) * e;
  }
  vec3 nightLight(vec2 u) {
    return calmLight(u) * uCalmLevel * uBreath + lampLight(u) * uLampLevel * uPulse;
  }
`

/** JS mirror of lampFall (the padlock's light is re-gelled by how much of the lamp reaches it). */
export function lampFall(u: THREE.Vector2, U: NightUniforms) {
  const dx = (u.x - U.uLampPos.value.x) * U.uSize.value.x
  const dy = (u.y - U.uLampPos.value.y) * U.uSize.value.y
  const q = 1 / (1 + (dx * dx + dy * dy) / Math.max(1e-4, U.uLampH.value * U.uLampH.value))
  return q * Math.sqrt(q)
}

const WORLD_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

// ------------------------------------------------------------------ the back wall

/**
 * The room's back wall: an emissive plane w × h lit by the field (soft
 * edges). Bright in the glass (transmission) buffer; `frameK` of that in the
 * frame itself, where it's only seen through the seams between the panels
 * (a dim crisp line of the light behind, never a bright tube).
 */
export function nightCard(w: number, h: number, u: NightUniforms, o: { hdr: number; soft?: number; frameK: number; isFrameTarget: (rt: THREE.WebGLRenderTarget | null) => boolean }) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uHdr: { value: o.hdr }, uSoft: { value: o.soft ?? 0.03 }, uK: { value: 1 } },
    vertexShader: WORLD_VERT,
    fragmentShader: /* glsl */ `
      ${NIGHT_GLSL}
      uniform float uHdr, uSoft, uK;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec2 u = wallSpace(vWorld.xy);
        vec2 e = smoothstep(vec2(0.0), vec2(uSoft), 0.5 - abs(vUv - 0.5));
        gl_FragColor = vec4(nightLight(u) * uHdr * uK * e.x * e.y, 1.0);
      }
    `,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  mesh.onBeforeRender = renderer => {
    const rt = renderer.getRenderTarget() as THREE.WebGLRenderTarget | null
    mat.uniforms.uK.value = rt === null || o.isFrameTarget(rt) ? o.frameK : 1
    mat.uniformsNeedUpdate = true
  }
  return mesh
}

// ------------------------------------------------------------------ the tube bank

/**
 * Thin vertical tubes of the watch light between the wall and the glass
 * (one merged mesh, open ends, no caps): the frost turns them into soft
 * bands. They follow the watch light's level and breath.
 */
export function tubeBank(xs: number[], y0: number, y1: number, z: number, u: NightUniforms, o: { radius: number; hdr: number; color: string; radial?: number }) {
  const radial = o.radial ?? 6
  const len = y1 - y0
  const geos = xs.map(x => {
    const g = new THREE.CylinderGeometry(o.radius, o.radius, len, radial, 1, true)
    g.translate(x, (y0 + y1) / 2, z)
    g.deleteAttribute('uv')
    return g
  })
  const geo = mergeGeometries(geos, false)!
  geos.forEach(g => g.dispose())
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uColor: { value: new THREE.Color(o.color) }, uHdr: { value: o.hdr }, uY: { value: new THREE.Vector2(y0, y1) } },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      uniform vec2 uY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vY = (wp.y - uY.x) / (uY.y - uY.x);
        vec4 mv = viewMatrix * wp;
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NIGHT_GLSL}
      uniform vec3 uColor;
      uniform float uHdr;
      varying vec3 vN;
      varying vec3 vV;
      varying float vY;
      void main() {
        float facing = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        vec3 hot = uColor * uHdr;
        float m = max(hot.r, max(hot.g, hot.b));
        hot = mix(hot, vec3(m) * 0.85, facing * facing * 0.22);
        hot *= 0.72 + 0.28 * facing;
        // fixtures fade toward their ends (no hard tips through the glass)
        float ends = smoothstep(0.0, 0.08, vY) * smoothstep(0.0, 0.08, 1.0 - vY);
        gl_FragColor = vec4(hot * uCalmLevel * uBreath * ends + 0.004, 1.0);
      }
    `,
  })
  return new THREE.Mesh(geo, mat)
}

// ------------------------------------------------------------------ the designs' light

export interface WindowLight {
  mesh: THREE.Mesh
  /** the design's light (colour × HDR × level) */
  design: THREE.Color
  /** the indicator slot's light (colour × HDR × level) */
  slot: THREE.Color
}

/**
 * The design drawn in LIGHT right behind the glass, read from the pane's own
 * etch map (the plane is exactly the etch's region, so its uv IS the map's
 * uv): the crisp design + a wider halo from a coarser mip. Polished windows
 * show the core crisp; the frost around spreads the halo into a glow that
 * follows the design. Everything below `slotY` (panel-local, the indicator
 * slot) takes the slot's light instead.
 *
 * Blended "over" (premultiplied: src + dst × (1 − core)) but in the OPAQUE
 * list (transparent: false) and drawn last (renderOrder): three's glass
 * buffer only sees opaque objects. So inside a window the design's light
 * (mostly) REPLACES whatever is behind (`cover`: no tube reads through a
 * numeral; an unlit design is a dark clear window with a hint of the room
 * behind it), and outside it the halo adds on top of the back wall and the
 * tubes instead of hiding them behind a plane.
 */
export function windowLight(w: number, h: number, map: THREE.Texture, o: { regionY: number; slotY: number; halo?: number; gain?: number; bias?: number; cover?: number }): WindowLight {
  const design = new THREE.Color(0, 0, 0)
  const slot = new THREE.Color(0, 0, 0)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uDesign: { value: design },
      uSlot: { value: slot },
      uSlotY: { value: o.slotY - o.regionY },
      uH: { value: h },
      uHalo: { value: o.halo ?? 0.25 },
      uGain: { value: o.gain ?? 2.6 },
      uBias: { value: o.bias ?? 3.2 },
      uCover: { value: o.cover ?? 0.82 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uDesign, uSlot;
      uniform float uSlotY, uH, uHalo, uGain, uBias, uCover;
      varying vec2 vUv;
      void main() {
        float core = 1.0 - texture2D(uMap, vUv).g;
        // two coarse reads (one wider): a smooth glow, never the mip's blocks
        float halo = clamp((1.0 - 0.6 * texture2D(uMap, vUv, uBias).g - 0.4 * texture2D(uMap, vUv, uBias + 1.5).g) * uGain, 0.0, 1.0);
        float lit = max(core, halo * uHalo);
        float y = (vUv.y - 0.5) * uH;
        float isSlot = 1.0 - smoothstep(uSlotY + 0.05, uSlotY + 0.14, y);
        gl_FragColor = vec4(mix(uDesign, uSlot, isSlot) * lit, core * uCover);
      }
    `,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    transparent: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  mesh.renderOrder = 2
  return { mesh, design, slot }
}

// ------------------------------------------------------------------ floor spill

/**
 * The wall's light on the polished stone in front of it: an additive band
 * along the partition's foot, coloured by the same field, fading with
 * distance. It runs on past the wall's right end, where the lamp stands, so
 * the alarm pools around the end of the partition.
 */
export function floorSpill(w: number, d: number, cx: number, u: NightUniforms, strength = 0.3) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...u, uStrength: { value: strength }, uDepth: { value: d } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: WORLD_VERT,
    fragmentShader: /* glsl */ `
      ${NIGHT_GLSL}
      uniform float uStrength, uDepth;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        float ux = wallSpace(vWorld.xy).x;
        vec2 u = vec2(ux, 0.12);
        // the watch light stops with the wall; the lamp's light runs on round its end
        float inWall = smoothstep(-0.04, 0.03, ux) * (1.0 - smoothstep(0.97, 1.04, ux));
        vec3 c = calmLight(u) * uCalmLevel * uBreath * inWall + lampLight(vec2(ux, 0.2)) * uLampLevel * uPulse * 0.9;
        float z = clamp(vWorld.z / uDepth, 0.0, 1.0);
        float fall = exp(-z * 4.0) * (1.0 - z);
        float side = smoothstep(0.0, 0.1, vUv.x) * smoothstep(0.0, 0.1, 1.0 - vUv.x);
        gl_FragColor = vec4(c * uStrength * fall * side, 1.0);
      }
    `,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
  m.rotation.x = -Math.PI / 2
  m.position.set(cx, 0, d / 2)
  return m
}

// ------------------------------------------------------------------ the glass

/**
 * One tall panel: a rounded slab w × h (OUTER size), `depth` thick, with a
 * deep round bevel (~0.72 of its thickness, so the edge is one continuous
 * round that carries a clean hairline, never a dashed strip). Groups: 0 = the
 * two flat caps (frosted + etched), 1 = bevel + sides (polished). Cap UVs
 * are panel units (x, y), which is what etchMap expects.
 */
export function panelGeometry(w: number, h: number, depth: number, radius: number, mobile: boolean) {
  const bevT = Math.min(0.036, depth * 0.34)
  const bevS = bevT * 0.72
  const iw = w - 2 * bevS
  const ih = h - 2 * bevS
  const r = Math.max(0.002, Math.min(radius, iw / 2, ih / 2))
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
    curveSegments: 6,
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
