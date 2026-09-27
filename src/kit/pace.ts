/*
 * PACING for item montages (WCAG 2.3.1). A scroll can sweep the camera past
 * bright signs faster than 3 a second: each pass swings a screen block's
 * luminance up and down (a flash), and Striker's budget can't help because
 * nothing flickers — the camera moves. A StoryClock is a time-paced view of
 * `local`: it follows the scroll, but never faster than `maxRate` local units
 * per second, and snaps on teleports (nav jumps, screenshots, entering the
 * chapter). Drive the camera AND the active item from clock.value, not from
 * local, and report clock.busy through chapter.busy().
 *
 *   const clock = new StoryClock({ rate: itemsPerSecond * slotLength })
 *   update(local, frame) { const q = clock.update(local, frame.dt) ... }
 *   onEnter() { clock.reset() }
 *   busy: () => clock.busy
 *
 * Rule of thumb: ≤ 1.2 item changes per second (one bright pass per block
 * per ~0.8 s), and camera moves between items that take ≥ 0.5 s of TIME.
 */
export class StoryClock {
  value = NaN
  private last = NaN
  private target = 0
  /** local units per second */
  rate: number
  /** a single-frame jump in local larger than this is a teleport: snap */
  snap: number

  constructor({ rate, snap = 0.12 }: { rate: number; snap?: number }) {
    this.rate = rate
    this.snap = snap
  }

  update(target: number, dt: number): number {
    this.target = target
    if (!Number.isFinite(this.value) || !Number.isFinite(this.last) || Math.abs(target - this.last) > this.snap) {
      this.value = target
    } else {
      const step = this.rate * Math.max(0, dt)
      const d = target - this.value
      this.value += Math.max(-step, Math.min(step, d))
    }
    this.last = target
    return this.value
  }

  /** forget the past (onEnter): the next update snaps */
  reset() {
    this.value = NaN
    this.last = NaN
  }

  /** still catching up with the scroll (keep the Motion-off heartbeat awake) */
  get busy() {
    return Number.isFinite(this.value) && Math.abs(this.target - this.value) > 1e-4
  }
}
