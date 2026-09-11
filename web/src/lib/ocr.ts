// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/**
 * OCR for scanned invoices, in the browser, with tesseract.js.
 *
 * pdf.js renders each page to a canvas; tesseract reads it. The worker,
 * WebAssembly core and English language data are fetched on first use
 * only, so a visitor who never drops a scan never pays for them. Files
 * still never leave the browser: recognition runs in a local Web Worker.
 *
 * Mirrors extract.ocr_pdf_text: the untouched raster goes first, because
 * tesseract's own binarisation copes with a clean desk scan better than a
 * hand-rolled threshold does with thin type. There is no deskew here; the
 * Python side found it rarely helped once speckle was handled.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Block, Worker as TesseractWorker } from 'tesseract.js'

import { wordsToPage, type OcrLine } from '../domain/ocrPages'
import type { PdfPage } from '../domain/types'
import { loadPdfjs } from './pdf'

const RENDER_SCALE = 300 / 72 // pdf.js user units are 1/72 inch: render at 300 dpi

let workerPromise: Promise<TesseractWorker> | null = null

async function worker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js')
      return createWorker('eng', 1)
    })()
  }
  return workerPromise
}

/** Renders one page of an open document to a canvas at roughly 300 dpi. */
async function renderPage(doc: PDFDocumentProxy, n: number): Promise<HTMLCanvasElement | null> {
  const page = await doc.getPage(n)
  const viewport = page.getViewport({ scale: RENDER_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // 'print' rather than the default 'display' intent: display rendering
  // is paced by requestAnimationFrame, which browsers stop firing in a
  // background tab, so a user who switches tabs while a batch of scans
  // is running would see it stall until they came back.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise
  return canvas
}

/** Renders page 1 of a PDF to a canvas at roughly 300 dpi. */
export async function renderFirstPage(file: Blob): Promise<HTMLCanvasElement | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return null
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: bytes })
  try {
    const doc = await task.promise
    if (doc.numPages < 1) return null
    return await renderPage(doc, 1)
  } finally {
    await task.destroy()
  }
}

/** tesseract's block tree flattened to the lines domain/ocrPages.ts reads. */
function linesOf(blocks: Block[] | null): OcrLine[] {
  return (blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
}

/**
 * Every page of a scan as PdfPage[], word boxes and confidences included,
 * in PDF points: the same shape readPdf returns for a text layer, so the
 * extractor and the page overlay never learn which one they are looking
 * at. `blocks: true` is what makes tesseract.js 7 return the word tree; the
 * default output is text only.
 */
export async function ocrPdfPages(file: Blob): Promise<PdfPage[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length === 0) return []
  const pdfjs = await loadPdfjs()
  const task = pdfjs.getDocument({ data: bytes })
  try {
    const doc = await task.promise
    const pages: PdfPage[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      // Render before touching the engine: creating the worker downloads the
      // language data, and a page that cannot be rendered (no canvas, as
      // under Node) should fail before that download starts.
      const canvas = await renderPage(doc, n)
      if (!canvas) continue
      const { data } = await (await worker()).recognize(canvas, {}, { blocks: true })
      pages.push(wordsToPage(linesOf(data.blocks), n, canvas.width, canvas.height, RENDER_SCALE))
    }
    return pages
  } finally {
    await task.destroy()
  }
}

/**
 * Recognises the text on page 1. Returns '' when nothing could be read, so
 * the caller reports the file as unreadable exactly as it would for an
 * empty text layer. Throws only on a genuine failure to load the OCR
 * engine, which the pipeline surfaces as a per-file error.
 */
export async function ocrPdfText(file: Blob): Promise<string> {
  const canvas = await renderFirstPage(file)
  if (!canvas) return ''
  const w = await worker()
  const { data } = await w.recognize(canvas)
  return data.text ?? ''
}
