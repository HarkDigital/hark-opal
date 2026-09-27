import * as THREE from 'three'
import type { Chapter } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { ease, segment, smoothstep } from '../../core/math'
import { framedCamera } from '../common'
import { Dimmer, etchMap, etchMark, lightTube, opalBox, stoneFloor } from '../../kit/opal'
import { caustic } from '../../kit/glass'
import '../chapter.css'

/*
 * HERO (look lab). The foundation's smoke test: a thick frosted slab with
 * the Hark mark polished clear through it, a dusk-gradient light card
 * behind, two thin tubes at the edges, a black stone floor. The hero agent
 * replaces the scene; keep the copy pattern (intro → payoff with CTAs).
 */
export default function create(): Chapter {
  const group = new THREE.Group()
  let intro: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement
  let box: ReturnType<typeof opalBox>
  const tubes: { part: ReturnType<typeof lightTube>; d: Dimmer }[] = []
  const dim = new Dimmer(0.9, 0.4)
  return {
    id: 'hero',
    group,
    anchors: [0.8],
    init(ctx) {
      const W = 2.6
      const H = 3.4
      const etch = etchMap(W, H, (g, _W, _H, toPx) => {
        etchMark(g, toPx, { cy: 0.15, height: 1.5 })
        // a single polished hairline across the lower third
        const [x0, y0] = toPx(-W * 0.36, -1.1)
        const [x1] = toPx(W * 0.36, -1.1)
        g.fillRect(x0, y0 - 1.5, x1 - x0, 3)
      })
      box = opalBox({ w: W, h: H, depth: 0.12, gap: 0.34, a: 'blush', b: 'periwinkle', angle: 1.2, hdr: 0.55, frost: 0.62, etch, tubes: 9, tubeHdr: 2.2 })
      box.group.position.set(0, 0.2, 0)
      group.add(box.group)
      for (const x of [-2.6, 2.6]) {
        const t = lightTube(3.6, { color: x < 0 ? 'blush' : 'periwinkle', hdr: 2.2 })
        t.group.position.set(x, 0.3, -1.2)
        group.add(t.group)
        tubes.push({ part: t, d: new Dimmer(0.9, 0.4) })
      }
      const floor = stoneFloor(30, 20, ctx.world.envMap)
      floor.position.y = -1.6
      group.add(floor)
      const pool = caustic({ size: 3.4, color: '#ff9cc2', strength: 0.6 })
      pool.position.set(0, -1.59, 0.4)
      group.add(pool)

      intro = el('div', 'ph-copy', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body', BRAND.manifesto, intro)
      el('p', 'hud-label', MICROCOPY.scrollHint + ' ↓', intro)
      payoff = el('div', 'ph-copy', undefined, ctx.stage)
      title = rise(el('h1', 'hud-title', undefined, payoff), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'ph-ctas', undefined, payoff)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })
    },
    update(local, frame, ctx) {
      box.setLevel(dim.update(true, frame.dt))
      for (const t of tubes) t.part.setLevel(t.d.update(true, frame.dt))
      const W = ctx.world.params
      W.field = 0.6
      W.focus.set(0.35, 0.1)
      reveal(intro, 1 - smoothstep(0.08, 0.14, local))
      reveal(payoff, smoothstep(0.62, 0.7, local) * (1 - smoothstep(0.93, 0.97, local)))
      setRise(title, local > 0.64 && local < 0.95)
    },
    camera(local, frame, out) {
      framedCamera(out, frame, ease.inOutCubic(segment(local, 0.55, 0.7)), 7.2)
    },
  }
}
