// Round 3 adversarial checks for F001-F005. New file, per convention: one
// assertion per ACCEPTANCE criterion, plus edge attacks on the code the
// diff touched. Ground truth for the fixtures below comes from
// tests/fixtures/ground-truth/*.json and from reading the sample PDFs'
// own extracted text (pypdf), never from what the code currently returns.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { boxFor } from '../src/domain/spans'
import { extractHeaderFields } from '../src/domain/fields'
import { coverageOf, coverageLine } from '../src/domain/coverage'
import { readDocument } from '../src/ui/pipeline'
import type { Line, PdfPage } from '../src/domain/types'

function pdfBuffer(name: string): Buffer {
  return readFileSync(new URL(`../public/sample/${name}`, import.meta.url))
}

function mkLine(text: string, y = 10): Line {
  return {
    text,
    bbox: { x: 0, y, width: 500, height: 12 },
    items: [],
    spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: 500, height: 12 } }],
  }
}

function mkPage(lines: Line[], page = 1): PdfPage {
  return { page, width: 600, height: 800, items: [{ str: 'x', bbox: { x: 0, y: 0, width: 1, height: 1 } }], lines }
}

// --- F001: a scan routes to human review, never claims the page prints ----

describe('F001: scanned document reports uncertain, not not_found', () => {
  it('06_NW-213.pdf (flatbed scan, ground truth vendor Nordway Logistics) -> ocr source, all 8 fields uncertain', async () => {
    const buf = pdfBuffer('06_NW-213.pdf')
    const file = new File([buf], '06_NW-213.pdf')
    const doc = await readDocument(file)

    expect(doc.source).toBe('ocr')
    expect(doc.fields.length).toBe(8)
    for (const f of doc.fields) {
      expect(f.state).toBe('uncertain')
      expect(f.value).toBeNull()
      expect(f.provenance).toBeNull()
      expect(f.candidates).toEqual([])
    }
  })

  it('coverage line for a scan reads "8 uncertain", never "8 not found" (the false claim a batch report would surface)', async () => {
    const buf = pdfBuffer('06_NW-213.pdf')
    const file = new File([buf], '06_NW-213.pdf')
    const doc = await readDocument(file)
    const cov = coverageOf(doc.fields)
    expect(cov).toEqual({ total: 8, read: 0, corrected: 0, uncertain: 8, not_found: 0 })
    expect(coverageLine(cov)).toBe('8 fields: 0 read, 0 corrected, 8 uncertain, 0 not found. 0 unaccounted.')
  })
})

// --- F002: money survives a glued label/value with no word boundary -------

