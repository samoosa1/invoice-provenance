/**
 * Per-field precision and recall of a run against the sample_gen ground
 * truth. Pure. This produces the number the portfolio entry travels on, so
 * the definitions are written down here and built not to flatter:
 *
 * - precision is null, never 1.0, when a field reported nothing;
 * - a value reported where the page prints nothing is a false positive,
 *   counted in `reported` and kept out of `correct`;
 * - what went to review is shown beside precision and recall, never netted
 *   against them: sending everything to review is not accuracy;
 * - every extracted document must have a truth record and vice versa, or
 *   the run throws rather than scoring a subset.
 *
 * Line items join the table per cell (description, qty, unit_price,
 * amount), truth row i against extracted row i.
 *
 * Only `read` fields count as reported. `uncertain` and `not_found` are
 * both "did not put a value in the output", which is what the review queue
 * exists for, so both land in routedToReview when the page prints a value.
 */

import { parseAmount } from './fields'
import { LINE_ITEM_FIELDS, parseLineItemName, type LineItemField } from './lineItems'
import { sequenceRatio } from './similarity'
import type { Field } from './types'

export type FieldAccuracy = {
  field: string
  truthPresent: number // documents where the layout prints it
  reported: number // state === 'read'
  correct: number // reported AND truth present AND values match
  falsePositive: number // reported but truth is null (claimed a value that is not on the page)
  routedToReview: number // uncertain + not_found, where truth is present
  precision: number | null // correct / reported; null when reported === 0, never 1.0
  recall: number | null // correct / truthPresent; null when truthPresent === 0
}

/** One document's extraction, keyed by the file the truth record names. */
export type DocumentResult = { file: string; fields: Field[] }

export type TruthLineItem = { description: string; qty: number; unit_price: number | null; amount: number }

/** A ground-truth JSON: the header fields plus the printed line items. */
export type TruthFile = {
  file: string
  vendor: string
  invoice_number: string
  invoice_date: string
  due_date: string | null
  currency: string
  subtotal: number | null
  tax: number | null
  total: number
  line_items: TruthLineItem[]
}

export const HEADER_FIELDS = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'] as const
type HeaderField = (typeof HEADER_FIELDS)[number]
export type ScoredField = HeaderField | LineItemField

/**
 * Vendor is judged by SequenceMatcher ratio at this threshold, quoted in the
 * README next to the table; every other field is exact. What it forgives is
 * punctuation `cleanVendor` legitimately drops: "Nordway Logistics Inc." vs
 * "Nordway Logistics Inc" is 0.977. What it does not forgive is a dropped
 * word: "Bluefern Supplies" vs "Bluefern Supplies Ltd" is 0.895, and a
 * vendor name missing its legal form is a different value on an invoice.
 */
export const VENDOR_MATCH_RATIO = 0.95

/** Whether a `read` value equals the truth, by the field's own comparison rule. */
export function valuesMatch(field: ScoredField, value: string, truth: string | number): boolean {
  switch (field) {
    case 'qty':
      return Number(value.replace(',', '.')) === Number(truth)
    case 'description':
      return value.trim() === String(truth).trim()
    case 'subtotal':
    case 'tax':
    case 'total':
    case 'unit_price':
    case 'amount': {
      const got = parseAmount(value)
      return got !== null && Math.round(got * 100) === Math.round(Number(truth) * 100)
    }
    case 'invoice_number':
      return normaliseNumber(value) === normaliseNumber(String(truth))
    case 'vendor':
      return sequenceRatio(value.toLowerCase(), String(truth).toLowerCase()) >= VENDOR_MATCH_RATIO
    case 'invoice_date':
    case 'due_date':
    case 'currency':
      return value === String(truth)
  }
}

function normaliseNumber(s: string): string {
  return s.toUpperCase().replace(/[\s\-/]/g, '')
}

export function scoreRun(extracted: DocumentResult[], truth: TruthFile[]): FieldAccuracy[] {
  const truthByFile = new Map(truth.map((t) => [t.file, t]))
  const extractedFiles = new Set(extracted.map((d) => d.file))
  for (const d of extracted) if (!truthByFile.has(d.file)) throw new Error(`No ground truth for ${d.file}`)
  for (const t of truth) if (!extractedFiles.has(t.file)) throw new Error(`No extraction for ${t.file}`)
  if (extractedFiles.size !== extracted.length) throw new Error('A document appears twice in the run')

  const header = HEADER_FIELDS.map((field) => {
    const row = emptyRow(field)
    for (const d of extracted) {
      const f = d.fields.find((x) => x.name === field)
      if (!f) throw new Error(`${d.file} has no ${field} field`)
      tally(row, field, f, truthByFile.get(d.file)![field])
    }
    return finish(row)
  })

  // Line items are scored per cell, rows paired by index: truth row i against
  // extracted row i. A truth row the extractor never produced counts as
  // routed to review (nothing was put in the output); an extracted row past
  // the end of the truth is a false positive per cell (a value claimed
  // where the page prints no row).
  const lineItems = LINE_ITEM_FIELDS.map((column) => {
    const row = emptyRow(column)
    for (const d of extracted) {
      const truthRows = truthByFile.get(d.file)!.line_items
      const byIndex = new Map<number, Field>()
      for (const f of d.fields) {
        const p = parseLineItemName(f.name)
        if (p && p.column === column) byIndex.set(p.index, f)
      }
      const n = Math.max(truthRows.length, byIndex.size === 0 ? 0 : Math.max(...byIndex.keys()) + 1)
      for (let i = 0; i < n; i++) {
        const expected = truthRows[i] ? truthRows[i][column] : null
        tally(row, column, byIndex.get(i), expected)
      }
    }
    return finish(row)
  })

  return [...header, ...lineItems]
}

function emptyRow(field: string): FieldAccuracy {
  return { field, truthPresent: 0, reported: 0, correct: 0, falsePositive: 0, routedToReview: 0, precision: null, recall: null }
}

/** One cell's contribution. `f` undefined means the extractor produced no field for it. */
function tally(row: FieldAccuracy, field: ScoredField, f: Field | undefined, expected: string | number | null): void {
  if (expected !== null) row.truthPresent++
  if (f?.state === 'read') {
    row.reported++
    if (expected === null) row.falsePositive++
    else if (f.value !== null && valuesMatch(field, f.value, expected)) row.correct++
  } else if (expected !== null) {
    row.routedToReview++
  }
}

function finish(row: FieldAccuracy): FieldAccuracy {
  row.precision = row.reported === 0 ? null : row.correct / row.reported
  row.recall = row.truthPresent === 0 ? null : row.correct / row.truthPresent
  return row
}

/** Plain text, for the test log and the README. `-` where a ratio is undefined. */
export function formatAccuracyTable(rows: FieldAccuracy[]): string {
  const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`)
  const head = ['field', 'truth', 'reported', 'correct', 'false+', 'review', 'precision', 'recall']
  const body = rows.map((r) => [
    r.field,
    String(r.truthPresent),
    String(r.reported),
    String(r.correct),
    String(r.falsePositive),
    String(r.routedToReview),
    pct(r.precision),
    pct(r.recall),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return [line(head), ...body.map(line)].join('\n')
}
