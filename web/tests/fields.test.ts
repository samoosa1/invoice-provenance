import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { coverageOf } from '../src/domain/coverage'
import { extractHeaderFields, OCR_CONFIDENCE_FLOOR, resolveField, type Candidate } from '../src/domain/fields'
import type { Field, PdfPage } from '../src/domain/types'
import { readPdf } from '../src/lib/pdf'

async function readSample(file: string): Promise<PdfPage[]> {
  const bytes = await readFile(new URL(`../public/sample/${file}`, import.meta.url))
  return readPdf(new Blob([bytes]), file)
}

async function fieldsFor(file: string): Promise<Field[]> {
  return extractHeaderFields(await readSample(file), 'text')
}

function byName(fields: Field[], name: string): Field {
  return fields.find((f) => f.name === name)!
}

// --- R006/R007: resolveField clauses ---------------------------------------

function cand(over: Partial<Candidate>): Candidate {
  return { value: 'A', raw: 'A', page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: null, patternRank: 0, ...over }
}

describe('resolveField', () => {
  it('no candidates -> not_found, everything null', () => {
    expect(resolveField('x', [], 'text')).toEqual({
      name: 'x', value: null, state: 'not_found', source: 'text', provenance: null, confidence: null, candidates: null,
    })
  })

  it('best rank group disagreeing on value -> uncertain, provenance from the first with a box', () => {
    const a = cand({ value: 'A', page: 1 })
    const b = cand({ value: 'B', page: 2 })
    const f = resolveField('x', [a, b], 'text')
    expect(f.state).toBe('uncertain')
    expect(f.value).toBeNull()
    expect(f.candidates).toEqual(['A', 'B'])
    expect(f.provenance?.page).toBe(1)
  })

  it('a lower-ranked candidate with a different value never competes', () => {
    const a = cand({ value: 'A', patternRank: 0 })
    const b = cand({ value: 'B', patternRank: 2 })
    const f = resolveField('x', [a, b], 'text')
    expect(f.state).toBe('read')
    expect(f.value).toBe('A')
    expect(f.candidates).toBeNull()
  })

  it('two candidates at the best rank with the SAME value -> read', () => {
    const a = cand({ value: 'A', patternRank: 0 })
    const b = cand({ value: 'A', patternRank: 0 })
    const f = resolveField('x', [a, b], 'text')
    expect(f.state).toBe('read')
    expect(f.value).toBe('A')
  })

  it('single rank-0 candidate with a null bbox -> uncertain, candidates:[value], provenance:null', () => {
    const a = cand({ value: 'A', bbox: null })
    const f = resolveField('x', [a], 'text')
    expect(f).toEqual({
      name: 'x', value: null, state: 'uncertain', source: 'text', provenance: null, confidence: null, candidates: ['A'],
    })
  })

  it('OCR confidence below the floor -> uncertain', () => {
    const a = cand({ value: 'A', confidence: 55 })
    const f = resolveField('x', [a], 'ocr')
    expect(f.state).toBe('uncertain')
    expect(f.candidates).toEqual(['A'])
    expect(f.confidence).toBe(55)
  })

  it('OCR confidence at or above the floor -> read', () => {
    const a = cand({ value: 'A', confidence: 85 })
    const f = resolveField('x', [a], 'ocr')
    expect(f.state).toBe('read')
    expect(OCR_CONFIDENCE_FLOOR).toBe(70)
  })

  it('never returns undefined for an absent value', () => {
    const f = resolveField('x', [], 'text')
    for (const v of Object.values(f)) expect(v).not.toBeUndefined()
  })
})

// --- R006/R008: shape and page-scan order -----------------------------------

describe('extractHeaderFields: shape', () => {
  it('always returns exactly eight fields, in FIELD_NAMES order', () => {
    const names = extractHeaderFields([], 'text').map((f) => f.name)
    expect(names).toEqual(['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'])
  })

  it('an empty page list is eight not_found fields, all with source text', () => {
    for (const f of extractHeaderFields([], 'text')) {
      expect(f).toEqual({ name: f.name, value: null, state: 'not_found', source: 'text', provenance: null, confidence: null, candidates: null })
    }
  })

  it('stops at the first page yielding a candidate, except total which scans every page', async () => {
    const page1: PdfPage = {
      page: 1,
      width: 600,
      height: 800,
      items: [],
      lines: [
        { text: 'Invoice no. AB-1', bbox: { x: 0, y: 0, width: 10, height: 10 }, items: [], spans: [{ start: 12, end: 16, bbox: { x: 0, y: 0, width: 10, height: 10 } }] },
        { text: 'Total 10.00', bbox: { x: 0, y: 10, width: 10, height: 10 }, items: [], spans: [{ start: 6, end: 11, bbox: { x: 0, y: 10, width: 10, height: 10 } }] },
      ],
    }
    const page2: PdfPage = {
      page: 2,
      width: 600,
      height: 800,
      items: [],
      lines: [
        { text: 'Invoice no. CD-2', bbox: { x: 0, y: 0, width: 10, height: 10 }, items: [], spans: [{ start: 12, end: 16, bbox: { x: 0, y: 0, width: 10, height: 10 } }] },
        { text: 'Total 99.00', bbox: { x: 0, y: 10, width: 10, height: 10 }, items: [], spans: [{ start: 6, end: 11, bbox: { x: 0, y: 10, width: 10, height: 10 } }] },
      ],
    }
    const fields = extractHeaderFields([page1, page2], 'text')
    const invoiceNumber = byName(fields, 'invoice_number')
    expect(invoiceNumber.state).toBe('read')
    expect(invoiceNumber.value).toBe('AB-1')

    const total = byName(fields, 'total')
    expect(total.state).toBe('uncertain')
    expect(total.candidates).toEqual(['10.00', '99.00'])
  })
})

