/**
 * Regression tests for the F001-F005 findings fixed in this task. Each test
 * FAILS against the pre-fix code and passes after it. Kept in its own file
 * per the one-file-per-concern convention; the shared test files
 * (fields.test.ts, tester.adversarial.test.ts) are untouched except for the
 * F001-authorised correction of the scan-path assertions.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import { readDocument } from '../src/ui/pipeline'

function pdfBuffer(name: string): Buffer {
  return readFileSync(new URL(`../public/sample/${name}`, import.meta.url))
}

// A single-span line, mirroring the synthetic-page helper already used in
// tests/tester.adversarial.test.ts (R012 / R008 describe blocks).
function mkLine(text: string, y: number) {
  return {
    text,
    bbox: { x: 0, y, width: 500, height: 12 },
    items: [],
    spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: 500, height: 12 } }],
  }
}

// --- F001: a scan reports 'uncertain', not 'not_found' --------------------

describe('F001: scanned document routes to human review, does not claim the page is blank', () => {
  it('06_NW-213.pdf (a scan) -> all eight fields uncertain, not not_found', async () => {
    const buf = pdfBuffer('06_NW-213.pdf')
    const file = new File([buf], '06_NW-213.pdf')
    const doc = await readDocument(file)
    expect(doc.source).toBe('ocr')
    expect(doc.fields.length).toBe(8)
    for (const field of doc.fields) {
      expect(field.state).toBe('uncertain')
      expect(field.value).toBeNull()
      expect(field.provenance).toBeNull()
      expect(field.candidates).toEqual([])
    }
  })
})

// --- F002: money label glued to its value ----------------------------------

describe('F002: money patterns de-glue a label directly glued to its digits', () => {
  // Every TOTAL_LABELS entry requires a trailing `\b` right after the label
  // ("total\s*due\b" etc), which finds no boundary between a letter and an
  // immediately following digit (both are `\w`). 'GRAND TOTAL1,148.72' (no
  // "DUE" word, so no accidental currency-code coincidence in MONEY's
  // optional `[A-Z]{3}` group) isolates that specific failure.
  it("'GRAND TOTAL1,148.72' with no separator -> total read as 1148.72", () => {
    const page = { page: 1, width: 600, height: 800, items: [], lines: [mkLine('GRAND TOTAL1,148.72', 10)] }
    const fields = extractHeaderFields([page as any], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it("'TOTAL DUE1,148.72' with no separator -> total read as 1148.72", () => {
    const page = { page: 1, width: 600, height: 800, items: [], lines: [mkLine('TOTAL DUE1,148.72', 10)] }
    const fields = extractHeaderFields([page as any], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it('provenance box for the deglued total maps back to the ORIGINAL line characters (the money digits only)', () => {
    // One-unit-per-character span (width == text.length), so boxFor's
    // per-char interpolation makes bbox.x equal the character offset.
    const text = 'GRAND TOTAL1,148.72'
    const line = {
      text,
      bbox: { x: 0, y: 10, width: text.length, height: 12 },
      items: [],
      spans: [{ start: 0, end: text.length, bbox: { x: 0, y: 10, width: text.length, height: 12 } }],
    }
    const page = { page: 1, width: 600, height: 800, items: [], lines: [line] }
    const fields = extractHeaderFields([page as any], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.provenance).not.toBeNull()
    // 'GRAND TOTAL' is 11 characters (indices 0-10); the digits start at
    // index 11 in the ORIGINAL (glued) line, not at index 12 as they would
    // if the provenance box were computed against the deglued copy.
    expect(total.provenance!.bbox.x).toBe(11)
    expect(total.provenance!.bbox.width).toBe('1,148.72'.length)
  })
})

// --- F003: stacked date labels (value on the line below) ------------------

describe('F003: invoice_date / due_date read a bare value stacked on the next line', () => {
  it("'Invoice date' on one line, '15 Jan 2025' on the next -> invoice_date read", () => {
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Invoice date', 10), mkLine('15 Jan 2025', 24)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-01-15')
  })

  it("'Due date' on one line, '20 Feb 2025' on the next -> due_date read", () => {
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Due date', 10), mkLine('20 Feb 2025', 24)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-02-20')
  })
})

// --- F004: a glued '$' no longer flips document-wide date orientation -----

describe('F004: a glued $ (word-boundary accident) does not flip document orientation to US by itself', () => {
  it("a 'GST$762.68' line does not flip an ambiguous date to month-first on the strength of the '$' alone; GST is genuine non-US evidence, so it reads day-first", () => {
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('GST$762.68', 10), mkLine('Due date 06/08/2025', 24)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    // The glued '$' no longer fires US_HINTS. GST does fire NON_US_HINTS
    // (it's Australian, not US), so the document orientation is 'non_us'
    // and the ambiguous 06/08/2025 reads day-first, not month-first.
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-08-06')
  })

  it('the real 07_AF-00496.pdf sample (GST/ABN, no US_HINTS token) reads its ambiguous due date day-first, from the GST/ABN evidence', async () => {
    const pages = await import('../src/lib/pdf').then((m) => m.readPdf(new Blob([pdfBuffer('07_AF-00496.pdf')]), '07_AF-00496.pdf'))
    const fields = extractHeaderFields(pages, 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    // GST/ABN fire NON_US_HINTS and no US_HINTS token is present, so the
    // orientation is 'non_us': the ambiguous due date reads day-first
    // (2025-08-06), not the month-first misread (2025-06-08).
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-08-06')
  })
})

// --- F005: overlap suppression reports 'uncertain', not 'not_found' -------

describe('F005: a due_date suppressed for overlapping the invoice_date box is uncertain, not not_found', () => {
  it("a mislabelled 'Due' catching the invoice's own date box -> due_date uncertain, value kept as a candidate, not not_found", () => {
    // Two lines placed at the SAME y so their whole-line boxes overlap,
    // reproducing the "due catches the invoice's own date" layout without
    // depending on a specific label wording.
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Issued 06/05/2025', 10), mkLine('Due 06/05/2025', 10)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(dueDate.state).toBe('uncertain')
    expect(dueDate.value).toBeNull()
    expect(dueDate.candidates).not.toBeNull()
    expect(dueDate.candidates!.length).toBeGreaterThan(0)
    expect(dueDate.provenance).not.toBeNull()
  })
})
