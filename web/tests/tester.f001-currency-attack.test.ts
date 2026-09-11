/**
 * Independent adversarial coverage for F001 (currency ranks 2-4), written
 * by the tester, not the coder. Targets edges the coder's own
 * fields.currency-rank2-4.test.ts did not exercise: rank-2 (ISO anywhere)
 * ambiguity when two DIFFERENT ISO codes appear in the document, symbol
 * scan order across pages, priority of rank 0/1 over 2/3/4 when a winner
 * exists with real content, and a false-alarm check that a clean document
 * does not spuriously go 'uncertain'.
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

describe('F001 attack: rank 2 (ISO anywhere) collects distinct codes', () => {
  it('two DIFFERENT ISO codes adjacent to amounts in the document (no winner) -> uncertain with both, not a silent pick of the first', () => {
    // Post-replacement-rule: rank 2 collects every ISO code that sits next
    // to an amount before deciding. A conversion note ("1 EUR = 1.10 USD")
    // has both EUR and USD next to amounts, so it disagrees and resolveField
    // reports 'uncertain', the same standard rank 2 applies to symbols.
    const page1 = mkPage(1, ['Total 1,000.00', 'Rate: 1 EUR = 1.10 USD'])
    const page2 = mkPage(2, ['Total 1,250.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['EUR', 'USD']))
  })
})

describe('F001 attack: priority ordering with a real winner present', () => {
  it('winner line has an ISO code -> rank 0 still wins over document-wide rank 2/3 even if other pages contain different currency symbols', () => {
    const page1 = mkPage(1, ['Total USD 1,000.00'])
    const page2 = mkPage(2, ['Note: also billed in £ elsewhere'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('USD')
  })

  it('winner exists, winner line has neither ISO nor symbol, but a DIFFERENT total-shaped line elsewhere in the doc has $ -> falls through to rank 2/3 and reports based on doc-wide scan (not silently not_found)', () => {
    const page1 = mkPage(1, ['Total 1,000.00'])
    const page2 = mkPage(2, ['Total 1,000.00', 'Paid via card ending 1234 $50.00 fee'])
    const total = extractHeaderFields([page1, page2], 'text').find((f) => f.name === 'total')!
    expect(total.state).toBe('read') // both totals agree on value -> real winner exists
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })
})

describe('F001 attack: false-alarm protection', () => {
  it('clean single-currency USD invoice with a real ISO code on the winner line still reads cleanly (no spurious uncertainty introduced by the new ranks)', () => {
    const page1 = mkPage(1, ['Total USD 1,234.56'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('USD')
    expect(currency.provenance?.bbox).not.toBeNull()
  })

  it('a document with absolutely no currency evidence anywhere -> not_found, not a false "uncertain"', () => {
    const page1 = mkPage(1, ['Invoice Number: 12345', 'Vendor: Acme Corp', 'Total 500.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('not_found')
    expect(currency.candidates).toBeNull()
  })
})

describe('F001 attack: rank 3 symbol scan order and doc-order first-occurrence box', () => {
  it('same symbol repeated across pages -> box comes from the FIRST occurrence (page 1), not a later one', () => {
    const page1 = mkPage(1, ['Total 1,000.00', 'Fee £5.00'])
    const page2 = mkPage(2, ['Total 1,250.00', 'Adjustment £10.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
    expect(currency.provenance?.page).toBe(1)
  })

  it('three distinct symbols (£, €, $) with no winner -> uncertain with GBP, EUR, USD, AUD all present', () => {
    const page1 = mkPage(1, ['Total 1,000.00', 'Fee £5.00', 'Conv €3.00'])
    const page2 = mkPage(2, ['Total 1,250.00', 'Surcharge $2.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['GBP', 'EUR', 'USD', 'AUD']))
  })
})

describe('F001 attack: empty document edge case', () => {
  it('zero pages -> not_found, not a crash', () => {
    const currency = currencyOf([])
    expect(currency.state).toBe('not_found')
    expect(currency.value).toBeNull()
  })

  it('a page with zero lines -> not_found, not a crash', () => {
    const page1 = mkPage(1, [])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('not_found')
  })
})
