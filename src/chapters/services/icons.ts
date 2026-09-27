/*
 * SERVICES · the eleven etched icons.
 *
 * Plain 2D line drawings (no three.js here): each icon lives in a unit box
 * [-1, 1]², y UP, as open or closed polylines (arcs pre-sampled) plus a few
 * filled dots. One weight for every line; round caps and joins. The etch
 * atlas (spectrum.ts) strokes them twice: a thin POLISHED line into the
 * frost (the glass) and a thicker, softer LIT line into the light card
 * behind (what the polished window shows crisp).
 *
 *   01 </>        02 browser window   03 cart        04 magnifier
 *   05 bolt       06 sparkle          07 drone       08 wrench
 *   09 padlock    10 access figure    11 W in a circle
 */

export type P2 = [number, number]
export interface IconPath {
  pts: P2[]
  closed?: boolean
}
export interface Icon {
  paths: IconPath[]
  /** filled dots [x, y, r] */
  dots?: [number, number, number][]
}

const TAU = Math.PI * 2

/** an arc from a0 to a1 (radians, CCW when a1 > a0), sampled */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, step = 0.08): P2[] {
  const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / step))
  const out: P2[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return out
}

const ring = (cx: number, cy: number, r: number): IconPath => ({ pts: arc(cx, cy, r, 0, TAU).slice(0, -1), closed: true })

/** rounded rectangle (x0, y0) – (x1, y1), corner radius r */
function rrect(x0: number, y0: number, x1: number, y1: number, r: number): IconPath {
  const pts: P2[] = [
    ...arc(x1 - r, y0 + r, r, -Math.PI / 2, 0),
    ...arc(x1 - r, y1 - r, r, 0, Math.PI / 2),
    ...arc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI),
    ...arc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5),
  ]
  return { pts, closed: true }
}

/** a quadratic Bézier, sampled (without its start point) */
function quad(a: P2, c: P2, b: P2, n = 10): P2[] {
  const out: P2[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
  }
  return out
}

/** a four-point sparkle: concave sides, points up/right/down/left */
function sparkle(cx: number, cy: number, r: number): IconPath {
  const k = r * 0.14
  const T: P2 = [cx, cy + r]
  const R: P2 = [cx + r, cy]
  const B: P2 = [cx, cy - r]
  const L: P2 = [cx - r, cy]
  const pts: P2[] = [T, ...quad(T, [cx + k, cy + k], R), ...quad(R, [cx + k, cy - k], B), ...quad(B, [cx - k, cy - k], L), ...quad(L, [cx - k, cy + k], T).slice(0, -1)]
  return { pts, closed: true }
}

/** an open-end wrench on the diagonal: head top-right (jaw opening outward), rounded tail bottom-left */
function wrench(): IconPath {
  const H: P2 = [0.36, 0.36]
  const u: P2 = [Math.SQRT1_2, Math.SQRT1_2]
  const n: P2 = [-Math.SQRT1_2, Math.SQRT1_2]
  const rh = 0.4
  const w = 0.13
  const s = 0.15
  const L = 1.28
  const slot = -0.02
  const to = (a: number, b: number): P2 => [H[0] + a * u[0] + b * n[0], H[1] + a * u[1] + b * n[1]]
  const pts: P2[] = []
  // shaft, +n side, from the tail to the head
  const aj = -Math.sqrt(rh * rh - w * w)
  pts.push(to(-L, w), to(aj, w))
  // head, +n side: from the shaft round to the jaw
  const th1 = Math.atan2(w, aj)
  const ths = Math.atan2(s, Math.sqrt(rh * rh - s * s))
  for (const p of arc(0, 0, rh, th1, ths)) pts.push(to(p[0], p[1]))
  // the jaw's slot
  pts.push(to(slot, s), to(slot, -s))
  // head, −n side
  for (const p of arc(0, 0, rh, -ths, -th1)) pts.push(to(p[0], p[1]))
  // shaft, −n side, back to the tail
  pts.push(to(-L, -w))
  // the rounded tail
  for (const p of arc(-L, 0, w, -Math.PI / 2, -Math.PI * 1.5).slice(1, -1)) pts.push(to(p[0], p[1]))
  return { pts, closed: true }
}

/** a quadcopter from above: body, four arms, four rotors */
function drone(): Icon {
  const paths: IconPath[] = [rrect(-0.24, -0.17, 0.24, 0.17, 0.07)]
  const dots: [number, number, number][] = []
  const rx = 0.6
  const ry = 0.54
  const rr = 0.27
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const c: P2 = [sx * rx, sy * ry]
      const b: P2 = [sx * 0.24, sy * 0.17]
      const dx = c[0] - b[0]
      const dy = c[1] - b[1]
      const d = Math.hypot(dx, dy)
      paths.push({ pts: [b, [c[0] - (dx / d) * rr, c[1] - (dy / d) * rr]] })
      paths.push(ring(c[0], c[1], rr))
      dots.push([c[0], c[1], 0.055])
    }
  }
  return { paths, dots }
}

