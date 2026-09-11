/**
 * Word items -> lines. Pure: the text path (lib/pdf.ts, via lib/glyphs.ts)
 * and the OCR path (domain/ocrPages.ts) both hand their words here, so the
 * two sources produce the same Line shape and the extractor never knows
 * which one it is reading. Lifted from lib/pdf.ts unchanged when the OCR
 * path arrived; the rules are ledger-reconciler's.
 */

import type { BBox, Line, PositionedItem, Span } from './types'

/**
 * Groups fragments into lines by baseline, within a tolerance, and joins
 * each line left to right. A horizontal gap wider than kerning becomes a
 * space, so two columns on one baseline do not glue together. The line
 * also carries its union box.
 */
export function assembleLines(items: PositionedItem[]): Line[] {
  const TOLERANCE = 2 // points
  const GAP = 1 // points; wider than this is a real gap
  const groups: Array<{ y: number; items: PositionedItem[] }> = []

  for (const item of items) {
    if (item.str.trim() === '') continue
    const baseline = item.bbox.y + item.bbox.height
    const g = groups.find((l) => Math.abs(l.y - baseline) <= TOLERANCE)
    if (g) g.items.push(item)
    else groups.push({ y: baseline, items: [item] })
  }
  groups.sort((a, b) => a.y - b.y) // top-left origin: ascending y is top to bottom

  return groups.map(({ items: parts }) => {
    parts.sort((a, b) => a.bbox.x - b.bbox.x)
    let raw = ''
    let prevEnd: number | null = null
    // Spans are recorded against this UNTRIMMED joined string first, then
    // shifted once the final `.trim()` amount is known below. A gap space
    // inserted between items belongs to no span; an item's own bbox is kept
    // unchanged even when its text carries leading/trailing spaces (an
    // accepted approximation, since pdf.js gives one advance per item).
    const rawSpans: Array<{ start: number; end: number; bbox: BBox }> = []
    for (const p of parts) {
      if (prevEnd !== null && p.bbox.x - prevEnd > GAP && !raw.endsWith(' ') && !p.str.startsWith(' ')) {
        raw += ' '
      }
      const start = raw.length
      raw += p.str
      rawSpans.push({ start, end: raw.length, bbox: p.bbox })
      prevEnd = p.bbox.x + p.bbox.width
    }
    const text = raw.trim()
    const lead = raw.length - raw.trimStart().length
    const spans: Span[] = []
    for (const rs of rawSpans) {
      const start = Math.max(0, Math.min(text.length, rs.start - lead))
      const end = Math.max(0, Math.min(text.length, rs.end - lead))
      if (start >= end) continue // fully consumed by the leading/trailing trim
      spans.push({ start, end, bbox: rs.bbox })
    }
    return { text, bbox: union(parts.map((p) => p.bbox)), items: parts, spans }
  })
}

export function union(boxes: BBox[]): BBox {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
