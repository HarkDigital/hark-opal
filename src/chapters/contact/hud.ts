import { el, rise } from '../../core/dom'
import { BRAND, CONTACT, OTHER_CONCEPTS } from '../../content'

/*
 * The Foyer's copy: one opaque panel (no backdrop blur) in two parts —
 *   A  eyebrow, "Say hello.", body, the address as the big CTA, Copy email
 *   B  Other concepts, Back to top, the colophon
 * — and the closing sign-off (the address, Back to top, colophon) set under
 * the slab: the one thing the sign asks for stays on the last frame.
 *
 * Layout is MEASURED (resize / fonts / size changes, never per frame):
 *   side   landscape: the panel on the left, the slab in the space to its right
 *   stack  portrait: the panel along the bottom, the slab above it
 * Short screens step the panel down through fit levels (spacing, type); if
 * it still doesn't fit (short landscape, 200% zoom, phones) it SPLITS into
 * two beats: A first, then B (the chapter swaps them mid-way). `art` is the
 * free rectangle the camera frames the slab into (CSS px).
 */

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Hud {
  root: HTMLElement
  probe: HTMLElement
  dock: HTMLElement
  panel: HTMLElement
  partA: HTMLElement
  partB: HTMLElement
  title: HTMLElement
  end: HTMLElement
  mail: HTMLAnchorElement
  copyBtn: HTMLButtonElement
  dirty: boolean
  /** performance.now() of the last successful copy (the slab answers with a glint) */
  copiedAt: number
  /** pointer / focus on the address or the copy button */
  hover: boolean
}

export interface Layout {
  W: number
  H: number
  stack: boolean
  split: boolean
  /** the band between the chrome's safe areas */
  band: Rect
  /** the panel (split: the taller part's box) */
  panel: Rect
  /** free space for the slab while the panel is up */
  art: Rect
  /** free space for the slab in the closing frame (above the sign-off) */
  fin: Rect
}

/** Copy text: async Clipboard API first, then a hidden-textarea fallback. */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* denied or unsupported: fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;'
  const active = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}

/** A polite live region OUTSIDE the aria-hidden stage, so the copy result is announced. */
function liveRegion() {
  const id = 'contact-copy-live'
  let node = document.getElementById(id)
  if (!node) {
    node = document.createElement('p')
    node.id = id
    node.className = 'sr-only'
    node.setAttribute('role', 'status')
    node.setAttribute('aria-live', 'polite')
    document.body.appendChild(node)
  }
  return node
}

const legalText = () => `© ${new Date().getFullYear()} ${BRAND.name} · ${BRAND.locale}`

function backToTop(parent: HTMLElement, cls: string) {
  const b = el('button', cls, undefined, parent)
  b.type = 'button'
  el('span', '', 'Back to top', b)
  el('span', 'contact-arr', '↑', b).setAttribute('aria-hidden', 'true')
  b.addEventListener('click', e => {
    const hark = window.__hark
    if (!hark) return
    hark.land('hero')
    // keyboard activation: move focus to the hero's heading as well
    if (e.detail === 0) hark.engine?.focusChapter?.('hero')
  })
  return b
}

function legal(parent: HTMLElement, cls: string) {
  const p = el('p', `hud-label ${cls}`, undefined, parent)
  // wrap only between the parts, and keep each separator with the part before it
  const parts = legalText().split(' · ')
  parts.forEach((s, i) => {
    if (i) p.append(' ')
    el('span', 'contact-nw', i < parts.length - 1 ? `${s}\u00a0·` : s, p)
  })
  return p
}

