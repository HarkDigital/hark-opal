import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

/*
 * AFTERGLOW's room — a Turrell "space division" piece, drawn analytically.
 *
 * A black gallery (floor y = 0, far wall z = 0, side walls, ceiling) with ONE
 * rectangular APERTURE cut knife-edged into the far wall. Behind it, a
 * sensing space (a coved box, depth DEPTH, a little larger than the opening)
 * whose back wall is an even field of coloured light: from the room you see
 * a flat plane of colour whose depth you can't judge. The field is a soft
 * two-colour gradient (top → bottom, the dusk sky after sunset), with the
 * faint brightening of the hidden cove lights near the sensing space's edges,
 * which parallaxes a hair against the knife edge as the camera drifts.
 *
 * The aperture is the room's ONLY light. Every surface is lit by it exactly
 * (the Lambert form factor of the opening's two halves — top and bottom
 * colour — no RectAreaLight), the polished black stone (floor, bench top)
 * reflects it as a soft coloured streak, and the low stone bench occludes
 * both (a soft shadow on the floor, its silhouette across the reflection).
 * All of it is one small shader, three programs (far wall / plaster / stone).
 * No transmission, no lights, no textures: cheap on phones.
 *
 * Colours come in LINEAR and already luminance-balanced (index.ts), so a
 * change of colour is a change of hue, never of brightness.
 */

/** the room (world units ≈ metres) */
export const ROOM = {
  /** far wall at z = 0: x extent */
  x0: -8,
  x1: 2.9,
  height: 4.5,
  depth: 20,
  /** the sensing space behind the aperture */
  cavityDepth: 2.2,
  cavityMargin: 0.55,
  /** the aperture at rest (centre + half size) */
  apX: 0,
  apY: 1.55,
  apW: 3.2,
  apH: 2.05,
  /** the bench: a black stone slab (min / max corners) on two slab legs */
  bench: { min: new THREE.Vector3(-1.5, 0.34, 2.9), max: new THREE.Vector3(0.4, 0.44, 3.34) },
  benchLeg: { w: 0.09, inset: 0.16, depthInset: 0.03 },
}

