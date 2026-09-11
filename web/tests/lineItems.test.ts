/**
 * T7: line items and the totals cross-check. The 20 text-layer samples are
 * judged against sample_gen's ground truth (row counts, every cell, the two
 * planted line_sum_mismatch files and no others); the pure rules are pinned
 * on synthetic lines.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { scoreRun, valuesMatch, type DocumentResult, type TruthFile } from '../src/domain/accuracy'
import { coverageOf } from '../src/domain/coverage'
import { extractHeaderFields } from '../src/domain/fields'
import { extractLineItems, LINE_ITEM_FIELDS, LINE_SUM_MISMATCH, LINE_SUM_UNCHECKED, lineSumFlags, parseLineItemName } from '../src/domain/lineItems'
import type { Field, Line, PdfPage } from '../src/domain/types'
import { readPdf } from '../src/lib/pdf'

const GT = new URL('./fixtures/ground-truth/', import.meta.url)
type Truth = TruthFile & { scanned: string; template: string; planted: string[] }
const truths: Truth[] = readdirSync(GT)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, GT), 'utf8')) as Truth)
const textLayer = truths.filter((t) => t.scanned === '')

/** A line from [text, x0, x1] words on one baseline; spans are per word, like lib/glyphs.ts produces. */
function line(y: number, words: Array<[string, number, number]>): Line {
  let text = ''
  const spans = words.map(([w, x0, x1], i) => {
    if (i > 0) text += ' '
    const start = text.length
    text += w
    return { start, end: text.length, bbox: { x: x0, y, width: x1 - x0, height: 10 } }
  })
  const x0 = Math.min(...words.map((w) => w[1]))
  const x1 = Math.max(...words.map((w) => w[2]))
  return { text, bbox: { x: x0, y, width: x1 - x0, height: 10 }, items: [], spans }
}
function page(lines: Line[]): PdfPage {
  return { page: 1, width: 595, height: 842, items: [], lines }
}
function field(name: string, state: Field['state'], value: string | null): Field {
  return { name, state, value, source: 'text', provenance: null, confidence: null, candidates: null }
}
const rowsOf = (fields: Field[]) => fields.filter((f) => parseLineItemName(f.name)).length / 4

describe('the 20 text-layer samples against ground truth', () => {
  for (const t of textLayer) {
    it(`${t.file} (${t.template}): ${t.line_items.length} rows, every cell, flags ${JSON.stringify(t.planted)}`, async () => {
      const pages = await readPdf(new Blob([readFileSync(new URL(`../public/sample/${t.file}`, import.meta.url))]), t.file)
      const header = extractHeaderFields(pages, 'text')
      const items = extractLineItems(pages, 'text')
      expect(rowsOf(items)).toBe(t.line_items.length)

      t.line_items.forEach((truthRow, i) => {
        for (const column of LINE_ITEM_FIELDS) {
          const f = items.find((x) => x.name === `line_item[${i}].${column}`)!
          const expected = truthRow[column]
          if (expected === null) {
            // The layout prints no such column: that is what not_found means.
            expect(f.state, f.name).toBe('not_found')
            expect(f.provenance).toBeNull()
          } else {
            expect(f.state, `${f.name} = ${f.value}`).toBe('read')
            expect(valuesMatch(column, f.value!, expected), `${f.name}: ${f.value} vs ${expected}`).toBe(true)
            const p = pages.find((pg) => pg.page === f.provenance!.page)!
            const b = f.provenance!.bbox
            expect(b.width).toBeGreaterThan(0)
            expect(b.x + b.width).toBeLessThanOrEqual(p.width + 0.5)
            expect(b.y + b.height).toBeLessThanOrEqual(p.height + 0.5)
          }
        }
      })

      // Coverage denominator grows by four per row and still ties.
      const all = [...header, ...items]
      const c = coverageOf(all)
      expect(c.total).toBe(8 + 4 * t.line_items.length)

      // Exactly the planted documents flag. 18_809 is planted too but is a
      // scan, so it is only measurable in the browser.
      expect(lineSumFlags(all)).toEqual(t.planted.includes('line_sum_mismatch') ? [LINE_SUM_MISMATCH] : [])
    })
  }

  it('the two planted text-layer files are 00_BF-00885 and 02_BF-00887', () => {
    expect(textLayer.filter((t) => t.planted.includes('line_sum_mismatch')).map((t) => t.file)).toEqual(['00_BF-00885.pdf', '02_BF-00887.pdf'])
  })
})