export const ICONS: Icon[] = [
  // 01 Software Development: </>
  {
    paths: [
      { pts: [[-0.34, 0.5], [-0.86, 0], [-0.34, -0.5]] },
      { pts: [[0.34, 0.5], [0.86, 0], [0.34, -0.5]] },
      { pts: [[0.17, 0.68], [-0.17, -0.68]] },
    ],
  },
  // 02 Web Design: a browser window with a layout
  {
    paths: [
      rrect(-0.92, -0.72, 0.92, 0.72, 0.12),
      { pts: [[-0.92, 0.36], [0.92, 0.36]] },
      { pts: [[-0.64, 0.08], [0.12, 0.08]] },
      { pts: [[-0.64, -0.17], [0.64, -0.17]] },
      { pts: [[-0.64, -0.42], [0.34, -0.42]] },
    ],
    dots: [
      [-0.72, 0.54, 0.05],
      [-0.56, 0.54, 0.05],
      [-0.4, 0.54, 0.05],
    ],
  },
  // 03 Ecommerce: a cart
  {
    paths: [
      { pts: [[-0.96, 0.66], [-0.72, 0.66], [-0.46, -0.28], [0.64, -0.28], [0.86, 0.36], [-0.637, 0.36]] },
      ring(-0.33, -0.58, 0.11),
      ring(0.5, -0.58, 0.11),
    ],
  },
  // 04 SEO / GEO: a magnifier
  {
    paths: [ring(-0.15, 0.15, 0.54), { pts: [[-0.15 + 0.54 * Math.SQRT1_2, 0.15 - 0.54 * Math.SQRT1_2], [0.8, -0.8]] }],
  },
  // 05 Page Speed: a lightning bolt
  {
    paths: [
      {
        pts: [
          [0.2, 0.94],
          [-0.52, -0.08],
          [-0.04, -0.08],
          [-0.2, -0.94],
          [0.52, 0.1],
          [0.04, 0.1],
        ],
        closed: true,
      },
    ],
  },
  // 06 AI Consulting: a sparkle and a small one
  { paths: [sparkle(-0.14, -0.1, 0.8), sparkle(0.6, 0.6, 0.27)] },
  // 07 Aerial Photography & Video: a drone
  drone(),
  // 08 Hack Remediation: a wrench
  { paths: [wrench()] },
  // 09 Website & Data Security: a padlock
  {
    paths: [
      rrect(-0.58, -0.88, 0.58, 0.1, 0.12),
      { pts: [[-0.34, 0.1], ...arc(0, 0.44, 0.34, Math.PI, 0), [0.34, 0.1]] },
      ring(0, -0.3, 0.1),
      { pts: [[0, -0.4], [0, -0.6]] },
    ],
  },
  // 10 ADA Accessibility: the figure in a ring
  {
    paths: [
      ring(0, 0, 0.92),
      { pts: [[-0.52, 0.24], [0.52, 0.24]] },
      { pts: [[0, 0.24], [0, -0.1]] },
      { pts: [[-0.3, -0.6], [0, -0.1], [0.3, -0.6]] },
    ],
    dots: [[0, 0.5, 0.11]],
  },
  // 11 WordPress: a W in a ring
  {
    paths: [
      ring(0, 0, 0.92),
      { pts: [[-0.62, 0.42], [-0.32, -0.48], [0, 0.22], [0.32, -0.48], [0.62, 0.42]] },
    ],
  },
]

/**
 * Stroke icon i into a canvas. `toPx` maps unit-box coords (y up) to canvas
 * pixels; `width` is the line width in pixels. Uses the context's current
 * strokeStyle / fillStyle / composite mode.
 */
export function drawIcon(g: CanvasRenderingContext2D, i: number, toPx: (x: number, y: number) => P2, width: number, dotGrow = 0) {
  const icon = ICONS[i]
  if (!icon) return
  g.lineWidth = width
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const p of icon.paths) {
    g.beginPath()
    p.pts.forEach((q, k) => {
      const [x, y] = toPx(q[0], q[1])
      if (k) g.lineTo(x, y)
      else g.moveTo(x, y)
    })
    if (p.closed) g.closePath()
    g.stroke()
  }
  for (const [x, y, r] of icon.dots ?? []) {
    const [px, py] = toPx(x, y)
    const [ex] = toPx(x + r, y)
    g.beginPath()
    g.arc(px, py, Math.abs(ex - px) + dotGrow, 0, TAU)
    g.fill()
  }
}
