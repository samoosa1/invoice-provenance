/**
 * GST is not an Australian signal: New Zealand, Canada, Singapore and India
 * print it too, and CAD is in the module's own ISO list. A hint that can decide
 * a currency must be country-specific, so GST must never break a `$` tie.
 * ABN, which is Australian, must.
 */

import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import type { PdfPage } from '../src/domain/types'

function line(text: string, y: number) {
  const spans = [...text].map((_, i) => ({ start: i, end: i + 1, bbox: { x: 50 + i * 5, y, width: 5, height: 10 } }))
  return { text, bbox: { x: 50, y, width: text.length * 5, height: 10 }, spans }
}

function page(texts: string[]): PdfPage {
  return { page: 1, width: 595, height: 842, items: [], lines: texts.map((t, i) => line(t, 100 + i * 20)) }
}

const currencyOf = (texts: string[]) => extractHeaderFields([page(texts)], 'text').find((f) => f.name === 'currency')!

describe('GST alone never decides between USD and AUD', () => {
  it('$ on the total line, GST in the tax row, no ABN -> uncertain {USD, AUD}', () => {
    const c = currencyOf(['Kauri Landscaping Ltd', 'Invoice No 77', 'Invoice date 14/03/2025', 'Mulch  $400.00', 'GST 15%  $60.00', 'Total $460.00'])
    expect(c.state).toBe('uncertain')
    expect([...(c.candidates ?? [])].sort()).toEqual(['AUD', 'USD'])
  })

  it('$ only on item lines (no total winner symbol), GST present, no ABN -> still uncertain', () => {
    const c = currencyOf(['Kauri Landscaping Ltd', 'Invoice No 77', 'Mulch  $400.00', 'GST 15%  60.00', 'Total 460.00'])
    expect(c.state).toBe('uncertain')
    expect([...(c.candidates ?? [])].sort()).toEqual(['AUD', 'USD'])
  })

  it('the same document with an ABN in the letterhead -> read AUD', () => {
    const c = currencyOf(['Amberlake Facilities', 'ABN 51 824 753 556', 'Invoice No 77', 'Mulch  $400.00', 'GST 10%  $40.00', 'Total $440.00'])
    expect(c.state).toBe('read')
    expect(c.value).toBe('AUD')
  })
})
