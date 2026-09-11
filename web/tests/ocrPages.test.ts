/**
 * domain/ocrPages.ts and the confidence rule it feeds. Pure: tesseract's
 * tree is hand-written pixel data here; the real engine runs only in the
 * browser (verified through the preview on the five scanned samples).
 */

import { describe, expect, it } from 'vitest'

import { coverageOf } from '../src/domain/coverage'
import { extractHeaderFields, OCR_CONFIDENCE_FLOOR } from '../src/domain/fields'
import { wordsToPage, type OcrLine } from '../src/domain/ocrPages'

const SCALE = 300 / 72

/** One OCR line at pixel row `yPx`, words laid out left to right from `xPx`. */
function ocrLine(yPx: number, words: Array<[text: string, confidence: number]>, xPx = 300): OcrLine {
  let x = xPx
  const out: OcrLine['words'] = []
  for (const [text, confidence] of words) {
    const w = text.length * 25
    out.push({ text, confidence, bbox: { x0: x, y0: yPx + 4, x1: x + w, y1: yPx + 38 } })
    x += w + 30
  }
  return { bbox: { x0: xPx, y0: yPx, x1: x, y1: yPx + 42 }, words: out }
}

describe('wordsToPage', () => {
  it('divides every pixel coordinate by the render scale so boxes land in PDF points', () => {
    const page = wordsToPage([ocrLine(1000, [['Total', 95]])], 1, 2480, 3508, SCALE)
    expect(page.width).toBeCloseTo(2480 / SCALE, 6)
    expect(page.height).toBeCloseTo(3508 / SCALE, 6)
    const [item] = page.items
    expect(item.str).toBe('Total')
    expect(item.bbox.x).toBeCloseTo(300 / SCALE, 6)
    expect(item.bbox.width).toBeCloseTo(125 / SCALE, 6)
    // Line-height box, not the word's own tight glyph box.
    expect(item.bbox.y).toBeCloseTo(1000 / SCALE, 6)
    expect(item.bbox.height).toBeCloseTo(42 / SCALE, 6)
    expect(item.confidence).toBe(95)
  })

  it('joins the words of one line into one Line with a span per word', () => {
    const page = wordsToPage([ocrLine(1000, [['Total', 95], ['due', 90], ['£1,234.00', 88]])], 1, 2480, 3508, SCALE)
    expect(page.lines).toHaveLength(1)
    expect(page.lines[0].text).toBe('Total due £1,234.00')
    expect(page.lines[0].spans).toHaveLength(3)
  })

  it('drops empty words and keeps page numbering', () => {
    const page = wordsToPage([ocrLine(1000, [['', 0], ['Total', 95]])], 3, 2480, 3508, SCALE)
    expect(page.page).toBe(3)
    expect(page.items.map((i) => i.str)).toEqual(['Total'])
  })
})

describe('OCR confidence reaches the field as the minimum over its covering words', () => {
  const doc = (totalConfidence: number) =>
    wordsToPage(
      [
        ocrLine(200, [['Amberlake', 96], ['Facilities', 97]]),
        ocrLine(300, [['Invoice', 95], ['No', 94], ['AF-00496', 93]]),
        ocrLine(400, [['Invoice', 95], ['date', 96], ['14/03/2025', 91]]),
        ocrLine(1000, [['Total', 95], ['$460.00', totalConfidence]]),
      ],
      1,
      2480,
      3508,
      SCALE,
    )

  it('a confident total reads, with its confidence recorded', () => {
    const fields = extractHeaderFields([doc(92)], 'ocr')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('460.00')
    expect(total.confidence).toBe(92) // the worst word the total's box covers
    expect(total.provenance).not.toBeNull()
  })

  it(`a total whose amount word is below ${OCR_CONFIDENCE_FLOOR} routes to review, value kept as the candidate`, () => {
    const fields = extractHeaderFields([doc(OCR_CONFIDENCE_FLOOR - 1)], 'ocr')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('uncertain')
    expect(total.value).toBeNull()
    expect(total.candidates).toEqual(['460.00'])
    expect(total.confidence).toBe(OCR_CONFIDENCE_FLOOR - 1)
  })

  it('a junk word whose box only grazes the total line does not drag its confidence down', () => {
    // 23_AF-00503 in the browser: a table rule OCR'd as "ee", confidence 4,
    // 252pt wide and 7pt tall, touching the total line's box from above.
    const page = doc(92)
    const total = page.lines.find((l) => l.text.startsWith('Total'))!
    page.items.push({
      str: 'ee',
      confidence: 4,
      bbox: { x: total.bbox.x - 20, y: total.bbox.y - 5, width: 252, height: 7 },
    })
    const field = extractHeaderFields([page], 'ocr').find((f) => f.name === 'total')!
    expect(field.state).toBe('read')
    expect(field.confidence).toBe(92)
  })

  it('coverage still ties to 8 on an OCR document', () => {
    const c = coverageOf(extractHeaderFields([doc(50)], 'ocr'))
    expect(c.total).toBe(8)
    expect(c.read + c.corrected + c.uncertain + c.not_found).toBe(8)
  })

  it('the same document from a text layer (no confidences) never trips the floor', () => {
    const page = doc(10)
    for (const item of page.items) delete item.confidence
    const total = extractHeaderFields([page], 'text').find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.confidence).toBeNull()
  })
})
