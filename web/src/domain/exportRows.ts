/**
 * The export, as rows: one per field, every field, whatever its state. A
 * value that went to review appears as an empty value with its state, so
 * the sheet carries the same coverage the screen does; nothing is dropped
 * to make the export look cleaner.
 *
 * CSV gets the formula-injection guard on human-typed values (Musa's note
 * batch 2): a CSV has no cell types, so a typed value starting with `=`,
 * `+`, `-` or `@` is executed as a formula by the spreadsheet that opens
 * it. Extractor values are digits, dates and codes the patterns admitted,
 * so only the one column a person can type into is guarded. The .xlsx path
 * needs no guard: SheetJS writes typed string cells, and a cell is only a
 * formula in that format when it carries an explicit <f> element (verified
 * in ledger-reconciler by inspecting the emitted sheet XML).
 */

import type { Field } from './types'

export const EXPORT_HEADERS = ['file', 'field', 'value', 'state', 'source', 'page', 'x', 'y', 'width', 'height', 'candidates'] as const

export type ExportRow = (string | number | null)[]

export type ExportableDocument = { fileName: string; fields: Field[] }

export function exportRows(docs: ExportableDocument[]): ExportRow[] {
  const rows: ExportRow[] = []
  for (const d of docs) {
    for (const f of d.fields) {
      const b = f.provenance?.bbox
      rows.push([
        d.fileName,
        f.name,
        f.value,
        f.state,
        f.source,
        f.provenance?.page ?? null,
        b ? round(b.x) : null,
        b ? round(b.y) : null,
        b ? round(b.width) : null,
        b ? round(b.height) : null,
        f.candidates && f.candidates.length > 0 ? f.candidates.join(' | ') : null,
      ])
    }
  }
  return rows
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** A human-typed value that a spreadsheet would execute gets an apostrophe in front. */
export function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function csvCell(v: string | number | null): string {
  if (v === null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: ExportRow[]): string {
  const VALUE = EXPORT_HEADERS.indexOf('value')
  const SOURCE = EXPORT_HEADERS.indexOf('source')
  const lines = [EXPORT_HEADERS.join(',')]
  for (const r of rows) {
    const cells = r.map((v, i) => (i === VALUE && r[SOURCE] === 'human' && typeof v === 'string' ? guardFormula(v) : v))
    lines.push(cells.map(csvCell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
