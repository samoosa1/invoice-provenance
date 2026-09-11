/**
 * OCR output -> the same PdfPage shape the text layer produces, so
 * domain/fields.ts needs no OCR branch. Pure: tesseract's result is handed
 * in as plain data (lib/ocr.ts does the rendering and recognising).
 *
 * Word boxes arrive in image PIXELS at whatever scale the page was
 * rendered; dividing by that scale puts them in PDF points, the space every
 * text-layer box already lives in, so a box drawn from OCR lands on the
 * same pixels of the same page image as a box drawn from text.
 */

import { assembleLines } from './lines'
import type { PdfPage, PositionedItem } from './types'

/** The slice of tesseract's line/word tree this module reads; pixel coordinates. */
export type OcrLine = {
  bbox: { x0: number; y0: number; x1: number; y1: number }
  words: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }>
}

/**
 * `scale` is image pixels per PDF point (300/72 for a 300 dpi render);
 * `widthPx`/`heightPx` are the rendered image's dimensions.
 *
 * A word takes its LINE's top and height rather than its own tight glyph
 * box: tesseract boxes "pc" and "Ph" differently by their descenders and
 * ascenders, and assembleLines groups by baseline within 2pt, so tight boxes
 * would split one printed line into two. Line-height boxes are also what the
 * text path produces (font-height boxes), so provenance looks the same from
 * either source.
 */
export function wordsToPage(lines: OcrLine[], pageNo: number, widthPx: number, heightPx: number, scale: number): PdfPage {
  const items: PositionedItem[] = []
  for (const line of lines) {
    const y = line.bbox.y0 / scale
    const height = (line.bbox.y1 - line.bbox.y0) / scale
    for (const w of line.words) {
      if (w.text.trim() === '') continue
      items.push({
        str: w.text,
        bbox: { x: w.bbox.x0 / scale, y, width: (w.bbox.x1 - w.bbox.x0) / scale, height },
        confidence: w.confidence,
      })
    }
  }
  return { page: pageNo, width: widthPx / scale, height: heightPx / scale, items, lines: assembleLines(items) }
}
