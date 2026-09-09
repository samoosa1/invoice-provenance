/**
 * File -> positioned text, every page, via pdf.js. The browser edge of
 * extraction; parsing lives in domain/. Derived from ledger-reconciler's
 * lib/pdf.ts (same author, MIT), which read page-1 text only. This one
 * keeps every fragment's box so a value can point back at its pixels.
 */

import type * as PdfjsTypes from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { BBox, Line, PdfPage, PositionedItem } from '../domain/types'

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
    let text = ''
    let prevEnd: number | null = null
    for (const p of parts) {
      if (prevEnd !== null && p.bbox.x - prevEnd > GAP && !text.endsWith(' ') && !p.str.startsWith(' ')) {
        text += ' '
      }
      text += p.str
      prevEnd = p.bbox.x + p.bbox.width
    }
    return { text: text.trim(), bbox: union(parts.map((p) => p.bbox)), items: parts }
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
        items.push({ str: item.str, bbox: { x: vx, y: vy - glyphHeight(item), width: item.width, height: glyphHeight(item) } })
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
