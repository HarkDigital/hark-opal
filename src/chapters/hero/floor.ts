import * as THREE from 'three'

/*
 * The slab's light on the polished black stone: an additive plane lying on
 * the floor that computes, per fragment, what the stone MIRRORS (the lit
 * face of the slab and the room's hairline tubes, blurred more the further
 * the reflected ray travels) plus a plain soft pool of diffuse spill in
 * front of the plinth. Analytic, so no mirror render; it follows the camera
 * exactly because the reflection is traced from uCam every frame.
 *
 *   face: a lit rectangle in the plane z = uFaceZ, x ∈ [x0, x1], y ∈ [y0, y1]
 *   lines: up to two vertical hairlines (x, z, top y, strength) with colors
 *   run: one hairline lying on the floor along x (its soft spill on the stone)
 */

const VERT = /* glsl */ `
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

const FRAG = /* glsl */ `
  uniform vec3 uCam;
  uniform vec4 uFace;      // x0, x1, y0, y1
  uniform float uFaceZ, uFloor;
  uniform vec3 uA, uB;
  uniform float uRefl, uPool;
  uniform vec4 uPoolAt;    // x, z, rx, rz
  uniform vec4 uLine0, uLine1; // x, z, top, strength
  uniform vec3 uLineC0, uLineC1;
  uniform vec4 uRun;       // a tube lying on the floor along x: x0, x1, z, strength
  uniform vec3 uRunC;
  uniform float uFade;     // world radius where the whole effect has faded out
  varying vec3 vW;

  float lineRefl(vec4 L, vec3 P, vec3 r) {
    // closest approach (in plan) of the reflected ray to a vertical hairline
    vec2 rd = r.xz;
    float rr = max(dot(rd, rd), 1e-5);
    float t = dot(L.xy - P.xz, rd) / rr;
    if (t <= 0.0) return 0.0;
    vec2 q = P.xz + rd * t - L.xy;
    float y = P.y + r.y * t;
    float w = 0.008 + t * 0.014;
    float along = smoothstep(uFloor - 0.02, uFloor + 0.1, y) * (1.0 - smoothstep(L.z - 0.4, L.z, y));
    float fall = exp(-(y - uFloor) * 0.5);
    return exp(-dot(q, q) / (w * w)) * along * fall * L.w;
  }

  void main() {
    vec3 v = normalize(vW - uCam);
    vec3 r = vec3(v.x, -v.y, v.z);
    // stone: a dielectric, much stronger at grazing angles
    float c = 1.0 - clamp(-v.y, 0.0, 1.0);
    float fr = 0.04 + 0.6 * c * c * c * c * c;
    vec3 col = vec3(0.0);
    if (r.z < -1e-3 && vW.z > uFaceZ) {
      float t = (uFaceZ - vW.z) / r.z;
      vec3 h = vW + r * t;
      // the further the reflected ray travels, the softer the image (honed stone)
      float b = 0.03 + t * 0.09;
      float fx = smoothstep(uFace.x - b, uFace.x + b, h.x) * (1.0 - smoothstep(uFace.y - b, uFace.y + b, h.x));
      float fy = smoothstep(uFace.z - b * 0.4, uFace.z + b, h.y) * (1.0 - smoothstep(uFace.w - b * 2.0, uFace.w + b, h.y));
      float g = clamp((h.x - uFace.x) / max(uFace.y - uFace.x, 1e-3) + (h.y - uFace.z) * 0.08, 0.0, 1.0);
      vec3 fc = mix(uA, uB, smoothstep(0.0, 1.0, g));
      // a blurred reflection loses the top of the face first
      float up = exp(-max(h.y - uFace.z, 0.0) * 0.55);
      col += fc * fx * fy * up * fr * uRefl;
    }
    col += uLineC0 * lineRefl(uLine0, vW, r) * fr;
    col += uLineC1 * lineRefl(uLine1, vW, r) * fr;
    // the lying tube's spill on the stone (a soft band either side of it)
    float rx = smoothstep(uRun.x - 0.3, uRun.x + 0.2, vW.x) * (1.0 - smoothstep(uRun.y - 0.2, uRun.y + 0.3, vW.x));
    float rz = vW.z - uRun.z;
    col += uRunC * rx * (exp(-rz * rz / 0.02) * 0.5 + exp(-rz * rz / 0.3) * 0.12) * uRun.w;
    // the plain pool: diffuse spill on the stone in front of the plinth
    vec2 d = (vW.xz - uPoolAt.xy) / uPoolAt.zw;
    float pool = exp(-dot(d, d));
    float px = clamp((vW.x - uFace.x) / max(uFace.y - uFace.x, 1e-3), 0.0, 1.0);
    col += mix(uA, uB, px) * pool * uPool;
    // fade the plane's own edges (never a visible rectangle)
    float rim = 1.0 - smoothstep(uFade * 0.6, uFade, length(vW.xz - uPoolAt.xy));
    gl_FragColor = vec4(col * rim, 1.0);
  }
`

export interface FloorLight {
  mesh: THREE.Mesh
  u: {
    uCam: { value: THREE.Vector3 }
    uFace: { value: THREE.Vector4 }
    uFaceZ: { value: number }
    uFloor: { value: number }
    uA: { value: THREE.Color }
    uB: { value: THREE.Color }
    uRefl: { value: number }
    uPool: { value: number }
    uPoolAt: { value: THREE.Vector4 }
    uLine0: { value: THREE.Vector4 }
    uLine1: { value: THREE.Vector4 }
    uLineC0: { value: THREE.Color }
    uLineC1: { value: THREE.Color }
    uRun: { value: THREE.Vector4 }
    uRunC: { value: THREE.Color }
    uFade: { value: number }
  }
}

/** size: the plane's side (world); centered at (cx, cz) on the floor y. */
export function floorLight(size: number, cx: number, cz: number, y: number): FloorLight {
  const u = {
    uCam: { value: new THREE.Vector3() },
    uFace: { value: new THREE.Vector4() },
    uFaceZ: { value: 0 },
    uFloor: { value: y },
    uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() },
    uRefl: { value: 0 },
    uPool: { value: 0 },
    uPoolAt: { value: new THREE.Vector4(cx, cz, 1, 1) },
    uLine0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLine1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLineC0: { value: new THREE.Color() },
    uLineC1: { value: new THREE.Color() },
    uRun: { value: new THREE.Vector4(0, 0, 0, 0) },
    uRunC: { value: new THREE.Color() },
    uFade: { value: size / 2 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(cx, y + 0.002, cz)
  mesh.renderOrder = 1
  return { mesh, u }
}
