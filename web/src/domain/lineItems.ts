/**
 * Line items, one Field per cell, plus the totals cross-check.
 *
 * Two families of layout, read from the six sample_gen templates:
 *
 * 1. Header-driven (uk_service, us_letter, grid_einvoice, statement). A
 *    header line names the columns; its cells' x positions become x-bands
 *    (band i runs from header cell i to header cell i+1), and every line
 *    below it is a row until a totals label or a line with no money in the
 *    amount band. Bands, not header boxes, because numeric cells are
 *    right-aligned under a left-aligned header: on uk_service "QTY" prints
 *    at x 303-321 and the quantity beneath it at 339-345, no overlap.
 *
 * 2. Header-less (minimal_freelancer, thermal_receipt). No header exists, so
 *    rows are found by walking UP from the first SUBTOTAL/TOTAL label and
 *    taking every contiguous line that reads as `qty desc amount` (thermal)
 *    or `desc [xN] amount` (minimal). The thermal shape is tried first, so a
 *    minimal row whose description starts with a number would be read as a
 *    quantity; the templates never print one, and the row would still flag
 *    on the totals cross-check if the amounts did not tie.
 *
 * Every cell is its own Field, named `line_item[i].<column>` (i is 0-based),
 * so coverage counts it: the denominator grows by four per row and still has
 * to tie. A column the layout does not print (unit price on a receipt) is
 * `not_found`, which is exactly what that state means. A quantity the
 * minimal template leaves implicit (it prints `xN` only when N != 1) is read
 * as "1" with the row's description box as its evidence: the absence of a
 * multiplier on that line is what says so.
 */

import { MONEY, parseAmount } from './fields'
import { boxFor } from './spans'
import type { BBox, Field, FieldSource, Line, PdfPage } from './types'

export const LINE_ITEM_FIELDS = ['description', 'qty', 'unit_price', 'amount'] as const
export type LineItemField = (typeof LINE_ITEM_FIELDS)[number]

export const LINE_SUM_MISMATCH = 'line_sum_mismatch'
export const LINE_SUM_UNCHECKED = 'line_sum_unchecked'

/** `line_item[3].amount` -> { index: 3, column: 'amount' }; null for any other name. */
export function parseLineItemName(name: string): { index: number; column: LineItemField } | null {
  const m = /^line_item\[(\d+)\]\.(description|qty|unit_price|amount)$/.exec(name)
  return m ? { index: Number(m[1]), column: m[2] as LineItemField } : null
}

// --- header-driven layouts ------------------------------------------------

type Role = LineItemField | 'ignore'

/**
 * Header labels as whitespace-delimited tokens (not `\b`: "#" and "Disc."
 * have no word boundary). Longer labels come first inside the alternation
 * so "Tax amount" is never read as the amount column and "Unit price" never
 * as the unit column. Ignored columns still have to be named: an unnamed
 * column would be absorbed into the band to its left ("1 pc" as a quantity).
 */
const HEADER_LABEL = /(?<!\S)(line\s+total|tax\s+amount|unit\s+price|hours\/units|description|quantity|service|amount|rate|qty|unit|item|date|site|disc\.?|tax\s*%|#)(?!\S)/dgi

function roleOf(label: string): Role {
  const l = label.toLowerCase().replace(/\s+/g, ' ')
  if (l === 'description' || l === 'service') return 'description'
  if (l === 'qty' || l === 'quantity' || l === 'hours/units') return 'qty'
  if (l === 'unit price' || l === 'rate') return 'unit_price'
  if (l === 'amount' || l === 'line total') return 'amount'
  return 'ignore'
}

type Band = { role: Role; x0: number; x1: number }

/** The header's bands, or null when the line is not a header (needs one
 * description and one amount column, and no role named twice). */
function bandsOf(line: Line): Band[] | null {
  const cells: Array<{ role: Role; x: number }> = []
  for (const m of line.text.matchAll(HEADER_LABEL)) {
    const [s, e] = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]
    const box = boxFor(line, s, e)
    if (box) cells.push({ role: roleOf(m[1]), x: box.x })
  }
  const roles = cells.map((c) => c.role).filter((r) => r !== 'ignore')
  if (!roles.includes('description') || !roles.includes('amount')) return null
  if (new Set(roles).size !== roles.length) return null
  // Every token on the line must be a known label: a prose line that happens
  // to contain "description" and "amount" is not a header.
  const tokens = line.text.trim().split(/\s+/).length
  const labelTokens = [...line.text.matchAll(HEADER_LABEL)].reduce((n, m) => n + m[1].trim().split(/\s+/).length, 0)
  if (tokens !== labelTokens) return null
  cells.sort((a, b) => a.x - b.x)
  return cells.map((c, i) => ({ role: c.role, x0: c.x, x1: i + 1 < cells.length ? cells[i + 1].x : Infinity }))
}

