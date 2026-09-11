/**
 * File -> positioned text, every page, via pdf.js. The browser edge of
 * extraction; parsing lives in domain/. Derived from ledger-reconciler's
 * lib/pdf.ts (same author, MIT), which read page-1 text only. This one
 * keeps every fragment's box so a value can point back at its pixels.
 */

import type * as PdfjsTypes from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { BBox, Line, PdfPage, PositionedItem, Span } from '../domain/types'

// The external oracle (tests/oracle.spans.test.ts) imports boxFor from here,
// but the interpolation math is pure and belongs in domain/; this is just a
// hallway door so the browser-edge module and the pure module agree on one
// function.
export { boxFor } from '../domain/spans'

// pdf.js is loaded on first read: nothing on the landing page needs it. The
// worker URL must be a static `?url` import (Vite resolves the package
// specifier there and nowhere else). Under Node there is no worker.
const isBrowser = typeof window !== 'undefined'

let cached: typeof PdfjsTypes | undefined

export async function loadPdfjs(): Promise<typeof PdfjsTypes> {
  if (!cached) {
    cached = await import('pdfjs-dist')
    if (isBrowser) {
      cached.GlobalWorkerOptions.workerSrc = workerUrl
    }
  }
  return cached
}

/**
 * Glyph height in points. pdf.js's `height` is 0 for some real fragments
 * (any run whose text is whitespace, and occasionally short runs), which
 * would make a zero-height provenance box. The vertical scale of the text
 * matrix is the font size actually in effect, so it is the fallback.
 */
function glyphHeight(item: TextItem): number {
  if (item.height > 0) return item.height
  const [, b, , d] = item.transform
  return Math.hypot(b, d)
}

/**
 * Relative glyph widths (AFM Helvetica, /1000 em) used only to split a
 * pdf.js TextItem into per-word items before it ever reaches assembleLines.
 * pdf.js's public getTextContent() reports one advance for an entire Tj
 * run (a whole address or footer line is routinely ONE item), so treating
 * such a run as a single span and leaning on domain/spans.ts's uniform
 * per-character interpolation for the whole run is off by several points
 * on a proportional font (measured against the PyMuPDF oracle). These
 * invoices are all set in ordinary sans-serif business fonts, so a generic
 * Helvetica-shaped table, scaled to the run's own measured width, recovers
 * word-accurate boxes without reading the embedded font itself (pdf.js
 * exposes no public API for that). Anything not in the table falls back to
 * the digit width (556), a safe average for Latin text.
 */
const GLYPH_WIDTH: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
  '£': 556, '€': 556, '₺': 556, '·': 278,
}
const DEFAULT_GLYPH_WIDTH = 556

function glyphWidth(c: string): number {
  return GLYPH_WIDTH[c] ?? DEFAULT_GLYPH_WIDTH
}

/**
 * Splits one pdf.js TextItem into one PositionedItem per word, so a run
 * like "Suite 12, 45 Quayside, Bristol BS1 4TR" (one Tj call, one advance)
 * becomes several narrower items, each carrying its own estimated box. The
 * split point of every word is the cumulative GLYPH_WIDTH fraction of the
 * run scaled to the run's real measured width, so the sum of the pieces
 * still equals the item's own width exactly. A run with no internal space
 * is left as a single item (nothing to gain from splitting it).
 */
function splitWordItems(str: string, x: number, y: number, width: number, height: number): PositionedItem[] {
  if (!str.includes(' ')) return [{ str, bbox: { x, y, width, height } }]
  let total = 0
  for (const c of str) total += glyphWidth(c)
  if (total === 0) return [{ str, bbox: { x, y, width, height } }]
  const scale = width / total
  const out: PositionedItem[] = []
  let cum = 0
  let wordStart = -1
  let wordCum = 0
  for (let i = 0; i <= str.length; i++) {
    const c = str[i]
    const isBoundary = c === undefined || c === ' '
    if (!isBoundary) {
      if (wordStart === -1) {
        wordStart = i
        wordCum = cum
      }
    } else if (wordStart !== -1) {
      out.push({ str: str.slice(wordStart, i), bbox: { x: x + wordCum * scale, y, width: (cum - wordCum) * scale, height } })
      wordStart = -1
    }
    if (c !== undefined) cum += glyphWidth(c)
  }
  return out
}

