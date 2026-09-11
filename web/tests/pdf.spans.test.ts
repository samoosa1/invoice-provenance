import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { assembleLines, boxFor, readPdf } from '../src/lib/pdf'
import type { Line } from '../src/domain/types'

describe('assembleLines: spans', () => {
  it('records one span per item, offsets into the trimmed text, gap space unowned', () => {
    const [line] = assembleLines([
      { str: 'Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
    expect(line.text).toBe('Total 99.00')
    expect(line.spans).toEqual([
      { start: 0, end: 5, bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { start: 6, end: 11, bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
  })

  it('shifts spans by the leading whitespace the trim removes, and clips to text bounds', () => {
    const [line] = assembleLines([
      { str: '  Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
    expect(line.text).toBe('Total 99.00')
    expect(line.spans).toEqual([
      { start: 0, end: 5, bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { start: 6, end: 11, bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])
  })

  it('every line from a real sample PDF has sorted, non-overlapping, non-blank spans', async () => {
    const bytes = await readFile(new URL('../public/sample/00_BF-00885.pdf', import.meta.url))
    const pages = await readPdf(new Blob([bytes]), '00_BF-00885.pdf')
    for (const page of pages) {
      for (const line of page.lines) {
        let prevEnd = -1
        for (const span of line.spans) {
          expect(span.start).toBeGreaterThanOrEqual(0)
          expect(span.start).toBeLessThan(span.end)
          expect(span.end).toBeLessThanOrEqual(line.text.length)
          expect(span.start).toBeGreaterThanOrEqual(prevEnd) // sorted and non-overlapping
          expect(line.text.slice(span.start, span.end).trim()).not.toBe('')
          prevEnd = span.end
        }
      }
    }
  })
})

describe('boxFor', () => {
  function line(): Line {
    return assembleLines([
      { str: 'Total', bbox: { x: 300, y: 700, width: 10, height: 10 } },
      { str: '99.00', bbox: { x: 400, y: 700, width: 10, height: 10 } },
    ])[0]
  }

  it('returns a span box verbatim when fully covered, with no interpolation', () => {
    const L = line()
    expect(boxFor(L, 0, 5)).toEqual({ x: 300, y: 700, width: 10, height: 10 })
    expect(boxFor(L, 6, 11)).toEqual({ x: 400, y: 700, width: 10, height: 10 })
  })

  it('unions every intersecting span across the whole range', () => {
    const L = line()
    expect(boxFor(L, 0, 11)).toEqual({ x: 300, y: 700, width: 110, height: 10 })
    expect(boxFor(L, 0, 100)).toEqual({ x: 300, y: 700, width: 110, height: 10 }) // clipped to text length
  })

  it('subdivides a partially-covered span by character index', () => {
    const L = line()
    expect(boxFor(L, 2, 4)).toEqual({ x: 304, y: 700, width: 4, height: 10 })
    expect(boxFor(L, 4, 8)).toEqual({ x: 308, y: 700, width: 96, height: 10 })
  })

  it('trims whitespace off both edges of the requested range before locating spans', () => {
    const L = line()
    expect(boxFor(L, 0, 6)).toEqual({ x: 300, y: 700, width: 10, height: 10 }) // trailing gap space trimmed off
  })

  it('returns null for a range with no non-whitespace content, or that intersects no span', () => {
    const L = line()
    expect(boxFor(L, 5, 6)).toBeNull() // the gap space itself, owned by no span
    expect(boxFor(L, 3, 3)).toBeNull()
    expect(boxFor(L, 0, 0)).toBeNull()
  })
})