export function buildHud(stage: HTMLElement): Hud {
  const root = el('div', 'contact-root', undefined, stage)
  const probe = el('div', 'contact-probe', undefined, root)
  probe.setAttribute('aria-hidden', 'true')
  const dock = el('div', 'contact-dock', undefined, root)
  const panel = el('div', 'hud-panel contact-panel', undefined, dock)

  const partA = el('div', 'contact-part contact-a', undefined, panel)
  el('p', 'hud-eyebrow contact-eyebrow', CONTACT.eyebrow, partA)
  const title = rise(el('h2', 'hud-h2 contact-title', undefined, partA), 'Say <em>hello.</em>')
  el('p', 'hud-body contact-body', CONTACT.body, partA)
  const cta = el('div', 'contact-cta', undefined, partA)
  const mail = el('a', 'contact-email', undefined, cta)
  mail.href = CONTACT.href
  el('span', 'contact-addr', BRAND.email, mail)
  el('span', 'contact-go', '→', mail).setAttribute('aria-hidden', 'true')
  const copyBtn = el('button', 'hud-btn hud-btn--ghost contact-copy', 'Copy email', cta)
  copyBtn.type = 'button'
  copyBtn.setAttribute('aria-label', `Copy email address ${BRAND.email}`)

  const partB = el('div', 'contact-part contact-b', undefined, panel)
  el('p', 'hud-label contact-others', 'Other concepts', partB)
  const list = el('ul', 'contact-links', undefined, partB)
  for (const c of OTHER_CONCEPTS) {
    const li = el('li', '', undefined, list)
    const a = el('a', 'contact-link', undefined, li)
    a.href = c.url
    a.target = '_blank'
    a.rel = 'noopener'
    el('span', '', c.name, a)
    el('span', 'contact-arr', '↗', a).setAttribute('aria-hidden', 'true')
  }
  const foot = el('div', 'contact-foot', undefined, partB)
  backToTop(foot, 'contact-top')
  legal(foot, 'contact-legal')

  // the closing frame's sign-off, under the slab: the address, then Back to top
  const end = el('div', 'contact-end', undefined, root)
  const endMail = el('a', 'contact-email contact-email--end', undefined, end)
  endMail.href = CONTACT.href
  el('span', 'contact-addr', BRAND.email, endMail)
  el('span', 'contact-go', '→', endMail).setAttribute('aria-hidden', 'true')
  backToTop(end, 'hud-btn hud-btn--ghost contact-top contact-top--end')
  legal(end, 'contact-legal contact-legal--end')

  const hud: Hud = { root, probe, dock, panel, partA, partB, title, end, mail, copyBtn, dirty: true, copiedAt: -1e9, hover: false }

  const on = () => (hud.hover = true)
  const off = () => (hud.hover = false)
  for (const n of [mail, copyBtn, endMail]) {
    n.addEventListener('pointerenter', on)
    n.addEventListener('pointerleave', off)
    n.addEventListener('focus', on)
    n.addEventListener('blur', off)
  }

  const live = liveRegion()
  let resetT = 0
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(BRAND.email)
    window.clearTimeout(resetT)
    copyBtn.textContent = ok ? 'Copied' : 'Copy failed'
    copyBtn.classList.toggle('is-copied', ok)
    if (ok) hud.copiedAt = performance.now()
    live.textContent = ok ? `Copied ${BRAND.email} to the clipboard.` : `Copy failed. The address is ${BRAND.email}.`
    window.__hark?.engine?.wake?.()
    resetT = window.setTimeout(() => {
      copyBtn.textContent = 'Copy email'
      copyBtn.classList.remove('is-copied')
      live.textContent = ''
    }, 1800)
  })

  const dirty = () => (hud.dirty = true)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(dirty)
    ro.observe(probe)
  }
  window.addEventListener('resize', dirty)
  document.fonts?.ready.then(dirty).catch(() => {})
  return hud
}

const FIT = ['contact-fit-1', 'contact-fit-2', 'contact-fit-3'] as const

/** Bottom of the chrome's brand lockup (CSS px), or -1 when it isn't there. */
function brandBottom() {
  const b = document.querySelector<HTMLElement>('#chrome .ch-brand') ?? document.querySelector<HTMLElement>('.ch-brand')
  if (!b) return -1
  const r = b.getBoundingClientRect()
  return r.height > 0 ? r.bottom : -1
}

const rectOf = (r: DOMRect): Rect => ({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom })

/** Measure the panel and the free areas around it (resize-time only). */
export function measureHud(hud: Hud, W: number, H: number): Layout {
  const { root, panel, partA, partB } = hud
  const stack = H > W
  root.classList.toggle('is-stack', stack)
  root.classList.remove('is-split', 'show-b', ...FIT)
  const band = rectOf(hud.probe.getBoundingClientRect())
  const bandH = Math.max(1, band.y1 - band.y0)
  // portrait: the panel may take the lower ~62% of the band; the slab lives above
  const limit = stack ? bandH * (H < 720 ? 0.66 : 0.62) : bandH
  const fit = () => {
    for (let i = 0; i < FIT.length && tallest() > limit; i++) root.classList.add(FIT[i])
  }
  let split = false
  // offsetHeight ignores the reveal transform (stable mid-reveal)
  const partH = [0, 0]
  const tallest = () => {
    if (!split) return panel.offsetHeight
    root.classList.remove('show-b')
    partH[0] = panel.offsetHeight
    root.classList.add('show-b')
    partH[1] = panel.offsetHeight
    root.classList.remove('show-b')
    return Math.max(partH[0], partH[1])
  }
  fit()
  if (panel.offsetHeight > limit) {
    split = true
    root.classList.remove(...FIT)
    root.classList.add('is-split')
    fit()
  }
  const ph = tallest()
  const dock = hud.dock.getBoundingClientRect()
  const px0 = dock.left + panel.offsetLeft
  const pw = panel.offsetWidth
  // the panel is centered (side) or bottom-aligned (stack) in the dock: derive
  // the tallest part's box from the dock rather than the current part's
  const py1 = stack ? dock.bottom : dock.top + (dock.height + ph) / 2
  const py0 = py1 - ph
  const pan: Rect = { x0: px0, y0: py0, x1: px0 + pw, y1: py1 }

  let art: Rect
  if (!stack) {
    const gap = Math.max(20, W * 0.028)
    art = { x0: pan.x1 + gap, x1: band.x1, y0: band.y0, y1: band.y1 }
  } else {
    const gap = Math.max(12, H * 0.018)
    // phones: the slab may rise into the top band, to just under the brand
    const bb = brandBottom()
    const top = W < 600 ? Math.max(bb > 0 ? bb + 8 : band.y0 * 0.8, 40) : band.y0
    art = { x0: band.x0, x1: band.x1, y0: top, y1: Math.max(top + 80, pan.y0 - gap) }
  }
  // the closing frame: the slab over the sign-off
  const endTop = hud.end.offsetTop || band.y1 - 60
  const fin: Rect = { x0: band.x0, x1: band.x1, y0: band.y0, y1: Math.max(band.y0 + 80, endTop - Math.max(14, H * 0.025)) }
  root.classList.toggle('is-split', split)
  hud.dirty = false
  return { W, H, stack, split, band, panel: pan, art, fin }
}
