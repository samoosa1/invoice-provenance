/**
 * File -> fingerprinted, field-extracted document. The browser edge that
 * glues lib/pdf.ts's reading to domain/fields.ts's extraction. Strictly
 * sequential, no `Promise.all`: this runs on a 2-core machine and OCR
 * (tesseract) is a memory hog, so there is nothing to gain from overlapping
 * a PDF read with an OCR pass and a real risk of starving both.
 */

import { extractHeaderFields } from '../domain/fields'
import type { Field, FieldSource } from '../domain/types'
import { readPdf } from '../lib/pdf'

const FIELD_NAMES = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'] as const

/** A scan with no text layer has never been read (OCR is a later task), so
 * it cannot claim 'not_found' for its eight fields: that state means "the
 * page does not print this", which is not known yet. It reports 'uncertain'
 * with no value and no candidates, so the document routes to human review
 * instead of asserting the page is blank. */
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

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function readDocument(file: File): Promise<{
  fileName: string
  fingerprint: string
  pageCount: number
  source: FieldSource
  fields: Field[]
}> {
  const bytes = await file.arrayBuffer() // read once; used for both the fingerprint and the PDF read below
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const fingerprint = toHex(digest)

  const pages = await readPdf(new Blob([bytes]), file.name)
  const hasTextLayer = pages.some((p) => p.items.length > 0)

  // OCR positioning (spec 1c) is a later task: without it a scan has no
  // per-value boxes to offer, so it routes straight to human review instead
  // of guessing at eight fields with fabricated provenance.
  const source: FieldSource = hasTextLayer ? 'text' : 'ocr'
  const fields = hasTextLayer ? extractHeaderFields(pages, source) : unreadFields(source)

  return { fileName: file.name, fingerprint, pageCount: pages.length, source, fields }
}
