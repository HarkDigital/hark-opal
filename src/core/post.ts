import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * Post-processing: Scene (+ Sanitize NaN guard) → Bloom → Output → FIELD → FINAL.
 * Only the scene render is multisampled (its own target, the only one with a
 * depth buffer); the composer's ping-pong targets are single-sampled.
 *
 * Earlier concepts' final passes: Orbit glitch + zoom blur; Resonance ripple;
 * Press riso halftone; Town tilt-shift + cloud wipe; Arcade pixel + CRT;
 * Frost breath fog; Noir silver-gelatin + blinds; Neon light trails +
 * lights-out.
 *
 * OPAL: a clean, quiet finish for a black gallery — no chromatic aberration
 * (polished edges stay razor sharp), a fine grain, a deep vignette, gentle
 * vibrance — and THE COLOUR-FIELD CUT (after Turrell's Ganzfeld rooms):
 * approaching a chapter boundary the frame loses its edges and dissolves
 * into a soft field of its own light (a 1/32-res copy of the frame, then its
 * average), luminous and uniform at the boundary; after it the next scene
 * resolves out of its own field. Brightness is conserved through the cut (a
 * blur, not a flash). The FIELD pass only runs while a cut is on screen.
 * Calm (reduced motion / Motion off): a plain fade through near-black.
 *
 * The final pass runs AFTER the sRGB output pass: it sees display values.
 * Keep the Post API (params / resetParams / setSize / render / compileAsync /
 * setFadeTone) and the uTransition / uFade / uFlash / uGlitch uniforms.
 */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 1/32-res copy of the frame (FIELD pass), bilinear */
    tField: { value: null as THREE.Texture | null },
    uFieldTexel: { value: new THREE.Vector2(1 / 64, 1 / 36) },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    /** 0..1, peaks exactly at a chapter boundary (engine-driven) */
    uTransition: { value: 0 },
    /** 0..1 a soft defocus a chapter can ask for (a focus pull), no cut */
    uGlitch: { value: 0 },
    uAberration: { value: 0 },
    uGrain: { value: 0.016 },
    uVignette: { value: 0.45 },
    /** 0..1 wash to white */
    uFlash: { value: 0 },
    /** 0..1 fade to uFadeColor (calm cuts) */
    uFade: { value: 0 },
    uCutColor: { value: new THREE.Color('#040306') },
    uFadeColor: { value: new THREE.Color('#040306') },
    /** 0..1 speed dim: the whole frame dims while the page moves fast (flash safety net) */
    uSpeedDim: { value: 0 },
    /** vibrance (1 = none) and black-point lift */
    uSat: { value: 1.04 },
    uLift: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tField;
    uniform vec2 uFieldTexel;
    uniform float uTime, uDpr, uTransition, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade, uSpeedDim, uSat, uLift;
    uniform vec2 uResolution;
    uniform vec3 uCutColor, uFadeColor;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    // a smooth read of the low-res field (5 bilinear taps: no blocky cross artifacts)
    vec3 field(vec2 uv) {
      vec2 o = uFieldTexel;
      return (texture2D(tField, uv).rgb * 2.0
        + texture2D(tField, uv + vec2(o.x, o.y)).rgb
        + texture2D(tField, uv + vec2(-o.x, o.y)).rgb
        + texture2D(tField, uv + vec2(o.x, -o.y)).rgb
        + texture2D(tField, uv + vec2(-o.x, -o.y)).rgb) / 6.0;
    }
    // the field's mean colour: 9 taps across the frame
    vec3 fieldMean() {
      vec3 m = vec3(0.0);
      for (int y = 0; y < 3; y++)
        for (int x = 0; x < 3; x++) m += texture2D(tField, vec2(0.2 + 0.3 * float(x), 0.2 + 0.3 * float(y))).rgb;
      return m / 9.0;
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      vec3 col;
      if (uAberration > 0.00001) {
        col.r = texture2D(tDiffuse, uv + c * uAberration).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - c * uAberration).b;
      } else col = texture2D(tDiffuse, uv).rgb;

      // THE COLOUR-FIELD CUT (and a chapter's soft focus pull via uGlitch)
      float t = clamp(uTransition, 0.0, 1.0);
      float soft = max(t, clamp(uGlitch, 0.0, 1.0) * 0.6);
      if (soft > 0.001) {
        vec3 f = field(uv);
        // the field is a blur: it keeps the frame's brightness, loses its edges
        float k = smoothstep(0.0, 0.75, soft);
        col = mix(col, f, k);
        // at the boundary the field itself evens out into one luminous colour
        vec3 mean = fieldMean();
        float u = smoothstep(0.55, 1.0, t);
        // a gentle radial falloff keeps it a room, not a flat card
        float room = 1.0 - 0.35 * smoothstep(0.1, 0.9, length(c * vec2(1.2, 1.0)));
        col = mix(col, max(mean, uCutColor) * room * 1.05, u);
      }

      col *= 1.0 - clamp(uSpeedDim, 0.0, 0.8);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(l), col, uSat), 0.0);
      col = uLift + col * (1.0 - uLift);
      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      float v = 1.0 - smoothstep(0.35, 1.05, length(c * vec2(1.0, 0.9)) * 1.4);
      col *= mix(1.0, 0.5 + 0.5 * v, uVignette);
      vec2 gp = floor(vUv * uResolution / max(1.0, uDpr));
      col += (hash(gp + fract(floor(uTime * 24.0) * 0.1317) * 97.0) - 0.5) * uGrain;
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

