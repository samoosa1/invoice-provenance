/**
 * File -> positioned text, every page, via pdf.js. The browser edge of
 * extraction; parsing lives in domain/. Derived from ledger-reconciler's
 * lib/pdf.ts (same author, MIT), which read page-1 text only. This one
 * keeps every word's box so a value can point back at its pixels.
 */

import type * as PdfjsTypes from 'pdfjs-dist'

import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { BBox, Line, PdfPage, PositionedItem, Span } from '../domain/types'
import { readGlyphs } from './glyphs'

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

/** Failures that mean "no readable text here", not "the reader broke". */
const BENIGN_READ_FAILURE = /InvalidPDF|Invalid PDF|Corrupt|password|Missing PDF|Empty file/i

export class PdfReadError extends Error {}

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
      // One item per word, boxed from the operator list's own glyph advances
      // (lib/glyphs.ts). getTextContent() would hand back one box per run,
      // and a run here is often a whole address line.
      const items = await readGlyphs(page, viewport, pdfjs)
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
