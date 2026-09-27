import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'
import { storeKey } from './prefs'

/*
 * OPAL sound: a light gallery after dark (WebAudio only, no files).
 *
 *   room     the gallery's own air: soft filtered noise, dark and wide (two
 *            decorrelated channels), breathing very slowly — barely there
 *   pad      a slow evolving pad in warm major-7th voicings: each room of the
 *            story has its own pair of chords and its own COLOUR (how open
 *            the low-pass is, how loud the pad and the room, how much high
 *            shimmer) — Threshold Dbmaj9, Light Boxes Gbmaj9, Spectrum the
 *            brightest (Abmaj9), Afterglow soft Ebmaj9, Night Watch low and
 *            cool (Gbmaj7#11, the pad thins), The Studio Abmaj7, Foyer an open
 *            Dbmaj9. Sine + triangle voices, gently detuned, long swells
 *            (3.5 s in, 5 s out) that overlap, each voice breathing on its
 *            own slow LFO, a long generated room
 *   blip()   a glassy chime: a few inharmonic sine partials (a struck glass
 *            rod), tuned to the room's chord; `pitch` walks up its tones
 *   cut()    a soft swell: air rising through a band-pass and the pad opening
 *            for a moment, then the next room's colour settles in
 *   tone()   a pure sine a chapter may ask for (also via 'hark:tone' events)
 *
 * CPU: chords are scheduled ~0.4 s ahead by a 100 ms lookahead timer (never
 * per frame); the beds are a handful of always-running nodes; update() only
 * touches gains when the room changes (debounced, so a fast scroll through
 * three rooms doesn't churn the pad) or ~8×/s for the scroll air. Off by
 * default. Sound only ever starts from a real gesture: the toggle's own
 * click / tap / Enter / Space. A remembered "on" (localStorage, per concept)
 * waits for the first real activation (a click or tap, or Enter / Space on a
 * control; never Tab, arrows or scrolling). Faded out and suspended while
 * the tab is hidden. On iOS the audio session is set to "playback" so the
 * silent switch doesn't swallow it. Levels stay low, behind a gentle
 * compressor.
 *
 * Keep the API: enabled, onChange, toggle(), update(), cut(), blip(), tone().
 */

const STORE_KEY = storeKey('sound')

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

interface Colour {
  /** two chords (MIDI), alternating */
  chords: number[][]
  /** pad low-pass centre (Hz) */
  warmth: number
  /** pad level 0..~1.3 */
  pad: number
  /** room tone level 0..~1.5 */
  room: number
  /** high octave shimmer on the top voices 0..1 */
  air: number
}

const COLOURS: Record<string, Colour> = {
  // Dbmaj9 ↔ Gbmaj9/Db
  hero: { chords: [[49, 56, 60, 63, 65], [49, 54, 58, 61, 65]], warmth: 900, pad: 1, room: 1, air: 0.35 },
  // Gbmaj9 ↔ Dbmaj7/F
  work: { chords: [[42, 53, 56, 58, 61], [41, 49, 53, 56, 60]], warmth: 980, pad: 1, room: 0.9, air: 0.4 },
  // Abmaj9 ↔ Dbmaj9: the brightest room
  services: { chords: [[44, 51, 55, 58, 60], [49, 56, 60, 63, 65]], warmth: 1250, pad: 1.05, room: 0.85, air: 0.6 },
  // Ebmaj9/Bb ↔ Abmaj7/Eb: soft, a colour field
  voices: { chords: [[46, 51, 55, 58, 62], [51, 55, 56, 60, 63]], warmth: 820, pad: 1.15, room: 0.8, air: 0.3 },
  // Gbmaj7#11: low and cool; the pad thins, the room comes forward
  shield: { chords: [[42, 49, 53, 60, 65], [42, 49, 53, 58, 60]], warmth: 560, pad: 0.6, room: 1.4, air: 0.1 },
  // Abmaj7/C ↔ Gbmaj9
  process: { chords: [[48, 51, 55, 56, 63], [42, 53, 56, 58, 61]], warmth: 1000, pad: 1, room: 0.9, air: 0.45 },
  // an open Dbmaj9, the warmest
  contact: { chords: [[37, 56, 60, 63, 68], [37, 53, 60, 63, 65]], warmth: 1100, pad: 1.25, room: 0.75, air: 0.5 },
}