describe('header-driven layouts (pure)', () => {
  const header = line(100, [['DESCRIPTION', 50, 111], ['QTY', 303, 321], ['UNIT', 354, 375], ['PRICE', 377, 405], ['AMOUNT', 465, 505]])
  const row1 = line(120, [['Label', 50, 76], ['tape', 78, 100], ['6', 339, 345], ['149.40', 424, 456], ['996.40', 514, 546]])
  const row2 = line(140, [['Paper', 50, 74], ['3', 339, 345], ['122.74', 424, 456], ['368.22', 514, 546]])
  const subtotal = line(160, [['Subtotal', 328, 366], ['1,364.62', 506, 546]])

  it('cells are assigned by x-band from the header, not by overlap with the header box (right-aligned numbers do not overlap "QTY")', () => {
    const fields = extractLineItems([page([header, row1, row2, subtotal])], 'text')
    expect(rowsOf(fields)).toBe(2)
    const by = (n: string) => fields.find((f) => f.name === n)!
    expect(by('line_item[0].description')).toMatchObject({ state: 'read', value: 'Label tape' })
    expect(by('line_item[0].qty')).toMatchObject({ state: 'read', value: '6' })
    expect(by('line_item[0].unit_price')).toMatchObject({ state: 'read', value: '149.40' })
    expect(by('line_item[0].amount')).toMatchObject({ state: 'read', value: '996.40' })
    // The qty box is the digit's own box, not the header's.
    expect(by('line_item[0].qty').provenance!.bbox.x).toBe(339)
    expect(by('line_item[1].description').provenance!.bbox).toMatchObject({ x: 50, width: 24 })
  })

  it('rows stop at a totals label and at a line with no money in the amount band (lines are taken in y order, whatever order they arrive in)', () => {
    const prose = line(130, [['Thank', 50, 80], ['you', 82, 100]])
    const earlySubtotal = line(130, [['Subtotal', 328, 366], ['996.40', 506, 546]])
    expect(rowsOf(extractLineItems([page([row2, header, row1, prose])], 'text'))).toBe(1)
    expect(rowsOf(extractLineItems([page([header, row1, earlySubtotal, row2])], 'text'))).toBe(1)
  })

  it('a header lacking a column leaves that cell not_found on every row (the page prints no such column)', () => {
    const h = line(100, [['Description', 50, 111], ['Amount', 465, 505]])
    const r = line(120, [['Consulting', 50, 111], ['500.00', 514, 546]])
    const fields = extractLineItems([page([h, r, subtotal])], 'text')
    expect(fields.find((f) => f.name === 'line_item[0].qty')).toMatchObject({ state: 'not_found', value: null, provenance: null })
    expect(fields.find((f) => f.name === 'line_item[0].unit_price')).toMatchObject({ state: 'not_found' })
  })

  it('"Tax amount" and "Unit" columns are named, so they are neither the amount column nor absorbed into a neighbour', () => {
    const h = line(100, [['#', 41, 46], ['Description', 58, 105], ['Qty', 221, 235], ['Unit', 252, 269], ['Unit', 290, 307], ['price', 309, 329], ['Tax', 439, 453], ['amount', 455, 486], ['Line', 512, 529], ['total', 532, 550]])
    const r = line(120, [['1', 41, 46], ['Bürostuhl', 58, 94], ['1', 234, 238], ['pc', 256, 265], ['391,55', 311, 337], ['74,39', 473, 495], ['391,55', 531, 557]])
    const fields = extractLineItems([page([h, r, subtotal])], 'text')
    const by = (n: string) => fields.find((f) => f.name === n)!
    expect(by('line_item[0].description').value).toBe('Bürostuhl')
    expect(by('line_item[0].qty').value).toBe('1')
    expect(by('line_item[0].unit_price').value).toBe('391.55')
    expect(by('line_item[0].amount').value).toBe('391.55')
  })

  it('a prose line that mentions description and amount is not a header', () => {
    const prose = line(100, [['Every', 50, 80], ['description', 82, 130], ['carries', 132, 160], ['an', 162, 170], ['amount', 172, 200]])
    // With no header and no totals anchor there is nothing to read; with the
    // real header in its place the same rows are found.
    expect(extractLineItems([page([prose, row1, row2])], 'text')).toEqual([])
    expect(rowsOf(extractLineItems([page([header, row1, row2])], 'text'))).toBe(2)
  })

  it('a non-numeric cell in a numeric column is uncertain with the text as its candidate, never read', () => {
    const r = line(120, [['Widget', 50, 80], ['n/a', 339, 350], ['149.40', 424, 456], ['996.40', 514, 546]])
    const fields = extractLineItems([page([header, r, subtotal])], 'text')
    expect(fields.find((f) => f.name === 'line_item[0].qty')).toMatchObject({ state: 'uncertain', value: null, candidates: ['n/a'] })
  })
})

