/**
 * Guards the ground truth itself.
 *
 * The accuracy table is only meaningful if truth records exactly what a layout
 * PRINTS. A field recorded as present when the page shows nothing turns a
 * correct `not_found` into a miss, and the published number quietly drops.
 *
 * The expectations below were written by reading the six Jinja templates in
 * `tools/sample_gen/templates/`, not by importing the generator's own `PRINTS`
 * table. Importing it would make this test agree with the code it is checking.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const GT = new URL('./fixtures/ground-truth/', import.meta.url)

type Truth = {
  file: string
  template: string
  scanned: string
  vendor: string
  invoice_number: string
  invoice_date: string
  due_date: string | null
  currency: string
  subtotal: number | null
  tax: number | null
  total: number
  line_items: Array<{ description: string; qty: number | null; unit_price: number | null; amount: number }>
  planted: string[]
}

const truths: Truth[] = readdirSync(GT)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, GT), 'utf8')) as Truth)

/** What each layout puts on the page. `null` means the layout never prints it. */
const PRINTS: Record<string, { due: boolean; subtotal: boolean; qty: boolean; unitPrice: boolean }> = {
  // "Invoice number / Invoice date / Due date / Subtotal / Total due", full item table
  'uk_service.html': { due: true, subtotal: true, qty: true, unitPrice: true },
  // "Invoice # / Date / Due / Subtotal / Balance Due", unit price is labelled "Rate"
  'us_letter.html': { due: true, subtotal: true, qty: true, unitPrice: true },
  // "Invoice No / Issue date / Due date / Goods-services total / Total payable"
  'grid_einvoice.html': { due: true, subtotal: true, qty: true, unitPrice: true },
  // Header reads "Issued <date> · Due <date>"; summary reads "Subtotal (ex VAT)"
  'statement.html': { due: true, subtotal: true, qty: true, unitPrice: true },
  // Two-row meta block: number and date only. Totals block has no subtotal line,
  // and quantity appears inline as "x3" only when it is not 1.
  'minimal_freelancer.html': { due: false, subtotal: false, qty: true, unitPrice: false },
  // "Receipt #<n>  <date>", then SUBTOTAL / tax / TOTAL. No due date, no unit price.
  'thermal_receipt.html': { due: false, subtotal: true, qty: true, unitPrice: false },
}

describe('ground truth', () => {
  it('covers 25 documents across all six layouts', () => {
    expect(truths).toHaveLength(25)
    expect(new Set(truths.map((t) => t.template))).toEqual(new Set(Object.keys(PRINTS)))
  })

  it('records a due date exactly where the layout prints one', () => {
    for (const t of truths) {
      expect(t.due_date === null, `${t.file} (${t.template})`).toBe(!PRINTS[t.template].due)
    }
  })

  it('records a subtotal exactly where the layout prints one', () => {
    for (const t of truths) {
      expect(t.subtotal === null, `${t.file} (${t.template})`).toBe(!PRINTS[t.template].subtotal)
    }
  })

  /**
   * The one case that is per-document rather than per-template:
   * minimal_freelancer.html wraps its tax row in `{% if tax %}`, so a zero-rate
   * vendor prints no tax label and no tax value at all. Every other layout
   * prints the row unconditionally, us_letter at a real 0.00 included.
   */
  it('records tax as null only for a zero-rate vendor on minimal_freelancer', () => {
    const nulls = truths.filter((t) => t.tax === null)
    expect(nulls.map((t) => t.file)).toEqual(['04_CF-2025-511.pdf', '17_CF-2025-513.pdf'])
    for (const t of nulls) {
      expect(t.template).toBe('minimal_freelancer.html')
      expect(t.vendor).toBe('Cedar & Finch Consulting')
    }
    // A printed zero is not an absent field.
    const usLetterZeros = truths.filter((t) => t.template === 'us_letter.html' && t.tax === 0)
    expect(usLetterZeros.length).toBeGreaterThan(0)
  })

  it('records line-item unit price and qty per the layout', () => {
    for (const t of truths) {
      const p = PRINTS[t.template]
      for (const li of t.line_items) {
        expect(li.unit_price === null, `${t.file} unit_price`).toBe(!p.unitPrice)
        if (p.qty) expect(li.qty, `${t.file} qty`).not.toBeNull()
      }
    }
  })

  it('always records the fields every layout prints', () => {
    for (const t of truths) {
      expect(t.invoice_number, t.file).toMatch(/\S/)
      expect(t.invoice_date, t.file).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(t.currency, t.file).toMatch(/^[A-Z]{3}$/)
      expect(typeof t.total, t.file).toBe('number')
      expect(t.line_items.length, t.file).toBeGreaterThan(0)
    }
  })

  it('plants the line-sum fault in exactly three documents', () => {
    const planted = truths.filter((t) => t.planted.includes('line_sum_mismatch'))
    expect(planted).toHaveLength(3)
    // A planted document's printed line amounts must NOT tie to its subtotal;
    // that disagreement is the thing Day 3's cross-check has to catch.
    for (const t of planted) {
      if (t.subtotal === null) continue
      const sum = t.line_items.reduce((a, li) => a + li.amount, 0)
      expect(Math.abs(sum - t.subtotal), t.file).toBeGreaterThan(0.01)
    }
  })

  it('leaves the other documents internally consistent', () => {
    for (const t of truths) {
      if (t.planted.length > 0 || t.subtotal === null) continue
      const sum = t.line_items.reduce((a, li) => a + li.amount, 0)
      expect(Math.abs(sum - t.subtotal), t.file).toBeLessThanOrEqual(0.01)
      if (t.tax !== null) expect(Math.abs(t.subtotal + t.tax - t.total), t.file).toBeLessThanOrEqual(0.01)
    }
  })

  it('marks five documents as scans', () => {
    expect(truths.filter((t) => t.scanned !== '')).toHaveLength(5)
  })

  /**
   * The sample vendors print bank identifiers. A syntactically VALID one could
   * coincide with a real account once this repo is public, so every IBAN in
   * the generator must fail mod-97 and the Turkish VKN must fail its own
   * check-digit algorithm. This reads the generator source directly: the
   * identifiers are not in the truth files, and the PDFs are what a stranger
   * would copy from.
   */
  it('prints only bank identifiers that fail their own checksum', () => {
    const vendorsPy = readFileSync(new URL('../../tools/sample_gen/vendors.py', import.meta.url), 'utf8')

    const ibans = [...vendorsPy.matchAll(/IBAN ([A-Z]{2}\d{2}(?: [A-Z0-9]{2,4})+)/g)].map((m) => m[1])
    expect(ibans.length).toBeGreaterThanOrEqual(3)
    for (const iban of ibans) {
      const s = iban.replace(/ /g, '')
      const rearranged = s.slice(4) + s.slice(0, 4)
      const digits = [...rearranged].map((c) => parseInt(c, 36).toString()).join('')
      expect(Number(BigInt(digits) % 97n), iban).not.toBe(1)
    }

    const vkn = /"VKN", "(\d{10})"/.exec(vendorsPy)?.[1]
    expect(vkn).toBeDefined()
    const d = [...vkn!].map(Number)
    let total = 0
    for (let i = 0; i < 9; i++) {
      const t = (d[i] + 9 - i) % 10
      let q = (t * 2 ** (9 - i)) % 9
      if (t !== 0 && q === 0) q = 9
      total += q
    }
    expect((10 - (total % 10)) % 10, vkn).not.toBe(d[9])
  })
})