const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'

/* levels (linear gain, before the master) */
const MASTER_LEVEL = 0.6
const ROOM_LEVEL = 0.022
const PAD_LEVEL = 0.1
const AIR_LEVEL = 0.05
const CHIME_LEVEL = 0.034
const SWELL_LEVEL = 0.03
const TONE_MAX = 0.03

/* the pad */
const CHORD_S = 8.5
const ATTACK_S = 3.5
const RELEASE_S = 5
const LOOKAHEAD = 0.4
const TICK_MS = 100
/** a room must hold this long before the pad follows it (fast scrolls don't churn) */
const SETTLE_S = 0.7

/** struck glass: partial ratios, relative levels, decay (s) */
const GLASS: readonly (readonly [number, number, number])[] = [
  [1, 1, 2.2],
  [2.76, 0.42, 1.3],
  [5.4, 0.2, 0.7],
  [8.93, 0.08, 0.35],
]

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const rand = (a: number, b: number) => a + Math.random() * (b - a)

function setAudioSession(type: string) {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = type
  } catch {
    /* not supported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private verbIn!: GainNode
  private room!: GainNode
  private pad!: GainNode
  private padLp!: BiquadFilterNode
  private air!: GainNode
  private fx!: GainNode
  private noise: AudioBuffer | null = null
  private toneOsc: OscillatorNode | null = null
  private toneGain: GainNode | null = null

  private chapter = 'hero'
  private slotIds: string[] = []
  /** the colour the pad is playing */
  private colourKey = ''
  private colour: Colour = COLOURS.hero
  /** the room the story is in, and since when (audio clock) */
  private pendingKey = 'hero'
  private pendingSince = 0
  private timer = 0
  private nextChordAt = 0
  private chordIndex = 0
  private chordStartedAt = -100
  private lastCut = -10
  private lastBlip = -10
  private lastSpeedAt = -10
  private speed = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" waiting for the first real gesture */
  private armed = false
  private gestureBound = false
  private toneHz = 440
  private toneLevel = 0

  constructor() {
    this.armed = stored() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
    // the static page took over (no GPU): silence, without touching the stored choice
    window.addEventListener('hark:fallback', () => this.setEnabled(false))
  }

  /** was sound on last visit? (it still needs a gesture to start) */
  get remembered() {
    return stored() === true
  }

  /** Flip the sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    try {
      localStorage.setItem(STORE_KEY, this.enabled ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  /** Follow the story: each room recolours the pad (once it holds); scroll speed stirs the air. */
  update(frame: Frame, state: EngineState) {
    const slot = state.slots[state.index]
    if (slot) this.chapter = slot.def.id
    if (this.slotIds.length !== state.slots.length) this.slotIds = state.slots.map(s => s.def.id)
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (this.chapter !== this.pendingKey) {
      this.pendingKey = this.chapter
      this.pendingSince = now
    }
    if (this.pendingKey !== this.colourKey && now - this.pendingSince > SETTLE_S) this.setColour(this.pendingKey, ctx, 1.4, true)
    // a little more air while the gallery slides past (≈ 8×/s)
    if (now - this.lastSpeedAt > 0.12) {
      this.lastSpeedAt = now
      const s = clamp01(Math.abs(frame.velocity || 0) / 3)
      if (Math.abs(s - this.speed) > 0.04) {
        this.speed = s
        this.air.gain.setTargetAtTime(this.airTarget(), now, s > 0.1 ? 0.12 : 0.6)
      }
    }
  }

  /** A chapter cut: a soft swell of air and light, then the next room's colour. */
  cut(_from: number, to: number) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const toId = this.slotIds[to]
    if (toId) {
      this.pendingKey = toId
      this.pendingSince = now
    }
    // a fast run of cuts: no more swells, the pad waits for the story to settle
    if (now - this.lastCut < 0.9) return
    this.lastCut = now
    // air rising through a slowly opening band-pass
    if (this.noise) {
      const src = ctx.createBufferSource()
      src.buffer = this.noise
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.9
      bp.frequency.setValueAtTime(420, now)
      bp.frequency.exponentialRampToValueAtTime(2400, now + 0.9)
      bp.frequency.exponentialRampToValueAtTime(1200, now + 2)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(SWELL_LEVEL, now + 0.75)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 2.1)
      src.connect(bp).connect(g).connect(this.fx)
      src.start(now, Math.random() * (this.noise.duration - 2.5))
      src.stop(now + 2.2)
    }
    // the pad opens for a moment, like a light coming up behind glass
    const f = this.padLp.frequency
    f.cancelScheduledValues(now)
    f.setValueAtTime(f.value, now)
    f.setTargetAtTime(this.colour.warmth * 1.8, now, 0.35)
    f.setTargetAtTime(this.colour.warmth, now + 0.9, 0.9)
  }

  /** A glassy chime (nav, toggles), tuned to the room. `pitch` walks up its tones. No-op while off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.08) return
    this.lastBlip = now
    const tones = [...new Set(this.colour.chords[0].map(m => ((m % 12) + 12) % 12))].sort((a, b) => a - b)
    const p = Math.max(0, Math.min(24, Math.round(pitch)))
    const pc = tones[p % tones.length]
    const oct = Math.floor(p / tones.length)
    this.chime(ctx, now + 0.005, mtof(81 + pc + 12 * Math.min(1, oct)), rand(-0.35, 0.35), 1)
  }

  /** A pure sine a chapter may ask for: level 0..1 (0 releases it). */
  tone(hz: number, level: number) {
    if (Number.isFinite(hz) && hz > 20 && hz < 12000) this.toneHz = hz
    this.toneLevel = clamp01(Number.isFinite(level) ? level : 0)
    this.applyTone()
  }

  /* ------------------------------------------------------------ internals */

  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private airTarget() {
    return this.colour.air * AIR_LEVEL * (1 + 1.2 * this.speed)
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) {
      try {
        this.ensureGraph()
      } catch (err) {
        console.warn('[hark] audio unavailable', err)
      }
    }
    this.applyRunning(true)
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, from enabled / hidden. */
  private applyRunning(greet = false) {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.6)
          this.pendingKey = this.chapter
          this.colourKey = ''
          this.setColour(this.chapter, ctx, 0.4, false)
          this.applyTone()
          // never catch up on chords missed while hidden: pick the pad up from here
          if (this.nextChordAt < t) this.nextChordAt = t + 0.05
          this.startClock()
          if (greet) this.blip(4)
        })
        .catch(() => this.waitForGesture())
    } else {
      this.stopClock()
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.3)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1500,
      )
    }
  }

  /** Start audio on the first real gesture (a remembered "on", or a blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    let sx = 0
    let sy = 0
    const events = ['click', 'keydown', 'touchstart', 'touchend'] as const
    const handler = (e: Event) => {
      if (e.type === 'touchstart') {
        const t = (e as TouchEvent).touches[0]
        if (t) {
          sx = t.clientX
          sy = t.clientY
        }
        return
      }
      if (e.type === 'touchend') {
        // a tap, not a scroll or a swipe
        const t = (e as TouchEvent).changedTouches[0]
        if (!t || Math.hypot(t.clientX - sx, t.clientY - sy) > 12) return
      }
      // keyboard: only Enter / Space on a control is "play"; Tab and friends are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, { capture: true, passive: true })
  }

  /* ------------------------------------------------------------ the graph */

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx
    const sr = ctx.sampleRate

    // master → rumble guard → gentle compression → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 45
    hp.Q.value = 0.5
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -24
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.03
    comp.release.value = 0.6
    this.master.connect(hp).connect(comp).connect(ctx.destination)

    // the gallery: a long, soft generated stereo room (~3.6 s, darker as it decays)
    const irLen = Math.floor(sr * 3.6)
    const ir = ctx.createBuffer(2, irLen, sr)
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c)
      let lp = 0
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen
        const k = 0.35 + 0.55 * t
        lp = lp * k + (Math.random() * 2 - 1) * (1 - k)
        const env = Math.pow(1 - t, 2.4)
        d[i] = lp * env * (i < sr * 0.03 ? i / (sr * 0.03) : 1) * 1.4
      }
    }
    const verb = ctx.createConvolver()
    verb.buffer = ir
    this.verbIn = ctx.createGain()
    const wet = ctx.createGain()
    wet.gain.value = 0.85
    this.verbIn.connect(verb).connect(wet).connect(this.master)

    const bus = (level: number, send: number) => {
      const g = ctx.createGain()
      g.gain.value = level
      g.connect(this.master)
      if (send > 0) {
        const s = ctx.createGain()
        s.gain.value = send
        g.connect(s).connect(this.verbIn)
      }
      return g
    }

    // soft (pinkish) noise, 6 s: the room, the air and the swells
    const nLen = Math.floor(sr * 6)
    this.noise = ctx.createBuffer(2, nLen, sr)
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c)
      let b0 = 0
      let b1 = 0
      let b2 = 0
      for (let i = 0; i < nLen; i++) {
        const w = Math.random() * 2 - 1
        b0 = 0.99765 * b0 + w * 0.099046
        b1 = 0.963 * b1 + w * 0.2965164
        b2 = 0.57 * b2 + w * 1.0526913
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2
      }
      // loop seam: a short crossfade into the start
      const xf = Math.floor(sr * 0.05)
      for (let i = 0; i < xf; i++) {
        const a = i / xf
        d[nLen - xf + i] = d[nLen - xf + i] * (1 - a) + d[i] * a
      }
    }

    // ROOM: dark, wide, breathing — the gallery's own air
    this.room = bus(0, 0.12)
    const roomSrc = ctx.createBufferSource()
    roomSrc.buffer = this.noise
    roomSrc.loop = true
    const roomLp = ctx.createBiquadFilter()
    roomLp.type = 'lowpass'
    roomLp.frequency.value = 650
    roomLp.Q.value = 0.3
    const roomHp = ctx.createBiquadFilter()
    roomHp.type = 'highpass'
    roomHp.frequency.value = 90
    const roomAmp = ctx.createGain()
    roomAmp.gain.value = 1
    roomSrc.connect(roomHp).connect(roomLp).connect(roomAmp).connect(this.room)
    roomSrc.start(0, rand(0, 5))
    const breathe = ctx.createOscillator()
    breathe.frequency.value = 0.06
    const breatheAmt = ctx.createGain()
    breatheAmt.gain.value = 0.22
    breathe.connect(breatheAmt).connect(roomAmp.gain)
    breathe.start()

    // AIR: a faint high band (the shimmer of light through glass) — rises with scroll speed
    this.air = bus(0, 0.4)
    const airSrc = ctx.createBufferSource()
    airSrc.buffer = this.noise
    airSrc.loop = true
    const airBp = ctx.createBiquadFilter()
    airBp.type = 'bandpass'
    airBp.frequency.value = 5200
    airBp.Q.value = 0.7
    const airAmp = ctx.createGain()
    airAmp.gain.value = 0.35
    airSrc.connect(airBp).connect(airAmp).connect(this.air)
    airSrc.start(0, rand(0, 5))
    const shimmer = ctx.createOscillator()
    shimmer.frequency.value = 0.13
    const shimmerAmt = ctx.createGain()
    shimmerAmt.gain.value = 0.15
    shimmer.connect(shimmerAmt).connect(airAmp.gain)
    shimmer.start()

    // PAD: one bus, one slow-breathing low-pass (the chords feed it)
    this.padLp = ctx.createBiquadFilter()
    this.padLp.type = 'lowpass'
    this.padLp.frequency.value = this.colour.warmth
    this.padLp.Q.value = 0.5
    const sweep = ctx.createOscillator()
    sweep.frequency.value = 0.037
    const sweepAmt = ctx.createGain()
    sweepAmt.gain.value = 180
    sweep.connect(sweepAmt).connect(this.padLp.frequency)
    sweep.start()
    this.pad = bus(0, 0.6)
    this.padLp.connect(this.pad)

    // chimes and swells go straight out, with plenty of room
    this.fx = bus(1, 0.55)

    // a pure tone a chapter may ask for
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain).connect(this.master)
    this.toneOsc.start()
  }

  /** Recolour the pad for a room; `early` brings the next chord in soon (the change is heard). */
  private setColour(id: string, ctx: AudioContext, tc: number, early: boolean) {
    const c = COLOURS[id] ?? COLOURS.hero
    this.colourKey = id
    this.colour = c
    const now = ctx.currentTime
    this.room.gain.setTargetAtTime(c.room * ROOM_LEVEL, now, tc)
    this.pad.gain.setTargetAtTime(c.pad * PAD_LEVEL, now, tc * 1.4)
    this.air.gain.setTargetAtTime(this.airTarget(), now, tc)
    const f = this.padLp.frequency
    f.cancelScheduledValues(now)
    f.setValueAtTime(f.value, now)
    f.setTargetAtTime(c.warmth, now, tc * 1.6)
    this.chordIndex = 0
    // the new room's chord swells in over the old one (never a cut-off)
    if (early && now - this.chordStartedAt > 2.5 && this.nextChordAt > now + 1.2) this.nextChordAt = now + 0.15
  }

  /* ------------------------------------------------------------ the clock */

  private startClock() {
    if (this.timer) return
    this.timer = window.setInterval(() => this.schedule(), TICK_MS)
    this.schedule()
  }

  private stopClock() {
    clearInterval(this.timer)
    this.timer = 0
  }

  /** everything due in the next LOOKAHEAD seconds, scheduled on the audio clock */
  private schedule() {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const horizon = now + LOOKAHEAD
    // a stalled timer (a long task) must not dump a backlog at once
    if (this.nextChordAt < now - 0.5) this.nextChordAt = now + 0.05
    while (this.nextChordAt < horizon) {
      const chords = this.colour.chords
      this.chord(ctx, this.nextChordAt, chords[this.chordIndex % chords.length], this.colour.air)
      this.chordStartedAt = this.nextChordAt
      this.chordIndex = (this.chordIndex + 1) % chords.length
      this.nextChordAt += CHORD_S
    }
  }

  /* ------------------------------------------------------------ voices */

  /** one chord: a long swell and release, two gently detuned voices per note, each breathing */
  private chord(ctx: AudioContext, t: number, notes: number[], air: number) {
    const len = CHORD_S + RELEASE_S
    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(1, t + ATTACK_S)
    env.gain.setValueAtTime(1, t + CHORD_S - 0.5)
    env.gain.linearRampToValueAtTime(0, t + len)
    env.connect(this.padLp)
    const nodes: AudioScheduledSourceNode[] = []
    notes.forEach((m, i) => {
      const f = mtof(m)
      // the bass note a little louder, the top a little softer
      const lvl = (i === 0 ? 0.24 : 0.17) * (i === notes.length - 1 ? 0.8 : 1)
      // each voice breathes on its own slow LFO, so the chord keeps evolving
      const vg = ctx.createGain()
      vg.gain.value = lvl
      const lfo = ctx.createOscillator()
      lfo.frequency.value = rand(0.05, 0.14)
      const lfoAmt = ctx.createGain()
      lfoAmt.gain.value = lvl * 0.35
      lfo.connect(lfoAmt).connect(vg.gain)
      vg.connect(env)
      nodes.push(lfo)
      for (const [type, det, a] of [
        ['sine', -4, 1],
        ['triangle', 5, 0.55],
      ] as const) {
        const o = ctx.createOscillator()
        o.type = type
        o.frequency.value = f
        o.detune.value = det + rand(-2, 2)
        const g = ctx.createGain()
        g.gain.value = a
        o.connect(g).connect(vg)
        nodes.push(o)
      }
      // shimmer: the top two voices an octave up, very soft (the light through glass)
      if (air > 0.05 && i >= notes.length - 2) {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.value = f * 2
        o.detune.value = rand(-4, 4)
        const g = ctx.createGain()
        g.gain.value = 0.22 * air
        o.connect(g).connect(vg)
        nodes.push(o)
      }
    })
    for (const n of nodes) {
      n.start(t)
      n.stop(t + len + 0.05)
    }
  }

  /** a struck glass rod: inharmonic sine partials, the high ones dying first */
  private chime(ctx: AudioContext, t: number, f: number, pan: number, level: number) {
    let out: AudioNode = this.fx
    if (pan && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      p.connect(this.fx)
      out = p
    }
    for (const [ratio, amp, decay] of GLASS) {
      const hz = f * ratio
      if (hz > 16000) continue
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = hz
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, CHIME_LEVEL * amp * level), t + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
      o.connect(g).connect(out)
      o.start(t)
      o.stop(t + decay + 0.05)
    }
  }

  private applyTone() {
    const ctx = this.ctx
    if (!ctx || !this.toneOsc || !this.toneGain) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.08)
    this.toneGain.gain.setTargetAtTime(this.toneLevel * TONE_MAX, now, 0.12)
  }
}
