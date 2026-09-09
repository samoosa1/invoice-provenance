import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { assembleLines, readPdf } from '../src/lib/pdf'

// Fixture: a clean text-layer uk_service invoice from ledger-reconciler's
// sample set (EXPECTED.json: WS-0622, 2025-01-11, GBP 741.98, A4).
const FIXTURE = new URL('./fixtures/uk_service_clean.pdf', import.meta.url)

describe('readPdf', () => {
  it('returns positioned items in top-left page coordinates', async () => {
    const pages = await readPdf(new Blob([await readFile(FIXTURE)]), 'uk_service_clean.pdf')
    expect(pages).toHaveLength(1)
    const [p] = pages
    expect(Math.abs(p.width - 595)).toBeLessThan(1.5) // A4; Chromium prints 595.92
    expect(Math.abs(p.height - 842)).toBeLessThan(1.5)
    expect(p.items.length).toBeGreaterThan(20)
    for (const it of p.items) {
      expect(it.bbox.x).toBeGreaterThanOrEqual(0)
      expect(it.bbox.y).toBeGreaterThanOrEqual(0)
      expect(it.bbox.x + it.bbox.width).toBeLessThanOrEqual(p.width + 1)
      expect(it.bbox.y + it.bbox.height).toBeLessThanOrEqual(p.height + 1)
      expect(it.bbox.height).toBeGreaterThan(0)
    }
  })

  it('places the invoice number in the top half and the total in the lower half', async () => {
    const [p] = await readPdf(new Blob([await readFile(FIXTURE)]), 'uk_service_clean.pdf')
    const number = p.items.find((i) => i.str.includes('WS-0622'))
    const total = p.lines.find((l) => l.text.startsWith('Total due'))
    expect(number).toBeDefined()
    expect(total).toBeDefined()
    expect(number!.bbox.y).toBeLessThan(p.height / 2)
    expect(total!.bbox.y).toBeGreaterThan(number!.bbox.y)
    expect(total!.text).toContain('741.98')
  })
})

describe('assembleLines', () => {
  it('joins same-baseline fragments with a space across a gap and orders top to bottom', () => {
    const box = (x: number, y: number, w = 10, h = 10) => ({ x, y, width: w, height: h })
    const lines = assembleLines([
      { str: 'Total', bbox: box(300, 700) },
      { str: 'Invoice', bbox: box(10, 100) },
      { str: 'number', bbox: box(60, 100) },
      { str: '99.00', bbox: box(400, 700) },
    ])
    expect(lines.map((l) => l.text)).toEqual(['Invoice number', 'Total 99.00'])
    expect(lines[1].bbox).toEqual({ x: 300, y: 700, width: 110, height: 10 })
  })
})