const VERT = /* glsl */ `
  varying vec3 vP;
  varying vec3 vN;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vP = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const FRAG = /* glsl */ `
  #define PI 3.14159265
  uniform vec2 uApC;       // aperture centre (x, y) on the z = 0 wall
  uniform vec2 uApH;       // aperture half size
  uniform vec3 uTop;       // field colour at the top (linear, balanced)
  uniform vec3 uBot;       // … and at the bottom
  uniform float uTilt;     // the gradient's slant (radians, tiny)
  uniform float uCavD;     // sensing space depth
  uniform float uCavM;     // sensing space margin round the opening
  uniform float uCove;     // cove glow near the sensing space's edges
  uniform float uSpill;    // room exposure: how strongly the opening lights the room
  uniform float uAmb;      // bounce light (fraction of the field's mean)
  uniform float uAlbedo;
  uniform float uGloss;    // stone: reflection strength
  uniform float uRough;    // stone: reflection blur per unit of travel
  uniform float uHair;     // knife-edge hairline strength
  uniform vec3 uBMin;      // bench slab
  uniform vec3 uBMax;
  uniform vec3 uL0Min;     // … and its legs
  uniform vec3 uL0Max;
  uniform vec3 uL1Min;
  uniform vec3 uL1Max;
  varying vec3 vP;
  varying vec3 vN;

  float sq(float x) { return x * x; }
  // interleaved gradient noise: well-spread per-pixel rotation for the soft taps
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  // the field seen at a point of the opening / sensing space, u in [-1, 1]^2
  vec3 fieldAt(vec2 u) {
    float s = sin(uTilt), c = cos(uTilt);
    float y = c * u.y + s * u.x;
    float g = smoothstep(-1.05, 1.05, y);
    vec3 col = mix(uBot, uTop, g);
    // the cove: hidden light round the sensing space's mouth washes its edges
    float e = max(abs(u.x), abs(u.y));
    return col * (1.0 + uCove * smoothstep(0.62, 1.0, e));
  }

  // Lambert form factor of one edge of a polygon (unit vectors a, b from p)
  float edgeF(vec3 a, vec3 b, vec3 n) {
    float th = acos(clamp(dot(a, b), -0.9999, 0.9999));
    vec3 cr = cross(a, b);
    float l = length(cr);
    return l > 1e-6 ? th * dot(n, cr) / l : 0.0;
  }
  // form factor of the axis-aligned rect [x0,x1]×[y0,y1] in the z = 0 plane, seen from p (z > 0)
  float rectF(vec3 p, vec3 n, float x0, float x1, float y0, float y1) {
    vec3 a = normalize(vec3(x0, y0, 0.0) - p);
    vec3 b = normalize(vec3(x1, y0, 0.0) - p);
    vec3 c = normalize(vec3(x1, y1, 0.0) - p);
    vec3 d = normalize(vec3(x0, y1, 0.0) - p);
    float f = edgeF(a, b, n) + edgeF(b, c, n) + edgeF(c, d, n) + edgeF(d, a, n);
    return max(0.0, -f) / (2.0 * PI);
  }

  // ray / box: distance to the first hit, or a big number
  float boxHit(vec3 o, vec3 inv, vec3 bmin, vec3 bmax) {
    vec3 t0 = (bmin - o) * inv;
    vec3 t1 = (bmax - o) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float a = max(max(tmin.x, tmin.y), tmin.z);
    float b = min(min(tmax.x, tmax.y), tmax.z);
    return (b > max(a, 0.0)) ? max(a, 0.0) : 1e9;
  }
  // ray / bench (slab + legs)
  float benchHit(vec3 o, vec3 d) {
    vec3 inv = 1.0 / d;
    return min(boxHit(o, inv, uBMin, uBMax), min(boxHit(o, inv, uL0Min, uL0Max), boxHit(o, inv, uL1Min, uL1Max)));
  }

  // direct light from the opening (top and bottom halves carry their own colour)
  vec3 direct(vec3 p, vec3 n) {
    float x0 = uApC.x - uApH.x, x1 = uApC.x + uApH.x;
    float y0 = uApC.y - uApH.y, y1 = uApC.y + uApH.y;
    float ym = uApC.y;
    float ft = rectF(p, n, x0, x1, ym, y1);
    float fb = rectF(p, n, x0, x1, y0, ym);
    vec3 top = fieldAt(vec2(0.0, 0.5 * uApH.y / (uApH.y + uCavM)));
    vec3 bot = fieldAt(vec2(0.0, -0.5 * uApH.y / (uApH.y + uCavM)));
    return top * ft + bot * fb;
  }

  // the bench's soft shadow: visibility of the opening from p (3 × 3 samples, dithered)
  float benchVis(vec3 p) {
    float h = ign(gl_FragCoord.xy + 17.0);
    float v = 0.0;
    for (int j = 0; j < 3; j++) {
      for (int i = 0; i < 3; i++) {
        vec2 o = (vec2(float(i), float(j)) + h) / 3.0 * 2.0 - 1.0;
        vec3 s = vec3(uApC + o * uApH, 0.0);
        vec3 d = s - p;
        v += benchHit(p, d) < 1.0 ? 0.0 : 1.0;
      }
    }
    return v / 9.0;
  }

  // polished stone: the opening reflected in a horizontal surface at p
  vec3 stoneReflect(vec3 p, vec3 n) {
    vec3 v = normalize(p - cameraPosition);
    vec3 r = reflect(v, vec3(0.0, 1.0, 0.0));
    float cosT = max(dot(-v, vec3(0.0, 1.0, 0.0)), 0.0);
    float fres = 0.045 + 0.955 * pow(1.0 - cosT, 5.0);
    float t = r.z < -1e-4 ? -p.z / r.z : 1e4;
    vec3 q = p + r * t;
    // the blur grows with the distance travelled, stretched along the streak
    vec2 soft = vec2(0.03 + t * uRough * 0.55, 0.05 + t * uRough * 1.2);
    vec2 dd = abs(q.xy - uApC) - uApH;
    float cov = (1.0 - smoothstep(-soft.x, soft.x, dd.x)) * (1.0 - smoothstep(-soft.y, soft.y, dd.y));
    vec2 u = clamp((q.xy - uApC) / (uApH + uCavM), -1.0, 1.0);
    vec3 fc = fieldAt(u);
    // the bench stands in the reflection (its silhouette, blurred like the rest:
    // RTAPS rays on a Vogel disk, stretched along the streak)
    float g = ign(gl_FragCoord.xy) * 6.2831853;
    float occ = 0.0;
    for (int k = 0; k < RTAPS; k++) {
      float fk = float(k);
      float rad = sqrt((fk + 0.5) / float(RTAPS));
      float a = fk * 2.3999632 + g;
      vec3 rr = normalize(r + vec3(cos(a) * 0.5, sin(a) * 1.2, 0.0) * (rad * uRough * 1.3));
      occ += benchHit(p + rr * 0.002, rr) < t ? 0.0 : 1.0 / float(RTAPS);
    }
    float up = r.z < -1e-4 ? 1.0 : 0.0;
    return fc * cov * fres * uGloss * occ * up * max(n.y, 0.0);
  }

  void main() {
    vec3 p = vP;
    vec3 n = normalize(vN);
    vec3 mean = 0.5 * (uTop + uBot);
    vec3 col;

  #if KIND == 0
    // ---- the far wall, and the field through its knife-edged opening
    vec2 d2 = abs(p.xy - uApC) - uApH;
    float sd = max(d2.x, d2.y);
    float aa = max(fwidth(sd), 1e-5);
    float inside = clamp(0.5 - sd / aa, 0.0, 1.0);
    // the sensing space: the view ray continues to its back wall (coved: clamp to its bounds)
    vec3 v = normalize(p - cameraPosition);
    float tb = (-uCavD - p.z) / min(v.z, -1e-3);
    vec2 q = p.xy + v.xy * tb;
    vec2 u = clamp((q - uApC) / (uApH + uCavM), -1.0, 1.0);
    vec3 field = fieldAt(u);
    // the wall: black plaster lit only by bounce, a touch more near the floor under the opening
    float near = exp(-sq((p.x - uApC.x) / (uApH.x * 2.2))) * exp(-p.y * 1.1);
    vec3 wall = mean * uAlbedo * (uAmb + uSpill * 0.05 * near);
    // a hairline where light catches the knife edge
    float hair = exp(-max(sd, 0.0) / (aa * 1.2)) * (1.0 - inside);
    col = mix(wall, field, inside) + mean * uHair * hair;
  #elif KIND == 1
    // ---- plaster (side walls, ceiling)
    col = uAlbedo * (direct(p, n) * uSpill + mean * uAmb);
  #else
    // ---- polished black stone (floor, bench)
    float vis = 1.0;
    #ifdef SHADOWED
      vis = benchVis(p);
    #endif
    col = uAlbedo * (direct(p, n) * uSpill * vis + mean * uAmb);
    col += stoneReflect(p, n);
  #endif
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`

export interface RoomUniforms {
  uApC: { value: THREE.Vector2 }
  uApH: { value: THREE.Vector2 }
  uTop: { value: THREE.Color }
  uBot: { value: THREE.Color }
  uTilt: { value: number }
  uCavD: { value: number }
  uCavM: { value: number }
  uCove: { value: number }
  uSpill: { value: number }
  uAmb: { value: number }
  uHair: { value: number }
  uBMin: { value: THREE.Vector3 }
  uBMax: { value: THREE.Vector3 }
  uL0Min: { value: THREE.Vector3 }
  uL0Max: { value: THREE.Vector3 }
  uL1Min: { value: THREE.Vector3 }
  uL1Max: { value: THREE.Vector3 }
}

export interface Room {
  group: THREE.Group
  u: RoomUniforms
  /** set the opening (centre + half size) */
  setAperture(cx: number, cy: number, hw: number, hh: number): void
  /** materials, for per-surface tuning */
  mats: { wall: THREE.ShaderMaterial; plaster: THREE.ShaderMaterial; floor: THREE.ShaderMaterial; bench: THREE.ShaderMaterial }
}

/** lite (phones): six reflection taps instead of eight, no soft bench shadow on the floor (it is barely visible) */
export function buildRoom(o: { lite?: boolean } = {}): Room {
  const lite = !!o.lite
  const R = ROOM
  const u: RoomUniforms = {
    uApC: { value: new THREE.Vector2(R.apX, R.apY) },
    uApH: { value: new THREE.Vector2(R.apW / 2, R.apH / 2) },
    uTop: { value: new THREE.Color(0.4, 0.3, 0.5) },
    uBot: { value: new THREE.Color(0.5, 0.3, 0.35) },
    uTilt: { value: 0 },
    uCavD: { value: R.cavityDepth },
    uCavM: { value: R.cavityMargin },
    uCove: { value: 0.3 },
    uSpill: { value: 5 },
    uAmb: { value: 0.01 },
    uHair: { value: 0.12 },
    uBMin: { value: R.bench.min.clone() },
    uBMax: { value: R.bench.max.clone() },
    uL0Min: { value: new THREE.Vector3() },
    uL0Max: { value: new THREE.Vector3() },
    uL1Min: { value: new THREE.Vector3() },
    uL1Max: { value: new THREE.Vector3() },
  }
  const mat = (kind: number, o: { albedo: number; gloss?: number; rough?: number; shadowed?: boolean }) =>
    new THREE.ShaderMaterial({
      uniforms: {
        ...u,
        uAlbedo: { value: o.albedo },
        uGloss: { value: o.gloss ?? 0 },
        uRough: { value: o.rough ?? 0.05 },
      },
      defines: { KIND: kind, RTAPS: lite ? 6 : 8, ...(o.shadowed && !lite ? { SHADOWED: 1 } : {}) },
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
  const mats = {
    wall: mat(0, { albedo: 0.16 }),
    plaster: mat(1, { albedo: 0.14 }),
    floor: mat(2, { albedo: 0.07, gloss: 0.62, rough: 0.09, shadowed: true }),
    bench: mat(2, { albedo: 0.035, gloss: 0.85, rough: 0.02 }),
  }

  const group = new THREE.Group()
  const W = R.x1 - R.x0
  const cx = (R.x0 + R.x1) / 2
  // far wall (z = 0, facing +z)
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(W, R.height), mats.wall)
  wall.position.set(cx, R.height / 2, 0)
  // floor (y = 0, facing +y)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, R.depth), mats.floor)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, 0, R.depth / 2)
  // ceiling (facing -y)
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, R.depth), mats.plaster)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(cx, R.height, R.depth / 2)
  // side walls (facing in)
  const left = new THREE.Mesh(new THREE.PlaneGeometry(R.depth, R.height), mats.plaster)
  left.rotation.y = Math.PI / 2
  left.position.set(R.x0, R.height / 2, R.depth / 2)
  const right = new THREE.Mesh(new THREE.PlaneGeometry(R.depth, R.height), mats.plaster)
  right.rotation.y = -Math.PI / 2
  right.position.set(R.x1, R.height / 2, R.depth / 2)
  // the bench: a black stone slab on two slab legs (a Judd bench). Only the
  // slab occludes in the shader: the floor's glow shows between the legs.
  const b = R.bench
  const L = R.benchLeg
  const size = new THREE.Vector3().subVectors(b.max, b.min)
  const slabGeo = new THREE.BoxGeometry(size.x, size.y, size.z)
  slabGeo.translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2)
  const legs = [b.min.x + L.inset + L.w / 2, b.max.x - L.inset - L.w / 2].map((x, i) => {
    const g = new THREE.BoxGeometry(L.w, b.min.y, size.z - 2 * L.depthInset)
    g.translate(x, b.min.y / 2, (b.min.z + b.max.z) / 2)
    ;(i ? u.uL1Min : u.uL0Min).value.set(x - L.w / 2, 0, b.min.z + L.depthInset)
    ;(i ? u.uL1Max : u.uL0Max).value.set(x + L.w / 2, b.min.y, b.max.z - L.depthInset)
    return g
  })
  const bench = new THREE.Mesh(mergeGeometries([slabGeo, ...legs])!, mats.bench)
  group.add(wall, floor, ceil, left, right, bench)
  for (const m of [wall, floor, ceil, left, right, bench]) m.frustumCulled = false

  return {
    group,
    u,
    mats,
    setAperture(x, y, hw, hh) {
      u.uApC.value.set(x, y)
      u.uApH.value.set(hw, hh)
    },
  }
}
