import { holdInert, releaseInert } from './inert'
import { MICROCOPY } from '../content'
import { storeKey } from './prefs'

/*
 * Phone-landscape suggestion, as a small FROSTED GLASS CARD in the dark
 * gallery: on the left a little frosted tile lit from behind (a rose → lilac
 * card and a bank of thin tubes, diffused) with a phone etched clear through
 * it — its window shows the tubes crisp — that turns upright ONCE, so its
 * lines come to rest parallel with the light behind (never a loop; simply
 * upright under reduced motion / Motion off). On the right, "Turn your phone
 * upright" (thin Hanken; "upright" is the Cormorant accent), "This gallery is
 * hung for portrait." and "Continue anyway". The scene is paused underneath
 * (createChrome wires onChange to the scene hold). Tablets and laptops in
 * landscape are taller than 500px and never see it.
 *
 * It is a suggestion, never a lock (WCAG 1.3.4): "Continue anyway" releases
 * it for the rest of the session. While it shows, the skip link and the
 * linear copy layer in #track stay reachable, and their focus pills paint
 * above the card (it sits at z 25: over the chrome (10) and the stages (5),
 * under #track:focus-within (30) and the skip link (120)); only the chrome
 * and the stages behind it are inert.
 *
 * API: mountRotateGate(onChange?) / unmountRotateGate(). Safe to call more
 * than once: later calls just add their onChange listener.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

const DISMISS_KEY = storeKey('rotate-ok')
const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
const rememberDismissed = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}

/* the frosted tile (0..120) and its etched phone */
const TUBES = [18, 36, 54, 72, 90, 108]
const GLOW = ['#ff7aa8', '#f08cc4', '#dca0ea', '#c7a8ff', '#a9a4ff', '#8f9eff']
const ART = `<svg class="rot-glass" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="rot-card" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#ff7aa8"/><stop offset="0.55" stop-color="#c7a8ff"/><stop offset="1" stop-color="#7f9cff"/>
    </linearGradient>
    <filter id="rot-frost" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="4.2"/></filter>
    <clipPath id="rot-clip"><rect width="120" height="120" rx="11"/></clipPath>
    <clipPath id="rot-win"><rect x="44" y="33" width="32" height="54" rx="6"/></clipPath>
    <linearGradient id="rot-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.14"/><stop offset="0.4" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rot-bevel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.14"/><stop offset="1" stop-color="#fff" stop-opacity="0.28"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#rot-clip)">
    <rect width="120" height="120" fill="#08070b"/>
    <g filter="url(#rot-frost)" opacity="0.9">
      <rect width="120" height="120" fill="url(#rot-card)"/>
      ${TUBES.map((x, i) => `<line x1="${x}" y1="0" x2="${x}" y2="120" stroke="${GLOW[i]}" stroke-width="7"/><line x1="${x}" y1="0" x2="${x}" y2="120" stroke="#fff" stroke-opacity="0.8" stroke-width="2"/>`).join('')}
    </g>
    <rect width="120" height="120" fill="#fff" opacity="0.035"/>
    <rect width="120" height="120" fill="url(#rot-sheen)"/>
    <g class="rot-phone">
      <g clip-path="url(#rot-win)">
        <rect x="40" y="30" width="40" height="60" fill="#060509" opacity="0.72"/>
        ${[48, 54, 60, 66, 72]
          .map((x, i) => `<line x1="${x}" y1="30" x2="${x}" y2="90" stroke="${GLOW[i + 1]}" stroke-opacity="0.5" stroke-width="3"/><line x1="${x}" y1="30" x2="${x}" y2="90" stroke="#fff4f8" stroke-width="0.9"/>`)
          .join('')}
      </g>
      <rect x="44" y="33" width="32" height="54" rx="6" fill="none" stroke="#fff" stroke-opacity="0.9" stroke-width="1.3"/>
      <path d="M56 38.5h8" stroke="#fff" stroke-opacity="0.8" stroke-width="1.3" stroke-linecap="round"/>
    </g>
  </g>
  <rect x="0.6" y="0.6" width="118.8" height="118.8" rx="10.4" fill="none" stroke="url(#rot-bevel)" stroke-width="1.2"/>
</svg>`

let gate: {
  el: HTMLElement
  mq: MediaQueryList
  sync: () => void
  listeners: ((shown: boolean) => void)[]
  on: () => boolean
} | null = null

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.on())
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  let dismissed = wasDismissed()
  const el = document.createElement('div')
  el.className = 'rot'
  // non-modal: the copy layer behind it stays in reach
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <div class="rot-card">
      <div class="rot-art" aria-hidden="true">${ART}</div>
      <div class="rot-text">
        <p class="rot-k" aria-hidden="true">${MICROCOPY.signalEyebrow}</p>
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright</em></h2>
        <p class="rot-sub" id="rot-sub">This gallery is hung for portrait.</p>
        <p class="rot-actions"><button class="hud-btn hud-btn--ghost rot-go" type="button">Continue anyway</button></p>
      </div>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  // right after the skip link: Tab goes skip link → this card → the page
  const skip = document.querySelector('.skip-link')
  if (skip && skip.parentNode === document.body) skip.after(el)
  else document.body.prepend(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const go = el.querySelector<HTMLButtonElement>('.rot-go')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  let turnTimer = 0
  const sync = () => {
    const want = mq.matches && !dismissed
    if (want === on) return
    on = want
    el.classList.toggle('is-on', on)
    document.documentElement.classList.toggle('is-rotate', on)
    clearTimeout(turnTimer)
    if (on) {
      // only the layers the card hides; the skip link and #track stay reachable
      holdInert('rotate', ['chrome', 'stages'].map(id => document.getElementById(id)))
      // focus stranded in a now-inert layer (or on <body>) comes to the card;
      // a reader already in the copy layer or on the skip link stays put
      const a = document.activeElement
      const keep = a instanceof HTMLElement && a !== document.body && (a.closest('#track') || a.matches('.skip-link'))
      if (!keep) el.focus({ preventScroll: true })
      // the phone turns upright once, after the card is on screen
      el.classList.remove('is-turned')
      void el.offsetWidth
      turnTimer = window.setTimeout(() => on && el.classList.add('is-turned'), 420)
      // a live region only speaks when its text changes after it is shown
      window.setTimeout(() => {
        if (on) live.textContent = 'Turn your phone upright. This gallery is hung for portrait.'
      }, 60)
    } else {
      releaseInert('rotate')
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }

  go.addEventListener('click', () => {
    const hadFocus = el.contains(document.activeElement)
    dismissed = true
    rememberDismissed()
    sync()
    if (!hadFocus) return
    // the card is gone: hand focus to the story, like the skip link does
    const main = document.getElementById('track')
    if (main && !main.closest('[inert], [aria-hidden="true"]')) main.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur?.()
  })

  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', sync)
  else mq.addListener?.(sync)
  gate = { el, mq, sync, listeners, on: () => on }
  sync()
}

/** The plain HTML page reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  const was = gate.on()
  if (typeof gate.mq.removeEventListener === 'function') gate.mq.removeEventListener('change', gate.sync)
  else gate.mq.removeListener?.(gate.sync)
  gate.el.remove()
  document.documentElement.classList.remove('is-rotate')
  releaseInert('rotate')
  if (was) for (const fn of gate.listeners) fn(false)
  gate = null
}
