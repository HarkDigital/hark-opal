import * as THREE from 'three'
import { textStrokes, type Stroke } from '../../kit/type'

/*
 * What is polished clear in each panel of the partition (etch canvases are
 * white = frosted, BLACK = polished; see kit/opal etchMap). Every polished
 * window has its own light line right behind it, so it reads crisp.
 */

export type ToPx = (x: number, y: number) => [number, number]

/** The 24/7 numerals as single-stroke centerlines (EMS Readability: a clean 7, a straight slash). */
export function numeralStrokes(size: number, cx: number, cy: number, z: number): Stroke[] {
  const t = textStrokes('24/7', { font: 'sans', size, tracking: 0.12 })
  return t.strokes.map(s => ({ pts: s.pts.map(p => new THREE.Vector3(p.x + cx, p.y + cy, z)) }))
}

/** Polish a set of strokes (panel-local coordinates) as round-capped windows `width` wide. */
export function etchStrokes(g: CanvasRenderingContext2D, toPx: ToPx, strokes: Stroke[], width: number, scale: number) {
  g.lineWidth = width * scale
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.strokeStyle = '#000'
  for (const s of strokes) {
    g.beginPath()
    s.pts.forEach((p, i) => {
      const [x, y] = toPx(p.x, p.y)
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    g.stroke()
  }
}

/** A thin horizontal slot (an indicator window), centred at (cx, cy), panel-local. */
export function etchSlot(g: CanvasRenderingContext2D, toPx: ToPx, cx: number, cy: number, len: number, h: number) {
  const [x0, y0] = toPx(cx - len / 2, cy + h / 2)
  const [x1, y1] = toPx(cx + len / 2, cy - h / 2)
  const r = Math.max(1, (y1 - y0) / 2)
  g.fillStyle = '#000'
  g.beginPath()
  g.roundRect(x0, y0, x1 - x0, y1 - y0, r)
  g.fill()
}

/** Padlock proportions (body centre cx, cy; body width w), shared by the etch and its light line. */
function lockDims(cx: number, cy: number, w: number) {
  const bh = w * 0.78
  return { bh, r: w * 0.1, sw: w * 0.13, sr: w * 0.29, top: cy + bh / 2, legTop: cy + bh / 2 + w * 0.2, ins: w * 0.075 }
}

/**
 * The padlock: a solid polished body with a frosted keyhole, a polished
 * shackle (a thick U). Centre of the BODY at (cx, cy), `w` = body width.
 * Panel-local units.
 */
export function etchPadlock(g: CanvasRenderingContext2D, toPx: ToPx, scale: number, cx: number, cy: number, w: number) {
  const d = lockDims(cx, cy, w)
  const [bx0, by0] = toPx(cx - w / 2, cy + d.bh / 2)
  g.fillStyle = '#000'
  g.beginPath()
  g.roundRect(bx0, by0, w * scale, d.bh * scale, d.r * scale)
  g.fill()
  // shackle: a U whose legs sink into the body
  g.lineWidth = d.sw * scale
  g.lineCap = 'butt'
  g.strokeStyle = '#000'
  g.beginPath()
  const [lx, ly0] = toPx(cx - d.sr, d.top - d.sw * 0.3)
  const [, ly1] = toPx(cx - d.sr, d.legTop)
  g.moveTo(lx, ly0)
  g.lineTo(lx, ly1)
  const [ccx, ccy] = toPx(cx, d.legTop)
  g.arc(ccx, ccy, d.sr * scale, Math.PI, 0, false)
  const [rx] = toPx(cx + d.sr, d.legTop)
  g.lineTo(rx, ly0)
  g.stroke()
  // keyhole: frosted (white) inside the polished body
  g.fillStyle = '#fff'
  const ky0 = cy + d.bh * 0.06
  const [kx, ky] = toPx(cx, ky0)
  const kr = w * 0.075
  g.beginPath()
  g.arc(kx, ky, kr * scale, 0, Math.PI * 2)
  g.fill()
  const [sx0, sy0] = toPx(cx - kr * 0.4, ky0)
  const [sx1, sy1] = toPx(cx - kr * 0.6, cy - d.bh * 0.24)
  const [sx2] = toPx(cx + kr * 0.6, cy - d.bh * 0.24)
  const [sx3] = toPx(cx + kr * 0.4, ky0)
  g.beginPath()
  g.moveTo(sx0, sy0)
  g.lineTo(sx1, sy1)
  g.lineTo(sx2, sy1)
  g.lineTo(sx3, sy0)
  g.closePath()
  g.fill()
}

/** The padlock's light line: an inset outline of the body + the shackle's centreline (x/y offset into world, z). */
export function padlockStrokes(cx: number, cy: number, w: number, ox: number, oy: number, z: number): Stroke[] {
  const d = lockDims(cx, cy, w)
  const V = (x: number, y: number) => new THREE.Vector3(x + ox, y + oy, z)
  const hw = w / 2 - d.ins
  const hh = d.bh / 2 - d.ins
  const r = d.r * 0.7
  const body: THREE.Vector3[] = []
  const corners: [number, number, number][] = [
    [cx + hw - r, cy + hh - r, 0],
    [cx - hw + r, cy + hh - r, Math.PI / 2],
    [cx - hw + r, cy - hh + r, Math.PI],
    [cx + hw - r, cy - hh + r, (3 * Math.PI) / 2],
  ]
  for (const [x, y, a0] of corners) for (let i = 0; i <= 5; i++) {
    const a = a0 + (i / 5) * (Math.PI / 2)
    body.push(V(x + Math.cos(a) * r, y + Math.sin(a) * r))
  }
  body.push(body[0].clone())
  const shackle: THREE.Vector3[] = [V(cx - d.sr, d.top - d.ins * 0.2)]
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI - (i / 16) * Math.PI
    shackle.push(V(cx + Math.cos(a) * d.sr, d.legTop + Math.sin(a) * d.sr))
  }
  shackle.push(V(cx + d.sr, d.top - d.ins * 0.2))
  return [{ pts: shackle }, { pts: body }]
}

/** A jagged crack as one polyline (deterministic), from a to b with `n` kinks. */
export function crackStroke(a: THREE.Vector2, b: THREE.Vector2, z: number, n = 9, amp = 0.09, seed = 7): Stroke {
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  const d = b.clone().sub(a)
  const nrm = new THREE.Vector2(-d.y, d.x).normalize()
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const off = i === 0 || i === n ? 0 : (rnd() - 0.5) * 2 * amp * (0.6 + 0.4 * Math.sin(t * Math.PI))
    const along = i === 0 || i === n ? 0 : (rnd() - 0.5) * 0.25 / n
    const p = a.clone().addScaledVector(d, t + along).addScaledVector(nrm, off)
    pts.push(new THREE.Vector3(p.x, p.y, z))
  }
  return { pts }
}