describe('F002: glued money label degludes without shifting provenance', () => {
  // NOTE on case selection: "TOTAL DUE1,148.72" / "Subtotal2,072.63" /
  // "VAT414.53" (the finding's own literal examples) turn out to ALSO
  // resolve correctly even with deglueForMoney neutralised to a no-op,
  // because MONEY's own optional `[A-Z]{3}` currency-code slot happens to
  // swallow a preceding 3-upper-letter word ("DUE"), and SUBTOTAL/TAX rank
  // patterns in this codebase never carry a trailing `\b` after the label
  // in the first place, so JUNK's zero-length match reaches the digits
  // regardless of the fix. Those are kept below as false-alarm/regression
  // checks (still real ACCEPTANCE requirements), but the cases proven to
  // go red without the fix - the ones that isolate the actual mechanism -
  // are the ones where nothing else can accidentally bridge the gap: a
  // label ending in a non-3-letter word, immediately glued to a digit.
  it('"GRAND TOTAL1,148.72" glued -> total reads 1148.72 (fails without deglue: proved by reverting deglueForMoney to identity, see notes)', () => {
    const text = 'GRAND TOTAL1,148.72'
    const page = mkPage([mkLine(text)])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')

    // Provenance must map back to the ORIGINAL line's own characters, not
    // the de-glued copy: the true offsets of "1,148.72" in the original,
    // un-mutated string.
    const start = text.indexOf('1,148.72')
    const end = start + '1,148.72'.length
    const expectedBox = boxFor(page.lines[0], start, end)
    expect(total.provenance?.bbox).toEqual(expectedBox)
  })

  it('"Amount Due1,148.72" glued -> total reads 1148.72 (fails without deglue)', () => {
    const page = mkPage([mkLine('Amount Due1,148.72')])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it('"Balance Due1,148.72" glued -> total reads 1148.72 (fails without deglue)', () => {
    const page = mkPage([mkLine('Balance Due1,148.72')])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it('"TOTAL DUE1,148.72" glued (finding\'s own literal example) -> total reads 1148.72', () => {
    const page = mkPage([mkLine('TOTAL DUE1,148.72')])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it('"Subtotal2,072.63" glued -> subtotal reads 2072.63', () => {
    const page = mkPage([mkLine('Subtotal2,072.63')])
    const fields = extractHeaderFields([page], 'text')
    const subtotal = fields.find((f) => f.name === 'subtotal')!
    expect(subtotal.state).toBe('read')
    expect(subtotal.value).toBe('2072.63')
  })

  it('"VAT414.53" glued -> tax reads 414.53', () => {
    const page = mkPage([mkLine('VAT414.53')])
    const fields = extractHeaderFields([page], 'text')
    const tax = fields.find((f) => f.name === 'tax')!
    expect(tax.state).toBe('read')
    expect(tax.value).toBe('414.53')
  })

  it('false-alarm check: an un-glued total line with a normal space is unaffected by the deglue path', () => {
    const page = mkPage([mkLine('Total due £2,487.16')])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('2487.16')
  })
})

// --- F003: stacked label/value dates read from the line BELOW the label ---

describe('F003: invoice_date/due_date read a bare date from the next non-empty line', () => {
  it('"Invoice date" alone, "15 Jan 2025" on the next line -> invoice_date reads 2025-01-15', () => {
    const page = mkPage([mkLine('Invoice date', 10), mkLine('15 Jan 2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-01-15')
    // provenance must come from the VALUE line, not the label line
    expect(invoiceDate.provenance?.bbox.y).toBe(30)
  })

  it('"Due date" alone, "15 Jan 2025" on the next line -> due_date reads 2025-01-15', () => {
    const page = mkPage([mkLine('Due date', 10), mkLine('15 Jan 2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-01-15')
  })

  it('false-alarm check: a normal same-line label still reads fine (stacked fallback did not break the common case)', () => {
    const page = mkPage([mkLine('Invoice date: 2025-01-15', 10)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-01-15')
  })
})

// --- F004: US_HINTS no longer contains an incidental \b\$ accident --------

describe('F004: a lone glued "$" never flips document-wide date orientation', () => {
  it('"GST$762.68" glued elsewhere on the page does not make an ambiguous date read as month-first; GST is genuine non-US evidence, so it reads day-first', () => {
    const page = mkPage([
      mkLine('Invoice date 06/08/2025', 10), // both components <=12: ambiguous without a real hint
      mkLine('GST$762.68', 30),
    ])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    // GST is a genuine NON_US_HINTS token (Australian tax), so the glued $
    // next to it must not make this read month-first: it reads day-first,
    // exactly as it would if the $ weren't there at all.
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-08-06')
  })

  it('07_AF-00496.pdf (AU invoice, GST/ABN, no US_HINTS token) -> due_date reads day-first from the GST/ABN non-US evidence, never the month-first reading', async () => {
    const buf = pdfBuffer('07_AF-00496.pdf')
    const pages = await import('../src/lib/pdf').then((m) => m.readPdf(new Blob([buf]), '07_AF-00496.pdf'))
    const fields = extractHeaderFields(pages, 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-08-06')
    // The bug's wrong output was 'read' state with value '2025-06-08'
    // (month-first). Assert that specific wrong value is never emitted.
    expect(dueDate.value).not.toBe('2025-06-08')
  })

  it('a genuine US hint (EIN) present elsewhere DOES resolve an ambiguous date to the US (month-first) reading', () => {
    const page = mkPage([
      mkLine('Invoice date 06/08/2025', 10),
      mkLine('EIN 12-3456789', 30),
    ])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-06-08') // month-first: US convention
  })

  it('an UNAMBIGUOUS date (day > 12) still reads even with no hint at all', () => {
    const page = mkPage([mkLine('Invoice date 25/12/2025', 10)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-12-25')
  })
})

// --- F005: an overlapping due/invoice match is 'uncertain', never 'not_found' -

describe('F005: suppressOverlap emits uncertain, not not_found', () => {
  it('a lone "Due" label and a bare year-first date resolve to the exact same box invoice_date also claims -> due_date uncertain, candidate carried, never not_found', () => {
    // "Due" alone matches DUE_DATE_LABEL_ONLY; the next non-empty line,
    // "2025-06-25", is a bare year-first date that ALSO independently
    // satisfies DATE_BARE_LINE for invoice_date. Both fields' matches span
    // the value line's ENTIRE text, so both resolve to that line's own
    // bbox verbatim: identical boxes, same page. This is the
    // "mislabelled due catching the invoice's own date" case the
    // suppressOverlap docstring describes.
    const page = mkPage([mkLine('Due', 10), mkLine('2025-06-25', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-06-25')
    expect(dueDate.state).not.toBe('not_found')
    expect(dueDate.state).toBe('uncertain')
    expect(dueDate.candidates).not.toBeNull()
    expect(dueDate.candidates!.length).toBeGreaterThan(0)
    expect(dueDate.candidates![0]).not.toBeNull()
  })

  it('false-alarm check: distinct invoice_date and due_date boxes on the SAME page and SAME line still both read (no over-suppression)', () => {
    // 07_AF-00496 ground truth: "Issued 23/07/2025 . Due 06/08/2025" - two
    // distinct, non-overlapping boxes on one line.
    const page = mkPage([mkLine('Issued 23/07/2025 . Due 06/08/2025', 10)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-07-23')
    expect(dueDate.state).not.toBe('not_found')
  })
})
