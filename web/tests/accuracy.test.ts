/**
 * The accuracy harness: its honesty rules, each pinned on hand-made input,
 * then the real run over the 20 text-layer samples with the table written
 * to tests/out/accuracy.txt (gitignored; Vitest 4 swallows console output).
 *
 * The five scans are measured in the browser, where the OCR engine runs,
 * and recorded by hand in the README with the date (Musa's ruling 11.09:
 * a two-part table). Under Node they would all score as routed to review,
 * which measures the test environment, not the extractor.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { formatAccuracyTable, scoreRun, valuesMatch, type DocumentResult, type TruthFile } from '../src/domain/accuracy'
import { extractHeaderFields } from '../src/domain/fields'
import { extractLineItems } from '../src/domain/lineItems'
import type { Field } from '../src/domain/types'
import { readPdf } from '../src/lib/pdf'

const GT = new URL('./fixtures/ground-truth/', import.meta.url)
type Truth = TruthFile & { scanned: string }
const truths: Truth[] = readdirSync(GT)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, GT), 'utf8')) as Truth)

function field(name: string, state: Field['state'], value: string | null): Field {
  return { name, state, value, source: 'text', provenance: null, confidence: null, candidates: null }
}

/** A document whose every header field is `read` with the given values. */
function doc(file: string, values: Partial<Record<string, string | null>>, states: Partial<Record<string, Field['state']>> = {}): DocumentResult {
  const names = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total']
  return { file, fields: names.map((n) => field(n, states[n] ?? 'read', values[n] ?? null)) }
}

const T: TruthFile = {
  file: 'a.pdf',
  vendor: 'Bluefern Supplies Ltd',
  invoice_number: 'BF-00885',
  invoice_date: '2025-05-06',
  due_date: null,
  currency: 'GBP',
  subtotal: 2072.63,
  tax: 414.53,
  total: 2487.16,
  line_items: [],
}

const row = (rows: ReturnType<typeof scoreRun>, name: string) => rows.find((r) => r.field === name)!

describe('scoreRun honesty rules', () => {
  it('precision is null, printed as -, when a field reported nothing', () => {
    const rows = scoreRun([doc('a.pdf', {}, { total: 'not_found' })], [T])
    const total = row(rows, 'total')
    expect(total.reported).toBe(0)
    expect(total.precision).toBeNull()
    expect(total.recall).toBe(0)
    expect(formatAccuracyTable(rows)).toMatch(/total\s+1\s+0\s+0\s+0\s+1\s+-\s+0\.0%/)
  })

  it('a value reported where truth is null is a false positive: in reported, out of correct', () => {
    const rows = scoreRun([doc('a.pdf', { due_date: '2025-06-20' })], [T])
    const due = row(rows, 'due_date')
    expect(due.truthPresent).toBe(0)
    expect(due.reported).toBe(1)
    expect(due.falsePositive).toBe(1)
    expect(due.correct).toBe(0)
    expect(due.precision).toBe(0)
    expect(due.recall).toBeNull() // nothing to recall
  })

  it('routed-to-review is reported beside precision, never netted against it', () => {
    const rows = scoreRun(
      [doc('a.pdf', { total: '2487.16' }, { total: 'uncertain' }), doc('b.pdf', { total: '2487.16' })],
      [T, { ...T, file: 'b.pdf' }],
    )
    const total = row(rows, 'total')
    expect(total.routedToReview).toBe(1)
    expect(total.reported).toBe(1)
    expect(total.correct).toBe(1)
    expect(total.precision).toBe(1) // of what it reported
    expect(total.recall).toBe(0.5) // of what the pages print
  })

  it('a document missing from truth, or truth missing from the run, throws', () => {
    expect(() => scoreRun([doc('zzz.pdf', {})], [T])).toThrow(/No ground truth for zzz\.pdf/)
    expect(() => scoreRun([], [T])).toThrow(/No extraction for a\.pdf/)
    expect(() => scoreRun([doc('a.pdf', {}), doc('a.pdf', {})], [T])).toThrow(/twice/)
  })

  it('a not_found where truth is null is neither reported nor review: the page prints nothing', () => {
    const rows = scoreRun([doc('a.pdf', {}, { due_date: 'not_found' })], [T])
    const due = row(rows, 'due_date')
    expect(due).toMatchObject({ truthPresent: 0, reported: 0, correct: 0, falsePositive: 0, routedToReview: 0, precision: null, recall: null })
  })
})

describe('valuesMatch, per field type', () => {
  it('money to 2dp through parseAmount, either thousands convention', () => {
    expect(valuesMatch('total', '2,487.16', 2487.16)).toBe(true)
    expect(valuesMatch('total', '2.487,16', 2487.16)).toBe(true)
    expect(valuesMatch('total', '2487.17', 2487.16)).toBe(false)
  })
  it('invoice number: case, spaces and - / stripped, then exact', () => {
    expect(valuesMatch('invoice_number', 'bf 00885', 'BF-00885')).toBe(true)
    expect(valuesMatch('invoice_number', 'PH/2025/0214', 'PH-2025-0214')).toBe(true)
    expect(valuesMatch('invoice_number', 'BF-00886', 'BF-00885')).toBe(false)
  })
  it('vendor by similarity at the published threshold: a dropped trailing dot passes, a dropped word does not', () => {
    expect(valuesMatch('vendor', 'Nordway Logistics Inc', 'Nordway Logistics Inc.')).toBe(true) // 0.977
    expect(valuesMatch('vendor', 'Bluefern Supplies', 'Bluefern Supplies Ltd')).toBe(false) // 0.895
    expect(valuesMatch('vendor', 'Bluefin Supplies Ltd', 'Bluefern Supplies Ltd')).toBe(false)
  })
  it('dates and currency exact', () => {
    expect(valuesMatch('invoice_date', '2025-05-06', '2025-05-06')).toBe(true)
    expect(valuesMatch('invoice_date', '2025-06-05', '2025-05-06')).toBe(false)
    expect(valuesMatch('currency', 'GBP', 'GBP')).toBe(true)
  })
})

describe('the run: 20 text-layer samples against ground truth', () => {
  it('scores every text-layer document, writes the table, and Task 0 files exercise the false-positive rule', async () => {
    const textLayer = truths.filter((t) => t.scanned === '')
    expect(textLayer).toHaveLength(20)

    const extracted: DocumentResult[] = []
    for (const t of textLayer) {
      const pages = await readPdf(new Blob([readFileSync(new URL(`../public/sample/${t.file}`, import.meta.url))]), t.file)
      extracted.push({ file: t.file, fields: [...extractHeaderFields(pages, 'text'), ...extractLineItems(pages, 'text')] })
    }
    const rows = scoreRun(extracted, textLayer)
    const table = formatAccuracyTable(rows)

    const out = new URL('./out/', import.meta.url)
    mkdirSync(out, { recursive: true })
    writeFileSync(new URL('accuracy.txt', out), `${new Date().toISOString().slice(0, 10)}  20 text-layer documents\n\n${table}\n`)

    // Task 0: two documents print no tax line (truth null). Whatever the
    // extractor does there is measured, never skipped.
    const tax = row(rows, 'tax')
    expect(tax.truthPresent).toBe(18)
    for (const r of rows) {
      expect(r.correct).toBeLessThanOrEqual(r.reported)
      expect(r.correct + r.routedToReview).toBeLessThanOrEqual(r.truthPresent)
      if (r.reported === 0) expect(r.precision).toBeNull()
    }
  }, 120_000)
})