/** A row's text and box per band, from the spans whose centre falls in it. */
function cellsOf(line: Line, bands: Band[]): Map<Role, { text: string; start: number; end: number }> {
  const out = new Map<Role, { text: string; start: number; end: number }>()
  for (const span of line.spans) {
    const cx = span.bbox.x + span.bbox.width / 2
    // 2pt of slack on the left edge: a right-aligned number never starts
    // before its header, but glyph boxes are not pixel-exact.
    const band = bands.filter((b) => cx >= b.x0 - 2 && cx < b.x1).at(-1)
    if (!band || band.role === 'ignore') continue
    const cur = out.get(band.role)
    if (cur) cur.end = span.end
    else out.set(band.role, { text: '', start: span.start, end: span.end })
  }
  for (const c of out.values()) c.text = line.text.slice(c.start, c.end).trim()
  return out
}

/** Labels that end the item rows. Anchored at the line start. */
const TOTALS_STOP = /^\s*(?:sub\s*-?\s*total|goods\s*\/\s*services\s*total|total|balance\s*due|amount\s*(?:due|in\s*words)|discount|tax\s*base|vat|gst|mwst|mva|tva|kdv|sales\s*tax|tax)\b/i
const MONEY_CELL = new RegExp(String.raw`^` + MONEY + String.raw`$`)
const QTY_CELL = /^\d+(?:[.,]\d+)?$/

type Cell = { value: string | null; state: Field['state']; bbox: BBox | null; candidates: string[] | null }

const notFound: Cell = { value: null, state: 'not_found', bbox: null, candidates: null }

function moneyCell(line: Line, c: { text: string; start: number; end: number } | undefined): Cell {
  if (!c || c.text === '') return notFound
  const m = MONEY_CELL.exec(c.text)
  const amount = m ? parseAmount(m[1]) : null
  const bbox = boxFor(line, c.start, c.end)
  if (amount === null || !bbox) return { value: null, state: 'uncertain', bbox, candidates: [c.text] }
  return { value: amount.toFixed(2), state: 'read', bbox, candidates: null }
}

function qtyCell(line: Line, c: { text: string; start: number; end: number } | undefined): Cell {
  if (!c || c.text === '') return notFound
  const bbox = boxFor(line, c.start, c.end)
  if (!QTY_CELL.test(c.text) || !bbox) return { value: null, state: 'uncertain', bbox, candidates: [c.text] }
  return { value: c.text, state: 'read', bbox, candidates: null }
}

function textCell(line: Line, c: { text: string; start: number; end: number } | undefined): Cell {
  if (!c || c.text === '') return notFound
  const bbox = boxFor(line, c.start, c.end)
  if (!bbox) return { value: null, state: 'uncertain', bbox: null, candidates: [c.text] }
  return { value: c.text, state: 'read', bbox, candidates: null }
}

type Row = Record<LineItemField, Cell>

function headerRows(page: PdfPage): Row[] | null {
  const lines = [...page.lines].sort((a, b) => a.bbox.y - b.bbox.y)
  for (let h = 0; h < lines.length; h++) {
    const bands = bandsOf(lines[h])
    if (!bands) continue
    const rows: Row[] = []
    for (const line of lines.slice(h + 1)) {
      if (TOTALS_STOP.test(line.text)) break
      const cells = cellsOf(line, bands)
      const amount = moneyCell(line, cells.get('amount'))
      if (amount.state !== 'read') break
      rows.push({
        description: textCell(line, cells.get('description')),
        qty: qtyCell(line, cells.get('qty')),
        unit_price: moneyCell(line, cells.get('unit_price')),
        amount,
      })
    }
    return rows
  }
  return null
}

// --- header-less layouts --------------------------------------------------

const THERMAL_ROW = new RegExp(String.raw`^(\d+)\s+(\S.*?\S)\s+` + MONEY + String.raw`$`, 'd')
const MINIMAL_ROW = new RegExp(String.raw`^(\S.*?\S)(?:\s+x(\d+))?\s+` + MONEY + String.raw`$`, 'd')
/** The first totals line; the item block sits directly above it. A subtotal
 * label counts wherever it sits on the line: on the scanned 13_PH-2025-0215
 * OCR glues "Goods/services total 889,86 EUR" onto the end of the "Amount
 * in words" line, and anchoring on "Total payable" further down made the
 * "Notes:" line between them a row. */
const HEADERLESS_ANCHOR = /^\s*(?:sub\s*-?\s*total|total)\b|\bsub\s*-?\s*total\b|goods\s*\/\s*services\s*total/i

