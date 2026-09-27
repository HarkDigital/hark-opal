import { BRAND, CONTACT, MICROCOPY, STATS } from '../content'
import { CHAPTER_COPY_IDS, buildChapterCopy } from '../core/srContent'
import { CHAPTERS } from '../chapters/index'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'
import { releaseScene } from './prefs'

/*
 * The plain HTML version, for browsers without WebGL2 (and the last resort
 * if boot fails or the GPU context is gone for good): every chapter's copy,
 * in story order, visible — set as the gallery's EXHIBITION CATALOGUE. A
 * black page, thin Hanken Grotesk headings whose last word is the Cormorant
 * italic accent (lit by the rose → lilac → periwinkle gradient), Hanken for
 * the words and Red Hat Mono for the small print. Each chapter is a numbered
 * room with a wall label in the margin ("Room 03 · Spectrum", the room's
 * name in Cormorant italic, a fine hairline of light); the services and the
 * process read as the catalogue's numbered entries, the quotes hang as wall
 * text, the figures are thin lit numerals. The room numbers, hairlines and
 * the colophon are decorative (aria-hidden or plainly not claims); the copy
 * is the live site's, verbatim, from srContent (buildChapterCopy). Links
 * stay underlined. Nothing here moves. Landmarks: the header (banner, with
 * the Primary nav) and the footer (contentinfo) sit beside <main> (#track),
 * which holds only the rooms.
 */
export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  document.documentElement.classList.remove('is-rotate', 'motion-off')
  unmountRotateGate()
  // boot can fail while the loader or the menu still holds the page inert: let go
  releaseInert('loader')
  releaseInert('menu')
  releaseScene('menu')
  document.getElementById('loader')?.remove()
  document.getElementById('gl')?.remove()
  // the live chrome drives a story that is no longer there
  document.getElementById('chrome')?.replaceChildren()
  window.dispatchEvent(new Event('hark:fallback'))
  root.style.pointerEvents = 'auto'
  root.inert = false
  root.removeAttribute('aria-hidden')

  // landmarks: the header (banner) and footer (contentinfo) are <body>'s own
  // children, around <main> (#track), which holds only the rooms
  document.querySelectorAll('body > .fb-top, body > .fb-foot').forEach(n => n.remove())
  const header = document.createElement('header')
  header.className = 'fb-top fb-band'
  header.innerHTML = `
    <a class="fb-brand" href="#hero" aria-label="${BRAND.name}, top of the page">
      <span class="fb-mark" aria-hidden="true">${markSvg('fb-mark-svg')}</span>
      <span class="fb-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>
    </a>
    <nav class="fb-nav" aria-label="Primary">
      <a href="#work">Work</a>
      <a href="#services">Services</a>
      <a href="#contact">Contact</a>
      <a class="fb-cta" href="${CONTACT.href}">Start a project</a>
    </nav>`
  const footer = document.createElement('footer')
  footer.className = 'fb-foot fb-band'
  // a catalogue's colophon: what it is set in (true of this page), no claims
  footer.innerHTML = `
    <span class="fb-foot-mark" aria-hidden="true">${markSvg('fb-foot-svg')}</span>
    <p class="fb-credit">${MICROCOPY.signalEyebrow}</p>
    <p class="fb-colophon">Set in Hanken Grotesk, <em>Cormorant Garamond</em> and Red Hat Mono.</p>`
  root.before(header)
  root.after(footer)
  const rooms = CHAPTERS.filter(c => CHAPTER_COPY_IDS.includes(c.id)).length
  root.innerHTML = `<div class="fb fb-band">
    <p class="fb-kicker" aria-hidden="true"><i></i>Catalogue · ${rooms === 7 ? 'Seven' : String(rooms)} rooms</p>
    <div class="fb-main" id="fb-main" tabindex="-1"></div>
  </div>`

  // a fresh skip link: the live one's handler focuses a chapter heading that is gone
  const skip = document.querySelector<HTMLAnchorElement>('.skip-link')
  if (skip) {
    const fresh = skip.cloneNode(true) as HTMLAnchorElement
    fresh.href = '#fb-main'
    skip.replaceWith(fresh)
  }

  const main = root.querySelector<HTMLElement>('#fb-main')!
  // story order (the chapters' order), then any copy the story doesn't use
  const order = CHAPTERS.map(c => c.id).filter(id => CHAPTER_COPY_IDS.includes(id))
  for (const id of CHAPTER_COPY_IDS) if (!order.includes(id)) order.push(id)
  order.forEach((id, i) => {
    const copy = buildChapterCopy(id, true)
    if (!copy) return
    // heading Tab stops only drive the live story
    copy.querySelectorAll('h1[tabindex], h2[tabindex]').forEach(h => h.removeAttribute('tabindex'))
    // item "stops" only steer the live story; here they're just text
    copy.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]:not([data-land])').forEach(a => {
      const span = document.createElement('span')
      span.textContent = a.textContent
      a.replaceWith(span)
    })
    // "See the work", "Back to top": plain in-page links here (a clone drops
    // the handler that would steer a story that may be gone)
    copy.querySelectorAll<HTMLAnchorElement>('a[data-land]').forEach(a => {
      const plain = a.cloneNode(true) as HTMLAnchorElement
      plain.removeAttribute('data-land')
      plain.removeAttribute('data-anchor')
      a.replaceWith(plain)
    })
    accentHeading(copy)
    markStats(copy)
    // the catalogue's entry numbers for numbered lists (the <ol> already says it)
    copy.querySelectorAll('ol > li > h3').forEach(h => {
      const li = h.parentElement!
      const n = document.createElement('span')
      n.className = 'fb-n'
      n.setAttribute('aria-hidden', 'true')
      n.textContent = String([...li.parentElement!.children].indexOf(li) + 1).padStart(2, '0')
      h.prepend(n)
    })
    const sec = document.createElement('section')
    sec.className = `fb-room fb-room--${id}`
    sec.id = id
    const heading = copy.querySelector<HTMLElement>('h1, h2')
    if (heading) {
      heading.id = `fb-${id}-title`
      sec.setAttribute('aria-labelledby', heading.id)
    }
    // the wall label (decorative): "Room 03 · Spectrum"
    const label = CHAPTERS.find(c => c.id === id)?.label
    const wall = document.createElement('p')
    wall.className = 'fb-wall'
    wall.setAttribute('aria-hidden', 'true')
    wall.innerHTML = `<span class="fb-wall-n">Room ${String(i + 1).padStart(2, '0')}</span>${label ? `<em>${label}</em>` : ''}<i></i>`
    sec.appendChild(wall)
    const body = document.createElement('div')
    body.className = 'fb-room-body'
    body.appendChild(copy)
    sec.appendChild(body)
    main.appendChild(sec)
  })
  window.scrollTo(0, 0)
}