/** minimum seconds between two white-flash onsets (WCAG 2.3.1) */
const FLASH_GAP = 0.4

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  /** a soft focus pull 0..1 (chapters: a rack-focus beat) */
  glitch: number
  /** white wash 0..1 */
  flash: number
  exposure: number
  /** vibrance (1 = none) */
  saturation: number
  /** black-point lift 0..0.15 */
  lift: number
}

/**
 * Bloom only on true highlights (tube cores seen through clear glass,
 * polished glints): light through FROSTED glass is already soft.
 */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.5,
  bloomRadius: 0.5,
  bloomThreshold: 0.95,
  aberration: 0,
  grain: 0.016,
  vignette: 0.45,
  glitch: 0,
  flash: 0,
  exposure: 1,
  saturation: 1.04,
  lift: 0,
}

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through bloom.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

/**
 * Renders the scene into its OWN target — the only multisampled one and the
 * only one with depth — then sanitizes (NaN guard) into the composer's
 * single-sampled read buffer. Multisampled ping-pong targets cost 2–3x per
 * post pass (Frost's lesson), so MSAA lives here only.
 */
class ScenePass extends Pass {
  target: THREE.WebGLRenderTarget
  material: THREE.ShaderMaterial
  private quad: FullScreenQuad
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    samples: number,
  ) {
    super()
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples })
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SanitizeShader.uniforms),
      vertexShader: SanitizeShader.vertexShader,
      fragmentShader: SanitizeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.material)
  }
  setSize(w: number, h: number) {
    this.target.setSize(w, h)
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    this.material.uniforms.tDiffuse.value = this.target.texture
    renderer.setRenderTarget(this.renderToScreen ? null : read)
    this.quad.render(renderer)
  }
}

/**
 * FIELD: a 1/32-res copy of the frame for the colour-field cut, made in two
 * box-filtered steps (1/8, then 1/32). Doesn't touch the ping-pong buffers
 * (needsSwap false); skipped entirely when no cut is on screen.
 */
const DownShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    void main() {
      vec2 o = uTexel;
      vec3 c = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tDiffuse, vUv + vec2(o.x, -o.y)).rgb
        + texture2D(tDiffuse, vUv + vec2(-o.x, o.y)).rgb + texture2D(tDiffuse, vUv + vec2(o.x, o.y)).rgb;
      gl_FragColor = vec4(c * 0.25, 1.0);
    }
  `,
}

class FieldPass extends Pass {
  a = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: false })
  b = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, depthBuffer: false })
  material = new THREE.ShaderMaterial({ ...DownShader, uniforms: THREE.UniformsUtils.clone(DownShader.uniforms), depthTest: false, depthWrite: false })
  private quad = new FullScreenQuad(this.material)
  active = false
  constructor() {
    super()
    this.needsSwap = false
  }
  setSize(w: number, h: number) {
    this.a.setSize(Math.max(8, Math.round(w / 8)), Math.max(8, Math.round(h / 8)))
    this.b.setSize(Math.max(4, Math.round(w / 32)), Math.max(4, Math.round(h / 32)))
  }
  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
    if (!this.active) return
    const u = this.material.uniforms
    u.tDiffuse.value = read.texture
    u.uTexel.value.set(1 / read.width, 1 / read.height).multiplyScalar(2)
    renderer.setRenderTarget(this.a)
    this.quad.render(renderer)
    u.tDiffuse.value = this.a.texture
    u.uTexel.value.set(1 / this.a.width, 1 / this.a.height).multiplyScalar(1.5)
    renderer.setRenderTarget(this.b)
    this.quad.render(renderer)
  }
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  private scenePass: ScenePass
  /**
   * Chapters write targets here every frame (the engine resets them to
   * defaults first); values are damped so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  fade = 0
  /** engine: reduced motion or the visitor's Motion switch is off */
  calm = false
  /** engine: smoothed scroll velocity in viewport heights per second (signed) */
  velocity = 0
  /** engine: +1 when the nearest boundary is ahead (leaving a chapter), -1 when behind (entering) */
  cutSide = 1
  private speedDim = 0
  private field: FieldPass
  /**
   * Run right before the scene renders each frame, at the TOP level (camera
   * already placed, its matrixWorld updated). Mirrors/reflectors render here
   * instead of from Mesh.onBeforeRender: a nested render makes every lit
   * material re-resolve its program twice a frame. Check your own group's
   * visibility inside the hook (it runs whichever chapter is active).
   */
  preRender: ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void)[] = []
  private lastFlashAt = -1e9
  private flashLive = false
  private flashOk = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    /** skip MSAA (retina / mobile: already supersampled; MSAA half-float targets are huge) */
    noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: false,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.scenePass = new ScenePass(scene, camera, noMsaa ? 0 : 4)
    this.composer.addPass(this.scenePass)
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), POST_DEFAULTS.bloomStrength, POST_DEFAULTS.bloomRadius, POST_DEFAULTS.bloomThreshold)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.field = new FieldPass()
    this.composer.addPass(this.field)
    this.final = new ShaderPass(FinalShader)
    this.final.uniforms.tField.value = this.field.b.texture
    this.composer.addPass(this.final)
  }

  /** The scene's render target (HDR, linear; multisampled on 1x desktops) — prewarm compiles against it. */
  get sceneTarget() {
    return this.scenePass.target
  }

  /** true when `rt` is the frame's own scene target (not a mirror / transmission pass) */
  isFrameTarget(rt: THREE.WebGLRenderTarget | null) {
    return rt === this.scenePass.target || rt === this.composer.renderTarget1 || rt === this.composer.renderTarget2
  }

  /** THEME: colour the cut and calm fade pass through. */
  setCutColor(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uCutColor.value as THREE.Color).set(color)
    ;(this.final.uniforms.uFadeColor.value as THREE.Color).set(color)
  }

  /** Engine hook (kept for compatibility; themes may tint the fade by scene tone). */
  setFadeTone(_tone: number) {}

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /**
   * Compile every post-processing shader in parallel so the first composer
   * render doesn't block on synchronous links.
   */
  compileAsync(): Promise<unknown> {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const b = this.bloom as unknown as Record<string, unknown>
    const mats: THREE.Material[] = []
    const add = (m: unknown) => {
      if (m && (m as THREE.Material).isMaterial) mats.push(m as THREE.Material)
    }
    for (const pass of this.composer.passes) add((pass as unknown as { material?: unknown }).material)
    for (const m of (b.separableBlurMaterials as unknown[]) ?? []) add(m)
    add(b.compositeMaterial)
    add(b.blendMaterial)
    add(b.materialHighPassFilter)
    add(b.copyMaterial)
    return Promise.all(mats.map(m => this.renderer.compileAsync(new THREE.Mesh(quad.geometry, m), cam).catch(() => {})))
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
    this.final.uniforms.uFieldTexel.value.set(1 / this.field.b.width, 1 / this.field.b.height)
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    // flash budget (WCAG 2.3.1): a flash starting within FLASH_GAP of the last is dropped
    if (c.flash > 0.02) {
      if (!this.flashLive) {
        this.flashLive = true
        this.flashOk = time - this.lastFlashAt >= FLASH_GAP
        if (this.flashOk) this.lastFlashAt = time
      }
      if (!this.flashOk) c.flash = 0
    } else this.flashLive = false
    // speed dim (WCAG 2.3.1 safety net): the frame dims as the page moves fast,
    // attack ~0.2 s, release ~0.6 s — slow enough that wheel notches under
    // reduced motion (instant scroll, spiky velocity) read as one steady dim
    {
      const v = Math.abs(this.velocity)
      const x = Math.max(0, Math.min(1, (v - 1.1) / 2.4))
      const target = x * x * (3 - 2 * x) * 0.5
      const tau = target > this.speedDim ? 0.2 : 0.6
      this.speedDim += (target - this.speedDim) * (1 - Math.exp(-dt / tau))
    }
    // chapters zero bloom where nothing crosses the threshold: skip the pass entirely
    this.bloom.enabled = c.bloomStrength > 0.01
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFade.value = this.fade
    u.uSpeedDim.value = this.speedDim
    u.uSat.value = c.saturation
    u.uLift.value = c.lift
    this.field.active = this.transition > 0.001 || c.glitch > 0.001
    if (this.preRender.length) {
      this.camera.updateMatrixWorld()
      for (const fn of this.preRender) fn(this.renderer, this.scene, this.camera)
    }
    this.composer.render(dt)
  }
}
