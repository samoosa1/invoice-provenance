/**
 * Exact word boxes from the page's operator list. pdf.js's getTextContent()
 * reports one box per text RUN, and a run on these Chromium-printed invoices
 * is routinely a whole address or footer line, so a value inside it can only
 * be placed by estimating where its characters fall. The operator list has
 * what the renderer itself uses: every glyph's advance from the embedded
 * font, and every text-positioning operator. Replaying the text state
 * machine over it gives each glyph its true origin, so a word's box is
 * measured, not guessed, in any font.
 *
 * Only the PDF text state (Tm, Tlm, Tf, Tc, Tw, Tz, TL, Ts) and the CTM
 * are tracked; painting operators are skipped. The worker has already
 * folded TJ arrays, ' and " into showText, so the operator set here is the
 * complete text vocabulary that can reach this side.
 */

import type * as PdfjsTypes from 'pdfjs-dist'
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'

import type { PositionedItem } from '../domain/types'

/** [a, b, c, d, e, f] as in the PDF spec: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** The matrix that applies `inner` first, then `outer` (PDF's M_inner × M_outer). */
function compose(inner: Matrix, outer: Matrix): Matrix {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ]
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** The shape of one entry in a showText argument; a number is a TJ kerning adjustment. */
type Glyph = { unicode: string; width: number; isSpace: boolean }

type TextState = {
  fontSize: number
  fontMatrix: Matrix
  charSpacing: number
  wordSpacing: number
  hscale: number
  rise: number
  leading: number
}

/**
 * A word under construction, in the coordinates of the current text line:
 * the space `setTextMatrix` established, before that matrix and the CTM are
 * applied. Working there keeps the gap test in font units.
 */
type Word = { str: string; x0: number; x1: number; y: number; fontSize: number; matrix: Matrix }

/**
 * A horizontal gap wider than this fraction of the font size separates two
 * words even when no space glyph was drawn. Skia positions every glyph with
 * its own moveText, so kerning and letter-spacing both arrive as gaps: a
 * kerning pair stays under 0.03 em, a space is at least 0.24 em (Georgia,
 * the narrowest here), and tracked-out headings sit between. PyMuPDF, the
 * oracle, splits a tracked heading into one word per letter; 0.1 em does
 * the same, so "I N V O I C E" reads the way the reference reads it.
 */
const WORD_GAP_EM = 0.1

/**
 * One PositionedItem per word, in top-left-origin viewport points, the same
 * frame `readPdf` has always produced. Word boxes are font-height boxes
 * (baseline to baseline + font size), matching what getTextContent reported
 * and what the PyMuPDF oracle's vertical budget was measured against.
 *
 * `pdfjs` is the loaded module (for its OPS table and normalizeUnicode):
 * `lib/pdf.ts` imports pdf.js lazily, and a static import here would pull
 * it into the first bundle.
 */