describe('header-less layouts (pure)', () => {
  it('thermal: "qty desc amount" rows above SUBTOTAL, unit price not printed', () => {
    const lines = [
      line(46, [['Receipt', 14, 52], ['#805', 57, 79], ['01/28/25', 170, 213]]),
      line(57, [['Register', 14, 57], ['2', 63, 68], ['12:40', 186, 213]]),
      line(75, [['1', 14, 20], ['Single', 25, 57], ['origin', 63, 95], ['250g', 101, 122], ['6.91', 191, 213]]),
      line(86, [['4', 14, 20], ['Single', 25, 57], ['origin', 63, 95], ['250g', 101, 122], ['20.44', 186, 213]]),
      line(115, [['SUBTOTAL', 14, 57], ['27.35', 181, 213]]),
      line(126, [['TAX', 14, 30], ['8.875%', 36, 68], ['2.43', 191, 213]]),
      line(136, [['TOTAL', 14, 47], ['$29.78', 167, 213]]),
    ]
    const fields = extractLineItems([page(lines)], 'text')
    expect(rowsOf(fields)).toBe(2)
    const by = (n: string) => fields.find((f) => f.name === n)!
    expect(by('line_item[0].qty')).toMatchObject({ state: 'read', value: '1' })
    expect(by('line_item[0].qty').provenance!.bbox.x).toBe(14)
    expect(by('line_item[0].description').value).toBe('Single origin 250g')
    expect(by('line_item[0].unit_price').state).toBe('not_found')
    expect(by('line_item[1].amount')).toMatchObject({ state: 'read', value: '20.44' })
  })

  it('minimal: "desc [xN] amount" rows above TOTAL; an implicit quantity reads as 1 with the description box as its evidence; a tax line between is skipped', () => {
    const lines = [
      line(169, [['For', 62, 80], ['Harrowgate', 143, 203], ['Trading', 209, 251], ['Co.', 257, 275]]),
      line(203, [['Process', 62, 104], ['review', 110, 152], ['x4', 188, 200], ['1,199.16', 486, 534]]),
      line(215, [['Report', 62, 98], ['drafting', 104, 152], ['211.86', 498, 534]]),
      line(250, [['MVA', 62, 92], ['25%', 98, 116], ['352.76', 486, 534]]),
      line(270, [['TOTAL', 62, 92], ['USD', 98, 116], ['1,763.78', 486, 534]]),
    ]
    const fields = extractLineItems([page(lines)], 'text')
    expect(rowsOf(fields)).toBe(2)
    const by = (n: string) => fields.find((f) => f.name === n)!
    expect(by('line_item[0].description').value).toBe('Process review')
    expect(by('line_item[0].qty')).toMatchObject({ state: 'read', value: '4' })
    // The box is the digit's share of the "x4" word (boxFor subdivides the span), not the whole word.
    expect(by('line_item[0].qty').provenance!.bbox).toMatchObject({ x: 194, width: 6 })
    expect(by('line_item[1].qty')).toMatchObject({ state: 'read', value: '1' })
    expect(by('line_item[1].qty').provenance!.bbox).toEqual(by('line_item[1].description').provenance!.bbox)
    expect(by('line_item[1].amount').value).toBe('211.86')
    // The tax line is not a row.
    expect(fields.some((f) => f.value === 'MVA 25%')).toBe(false)
  })

  it('no anchor label, no rows', () => {
    expect(extractLineItems([page([line(10, [['Hello', 0, 30], ['12.00', 100, 130]])])], 'text')).toEqual([])
  })
})

