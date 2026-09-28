import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights; `landing` is where nav jumps land (local progress, on settled
 * copy — keep it clear of the ~6% cut window at each end). Each chapter lives
 * in src/chapters/<id>/ and default-exports a factory returning a Chapter.
 *
 * OPAL: one black light gallery after dark — Threshold (the etched mark in a
 * lit slab), Light Boxes (work), Spectrum (eleven colours of light, eleven
 * services), Afterglow (voices), Night Watch (security), The Studio
 * (process), Foyer (contact). The ids are shared with src/core/srContent.ts
 * and the chrome's business names.
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Threshold', length: 2.2, landing: 0, intro: 0, load: () => import('./hero/index') },
  { id: 'work', label: 'Light Boxes', length: 6.1, landing: 0.07, intro: 0.07, load: () => import('./work/index') },
  { id: 'services', label: 'Spectrum', length: 7.0, landing: 0.06, intro: 0.05, load: () => import('./services/index') },
  { id: 'voices', label: 'Afterglow', length: 5.5, landing: 0.075, intro: 0.07, load: () => import('./voices/index') },
  { id: 'shield', label: 'Night Watch', length: 1.8, landing: 0.45, intro: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'The Studio', length: 2.4, landing: 0.2, intro: 0.1, load: () => import('./process/index') },
  { id: 'contact', label: 'Foyer', length: 1.5, landing: 0.3, intro: 0.3, load: () => import('./contact/index') },
]
