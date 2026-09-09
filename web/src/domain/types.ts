/**
 * Domain types. Pure data, no DOM, no Date (dates are ISO strings).
 *
 * Coordinates: PDF points (1/72 in), origin at the page's TOP-LEFT, y grows
 * downward. pdf.js reports bottom-left origin; lib/pdf.ts converts once so
 * nothing downstream has to think about it and the canvas overlay maps 1:1.
 */

export type BBox = { x: number; y: number; width: number; height: number }

/** One text fragment as the PDF positions it. */
export type PositionedItem = { str: string; bbox: BBox }

/** Fragments sharing a baseline, joined left to right. */
export type Line = { text: string; bbox: BBox; items: PositionedItem[] }

export type PdfPage = {
  page: number // 1-based
  width: number
  height: number
  items: PositionedItem[]
  lines: Line[]
}

export type FieldState = 'read' | 'uncertain' | 'not_found'
export type FieldSource = 'text' | 'ocr' | 'human'

export type FieldName =
  | 'invoice_number'
  | 'vendor'
  | 'invoice_date'
  | 'due_date'
  | 'currency'
  | 'subtotal'
  | 'tax'
  | 'total'

/** Where a value came from. `null` when the field was not found. */
export type Provenance = { page: number; bbox: BBox } | null

export type Field = {
  name: string // FieldName or `line_item[i].description|qty|unit_price|amount`
  value: string | null
  state: FieldState
  source: FieldSource
  provenance: Provenance
  confidence: number | null
  candidates: string[] | null // what an `uncertain` field was torn between
}