export async function readGlyphs(
  page: PDFPageProxy,
  viewport: PageViewport,
  pdfjs: typeof PdfjsTypes,
): Promise<PositionedItem[]> {
  const ops = pdfjs.OPS
  const { fnArray, argsArray } = await page.getOperatorList()

  let ctm: Matrix = IDENTITY
  let text: TextState = { fontSize: 0, fontMatrix: [0.001, 0, 0, 0.001, 0, 0], charSpacing: 0, wordSpacing: 0, hscale: 1, rise: 0, leading: 0 }
  const stack: Array<{ ctm: Matrix; text: TextState }> = []

  // Text matrix as set by Tm, and the pen position within that line (Td, T*,
  // and the advance of each glyph shown), exactly as pdf.js's canvas keeps
  // `textMatrix` and `x / lineX`.
  let matrix: Matrix = IDENTITY
  let x = 0
  let y = 0
  let lineX = 0
  let lineY = 0

  const items: PositionedItem[] = []
  let word: Word | null = null

  const flush = () => {
    if (word && word.str.trim() !== '') {
      // Ligature glyphs (ﬁ, ﬃ) carry their presentation-form code point;
      // getTextContent expanded them to plain letters and every string match
      // downstream (and the PyMuPDF oracle) expects the same.
      const str = pdfjs.normalizeUnicode(word.str)
      // Corners of the font-height box in text-line space, through the text
      // matrix, the CTM and the viewport; the axis-aligned hull is the item.
      const m = compose(word.matrix, ctm)
      const corners = [
        apply(m, word.x0, word.y),
        apply(m, word.x1, word.y),
        apply(m, word.x0, word.y + word.fontSize),
        apply(m, word.x1, word.y + word.fontSize),
      ].map(([px, py]) => viewport.convertToViewportPoint(px, py))
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const bx = Math.min(...xs)
      const by = Math.min(...ys)
      items.push({ str, bbox: { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by } })
    }
    word = null
  }

  const moveText = (tx: number, ty: number) => {
    lineX += tx
    lineY += ty
    x = lineX
    y = lineY
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]
    switch (fn) {
      case ops.save:
        stack.push({ ctm, text: { ...text } })
        break
      case ops.restore: {
        const s = stack.pop()
        if (s) ({ ctm, text } = s)
        break
      }
      case ops.transform:
        ctm = compose(toMatrix(args), ctm)
        break
      case ops.paintFormXObjectBegin:
        // The canvas does save + transform(matrix) here and restore at End.
        stack.push({ ctm, text: { ...text } })
        if (args[0]) ctm = compose(toMatrix(args[0]), ctm)
        break
      case ops.paintFormXObjectEnd: {
        const s = stack.pop()
        if (s) ({ ctm, text } = s)
        break
      }
      case ops.beginText:
        flush()
        matrix = IDENTITY
        x = y = lineX = lineY = 0
        break
      case ops.endText:
        flush()
        break
      case ops.setTextMatrix:
        flush()
        matrix = toMatrix(args[0])
        x = y = lineX = lineY = 0
        break
      case ops.moveText:
        moveText(args[0], args[1])
        break
      case ops.setLeading:
        text.leading = -args[0]
        break
      case ops.setLeadingMoveText:
        text.leading = args[1]
        moveText(args[0], args[1])
        break
      case ops.nextLine:
        moveText(0, text.leading)
        break
      case ops.setFont: {
        flush()
        const font = page.commonObjs.get(args[0]) as { fontMatrix?: number[] | null } | undefined
        if (!font) throw new Error(`Font ${String(args[0])} is not loaded`)
        text.fontSize = Math.abs(args[1])
        text.fontMatrix = font.fontMatrix ? toMatrix(font.fontMatrix) : [0.001, 0, 0, 0.001, 0, 0]
        break
      }
      case ops.setCharSpacing:
        text.charSpacing = args[0]
        break
      case ops.setWordSpacing:
        text.wordSpacing = args[0]
        break
      case ops.setHScale:
        text.hscale = args[0] / 100
        break
      case ops.setTextRise:
        text.rise = args[0]
        break
      case ops.showText: {
        for (const g of args[0] as Array<Glyph | number>) {
          if (typeof g === 'number') {
            // TJ adjustment, thousandths of text space, subtracted from the pen.
            x -= (g / 1000) * text.fontSize * text.hscale
            continue
          }
          const advance =
            (g.width * text.fontMatrix[0] * text.fontSize + text.charSpacing + (g.isSpace ? text.wordSpacing : 0)) *
            text.hscale
          // Skia prints a space as a real " " glyph with isSpace false, so the
          // unicode is the test, not the flag.
          const isSpace = g.isSpace || g.unicode.trim() === ''
          const baseline = y + text.rise
          const gap = word ? x - word.x1 : 0
          // A negative gap is a kerning pair ("Ta" pulls back 0.11 em) and
          // never a word break; a jump back of more than an em is the pen
          // being repositioned, which is.
          if (
            word &&
            (isSpace ||
              word.y !== baseline ||
              word.matrix !== matrix ||
              gap > WORD_GAP_EM * text.fontSize ||
              gap < -text.fontSize)
          ) {
            flush()
          }
          if (!isSpace) {
            if (!word) word = { str: '', x0: x, x1: x, y: baseline, fontSize: text.fontSize, matrix }
            word.str += g.unicode
            word.x1 = x + advance
          }
          x += advance
        }
        break
      }
    }
  }
  flush()
  return items
}

/** The operator list hands matrices over as array-likes with numeric keys; index, do not spread. */
function toMatrix(a: ArrayLike<number>): Matrix {
  return [a[0], a[1], a[2], a[3], a[4], a[5]]
}
