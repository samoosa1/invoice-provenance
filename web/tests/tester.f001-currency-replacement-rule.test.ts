/**
 * F001 acceptance coverage for the round-1 replacement rule: rank 2 becomes
 * ONE document-wide pass that collects iso/sym/hint evidence before
 * deciding, instead of returning on the first ISO code found anywhere (old
 * rank 2), then the first `$` found anywhere without ever reaching the
 * hints that exist to break its tie (old rank 3, which returned before old
 * rank 4 could run). Cases (a)-(h) below each FAIL against the round-1 code
 * and pass after the fix. Case (i) sweeps every non-scanned ground-truth
 * fixture through the real PDF pipeline.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import { readPdf } from '../src/lib/pdf'
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

describe('F001 replacement rule: single document-wide rank 2', () => {
  it('(a) UK scenario: total line has no symbol, VAT Reg No hint says GBP, money lines print £, a footer sentence contains the bare word USD with no amount next to it -> read GBP', () => {
    const page1 = mkPage(1, [
      'Total due 1,234.00',
      'VAT Reg No GB123456789',
      'Item one £500.00',
      'Item two £734.00',
      'Please settle in USD equivalent terms if preferred',
    ])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
  })

  it('(b) Australian scenario: total line has no symbol, $ on item lines, ABN in the letterhead -> read AUD via hint narrowing', () => {
    const page1 = mkPage(1, ['ABN 51 824 753 556', 'Item one $4,000.00', 'Item two $4,389.46', 'Total amount due 8,389.46'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('AUD')
  })

  it("(c) the only currency-like token is the English word 'TRY' loose in prose, £ on the money lines -> read GBP, not TRY", () => {
    const page1 = mkPage(1, ['Total £500.00', 'Please TRY to pay within 30 days'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
  })

  it('(d) £ on page 1 money lines and € on page 2 money lines, no ISO code, no hints -> uncertain {GBP, EUR}', () => {
    const page1 = mkPage(1, ['Fee £5.00'])
    const page2 = mkPage(2, ['Fee €5.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['GBP', 'EUR']))
  })

  it('(e) $ anywhere with no hint and no ISO code -> uncertain {USD, AUD}, the tie stays honest when nothing breaks it', () => {
    const page1 = mkPage(1, ['Fee $5.00'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })

  it("(f) 'TOTAL USD 3,820.96' style ISO-adjacent-to-amount anywhere -> read USD", () => {
    const page1 = mkPage(1, ['Some other line', 'TOTAL USD 3,820.96'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('USD')
  })

  it('(g) no code, symbol or hint anywhere -> not_found', () => {
    const page1 = mkPage(1, ['Total 500.00', 'Thank you for your business'])
    const currency = currencyOf([page1])
    expect(currency.state).toBe('not_found')
    expect(currency.value).toBeNull()
  })

  it('(h) round-1 acceptance case still holds: two-page £ document with two different totals -> read GBP', () => {
    const page1 = mkPage(1, ['Total £1,000.00'])
    const page2 = mkPage(2, ['Total £1,250.00'])
    const total = extractHeaderFields([page1, page2], 'text').find((f) => f.name === 'total')!
    expect(total.state).toBe('uncertain')
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('read')
    expect(currency.value).toBe('GBP')
  })

  it('(h) round-1 acceptance case still holds: $-only sample document -> uncertain {USD, AUD}', () => {
    const page1 = mkPage(1, ['Total $1,000.00'])
    const page2 = mkPage(2, ['Total $1,250.00'])
    const currency = currencyOf([page1, page2])
    expect(currency.state).toBe('uncertain')
    expect(currency.candidates).toEqual(expect.arrayContaining(['USD', 'AUD']))
  })
})

// --- (i) ground-truth sweep -------------------------------------------------

type Truth = { file: string; scanned: string; currency: string }

const GT = new URL('./fixtures/ground-truth/', import.meta.url)
const truths: Truth[] = readdirSync(GT)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, GT), 'utf8')) as Truth)
  .filter((t) => t.scanned === '')

describe('F001 (i): currency reads correctly across every non-scanned ground-truth fixture', () => {
  it('covers exactly 20 non-scanned documents', () => {
    expect(truths).toHaveLength(20)
  })

  it('reads the truth currency, or reports an honest uncertain containing it for a bare $ with no hint', async () => {
    const exceptions: string[] = []
    for (const t of truths) {
      const buf = readFileSync(new URL(`../public/sample/${t.file}`, import.meta.url))
      const pages = await readPdf(new Blob([buf]), t.file)
      const currency = extractHeaderFields(pages, 'text').find((f) => f.name === 'currency')!

      if ((t.currency === 'USD' || t.currency === 'AUD') && currency.state === 'uncertain' && currency.candidates?.includes(t.currency)) {
        exceptions.push(t.file)
        continue
      }
      expect(currency.state, t.file).toBe('read')
      expect(currency.value, t.file).toBe(t.currency)
    }
    // The exception list is asserted, not just printed: Saltmarsh Coffee
    // Roasters is the only vendor in tools/sample_gen/vendors.py with no tax-id
    // label at all (thermal receipt, `$`, no EIN), so its two documents are the
    // only ones allowed to stay uncertain. Any other file landing here is a
    // currency regression that a printed list would let through.
    expect(exceptions.sort()).toEqual(['11_805.pdf', '20_811.pdf'])
  })
})
