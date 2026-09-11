/**
 * File -> fingerprinted, field-extracted document. The browser edge that
 * glues lib/pdf.ts's reading to domain/fields.ts's extraction. Strictly
 * sequential, no `Promise.all`: this runs on a 2-core machine and OCR
 * (tesseract) is a memory hog, so there is nothing to gain from overlapping
 * a PDF read with an OCR pass and a real risk of starving both.
 */

import { extractHeaderFields } from '../domain/fields'
import { extractLineItems, lineSumFlags } from '../domain/lineItems'
import type { Field, FieldSource, PdfPage } from '../domain/types'
import { ocrPdfPages } from '../lib/ocr'
import { readPdf } from '../lib/pdf'

const FIELD_NAMES = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'] as const

/** A scan the OCR engine could not process has never been read, so it cannot
 * claim 'not_found' for its eight fields: that state means "the page does not
 * print this", which is not known. It reports 'uncertain' with no value and
 * no candidates, so the document routes to human review instead of asserting
 * the page is blank. */
function unreadFields(source: FieldSource): Field[] {
  return FIELD_NAMES.map((name) => ({
    name,
    value: null,
    state: 'uncertain',
    source,
    provenance: null,
    confidence: null,
    candidates: [],
  }))
}

/** The eight header fields, then every line-item cell, and the document
 * flags the totals cross-check raises over them. */
function extractAll(pages: PdfPage[], source: FieldSource): { fields: Field[]; flags: string[] } {
  const fields = [...extractHeaderFields(pages, source), ...extractLineItems(pages, source)]
  return { fields, flags: lineSumFlags(fields) }
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export type ExtractedDocument = {
  fileName: string
  fingerprint: string
  pageCount: number
  source: FieldSource
  fields: Field[]
  flags: string[]
}

/** The 25 sample_gen invoices shipped with the app, listed by public/sample/index.json. */
export async function loadSampleFiles(baseUrl: string): Promise<File[]> {
  const names = (await (await fetch(`${baseUrl}sample/index.json`)).json()) as string[]
  const files: File[] = []
  for (const name of names) {
    const blob = await (await fetch(`${baseUrl}sample/${name}`)).blob()
    files.push(new File([blob], name, { type: 'application/pdf' }))
  }
  return files
}

export async function readDocument(file: File): Promise<ExtractedDocument> {
  const bytes = await file.arrayBuffer() // read once; used for both the fingerprint and the PDF read below
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const fingerprint = toHex(digest)

  const pages = await readPdf(new Blob([bytes]), file.name)
  const hasTextLayer = pages.some((p) => p.items.length > 0)
  if (hasTextLayer) {
    return { fileName: file.name, fingerprint, pageCount: pages.length, source: 'text', ...extractAll(pages, 'text') }
  }

  // No text layer: OCR every page into the same PdfPage shape (word boxes in
  // PDF points, per-word confidence) and extract from that. Only a failure
  // to run the engine at all leaves the document unread.
  const source: FieldSource = 'ocr'
  let fields: Field[]
  let flags: string[] = []
  try {
    ;({ fields, flags } = extractAll(await ocrPdfPages(new Blob([bytes])), source))
  } catch (cause) {
    console.warn(`OCR failed for ${file.name}; routing to review`, cause)
    fields = unreadFields(source)
  }
  return { fileName: file.name, fingerprint, pageCount: pages.length, source, fields, flags }
}