/**
 * The heading's last word becomes the room's accent: Cormorant italic, lit by
 * the gradient ("Say <em>hello.</em>"). Only the markup changes; the heading
 * reads exactly as before.
 */
function accentHeading(copy: HTMLElement) {
  const h = copy.querySelector<HTMLElement>('h1, h2')
  if (!h || h.children.length) return
  const text = h.textContent ?? ''
  const m = text.match(/^(.*\s)(\S+)\s*$/)
  if (!m) return
  h.textContent = m[1]
  const em = document.createElement('em')
  em.textContent = m[2]
  h.appendChild(em)
}

/**
 * The figures (10 years, $1M+, 15, 24/7) are thin lit numerals: each one set
 * in a <strong> the CSS lights. Only the markup changes; the words stay the
 * live copy's.
 */
function markStats(copy: HTMLElement) {
  for (const n of copy.querySelectorAll<HTMLElement>('p, li')) {
    const text = n.textContent ?? ''
    const stat = STATS.find(s => text.startsWith(`${s.value}:`))
    if (!stat) continue
    n.classList.add('fb-stat')
    const head = n.firstChild
    const fig = document.createElement('strong')
    fig.textContent = stat.value
    if (head instanceof HTMLElement && head.textContent === stat.value) head.replaceWith(fig)
    else if (head?.nodeType === Node.TEXT_NODE) {
      head.textContent = (head.textContent ?? '').slice(stat.value.length)
      n.insertBefore(fig, head)
    } else continue
    // the figure sits on its own line: drop the ": " that joined it to its label
    const rest = fig.nextSibling
    if (rest?.nodeType === Node.TEXT_NODE) rest.textContent = (rest.textContent ?? '').replace(/^\s*:\s*/, '')
  }
}
