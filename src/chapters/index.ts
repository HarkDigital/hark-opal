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
  { id: 'hero', label: 'Threshold', length: 2.6, landing: 0, intro: 0.8, load: () => import('./hero/index') },
  { id: 'work', label: 'Light Boxes', length: 3.8, landing: 0.12, intro: 0.06, load: () => import('./work/index') },
  { id: 'services', label: 'Spectrum', length: 3.8, landing: 0.08, intro: 0.06, load: () => import('./services/index') },
  { id: 'voices', label: 'Afterglow', length: 3.0, landing: 0.08, intro: 0.06, load: () => import('./voices/index') },
  { id: 'shield', label: 'Night Watch', length: 1.7, landing: 0.45, intro: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'The Studio', length: 2.2, landing: 0.17, intro: 0.12, load: () => import('./process/index') },
  { id: 'contact', label: 'Foyer', length: 1.5, landing: 0.3, intro: 0.3, load: () => import('./contact/index') },
]
