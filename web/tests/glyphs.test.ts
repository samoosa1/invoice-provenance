/**
 * lib/glyphs.ts against facts read off the operator list by hand
 * (tools: pdf.js getOperatorList on the sample PDFs, 11.09.2026), not off the
 * reader's own output. The broad agreement check is the PyMuPDF oracle in
 * oracle.spans.test.ts; this file pins the mechanics that oracle cannot see.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { readPdf } from '../src/lib/pdf'

function sample(file: string) {
  return readPdf(new Blob([readFileSync(new URL(`../public/sample/${file}`, import.meta.url))]), file)
}

describe('readGlyphs: exact word boxes from the operator list', () => {
  it('places the first text object of 00_BF-00885.pdf where its text matrix and the base CTM put it', async () => {
    const [page] = await sample('00_BF-00885.pdf')
    // The first text object: setTextMatrix [1 0 0 -1 102.46875 91.5] under
    // Chromium's base CTM (0.24 x 3.125 = 0.75 scale), so the "B" of the
    // vendor name lands at 102.46875 * 0.75 = 76.85pt from the left edge.
    const first = page.items[0]
    expect(first.str.startsWith('B')).toBe(true)
    expect(Math.abs(first.bbox.x - 102.46875 * 0.75)).toBeLessThan(0.5)
  })

  it('splits the address run, one Tj run in getTextContent, into its six words', async () => {
    const [page] = await sample('00_BF-00885.pdf')
    const address = page.lines.find((l) => l.text === '14 Tanner Row, York YO1 6JB')
    expect(address).toBeDefined()
    expect(address!.items.map((i) => i.str)).toEqual(['14', 'Tanner', 'Row,', 'York', 'YO1', '6JB'])
  })

  it('treats a tracked-out heading as one item per letter, as the PyMuPDF reference does', async () => {
    // grid_einvoice prints INVOICE with a 3pt letter-spacing at 18.66pt
    // (0.16 em): wider than any kerning pair, narrower than a space.
    const [page] = await sample('03_PH-2025-0214.pdf')
    const heading = page.lines.find((l) => l.text === 'I N V O I C E')
    expect(heading).toBeDefined()
    expect(heading!.items).toHaveLength(7)
  })

  it('expands ligature glyphs to plain letters so string matches keep working', async () => {
    const [page] = await sample('00_BF-00885.pdf')
    // The embedded Helvetica sets "Office" with an ffi ligature (U+FB03).
    expect(page.items.some((i) => i.str === 'Office')).toBe(true)
    expect(page.items.some((i) => i.str.includes('ﬃ'))).toBe(false)
  })

  it('gives every word a font-height box that agrees with its line height, no zero-area boxes', async () => {
    const pages = await sample('04_CF-2025-511.pdf') // Courier: not Helvetica-shaped
    for (const page of pages) {
      for (const item of page.items) {
        expect(item.bbox.width).toBeGreaterThan(0)
        expect(item.bbox.height).toBeGreaterThan(0)
      }
    }
  })
})
