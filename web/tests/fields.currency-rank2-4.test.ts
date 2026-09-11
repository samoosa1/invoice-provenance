/**
 * Regression tests for F001: currency must not fall back to 'not_found'
 * whenever the `total` field has no single winner. Rank 2 (ISO code
 * anywhere in the document) and rank 3 (currency symbols anywhere in the
 * document) must run whether or not a total winner exists; rank 4 (the
 * former rank-2 tax-id hints) only after those. Each test FAILS against the
 * pre-fix code (which returned [] whenever `winner`/`winnerLine` was null)
 * and passes after it.
 */

import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import type { PdfPage } from '../src/domain/types'

// Mirrors the synthetic-page helper used in tests/findings.adversarial.test.ts.
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

describe('F001: currency reaches rank 2/3/4 even when the total field has no winner', () => {
  it('(a) two-page £ document with disagreeing totals -> currency read as GBP with a non-null bbox', () => {
    const page1 = mkPage(1, ['Total £1,000.00'])
    const page2 = mkPage(2, ['Total £1,250.00', 'VAT Reg No GB123456789'])
    const total = extractHeaderFields([page1, page2], 'text').find((f) => f.name === 'total')!
    expect(total.state).toBe('uncertain') // sanity: the winner really is ambiguous

    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
    expect(currency.provenance?.bbox).not.toBeNull()
  })

  it('(b) same document but one line prints € instead of £ -> uncertain with both GBP and EUR as candidates', () => {
    const page1 = mkPage(1, ['Total £1,000.00'])
    const page2 = mkPage(2, ['Total £1,250.00', 'Adjustment €50.00', 'VAT Reg No GB123456789'])

    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toContain('GBP')
    expect(currency.candidates).toContain('EUR')
  })

  it('(c) no ISO code, no symbol, no tax-id hint anywhere -> not_found', () => {
    const page1 = mkPage(1, ['Total 1,000.00'])
    const page2 = mkPage(2, ['Total 1,250.00'])

    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('not_found')
    expect(currency.value).toBeNull()
    expect(currency.provenance).toBeNull()
  })

  it('(d) the existing $-only case still resolves to uncertain with USD and AUD', () => {
    const page1 = mkPage(1, ['Total $1,000.00'])
    const page2 = mkPage(2, ['Total $1,250.00'])

    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })

  it('a Turkish document with no TOTAL_LABELS match and ₺ throughout still resolves currency (not not_found)', () => {
    // 'GENEL TOPLAM' is not in TOTAL_LABELS, so the total field itself stays
    // not_found; currency must still find ₺ via rank 3.
    const page1 = mkPage(1, ['GENEL TOPLAM 12.345,67 ₺'])
    const total = extractHeaderFields([page1], 'text').find((f) => f.name === 'total')!
    expect(total.state).toBe('not_found')

    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('TRY')
  })

  it('rank 2 (ISO code anywhere) beats rank 3 (symbol) even without a total winner', () => {
    const page1 = mkPage(1, ['Total £1,000.00', 'Currency: EUR'])
    const page2 = mkPage(2, ['Total £1,250.00'])

    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('EUR')
  })

  it('rank 4 tax-id hint still fires when there is a total winner but no ISO code or symbol anywhere', () => {
    const page1 = mkPage(1, ['Total 1,000.00', 'ABN 12 345 678 901'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('AUD')
  })
})
