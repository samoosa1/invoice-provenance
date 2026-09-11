/**
 * Domain types. Pure data, no DOM, no Date (dates are ISO strings).
 *
 * Coordinates: PDF points (1/72 in), origin at the page's TOP-LEFT, y grows
 * downward. pdf.js reports bottom-left origin; lib/pdf.ts converts once so
 * nothing downstream has to think about it and the canvas overlay maps 1:1.
 */

export type BBox = { x: number; y: number; width: number; height: number }

/** One word, boxed from the glyph advances the PDF itself positions it with (lib/glyphs.ts). */
export type PositionedItem = { str: string; bbox: BBox }

/**
 * One contributing item's character range within a Line's FINAL (trimmed)
 * text, half-open, in text order. `boxFor` subdivides a span by character
 * index so a value that sits inside a multi-word text run can still get its
 * own box instead of the whole run's.
 */
export type Span = { start: number; end: number; bbox: BBox }

/** Fragments sharing a baseline, joined left to right. */
export type Line = { text: string; bbox: BBox; items: PositionedItem[]; spans: Span[] }

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
