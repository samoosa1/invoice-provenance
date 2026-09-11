/**
 * Independent round-2 attack on F001's replacement rule (fields.ts
 * decideDocumentCurrency / collectHints / rank-1 `$` narrowing). Targets
 * edges the coder's own test files (tester.f001-currency-replacement-rule,
 * tester.f001-hint-unreachable-rank1, fields.currency-rank2-4) did not
 * exercise: contradictory hints, narrowing-to-empty preserving the original
 * tie, provenance box coming from the deciding token rather than the hint
 * that broke the tie, document order independence, and a false-alarm check
 * that non-`$` symbols on the winning line are never second-guessed by a
 * hint (per the spec text: ranks 0/1 "stay exactly as they are" for
 * everything except the `$` narrowing carve-out).
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

describe('F001 edges: contradictory hints never silently pick one side', () => {
  it('$ on the winning total line, BOTH EIN (USD) and ABN (AUD) present -> stays uncertain {USD, AUD}, not a coin-flip', () => {
    const page1 = mkPage(1, ['EIN 12-3456789', 'ABN 51 824 753 556', 'Total due $8,389.46'])
    const currency = currencyOf(page1 ? [page1] : [])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })

  it('no total winner, $ only evidence, BOTH EIN and ABN present -> stays uncertain {USD, AUD} via rank 2 as well', () => {
    // EIN (US) and ABN (AU) are each country-specific, so together they are a
    // genuine contradiction. GST is not used here: it is not a hint at all,
    // because it is printed in several `$` countries (see CURRENCY_HINTS).
    const page1 = mkPage(1, ['EIN 12-3456789', 'ABN 51 824 753 556', 'Fee $50.00'])
    const page2 = mkPage(2, ['Fee $75.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })
})

describe('F001 edges: narrowing to an empty intersection keeps the original tie honest', () => {
  it('two ISO codes adjacent to amounts (USD, EUR) plus an unrelated GBP hint that matches neither -> stays uncertain {USD, EUR}, not collapsed to nothing/not_found', () => {
    const page1 = mkPage(1, ['VAT Reg No GB123456789', 'Paid TOTAL USD 100.00', 'Ref TOTAL EUR 200.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'EUR']))
  })
})

describe('F001 edges: provenance box comes from the deciding token, not the hint', () => {
  it('ABN appears BEFORE the $ in document order; the narrowed AUD candidate box must point at the $ occurrence, not the ABN line', () => {
    const page1 = mkPage(1, ['ABN 51 824 753 556', 'Item one $4,000.00', 'Total amount due 8,389.46'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('AUD')
    // The $ sits on line index 1 (y = 10 + 1*12 = 22); the ABN line is y=10.
    expect(currency.provenance?.bbox.y).toBe(22)
  })

  it('repeated $ across two lines -> box is the FIRST occurrence, not the one nearer the hint', () => {
    const page1 = mkPage(1, ['Item one $10.00', 'ABN 51 824 753 556', 'Item two $20.00', 'Total amount due 30.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('AUD')
    // First $ is on line index 0 (y=10), not line index 2 (y=34) which is
    // adjacent to the ABN line.
    expect(currency.provenance?.bbox.y).toBe(10)
  })
})

describe('F001 edges: hint narrowing is $-specific, never second-guesses an unambiguous symbol', () => {
  it('£ on the winning total line with a contradictory EIN (USD) hint elsewhere -> still reads GBP, the hint never overrides a real symbol', () => {
    const page1 = mkPage(1, ['EIN 12-3456789', 'Total due £1,234.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
  })
})

describe('F001 edges: ISO code glued to its amount with no space still counts as adjacent', () => {
  it("'TOTAL USD1,234.00' (no space between code and digits) -> read USD", () => {
    const page1 = mkPage(1, ['TOTAL USD1,234.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('USD')
  })
})

describe('F001 edges: a currency with no symbol counterpart (CAD) resolves through ISO evidence alone', () => {
  it("'TOTAL CAD 500.00' with nothing else in the document -> read CAD", () => {
    const page1 = mkPage(1, ['TOTAL CAD 500.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('CAD')
  })
})

describe('F001 edges: false-alarm protection for a clean single-symbol EUR document', () => {
  it('€ everywhere, no ISO, no hint, no winner -> reads EUR cleanly, no spurious uncertainty from the new collection logic', () => {
    const page1 = mkPage(1, ['Fee €5.00'])
    const page2 = mkPage(2, ['Fee €10.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('EUR')
  })
})