// --- R009-R016: per-template field values on the real sample PDFs ----------

describe('invoice_number (R009)', () => {
  const cases: Array<[string, string]> = [
    ['07_AF-00496.pdf', 'AF-00496'],
    ['03_PH-2025-0214.pdf', 'PH/2025/0214'],
    ['11_805.pdf', '805'],
    ['04_CF-2025-511.pdf', 'CF-2025-511'],
    ['19_319.pdf', '319'],
    ['00_BF-00885.pdf', 'BF-00885'],
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'invoice_number')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
      expect(f.provenance?.page).toBe(1)
    })
  }
})

describe('vendor (R010)', () => {
  const cases: Array<[string, string]> = [
    ['00_BF-00885.pdf', 'Bluefern Supplies Ltd'],
    ['07_AF-00496.pdf', 'Amberlake Facilities'],
    ['03_PH-2025-0214.pdf', 'Pinehollow Office Co'],
    ['04_CF-2025-511.pdf', 'Cedar & Finch Consulting'],
    ['19_319.pdf', 'Orrin Bakke Elektro AS'],
    ['11_805.pdf', 'SALTMARSH COFFEE ROASTERS'], // printed uppercase; the extractor reports what is printed
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'vendor')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
      expect(f.provenance?.page).toBe(1)
      expect(f.provenance?.bbox).not.toBeNull()
    })
  }
})

describe('invoice_date (R011)', () => {
  const cases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2025-05-06'], // day-first: no US hint fires on a GBP invoice
    ['12_WS-0316.pdf', '2025-06-03'],
    ['01_TIB-0000101.pdf', '2025-04-17'],
    ['03_PH-2025-0214.pdf', '2025-03-22'],
    ['11_805.pdf', '2025-01-28'], // unlabelled "Receipt #805 01/28/25"
    ['04_CF-2025-511.pdf', '2025-01-10'],
    ['07_AF-00496.pdf', '2025-07-23'],
    ['19_319.pdf', '2025-05-13'],
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'invoice_date')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
})

describe('due_date (R012)', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2025-06-20'],
    ['01_TIB-0000101.pdf', '2025-05-01'],
    ['03_PH-2025-0214.pdf', '2025-04-21'],
    ['12_WS-0316.pdf', '2025-07-03'],
    ['07_AF-00496.pdf', '2025-08-06'], // same line as invoice_date, not suppressed: different value boxes
    ['10_AF-00500.pdf', '2025-05-01'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'due_date')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }

  const notFoundCases = ['04_CF-2025-511.pdf', '19_319.pdf', '11_805.pdf', '20_811.pdf']
  for (const file of notFoundCases) {
    it(`${file} -> not_found`, async () => {
      const f = byName(await fieldsFor(file), 'due_date')
      expect(f).toMatchObject({ state: 'not_found', value: null, provenance: null, candidates: null })
    })
  }
})

describe('currency (R013)', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', 'GBP'],
    ['01_TIB-0000101.pdf', 'USD'],
    ['03_PH-2025-0214.pdf', 'EUR'],
    ['04_CF-2025-511.pdf', 'USD'],
    ['19_319.pdf', 'EUR'],
    // ABN + GST in the letterhead narrow the $ on the winning total line to
    // AUD (F001 rank 1 hint narrowing), so these two now read instead of
    // staying uncertain.
    ['07_AF-00496.pdf', 'AUD'],
    ['10_AF-00500.pdf', 'AUD'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'currency')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }

  const uncertainCases = ['11_805.pdf', '20_811.pdf']
  for (const file of uncertainCases) {
    it(`${file} -> uncertain USD/AUD`, async () => {
      const f = byName(await fieldsFor(file), 'currency')
      expect(f.state).toBe('uncertain')
      expect(f.value).toBeNull()
      expect(f.candidates).toEqual(['USD', 'AUD'])
      expect(f.provenance).not.toBeNull()
    })
  }
})

describe('subtotal (R014)', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2072.63'],
    ['07_AF-00496.pdf', '7626.78'], // "Subtotal (ex GST)"
    ['03_PH-2025-0214.pdf', '1106.51'], // "Goods/services total" outranks "Tax base"
    ['11_805.pdf', '104.87'],
    ['01_TIB-0000101.pdf', '1733.82'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'subtotal')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }

  for (const file of ['04_CF-2025-511.pdf', '19_319.pdf']) {
    it(`${file} -> not_found (no subtotal row)`, async () => {
      const f = byName(await fieldsFor(file), 'subtotal')
      expect(f).toMatchObject({ state: 'not_found', value: null, provenance: null })
    })
  }
})

