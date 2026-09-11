// New file for this task's fixes (F001/F002/F003). One-file-per-concern
// convention: covers the three-state orientation fix and the second glue
// class deglueForMoney now handles, against both synthetic fixtures and the
// real sample invoices the finding measured.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import { boxFor } from '../src/domain/spans'
import { readPdf } from '../src/lib/pdf'
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

// --- F001: three-state orientation replaces the boolean preferUS ----------

describe('F001: document orientation is a genuine three-state signal, not just US_HINTS', () => {
  it('non-US evidence (EUR symbol) resolves an ambiguous date day-first, not to uncertain', () => {
    // Fails without the fix: the boolean-preferUS code treats "no US_HINTS
    // token" as "no evidence at all" and emits both readings -> uncertain,
    // even though the EUR symbol is genuine non-US evidence.
    const page = mkPage([mkLine('Total 1.200,00 EUR', 10), mkLine('Invoice date 05/06/2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-06-05') // day-first
  })

  it('non-US evidence (MwSt) resolves an ambiguous date day-first', () => {
    const page = mkPage([mkLine('MwSt 19%', 10), mkLine('Invoice date 05/06/2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-06-05')
  })

  it('US evidence (USD) still resolves an ambiguous date month-first', () => {
    const page = mkPage([mkLine('Total 1,200.00 USD', 10), mkLine('Invoice date 05/06/2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-05-06') // month-first
  })

  it('both US and non-US evidence present at once is a real conflict -> none -> uncertain', () => {
    const page = mkPage([mkLine('Total USD 1,200.00', 10), mkLine('VAT Reg No 123', 20), mkLine('Invoice date 05/06/2025', 30)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('uncertain')
    expect(invoiceDate.candidates).toEqual(expect.arrayContaining(['2025-05-06', '2025-06-05']))
  })

  it('no orientation evidence at all -> genuinely uncertain, both readings kept', () => {
    const page = mkPage([mkLine('Invoice date 05/06/2025', 10)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('uncertain')
    expect(invoiceDate.candidates).toEqual(expect.arrayContaining(['2025-05-06', '2025-06-05']))
  })

  it('00_BF-00885.pdf (UK invoice, VAT Reg No, no US_HINTS token) -> invoice_date reads day-first, 2025-05-06', async () => {
    // Fails without the fix: was 'uncertain', losing this real sample's date.
    const pages = await readPdf(new Blob([pdfBuffer('00_BF-00885.pdf')]), '00_BF-00885.pdf')
    const fields = extractHeaderFields(pages, 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-05-06')
  })

  it('10_AF-00500.pdf (AUD statement, no US_HINTS token) -> due_date reads day-first, 2025-05-01', async () => {
    // Fails without the fix: was 'uncertain', losing this real sample's date.
    const pages = await readPdf(new Blob([pdfBuffer('10_AF-00500.pdf')]), '10_AF-00500.pdf')
    const fields = extractHeaderFields(pages, 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-05-01')
  })
})

// --- F002: deglueForMoney handles the lowercase-then-ALLCAPS glue class too

describe('F002: deglueForMoney also splits lowercase-then-ALLCAPS glue, not just letter-then-digit', () => {
  it('"Total for ServicesTOTAL DUE1,148.72" reads the TOTAL DUE label and lands the bbox on the money digits', () => {
    // Fails without the fix: "ServicesTOTAL" stays glued, so the TOTAL DUE
    // label pattern (which ends in \b) never matches this line at all.
    const text = 'Total for ServicesTOTAL DUE1,148.72'
    const page = mkPage([mkLine(text)])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    expect(total.provenance).not.toBeNull()
    // The digits' box must map back to the ORIGINAL (glued) line's own
    // characters, not the de-glued copy.
    const start = text.indexOf('1,148.72')
    const end = start + '1,148.72'.length
    expect(total.provenance!.bbox).toEqual(boxFor(page.lines[0], start, end))
  })

  it('"ServicesSUBTOTAL 900.00" reads the SUBTOTAL label after the lowercase-then-ALLCAPS glue', () => {
    const text = 'ServicesSUBTOTAL 900.00'
    const page = mkPage([mkLine(text)])
    const fields = extractHeaderFields([page], 'text')
    const subtotal = fields.find((f) => f.name === 'subtotal')!
    expect(subtotal.state).toBe('read')
    expect(subtotal.value).toBe('900.00')
  })

  it('false-alarm check: the original letter-then-digit glue class still works unchanged', () => {
    const text = 'GRAND TOTAL1,148.72'
    const page = mkPage([mkLine(text)])
    const fields = extractHeaderFields([page], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    const start = text.indexOf('1,148.72')
    const end = start + '1,148.72'.length
    expect(total.provenance!.bbox).toEqual(boxFor(page.lines[0], start, end))
  })
})
