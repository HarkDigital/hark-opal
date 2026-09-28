import * as THREE from 'three'
import { releaseAfterUpload } from '../../kit/opal'

/*
 * What is polished CLEAR in each panel of the partition. Etch canvases are
 * white = frosted, BLACK = polished (kit/opal etchMap). Every design is a
 * FILLED window (a clear glass numeral, a clear glass padlock), never a
 * hairline: the light drawn right behind it (rig.ts windowLight) fills the
 * window crisp and glows through the frost around it.
 */

export type ToPx = (x: number, y: number) => [number, number]

export interface RegionEtch {
  tex: THREE.CanvasTexture
  /** repaint (after a late font swap) */
  repaint(): void
  /** free the canvas once it's on the GPU (call after any repaint) */
  release(): void
}

/**
 * kit/opal etchMap for a REGION of a pane: w × h panel units centred at
 * (0, cy) on a pane whose caps carry panel-unit UVs. ClampToEdge keeps the
 * rest of the face frosted (the border is white), so the map's pixels go
 * where the designs are (sharper windows at the same size). `draw` works in
 * panel-local units through toPx.
 */
export function regionEtch(w: number, h: number, cy: number, draw: (g: CanvasRenderingContext2D, toPx: ToPx, scale: number) => void, res: number): RegionEtch {
  const W = w >= h ? res : Math.max(16, Math.round((res * w) / h))
  const H = w >= h ? Math.max(16, Math.round((res * h) / w)) : res
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const sx = W / w
  const sy = H / h
  const toPx: ToPx = (x, y) => [(x + w / 2) * sx, (h / 2 - (y - cy)) * sy]
  const paint = () => {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, W, H)
    draw(g, toPx, sx)
  }
  paint()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  tex.repeat.set(1 / w, 1 / h)
  tex.offset.set(0.5, 0.5 - cy / h)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  let released = false
  return {
    tex,
    repaint() {
      if (released) return
      paint()
      tex.needsUpdate = true
    },
    release() {
      if (released) return
      released = true
      releaseAfterUpload(tex)
    },
  }
}

/** The display face (DOM-loaded; the chapter awaits it and redraws on fonts.ready). */
export const NUM_FONT = '"Hanken Grotesk Variable", "Hanken Grotesk", system-ui, sans-serif'
export const NUM_WEIGHT = 360

/**
 * "24/7" polished clear, set in the site's display face: centred at (cx, cy)
 * (panel-local units), its figures `capH` tall, fitted to `maxW`. Returns
 * whether the real face was used (the chapter redraws on fonts.ready).
 */
export function etchNumerals(g: CanvasRenderingContext2D, toPx: ToPx, scale: number, text: string, cx: number, cy: number, capH: number, maxW: number) {
  const probe = 200
  g.font = `${NUM_WEIGHT} ${probe}px ${NUM_FONT}`
  const m = g.measureText(text)
  const cap = m.actualBoundingBoxAscent || probe * 0.7
  const inkW = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || m.width)
  // size so the figures stand capH tall, unless that's wider than maxW
  const px = Math.min((capH * scale * probe) / cap, (maxW * scale * probe) / Math.max(1, inkW))
  g.font = `${NUM_WEIGHT} ${px}px ${NUM_FONT}`
  const n = g.measureText(text)
  const left = n.actualBoundingBoxLeft || 0
  const right = n.actualBoundingBoxRight || n.width
  const asc = n.actualBoundingBoxAscent || px * 0.7
  const desc = n.actualBoundingBoxDescent || 0
  const [x0, y0] = toPx(cx, cy)
  g.fillStyle = '#000'
  g.textAlign = 'left'
  g.textBaseline = 'alphabetic'
  // centre the INK box (the slash descends a little below the baseline)
  g.fillText(text, x0 - (right - left) / 2 + left, y0 + (asc - desc) / 2)
  return !!document.fonts?.check?.(`${NUM_WEIGHT} 64px ${NUM_FONT.split(',')[0]}`, text)
}

/** A slim horizontal slot (an indicator window), centred at (cx, cy), panel-local. */
export function etchSlot(g: CanvasRenderingContext2D, toPx: ToPx, cx: number, cy: number, len: number, h: number) {
  const [x0, y0] = toPx(cx - len / 2, cy + h / 2)
  const [x1, y1] = toPx(cx + len / 2, cy - h / 2)
  const r = Math.max(1, (y1 - y0) / 2)
  g.fillStyle = '#000'
  g.beginPath()
  g.roundRect(x0, y0, x1 - x0, y1 - y0, r)
  g.fill()
}

/**
 * The padlock, drawn with the same pen as the numerals: a polished line
 * `stroke` wide round the body and along the shackle (a U whose legs meet
 * the body), and a small polished keyhole. Centre of the BODY at (cx, cy),
 * `w` = body width (outer). Panel-local units.
 */
export function etchPadlock(g: CanvasRenderingContext2D, toPx: ToPx, scale: number, cx: number, cy: number, w: number, stroke: number) {
  const d = lockDims(cy, w, stroke)
  const hs = stroke / 2
  g.strokeStyle = '#000'
  g.fillStyle = '#000'
  g.lineWidth = stroke * scale
  g.lineJoin = 'round'
  // body: the line's centre runs half a stroke inside the outer edge
  const [bx0, by0] = toPx(cx - w / 2 + hs, d.top - hs)
  g.beginPath()
  g.roundRect(bx0, by0, (w - stroke) * scale, (d.bh - stroke) * scale, Math.max(0, d.r - hs) * scale)
  g.stroke()
  // shackle: legs from the body's top edge up into a half round
  g.lineCap = 'butt'
  g.beginPath()
  const [lx, ly0] = toPx(cx - d.sr, d.top - hs)
  const [, ly1] = toPx(cx - d.sr, d.legTop)
  g.moveTo(lx, ly0)
  g.lineTo(lx, ly1)
  const [ccx, ccy] = toPx(cx, d.legTop)
  g.arc(ccx, ccy, d.sr * scale, Math.PI, 0, false)
  const [rx] = toPx(cx + d.sr, d.legTop)
  g.lineTo(rx, ly0)
  g.stroke()
  // keyhole: a small polished round + a short stem
  const ky = cy + d.bh * 0.06
  const kr = w * 0.07
  const [kx, kyp] = toPx(cx, ky)
  g.beginPath()
  g.arc(kx, kyp, kr * scale, 0, Math.PI * 2)
  g.fill()
  const [sx0, sy0] = toPx(cx - kr * 0.36, ky)
  const [sx1, sy1] = toPx(cx - kr * 0.5, cy - d.bh * 0.2)
  const [sx2] = toPx(cx + kr * 0.5, cy - d.bh * 0.2)
  const [sx3] = toPx(cx + kr * 0.36, ky)
  g.beginPath()
  g.moveTo(sx0, sy0)
  g.lineTo(sx1, sy1)
  g.lineTo(sx2, sy1)
  g.lineTo(sx3, sy0)
  g.closePath()
  g.fill()
}

function lockDims(cy: number, w: number, stroke: number) {
  const bh = w * 0.78
  const top = cy + bh / 2
  return { bh, top, r: w * 0.12, sr: w * 0.3 - stroke * 0.5, legTop: top + w * 0.2 }
}

/** The padlock's overall height above its body centre (for framing / the etch region). */
export function padlockTop(cy: number, w: number, stroke: number) {
  const d = lockDims(cy, w, stroke)
  return d.legTop + d.sr + stroke / 2
}