type Indexed = RegExpExecArray & { indices: Array<[number, number] | undefined> }

function headerlessRow(line: Line): Row | null {
  const t = THERMAL_ROW.exec(line.text) as Indexed | null
  if (t) {
    const [qs, qe] = t.indices[1]!
    const [ds, de] = t.indices[2]!
    const [as_, ae] = t.indices[3]!
    return {
      description: textCell(line, { text: t[2], start: ds, end: de }),
      qty: qtyCell(line, { text: t[1], start: qs, end: qe }),
      unit_price: notFound,
      amount: moneyCell(line, { text: line.text.slice(as_, ae), start: as_, end: ae }),
    }
  }
  const m = MINIMAL_ROW.exec(line.text) as Indexed | null
  if (!m || !/[A-Za-z]/.test(m[1])) return null
  const [ds, de] = m.indices[1]!
  const [as_, ae] = m.indices[3]!
  const description = textCell(line, { text: m[1], start: ds, end: de })
  let qty: Cell
  if (m.indices[2]) {
    const [qs, qe] = m.indices[2]
    qty = qtyCell(line, { text: m[2], start: qs, end: qe })
  } else {
    // No multiplier printed: the template's convention for a quantity of 1.
    qty = { value: '1', state: description.bbox ? 'read' : 'uncertain', bbox: description.bbox, candidates: description.bbox ? null : ['1'] }
  }
  return { description, qty, unit_price: notFound, amount: moneyCell(line, { text: line.text.slice(as_, ae), start: as_, end: ae }) }
}

function headerlessRows(page: PdfPage): Row[] {
  const lines = [...page.lines].sort((a, b) => a.bbox.y - b.bbox.y)
  const anchor = lines.findIndex((l) => HEADERLESS_ANCHOR.test(l.text))
  if (anchor < 0) return []
  const rows: Row[] = []
  for (let i = anchor - 1; i >= 0; i--) {
    // A tax line between the items and the total (minimal_freelancer prints
    // "MVA 25% 1070.73" there) belongs to the totals block: skipped while no
    // row has been found yet, and the end of the block once one has.
    if (TOTALS_STOP.test(lines[i].text)) {
      if (rows.length === 0) continue
      break
    }
    const row = headerlessRow(lines[i])
    if (!row || row.amount.state !== 'read') break
    rows.unshift(row)
  }
  return rows
}

// --- public -----------------------------------------------------------------

/** Every line-item cell of the document as Fields, in row-then-column order. */
export function extractLineItems(pages: PdfPage[], source: FieldSource): Field[] {
  const fields: Field[] = []
  let index = 0
  let sawHeader = false
  const emit = (page: number, rows: Row[]) => {
    for (const row of rows) {
      for (const column of LINE_ITEM_FIELDS) {
        const c = row[column]
        fields.push({
          name: `line_item[${index}].${column}`,
          value: c.value,
          state: c.state,
          source,
          provenance: c.bbox ? { page, bbox: c.bbox } : null,
          confidence: null,
          candidates: c.candidates,
        })
      }
      index++
    }
  }
  for (const page of pages) {
    const rows = headerRows(page)
    if (rows) {
      sawHeader = true
      emit(page.page, rows)
    }
  }
  if (!sawHeader) {
    for (const page of pages) emit(page.page, headerlessRows(page))
  }
  return fields
}

/**
 * The totals cross-check. Reference is the read subtotal; a layout without
 * a subtotal line (minimal_freelancer) falls back to the read total less the
 * read tax, or the total alone when no tax line is read. `line_sum_mismatch`
 * when the read amounts do not tie to it within 0.01; `line_sum_unchecked`
 * when there are rows but the check cannot run (an amount not read, or no
 * reference); nothing when there are no rows.
 */
export function lineSumFlags(fields: Field[]): string[] {
  const amounts = fields.filter((f) => parseLineItemName(f.name)?.column === 'amount')
  if (amounts.length === 0) return []
  const read = (name: string) => {
    const f = fields.find((x) => x.name === name)
    return f?.state === 'read' && f.value !== null ? Number(f.value) : null
  }
  const subtotal = read('subtotal')
  const total = read('total')
  const ref = subtotal ?? (total === null ? null : total - (read('tax') ?? 0))
  if (ref === null || amounts.some((a) => a.state !== 'read' || a.value === null)) return [LINE_SUM_UNCHECKED]
  const sum = amounts.reduce((s, a) => s + Number(a.value), 0)
  return Math.abs(sum - ref) < 0.01 + 1e-9 ? [] : [LINE_SUM_MISMATCH]
}
