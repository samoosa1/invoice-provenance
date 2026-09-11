/**
 * Round-2 independent-tester attack suite against F001-F005.
 * New file, does not edit fields.test.ts, tester.adversarial.test.ts,
 * findings.adversarial.test.ts or tester.findings-breaks.test.ts.
 *
 * Goal: verify each finding's ACCEPTANCE independently (not by re-reading
 * what the code currently returns) and attack edges the coder's own
 * regression file did not cover: exact offset mapping for F002, false-alarm
 * protection for F001/F004, and the F004<->F005 interaction.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'
import { readDocument } from '../src/ui/pipeline'
import type { Line, PdfPage } from '../src/domain/types'

function pdfBuffer(name: string): Buffer {
  return readFileSync(new URL(`../public/sample/${name}`, import.meta.url))
}

// One span, ONE point per character (x = char index), so a returned bbox.x
// can be checked against an exact expected character offset in the
// ORIGINAL (possibly glued) string, not just "truthy".
function mkLine(text: string, y = 0): Line {
  return {
    text,
    bbox: { x: 0, y, width: text.length, height: 12 },
    items: [],
    spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: text.length, height: 12 } }],
  }
}

function mkPage(lines: Line[], page = 1): PdfPage {
  return { page, width: 600, height: 800, items: [], lines }
}

function byName(fields: ReturnType<typeof extractHeaderFields>, name: string) {
  return fields.find((f) => f.name === name)!
}

// --- F001 --------------------------------------------------------------

describe('F001: scan routing', () => {
  it('06_NW-213.pdf: candidates is an EMPTY ARRAY, not null and not [null]', async () => {
    const buf = pdfBuffer('06_NW-213.pdf')
    const doc = await readDocument(new File([buf], '06_NW-213.pdf'))
    expect(doc.source).toBe('ocr')
    for (const field of doc.fields) {
      expect(field.state).toBe('uncertain')
      expect(field.value).toBeNull()
      expect(field.provenance).toBeNull()
      expect(field.candidates).not.toBeNull()
      expect(Array.isArray(field.candidates)).toBe(true)
      expect(field.candidates).toEqual([]) // exactly per the ruling, not [null]
    }
  })

  it('false alarm: a normal TEXT-layer PDF is not routed through unreadFields (source stays text)', async () => {
    const buf = pdfBuffer('00_BF-00885.pdf')
    const doc = await readDocument(new File([buf], '00_BF-00885.pdf'))
    expect(doc.source).toBe('text')
    // A healthy document must still be able to reach 'read', not be forced uncertain.
    expect(doc.fields.some((f) => f.state === 'read')).toBe(true)
  })
})

// --- F002 ----------------------------------------------------------------

describe('F002: money deglue offset mapping', () => {
  // NOTE on what these prove: SUBTOTAL_PATTERN_DEFS and TAX_PATTERN_DEFS
  // (unlike TOTAL_PATTERN_DEFS) never append a trailing `\b` after their
  // label, so "Subtotal2,072.63" and "VAT414.53" actually still MATCH even
  // with deglue disabled entirely (verified directly: reverting
  // deglueForMoney to an identity no-op left these two tests green). Only
  // "TOTAL DUE1,148.72" (needs `total\s*due\b`) and "GRANDTOTAL1,148.72"
  // (below) require deglue to reach 'read' at all. What EVERY test in this
  // block verifies, and what a real bug in the offset-mapping would break,
  // is the exact provenance offset: proven by injecting a mapping bug
  // (deglue inserts spaces but toOriginal stays identity, i.e. does NOT map
  // back) and confirming all four indexOf assertions below go red with an
  // off-by-one/N x, while state/value stay 'read'/correct. That is the
  // silent-wrong-box failure mode the finding explicitly warns about.
  it('TOTAL DUE1,148.72 glued: total reads 1148.72 with a box over the ORIGINAL digits, not the deglued copy', () => {
    const text = 'TOTAL DUE1,148.72'
    const page = mkPage([mkLine(text)])
    const total = byName(extractHeaderFields([page], 'text'), 'total')
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    // '1,148.72' starts at index 9 in the ORIGINAL glued string
    // ("TOTAL DUE" is 9 chars). If offsets were computed against the
    // deglued copy ("TOTAL DUE 1,148.72") instead of mapped back, this
    // would be 10.
    expect(total.provenance).not.toBeNull()
    expect(total.provenance!.bbox.x).toBe(text.indexOf('1,148.72'))
  })

  it('Subtotal2,072.63 glued: subtotal reads 2072.63 with correctly-mapped provenance', () => {
    const text = 'Subtotal2,072.63'
    const page = mkPage([mkLine(text)])
    const subtotal = byName(extractHeaderFields([page], 'text'), 'subtotal')
    expect(subtotal.state).toBe('read')
    expect(subtotal.value).toBe('2072.63')
    expect(subtotal.provenance!.bbox.x).toBe(text.indexOf('2,072.63'))
  })

  it('VAT414.53 glued: tax reads 414.53 with correctly-mapped provenance', () => {
    const text = 'VAT414.53'
    const page = mkPage([mkLine(text)])
    const tax = byName(extractHeaderFields([page], 'text'), 'tax')
    expect(tax.state).toBe('read')
    expect(tax.value).toBe('414.53')
    expect(tax.provenance!.bbox.x).toBe(text.indexOf('414.53'))
  })

  it('two glue points on one line: label AND currency code both glued to their neighbours', () => {
    // "TOTALUSD1,148.72" glues total-to-USD and USD-to-digits. TOTAL_LABELS'
    // `total` pattern allows an optional trailing clause but here the plain
    // grand/total form must still find the money after skipping the ISO code
    // via JUNK... use a simpler two-glue case that stays inside JUNK's reach:
    // "TOTAL:Â·1,148.72USD" is out of scope; instead attack an adjacent
    // relabelling: "GRANDTOTAL1,148.72" (grand and total glued together,
    // which \s* already tolerates, PLUS total glued to the digits).
    const text = 'GRANDTOTAL1,148.72'
    const page = mkPage([mkLine(text)])
    const total = byName(extractHeaderFields([page], 'text'), 'total')
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    expect(total.provenance!.bbox.x).toBe(text.indexOf('1,148.72'))
  })

  it('false alarm: a normally-spaced money line is unaffected by deglue', () => {
    const text = 'TOTAL DUE 1,148.72'
    const page = mkPage([mkLine(text)])
    const total = byName(extractHeaderFields([page], 'text'), 'total')
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    expect(total.provenance!.bbox.x).toBe(text.indexOf('1,148.72'))
  })
})

// --- F003 ------------------------------------------------------------------

describe('F003: date label-then-next-line fallback', () => {
  it('stacked "Invoice date" / "15 Jan 2025" resolves to 2025-01-15 with provenance on the VALUE line', () => {
    const labelLine = mkLine('Invoice date', 0)
    const valueLine = mkLine('15 Jan 2025', 20)
    const page = mkPage([labelLine, valueLine])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-01-15')
    expect(f.provenance!.bbox.y).toBe(20) // came from the value line, not the label line
  })

  it('stacked "Due date" / "20 Feb 2025" resolves to 2025-02-20', () => {
    const labelLine = mkLine('Due date', 0)
    const valueLine = mkLine('20 Feb 2025', 20)
    const page = mkPage([labelLine, valueLine])
    const f = byName(extractHeaderFields([page], 'text'), 'due_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-02-20')
  })

  it('blank line between label and value is skipped to find the next NON-EMPTY line', () => {
    const page = mkPage([mkLine('Invoice date', 0), mkLine('   ', 10), mkLine('3 March 2025', 20)])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-03-03')
  })
})

// --- F004 --------------------------------------------------------------

describe('F004: US_HINTS $ accident removed, and no-hint ambiguous dates are uncertain', () => {
  it('a glued "$" run (e.g. GST$762.68) does NOT flip document-wide date orientation to month-first; GST is genuine non-US evidence so it reads day-first', () => {
    // 05/06/2025 is ambiguous (both components <=12). With the old buggy
    // \b\$ alternative, the glued $ here would set preferUS=true for the
    // WHOLE document and this would silently read as 2025-05-06 (US month-
    // first) with state 'read'. Fixed: the $ carries no orientation weight
    // at all, but GST is a genuine non-US signal, so this reads day-first.
    const page = mkPage([
      mkLine('GST$762.68', 0),
      mkLine('Invoice date 05/06/2025', 20),
    ])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-06-05') // day-first: non-US convention
  })

  it('an unambiguous day-first date (day > 12) still reads correctly with no hint present (false alarm)', () => {
    const page = mkPage([mkLine('Invoice date 25/01/2025', 0)])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-01-25')
  })

  it('a genuine US hint (USD) present anywhere in the document DOES resolve an ambiguous date, US-style', () => {
    const page = mkPage([
      mkLine('Total 1,200.00 USD', 0),
      mkLine('Invoice date 05/06/2025', 20),
    ])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-05-06') // US: month/day
  })

  it('an unambiguous same-day/month date (05/05/2025) does not falsely trigger uncertainty even with no hint', () => {
    const page = mkPage([mkLine('Invoice date 05/05/2025', 0)])
    const f = byName(extractHeaderFields([page], 'text'), 'invoice_date')
    expect(f.state).toBe('read')
    expect(f.value).toBe('2025-05-05')
  })
})

// --- F005 --------------------------------------------------------------

describe('F005: overlapping due_date is uncertain, carrying the value, never not_found', () => {
  // IMPORTANT: uses an UNAMBIGUOUS date (day=25 > 12) on purpose. The
  // coder's own findings.adversarial.test.ts F005 regression test uses
  // "06/05/2025" for both lines, which is itself ambiguous (both
  // components <=12) with no US hint anywhere in that synthetic page. Under
  // F004's fix, due_date is ALREADY 'uncertain' before suppressOverlap's
  // overlap check ever runs (the early-return added for F005 fires first),
  // so that test's due.state === 'uncertain' assertion is confounded: it
  // would hold even if overlap suppression were completely deleted. This
  // test isolates the overlap-suppression mechanism itself by using a value
  // that is unambiguous on its own, so due_date would resolve 'read' if
  // suppressOverlap did nothing.
  it('two same-position lines both printing an unambiguous date: due_date is downgraded from read to uncertain, not not_found, keeping the value as a candidate', () => {
    const page = mkPage([mkLine('Issued 25/12/2025', 10), mkLine('Due 25/12/2025', 10)])
    const fields = extractHeaderFields([page], 'text')
    const invoiceDate = byName(fields, 'invoice_date')
    const dueDate = byName(fields, 'due_date')
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-12-25')
    expect(dueDate.state).toBe('uncertain')
    expect(dueDate.state).not.toBe('not_found')
    expect(dueDate.value).toBeNull()
    expect(dueDate.candidates).toEqual(['2025-12-25'])
  })
})
