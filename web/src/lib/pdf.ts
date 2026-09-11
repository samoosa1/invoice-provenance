/**
 * File -> positioned text, every page, via pdf.js. The browser edge of
 * extraction; parsing lives in domain/. Derived from ledger-reconciler's
 * lib/pdf.ts (same author, MIT), which read page-1 text only. This one
 * keeps every word's box so a value can point back at its pixels.
 */

import type * as PdfjsTypes from 'pdfjs-dist'

import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { PdfPage } from '../domain/types'
import { assembleLines } from '../domain/lines'
import { readGlyphs } from './glyphs'

// The external oracle (tests/oracle.spans.test.ts) imports boxFor from here,
// but the interpolation math is pure and belongs in domain/; this is just a
// hallway door so the browser-edge module and the pure module agree on one
// function.
export { boxFor } from '../domain/spans'
// Same arrangement for line assembly: pure, shared with the OCR path.
export { assembleLines, union } from '../domain/lines'

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
