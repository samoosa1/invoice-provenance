import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { readPdf, assembleLines } from '../src/lib/pdf'
import { boxFor } from '../src/lib/pdf'
import { boxFor as boxForDomain } from '../src/domain/spans'
import { extractHeaderFields, resolveField, OCR_CONFIDENCE_FLOOR } from '../src/domain/fields'
import { readDocument } from '../src/ui/pipeline'
import type { Candidate } from '../src/domain/fields'

function pdfFile(name: string): Blob {
  return new Blob([readFileSync(new URL(`../public/sample/${name}`, import.meta.url))])
}
function pdfBuffer(name: string): Buffer {
  return readFileSync(new URL(`../public/sample/${name}`, import.meta.url))
}

describe('R002/R003 unit criteria', () => {
  it('assembleLines basic + leading space case', () => {
    const items = [
      { str: 'Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ]
    const lines = assembleLines(items as any)
    expect(lines.length).toBe(1)
    expect(lines[0].text).toBe('Total 99.00')
    expect(lines[0].spans).toEqual([
      { start: 0, end: 5, bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { start: 6, end: 11, bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
  })
  it('leading whitespace on first item still shifts correctly', () => {
    const items = [
      { str: '  Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ]
    const lines = assembleLines(items as any)
    expect(lines[0].text).toBe('Total 99.00')
    expect(lines[0].spans).toEqual([
      { start: 0, end: 5, bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { start: 6, end: 11, bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
  })

  it('boxFor exact acceptance table', () => {
    const items = [
      { str: 'Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ]
    const L = assembleLines(items as any)[0]
    expect(boxForDomain(L, 0, 5)).toEqual({ x: 300, y: 700, width: 10, height: 10 })
    expect(boxForDomain(L, 6, 11)).toEqual({ x: 400, y: 700, width: 10, height: 10 })
    expect(boxForDomain(L, 0, 11)).toEqual({ x: 300, y: 700, width: 110, height: 10 })
    expect(boxForDomain(L, 2, 4)).toEqual({ x: 304, y: 700, width: 4, height: 10 })
    expect(boxForDomain(L, 4, 8)).toEqual({ x: 308, y: 700, width: 96, height: 10 })
    expect(boxForDomain(L, 0, 6)).toEqual({ x: 300, y: 700, width: 10, height: 10 })
    expect(boxForDomain(L, 5, 6)).toBeNull()
    expect(boxForDomain(L, 3, 3)).toBeNull()
    expect(boxForDomain(L, 0, 0)).toBeNull()
    expect(boxForDomain(L, 0, 100)).toEqual({ x: 300, y: 700, width: 110, height: 10 })
  })

  it('re-export identity: lib/pdf boxFor === domain/spans boxFor', () => {
    expect(boxFor).toBe(boxForDomain)
  })

  it('every line from readPdf on sample satisfies span invariants', async () => {
    const pages = await readPdf(pdfFile('00_BF-00885.pdf'), '00_BF-00885.pdf')
    for (const page of pages) {
      for (const line of page.lines) {
        let prevEnd = -1
        for (const span of line.spans) {
          expect(span.start).toBeGreaterThanOrEqual(0)
          expect(span.start).toBeLessThan(span.end)
          expect(span.end).toBeLessThanOrEqual(line.text.length)
          expect(span.start).toBeGreaterThanOrEqual(prevEnd)
          expect(line.text.slice(span.start, span.end).trim()).not.toBe('')
          prevEnd = span.end
        }
      }
    }
  })
})

describe('R009 invoice_number acceptance', () => {
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
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'invoice_number')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
      expect(f.provenance?.page).toBe(1)
    })
  }
})

describe('R010 vendor acceptance', () => {
  const cases: Array<[string, string]> = [
    ['00_BF-00885.pdf', 'Bluefern Supplies Ltd'],
    ['07_AF-00496.pdf', 'Amberlake Facilities'],
    ['03_PH-2025-0214.pdf', 'Pinehollow Office Co'],
    ['04_CF-2025-511.pdf', 'Cedar & Finch Consulting'],
    ['19_319.pdf', 'Orrin Bakke Elektro AS'],
    ['11_805.pdf', 'SALTMARSH COFFEE ROASTERS'],
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'vendor')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
      expect(f.provenance?.page).toBe(1)
      expect(f.provenance?.bbox).not.toBeNull()
    })
  }
})

describe('R011 invoice_date acceptance', () => {
  const cases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2025-05-06'],
    ['12_WS-0316.pdf', '2025-06-03'],
    ['01_TIB-0000101.pdf', '2025-04-17'],
    ['03_PH-2025-0214.pdf', '2025-03-22'],
    ['11_805.pdf', '2025-01-28'],
    ['04_CF-2025-511.pdf', '2025-01-10'],
    ['07_AF-00496.pdf', '2025-07-23'],
    ['19_319.pdf', '2025-05-13'],
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> ${expected}`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'invoice_date')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
})

describe('R012 due_date acceptance', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2025-06-20'],
    ['01_TIB-0000101.pdf', '2025-05-01'],
    ['03_PH-2025-0214.pdf', '2025-04-21'],
    ['12_WS-0316.pdf', '2025-07-03'],
    ['07_AF-00496.pdf', '2025-08-06'],
    ['10_AF-00500.pdf', '2025-05-01'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'due_date')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
  const notFoundCases = ['04_CF-2025-511.pdf', '19_319.pdf', '11_805.pdf', '20_811.pdf']
  for (const file of notFoundCases) {
    it(`${file} -> not_found`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'due_date')!
      expect(f.state).toBe('not_found')
      expect(f.value).toBeNull()
      expect(f.provenance).toBeNull()
      expect(f.candidates).toBeNull()
    })
  }
})

describe('R013 currency acceptance', () => {
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
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'currency')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
  const uncertainCases = ['11_805.pdf', '20_811.pdf']
  for (const file of uncertainCases) {
    it(`${file} -> uncertain USD/AUD`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'currency')!
      expect(f.state).toBe('uncertain')
      expect(f.value).toBeNull()
      expect(f.candidates).toEqual(['USD', 'AUD'])
      expect(f.provenance).not.toBeNull()
    })
  }
})

describe('R014 subtotal acceptance', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '2072.63'],
    ['07_AF-00496.pdf', '7626.78'],
    ['03_PH-2025-0214.pdf', '1106.51'],
    ['11_805.pdf', '104.87'],
    ['01_TIB-0000101.pdf', '1733.82'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'subtotal')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
  const notFoundCases = ['04_CF-2025-511.pdf', '19_319.pdf']
  for (const file of notFoundCases) {
    it(`${file} -> not_found`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'subtotal')!
      expect(f.state).toBe('not_found')
      expect(f.value).toBeNull()
      expect(f.provenance).toBeNull()
    })
  }
})

describe('R015 tax acceptance', () => {
  const readCases: Array<[string, string]> = [
    ['00_BF-00885.pdf', '414.53'],
    ['07_AF-00496.pdf', '762.68'],
    ['11_805.pdf', '9.31'],
    ['03_PH-2025-0214.pdf', '210.24'],
    ['19_319.pdf', '1070.73'],
    ['01_TIB-0000101.pdf', '0.00'],
  ]
  for (const [file, expected] of readCases) {
    it(`${file} -> read ${expected}`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'tax')!
      expect(f.state).toBe('read')
      expect(f.value).toBe(expected)
    })
  }
  const notFoundCases = ['04_CF-2025-511.pdf', '17_CF-2025-513.pdf']
  for (const file of notFoundCases) {
    it(`${file} -> not_found`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const f = fields.find((x) => x.name === 'tax')!
      expect(f.state).toBe('not_found')
      expect(f.value).toBeNull()
      expect(f.provenance).toBeNull()
      expect(f.candidates).toBeNull()
    })
  }
})

describe('R016 total acceptance', () => {
  const cases: Array<[string, string]> = [
    ['03_PH-2025-0214.pdf', '1316.75'],
    ['01_TIB-0000101.pdf', '1733.82'],
    ['07_AF-00496.pdf', '8389.46'],
    ['00_BF-00885.pdf', '2487.16'],
    ['04_CF-2025-511.pdf', '3820.96'],
    ['19_319.pdf', '5353.66'],
    ['11_805.pdf', '114.18'],
  ]
  for (const [file, expected] of cases) {
    it(`${file} -> read ${expected}, not equal subtotal`, async () => {
      const pages = await readPdf(pdfFile(file), file)
      const fields = extractHeaderFields(pages, 'text')
      const total = fields.find((x) => x.name === 'total')!
      const subtotal = fields.find((x) => x.name === 'subtotal')!
      expect(total.state).toBe('read')
      expect(total.value).toBe(expected)
      // NOTE: R016's summary clause "none equals its document's subtotal" is
      // false for 01_TIB-0000101.pdf: R014 requires subtotal='1733.82' and
      // R016 itself requires total='1733.82' for the same file (tax=0.00 per
      // R015, so total legitimately equals subtotal). This is a spec
      // self-contradiction, not tested here; see tester notes.
      if (subtotal.value !== null && file !== '01_TIB-0000101.pdf') expect(total.value).not.toBe(subtotal.value)
    })
  }
})

describe('R017 provenance boxes per-value on 00_BF-00885.pdf', () => {
  it('matches independently measured coordinates within tolerance', async () => {
    const pages = await readPdf(pdfFile('00_BF-00885.pdf'), '00_BF-00885.pdf')
    const fields = extractHeaderFields(pages, 'text')
    const invNum = fields.find((x) => x.name === 'invoice_number')!
    expect(invNum.provenance!.page).toBe(1)
    const b1 = invNum.provenance!.bbox
    expect(Math.abs(b1.x - 498.2)).toBeLessThanOrEqual(6)
    expect(Math.abs(b1.x + b1.width - 544.88)).toBeLessThanOrEqual(6)
    expect(Math.abs(b1.y - 84.91)).toBeLessThanOrEqual(6)
    expect(Math.abs(b1.y + b1.height - 95.41)).toBeLessThanOrEqual(6)

    const subtotal = fields.find((x) => x.name === 'subtotal')!
    const b2 = subtotal.provenance!.bbox
    expect(Math.abs(b2.x - 505.52)).toBeLessThanOrEqual(6)
    expect(Math.abs(b2.x + b2.width - 546.39)).toBeLessThanOrEqual(6)
    expect(Math.abs(b2.y - 310.66)).toBeLessThanOrEqual(6)
    expect(Math.abs(b2.y + b2.height - 321.16)).toBeLessThanOrEqual(6)

    const tax = fields.find((x) => x.name === 'tax')!
    const b3 = tax.provenance!.bbox
    expect(Math.abs(b3.x - 514.28)).toBeLessThanOrEqual(6)
    expect(Math.abs(b3.x + b3.width - 546.39)).toBeLessThanOrEqual(6)

    const total = fields.find((x) => x.name === 'total')!
    const b4 = total.provenance!.bbox
    expect(b4.x).toBeGreaterThanOrEqual(493)
    expect(b4.x).toBeLessThanOrEqual(505)
    expect(Math.abs(b4.x + b4.width - 546.38)).toBeLessThanOrEqual(6)
    expect(b4.width).toBeLessThan(60)
  })
})

describe('R018/R019/R020 pipeline', () => {
  it('readDocument text-path basic props + fingerprint', async () => {
    const buf = pdfBuffer('00_BF-00885.pdf')
    const file = new File([buf], '00_BF-00885.pdf')
    const doc = await readDocument(file)
    expect(doc.fileName).toBe('00_BF-00885.pdf')
    expect(doc.pageCount).toBe(1)
    expect(doc.source).toBe('text')
    expect(doc.fields.length).toBe(8)
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const expectedHash = createHash('sha256').update(buf).digest('hex')
    expect(doc.fingerprint).toBe(expectedHash)
  })

  it('no actual Promise.all(...) CALL in pipeline.ts (the comment mentioning it does not count)', () => {
    const src = readFileSync(new URL('../src/ui/pipeline.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/Promise\.all\(/)
  })

  // Under Vitest's node environment there is no `document`, so the OCR
  // engine cannot start and readDocument takes its engine-failure path:
  // eight `uncertain` fields with no value and no box, never `not_found`.
  // The real OCR path (Task 1c) is verified in the browser against the
  // five scanned samples, not here.
  const scanFiles = ['06_NW-213.pdf', '13_PH-2025-0215.pdf', '15_808.pdf', '18_809.pdf', '23_AF-00503.pdf']
  for (const file of scanFiles) {
    it(`${file} -> ocr path; with no engine available, all uncertain`, async () => {
      const buf = pdfBuffer(file)
      const f = new File([buf], file)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const doc = await readDocument(f)
      warn.mockRestore()
      expect(doc.source).toBe('ocr')
      expect(doc.pageCount).toBe(1)
      expect(doc.fields.length).toBe(8)
      for (const field of doc.fields) {
        expect(field.state).toBe('uncertain')
        expect(field.value).toBeNull()
        expect(field.provenance).toBeNull()
        expect(field.candidates).toEqual([])
        expect(field.source).toBe('ocr')
      }
    })
  }

  it('a document with no text layer is sent through ocrPdfPages (Task 1c), not left unread', () => {
    const src = readFileSync(new URL('../src/ui/pipeline.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/ocrPdfPages\(/)
  })
})

describe('R007 resolveField clauses (independent of fields.ts internal tests)', () => {
  function cand(value: string, rank: number, bbox: any = { x: 0, y: 0, width: 1, height: 1 }, confidence: number | null = null, page = 1): Candidate {
    return { value, raw: value, page, bbox, confidence, patternRank: rank }
  }
  it('empty -> not_found', () => {
    const f = resolveField('x', [], 'text')
    expect(f).toMatchObject({ state: 'not_found', value: null, provenance: null, candidates: null })
  })
  it('two rank-0 different values -> uncertain', () => {
    const f = resolveField('x', [cand('A', 0), cand('B', 0)], 'text')
    expect(f.state).toBe('uncertain')
    expect(f.value).toBeNull()
    expect(f.candidates).toEqual(['A', 'B'])
  })
  it('rank0 A + rank2 B -> read A, candidates null', () => {
    const f = resolveField('x', [cand('A', 0), cand('B', 2)], 'text')
    expect(f.state).toBe('read')
    expect(f.value).toBe('A')
    expect(f.candidates).toBeNull()
  })
  it('two rank0 same value -> read', () => {
    const f = resolveField('x', [cand('A', 0), cand('A', 0)], 'text')
    expect(f.state).toBe('read')
    expect(f.value).toBe('A')
  })
  it('single rank0 bbox null -> uncertain', () => {
    const f = resolveField('x', [cand('A', 0, null)], 'text')
    expect(f.state).toBe('uncertain')
    expect(f.value).toBeNull()
    expect(f.candidates).toEqual(['A'])
    expect(f.provenance).toBeNull()
  })
  it('ocr confidence 55 -> uncertain', () => {
    const f = resolveField('x', [cand('A', 0, { x: 0, y: 0, width: 1, height: 1 }, 55)], 'ocr')
    expect(f.state).toBe('uncertain')
    expect(f.candidates).toEqual(['A'])
    expect(f.confidence).toBe(55)
  })
  it('ocr confidence 85 -> read', () => {
    const f = resolveField('x', [cand('A', 0, { x: 0, y: 0, width: 1, height: 1 }, 85)], 'ocr')
    expect(f.state).toBe('read')
  })
  it('OCR_CONFIDENCE_FLOOR is 70', () => {
    expect(OCR_CONFIDENCE_FLOOR).toBe(70)
  })
})

describe('R006 empty-pages and edge attacks', () => {
  it('extractHeaderFields([], "text") -> 8 not_found fields', () => {
    const fields = extractHeaderFields([], 'text')
    expect(fields.map((f) => f.name)).toEqual([
      'invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total',
    ])
    for (const f of fields) {
      expect(f.state).toBe('not_found')
      expect(f.value).toBeNull()
      expect(f.provenance).toBeNull()
      expect(f.candidates).toBeNull()
      expect(f.confidence).toBeNull()
      expect(f.source).toBe('text')
    }
  })
})

describe('R007 provenance-in-uncertain-group edge: skips null bboxes to find first non-null', () => {
  function cand(value: string, rank: number, bbox: any, page = 1): Candidate {
    return { value, raw: value, page, bbox, confidence: null, patternRank: rank }
  }
  it('3-way disagreeing group, first has null bbox, provenance comes from 2nd (first non-null) in collection order', () => {
    const candidates = [
      cand('A', 0, null, 1),
      cand('B', 0, { x: 9, y: 9, width: 1, height: 1 }, 2),
      cand('C', 0, { x: 5, y: 5, width: 1, height: 1 }, 3),
    ]
    const f = resolveField('x', candidates, 'text')
    expect(f.state).toBe('uncertain')
    expect(f.candidates).toEqual(['A', 'B', 'C'])
    expect(f.provenance).toEqual({ page: 2, bbox: { x: 9, y: 9, width: 1, height: 1 } })
  })
  it('all-null-bbox disagreeing group -> provenance null', () => {
    const candidates = [cand('A', 0, null, 1), cand('B', 0, null, 1)]
    const f = resolveField('x', candidates, 'text')
    expect(f.state).toBe('uncertain')
    expect(f.provenance).toBeNull()
  })
})

describe('R003 boxFor robustness on malformed ranges', () => {
  const items = [
    { str: 'Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
    { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
  ]
  it('reversed range (start > end) does not throw, returns null', () => {
    const L = assembleLines(items as any)[0]
    expect(() => boxForDomain(L, 8, 2)).not.toThrow()
    expect(boxForDomain(L, 8, 2)).toBeNull()
  })
  it('start beyond text length does not throw, returns null', () => {
    const L = assembleLines(items as any)[0]
    expect(() => boxForDomain(L, 1000, 2000)).not.toThrow()
    expect(boxForDomain(L, 1000, 2000)).toBeNull()
  })
  it('negative start clipped to 0', () => {
    const L = assembleLines(items as any)[0]
    expect(boxForDomain(L, -5, 5)).toEqual({ x: 300, y: 700, width: 10, height: 10 })
  })
})

describe('R012 suppressOverlap: different pages must NOT suppress even if bboxes numerically overlap', () => {
  it('due_date on a different page than invoice_date is never suppressed by the overlap guard', async () => {
    const mkLine = (text: string, y: number) => ({
      text, bbox: { x: 0, y, width: 500, height: 12 }, items: [],
      spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: 500, height: 12 } }],
    })
    const page1 = { page: 1, width: 600, height: 800, items: [], lines: [mkLine('Invoice date: 01/02/2025', 50)] }
    // Unambiguous (day 25 > 12), so the value resolves regardless of any
    // orientation evidence: this test is about the overlap guard, not dates.
    const page2 = { page: 2, width: 600, height: 800, items: [], lines: [mkLine('Due 25/06/2025', 50)] }
    const fields = extractHeaderFields([page1 as any, page2 as any], 'text')
    const due = fields.find((f) => f.name === 'due_date')!
    // due_date is on page 2, invoice_date on page 1 -> different pages -> NOT suppressed
    expect(due.state).toBe('read')
    expect(due.value).toBe('2025-06-25')
  })
})

describe('R008 page scan order', () => {
  it('non-total field stops at first page with a candidate; total scans all pages', async () => {
    // Build synthetic PdfPage[] mimicking two pages
    const mkLine = (text: string, y: number) => ({
      text,
      bbox: { x: 0, y, width: 500, height: 12 },
      items: [],
      spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: 500, height: 12 } }],
    })
    const page1 = {
      page: 1, width: 600, height: 800,
      items: [],
      lines: [mkLine('Invoice no. AB-1', 10), mkLine('Total 10.00', 30)],
    }
    const page2 = {
      page: 2, width: 600, height: 800,
      items: [],
      lines: [mkLine('Invoice no. CD-2', 10), mkLine('Total 99.00', 30)],
    }
    const fields = extractHeaderFields([page1 as any, page2 as any], 'text')
    const num = fields.find((f) => f.name === 'invoice_number')!
    expect(num.state).toBe('read')
    expect(num.value).toBe('AB-1')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('uncertain')
    expect(total.candidates).toEqual(['10.00', '99.00'])
  })
})