describe('tax (R015)', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '414.53'],
    ['07_AF-00496.pdf', '762.68'], // not '7626.78', not uncertain
    ['11_805.pdf', '9.31'], // not '8.87': the (?![\d%]) guard on "TAX 8.875%"
    ['03_PH-2025-0214.pdf', '210.24'],
    ['19_319.pdf', '1070.73'], // MVA label
    ['01_TIB-0000101.pdf', '0.00'], // a printed zero is a value, not an absence
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const f = byName(await fieldsFor(file), 'tax')
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }

  for (const file of ['04_CF-2025-511.pdf', '17_CF-2025-513.pdf']) {
    it(`${file} -> not_found`, async () => {
      const f = byName(await fieldsFor(file), 'tax')
      expect(f).toMatchObject({ state: 'not_found', value: null, provenance: null, candidates: null })
    })
  }
})

describe('total (R016)', () => {
  const cases: Array<[string, string]> = [
    ['03_PH-2025-0214.pdf', '1316.75'], // "Total payable"
    ['01_TIB-0000101.pdf', '1733.82'], // "Balance Due"
    ['07_AF-00496.pdf', '8389.46'], // "Total amount due"
    ['00_BF-00885.pdf', '2487.16'], // "Total due"
    ['04_CF-2025-511.pdf', '3820.96'], // "TOTAL USD"
    ['19_319.pdf', '5353.66'],
    ['11_805.pdf', '114.18'], // "TOTAL"
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}, never uncertain`, async () => {
      const total = byName(await fieldsFor(file), 'total')
      expect(total.state).toBe('read')
      expect(total.value).toBe(expected)
    })
  }

  // 01_TIB-0000101.pdf has zero tax, so its total legitimately equals its
  // subtotal; the "never equals subtotal" check from R016 guards against the
  // subtotal pattern accidentally swallowing the total's own line, which is
  // a different failure mode from a real invoice where tax happens to be 0.
  it('subtotal-pattern greed never makes total silently equal subtotal on a non-zero-tax invoice', async () => {
    for (const file of ['03_PH-2025-0214.pdf', '07_AF-00496.pdf', '00_BF-00885.pdf', '04_CF-2025-511.pdf', '19_319.pdf', '11_805.pdf']) {
      const fields = await fieldsFor(file)
      const total = byName(fields, 'total')
      const subtotal = byName(fields, 'subtotal')
      if (subtotal.value !== null) expect(total.value).not.toBe(subtotal.value)
    }
  })
})

// --- R017: per-value provenance boxes agree with the independently measured
// PyMuPDF word boxes (same document the oracle uses). --------------------

describe('provenance boxes (R017)', () => {
  it('00_BF-00885.pdf: every money/number field points at its own digits, not the line', async () => {
    const fields = await fieldsFor('00_BF-00885.pdf')
    const near = (v: number, target: number, tol = 6) => expect(Math.abs(v - target)).toBeLessThanOrEqual(tol)

    const invoiceNumber = byName(fields, 'invoice_number')
    expect(invoiceNumber.provenance?.page).toBe(1)
    const n = invoiceNumber.provenance!.bbox
    near(n.x, 498.2)
    near(n.x + n.width, 544.88)
    near(n.y, 84.91)
    near(n.y + n.height, 95.41)

    const subtotal = byName(fields, 'subtotal')
    const s = subtotal.provenance!.bbox
    near(s.x, 505.52)
    near(s.x + s.width, 546.39)
    near(s.y, 310.66)
    near(s.y + s.height, 321.16)

    const tax = byName(fields, 'tax')
    const t = tax.provenance!.bbox
    near(t.x, 514.28)
    near(t.x + t.width, 546.39)

    const total = byName(fields, 'total')
    const tt = total.provenance!.bbox
    expect(tt.x).toBeGreaterThanOrEqual(493)
    expect(tt.x).toBeLessThanOrEqual(505)
    near(tt.x + tt.width, 546.38)
    expect(tt.width).toBeLessThan(60) // a line-box fallback (~219pt wide) fails this
  })
})

// --- R020: coverage ties on every sample PDF --------------------------------

describe('coverage (R020)', () => {
  const expected: Record<string, { total: number; read: number; corrected: number; uncertain: number; not_found: number }> = {
    '00_BF-00885.pdf': { total: 8, read: 8, corrected: 0, uncertain: 0, not_found: 0 },
    '07_AF-00496.pdf': { total: 8, read: 8, corrected: 0, uncertain: 0, not_found: 0 },
    '04_CF-2025-511.pdf': { total: 8, read: 5, corrected: 0, uncertain: 0, not_found: 3 },
    '11_805.pdf': { total: 8, read: 6, corrected: 0, uncertain: 1, not_found: 1 },
  }
  for (const [file, cov] of Object.entries(expected)) {
    it(`${file} coverage ties`, async () => {
      expect(coverageOf(await fieldsFor(file))).toEqual(cov)
    })
  }
})
