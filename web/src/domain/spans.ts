/**
 * Per-value provenance boxes. pdf.js reports one advance width per text
 * RUN, and a run on these Chromium-generated invoices routinely holds two
 * or more words, so pointing a matched value at its run's box (or, worse,
 * the whole line's box) is off by up to a run's width. `boxFor` subdivides
 * a span by character index instead, assuming a uniform per-character
 * advance inside the run, which is what turns a run-granularity box into a
 * word-granularity one (see tests/oracle.spans.test.ts for the measured
 * error this buys back).
 */

import type { BBox, Line } from './types'

function union(boxes: BBox[]): BBox {
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.width))
  const y1 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** Clips [start, end) to the text bounds, then trims whitespace off both edges. */
function trimRange(text: string, start: number, end: number): [number, number] {
  let s = Math.max(0, start)
  let e = Math.min(text.length, end)
  while (s < e && /\s/.test(text[s])) s++
  while (e > s && /\s/.test(text[e - 1])) e--
  return [s, e]
}

/**
 * The box for `line.text.slice(start, end)`: the union of every span that
 * intersects the (whitespace-trimmed) range, subdividing a span that is
 * only partially covered. A span covered in full is returned verbatim, no
 * interpolation. `null` when the trimmed range is empty or lands outside
 * every span (e.g. entirely inside an inter-item gap space).
 */
export function boxFor(line: Line, start: number, end: number): BBox | null {
  const [s, e] = trimRange(line.text, start, end)
  if (s >= e) return null

  const boxes: BBox[] = []
  for (const span of line.spans) {
    const os = Math.max(span.start, s)
    const oe = Math.min(span.end, e)
    if (os >= oe) continue
    if (os === span.start && oe === span.end) {
      boxes.push(span.bbox)
    } else {
      const perChar = span.bbox.width / (span.end - span.start)
      boxes.push({
        x: span.bbox.x + perChar * (os - span.start),
        y: span.bbox.y,
        width: perChar * (oe - os),
        height: span.bbox.height,
      })
    }
  }
  if (boxes.length === 0) return null
  return union(boxes)
}