describe('lineSumFlags', () => {
  const amounts = (...v: string[]) => v.map((x, i) => field(`line_item[${i}].amount`, 'read', x))
  it('ties within 0.01 to the read subtotal: no flag', () => {
    expect(lineSumFlags([field('subtotal', 'read', '30.00'), ...amounts('10.00', '20.00')])).toEqual([])
    expect(lineSumFlags([field('subtotal', 'read', '30.01'), ...amounts('10.00', '20.00')])).toEqual([])
  })
  it('does not tie: line_sum_mismatch', () => {
    expect(lineSumFlags([field('subtotal', 'read', '30.02'), ...amounts('10.00', '20.00')])).toEqual([LINE_SUM_MISMATCH])
  })
  it('no subtotal: total less tax is the reference; total alone when no tax is read', () => {
    expect(lineSumFlags([field('subtotal', 'not_found', null), field('tax', 'read', '5.00'), field('total', 'read', '35.00'), ...amounts('10.00', '20.00')])).toEqual([])
    expect(lineSumFlags([field('subtotal', 'not_found', null), field('tax', 'not_found', null), field('total', 'read', '30.00'), ...amounts('10.00', '20.00')])).toEqual([])
    expect(lineSumFlags([field('subtotal', 'not_found', null), field('tax', 'read', '5.00'), field('total', 'read', '30.00'), ...amounts('10.00', '20.00')])).toEqual([LINE_SUM_MISMATCH])
  })
  it('rows present but the check cannot run: line_sum_unchecked, never a silent pass', () => {
    expect(lineSumFlags([field('subtotal', 'uncertain', null), field('total', 'uncertain', null), ...amounts('10.00')])).toEqual([LINE_SUM_UNCHECKED])
    expect(lineSumFlags([field('subtotal', 'read', '10.00'), field('line_item[0].amount', 'uncertain', null)])).toEqual([LINE_SUM_UNCHECKED])
  })
  it('no rows: nothing to check, no flag', () => {
    expect(lineSumFlags([field('subtotal', 'read', '10.00')])).toEqual([])
  })
})

describe('line items in the accuracy table', () => {
  const T: TruthFile = {
    file: 'a.pdf', vendor: 'V', invoice_number: '1', invoice_date: '2025-01-01', due_date: null, currency: 'EUR', subtotal: 30, tax: null, total: 30,
    line_items: [
      { description: 'A', qty: 1, unit_price: null, amount: 10 },
      { description: 'B', qty: 2, unit_price: null, amount: 20 },
    ],
  }
  const headerFields = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'].map((n) => field(n, 'not_found', null))
  const cell = (i: number, column: string, state: Field['state'], value: string | null) => field(`line_item[${i}].${column}`, state, value)
  const doc = (fields: Field[]): DocumentResult => ({ file: 'a.pdf', fields: [...headerFields, ...fields] })
  const row = (rows: ReturnType<typeof scoreRun>, name: string) => rows.find((r) => r.field === name)!

  it('rows paired by index; a truth row the extractor never produced is routed to review', () => {
    const rows = scoreRun([doc([cell(0, 'description', 'read', 'A'), cell(0, 'qty', 'read', '1'), cell(0, 'unit_price', 'not_found', null), cell(0, 'amount', 'read', '10.00')])], [T])
    expect(row(rows, 'amount')).toMatchObject({ truthPresent: 2, reported: 1, correct: 1, falsePositive: 0, routedToReview: 1, precision: 1, recall: 0.5 })
    expect(row(rows, 'unit_price')).toMatchObject({ truthPresent: 0, reported: 0, falsePositive: 0, routedToReview: 0, precision: null, recall: null })
  })

  it('an extracted row past the end of the truth is a false positive per read cell', () => {
    const fields = [0, 1, 2].flatMap((i) => [cell(i, 'description', 'read', 'X'), cell(i, 'qty', 'read', '1'), cell(i, 'unit_price', 'not_found', null), cell(i, 'amount', 'read', '10.00')])
    const rows = scoreRun([doc(fields)], [T])
    expect(row(rows, 'amount')).toMatchObject({ truthPresent: 2, reported: 3, correct: 1, falsePositive: 1 })
    expect(row(rows, 'description')).toMatchObject({ reported: 3, correct: 0, falsePositive: 1 })
  })

  it('valuesMatch: qty numerically, description exact after trim, unit_price and amount as money', () => {
    expect(valuesMatch('qty', '12', 12)).toBe(true)
    expect(valuesMatch('qty', '2', 12)).toBe(false)
    expect(valuesMatch('description', 'Label printer tape, 6 rolls ', 'Label printer tape, 6 rolls')).toBe(true)
    expect(valuesMatch('description', 'Label printer tape', 'Label printer tape, 6 rolls')).toBe(false)
    expect(valuesMatch('unit_price', '1.199,16', 1199.16)).toBe(true)
    expect(valuesMatch('amount', '13.00', 13)).toBe(true)
  })
})