/** Failures that mean "no readable text here", not "the reader broke". */
const BENIGN_READ_FAILURE = /InvalidPDF|Invalid PDF|Corrupt|password|Missing PDF|Empty file/i

export class PdfReadError extends Error {}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === 'object' && item !== null && 'str' in item
}

/**
 * Groups fragments into lines by baseline, within a tolerance, and joins
 * each line left to right. A horizontal gap wider than kerning becomes a
 * space, so two columns on one baseline do not glue together. Same rules
 * as ledger-reconciler; the line now also carries its union box.
 */
export function assembleLines(items: PositionedItem[]): Line[] {
  const TOLERANCE = 2 // points
  const GAP = 1 // points; wider than this is a real gap
  const groups: Array<{ y: number; items: PositionedItem[] }> = []

  for (const item of items) {
    if (item.str.trim() === '') continue
    const baseline = item.bbox.y + item.bbox.height
    const g = groups.find((l) => Math.abs(l.y - baseline) <= TOLERANCE)
    if (g) g.items.push(item)
    else groups.push({ y: baseline, items: [item] })
  }
  groups.sort((a, b) => a.y - b.y) // top-left origin: ascending y is top to bottom

  return groups.map(({ items: parts }) => {
    parts.sort((a, b) => a.bbox.x - b.bbox.x)
    let raw = ''
    let prevEnd: number | null = null
    // Spans are recorded against this UNTRIMMED joined string first, then
    // shifted once the final `.trim()` amount is known below. A gap space
    // inserted between items belongs to no span; an item's own bbox is kept
    // unchanged even when its text carries leading/trailing spaces (an
    // accepted approximation, since pdf.js gives one advance per item).
    const rawSpans: Array<{ start: number; end: number; bbox: BBox }> = []
    for (const p of parts) {
      if (prevEnd !== null && p.bbox.x - prevEnd > GAP && !raw.endsWith(' ') && !p.str.startsWith(' ')) {
        raw += ' '
      }
      const start = raw.length
      raw += p.str
      rawSpans.push({ start, end: raw.length, bbox: p.bbox })
      prevEnd = p.bbox.x + p.bbox.width
    }
    const text = raw.trim()
    const lead = raw.length - raw.trimStart().length
    const spans: Span[] = []
    for (const rs of rawSpans) {
      const start = Math.max(0, Math.min(text.length, rs.start - lead))
      const end = Math.max(0, Math.min(text.length, rs.end - lead))
      if (start >= end) continue // fully consumed by the leading/trailing trim
      spans.push({ start, end, bbox: rs.bbox })
    }
    return { text, bbox: union(parts.map((p) => p.bbox)), items: parts, spans }
  })
}

export function union(boxes: BBox[]): BBox {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/**
 * Reads every page. Returns [] for a corrupt, empty or image-only file so
 * one bad file among dozens does not abort the batch; the caller reports
 * that honestly as "no text layer" and tries OCR. Only a genuine pdf.js
 * failure is rethrown.
 */
export async function readPdf(file: Blob, fileName: string): Promise<PdfPage[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return []

  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: bytes })
  try {
    const doc = await task.promise
    const pages: PdfPage[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items: PositionedItem[] = []
      for (const item of content.items) {
        if (!isTextItem(item)) continue
        // Whitespace-only fragments are dropped: nothing can point provenance
        // at a space, and pdf.js reports height 0 for them, which would put a
        // degenerate box in the index. Lines get their spacing from the x gap.
        if (item.str.trim() === '') continue
        // transform[4..5] is the baseline start in PDF space (bottom-left
        // origin, rotation applied by the viewport). Convert the baseline
        // point, then hang the box above it by the glyph height.
        const [vx, vy] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
        const h = glyphHeight(item)
        items.push(...splitWordItems(item.str, vx, vy - h, item.width, h))
      }
      pages.push({ page: n, width: viewport.width, height: viewport.height, items, lines: assembleLines(items) })
    }
    return pages
  } catch (cause) {
    if (cause instanceof Error && BENIGN_READ_FAILURE.test(`${cause.name} ${cause.message}`)) {
      return []
    }
    throw new PdfReadError(`Could not read ${fileName}: ${String(cause)}`, { cause })
  } finally {
    // The loading task owns teardown in pdf.js v6; without this every file
    // leaks a live worker document.
    await task.destroy()
  }
}
