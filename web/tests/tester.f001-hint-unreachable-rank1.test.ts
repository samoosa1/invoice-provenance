/**
 * Domain attack on F001's acceptance (i): the exception carve-out for the
 * ground-truth sweep is worded "whose total line prints a bare `$` WITH NO
 * HINT". Two real fixtures (07_AF-00496.pdf, 10_AF-00500.pdf) print `$`
 * directly on the winning total line AND carry an ABN/GST hint in the
 * letterhead - so per the acceptance text they must NOT qualify for the
 * exception and must resolve to 'read' AUD via hint narrowing. They don't:
 * rank 1 (symbol on the winning total line, explicitly left unchanged by
 * the replacement rule) fires and returns before rank 2's hint-narrowing
 * ever runs, so the ABN/GST hint is unreachable whenever `$` sits on the
 * total line itself - the exact defect F001 was filed to kill, now hiding
 * one rank earlier than where the fix looked.
 */
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import type { PdfPage } from '../src/domain/types'

function mkLine(text: string, y: number) {
  return {
    text,
    bbox: { x: 0, y, width: 500, height: 12 },
    items: [],
    spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: 500, height: 12 } }],
  }
}

function mkPage(page: number, lines: string[]): PdfPage {
  return { page, width: 600, height: 800, items: [], lines: lines.map((t, i) => mkLine(t, 10 + i * 12)) } as any
}

function currencyOf(pages: PdfPage[]) {
  return extractHeaderFields(pages, 'text').find((f) => f.name === 'currency')!
}

describe('F001 attack: rank 1 short-circuit makes ABN/GST hint unreachable when $ sits on the winning total line', () => {
  it('mirrors 07_AF-00496.pdf/10_AF-00500.pdf shape: ABN + GST in letterhead, $ printed ON the total line itself -> must read AUD, not stay uncertain', () => {
    const page1 = mkPage(1, [
      'Level 3, 41 Exhibition St, Melbourne VIC 3000 · ABN 51 824 753 556',
      'Subtotal (ex GST) 7,626.78',
      'GST 10% 762.68',
      'Total amount due $8,389.46',
    ])
    const currency = currencyOf([page1])
    // Domain truth: ABN + GST identify this as an Australian invoice. The
    // hint exists precisely to disambiguate `$`; a real AUD invoice should
    // never come back 'uncertain {USD, AUD}' when its own letterhead
    // already answers the question.
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('AUD')
  })
})
