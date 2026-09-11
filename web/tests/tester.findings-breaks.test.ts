/**
 * Adversarial attack tests written by the independent tester, against the
 * F001-F005 fixes. New file per the one-file-per-concern convention; does
 * not touch findings.adversarial.test.ts (the coder's own regression file)
 * or any pre-existing shared test file.
 *
 * Two of these tests expose real defects (one an unfinished piece of F004's
 * own stated requirement, one a fresh bug introduced by the F005 fix
 * clobbering an already-uncertain due_date's real candidate list). The rest
 * are false-alarm / robustness checks that held.
 */

import type { Line } from '../src/domain/types'
import { describe, expect, it } from 'vitest'

import { extractHeaderFields } from '../src/domain/fields'

function mkLine(text: string, y: number): Line {
  return {
    text,
    bbox: { x: 0, y, width: text.length, height: 12 },
    items: [],
    spans: [{ start: 0, end: text.length, bbox: { x: 0, y, width: text.length, height: 12 } }],
  }
}

// --- F004 (domain gap, NOT proven fixed): a genuinely ambiguous date with
// no orientation hint anywhere in the document must be 'uncertain', per the
// finding's own text ("Anything else is null, never a guess."), not
// silently resolved to 'read' under the day-first default. -----------------

describe('F004 domain gap: ambiguous date with zero orientation hints', () => {
  it("'03/04/2025' alone, no US_HINTS anywhere in the document -> invoice_date should be uncertain with both readings, not silently read day-first", () => {
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Invoice date: 03/04/2025', 10)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    // Domain requirement per F004: both day (03) and month (04) are <=12,
    // and no US hint fires anywhere in this document, so the orientation is
    // genuinely unknown. The field must not claim a single definite value.
    expect(invoiceDate.state).toBe('uncertain')
  })
})

// --- F005 fix introduces a NEW bug: suppressOverlap unconditionally sets
// candidates: [dueDate.value as string]. If dueDate was ALREADY 'uncertain'
// from disagreeing rank-tied candidates (value already null, candidates
// already the real disputed readings) before the overlap check ever runs,
// this clobbers the real candidate list with a single-element [null]. -----

describe('F005 regression: suppressOverlap clobbers an already-uncertain due_date candidate list', () => {
  it('a due_date already uncertain from two disagreeing same-rank candidates, whose provenance box happens to overlap invoice_date, keeps its real candidates instead of becoming [null]', () => {
    const lineA = mkLine('Invoice date 01/02/2025', 10)
    // Two same-rank "due date" matches with different values on a line at
    // the same y as lineA, so due_date resolves to 'uncertain' BEFORE
    // suppressOverlap ever runs, and its returned provenance box (the first
    // candidate with a bbox) overlaps invoice_date's box.
    const lineB = mkLine('Due date 12/03/2025 Due date 06/04/2025', 10)
    const page = { page: 1, width: 600, height: 800, items: [], lines: [lineA, lineB] }
    const fields = extractHeaderFields([page as any], 'text')
    const dueDate = fields.find((f) => f.name === 'due_date')!

    expect(dueDate.state).toBe('uncertain')
    expect(dueDate.value).toBeNull()
    // The real bug: candidates comes back as [null] instead of the two
    // disputed date readings ('2025-03-12' and '2025-04-06'). A human
    // reviewing this field sees a single null candidate, not the two
    // readings the six-clause rule exists to surface.
    expect(dueDate.candidates).not.toEqual([null])
    expect(dueDate.candidates).not.toBeNull()
    expect(dueDate.candidates!.every((c) => c !== null)).toBe(true)
    expect(dueDate.candidates!.length).toBeGreaterThanOrEqual(2)
  })
})

// --- False-alarm protection: non-overlapping, genuinely distinct dates are
// NOT suppressed by F005's fix. -------------------------------------------

describe('F005 false-alarm check: distinct, non-overlapping dates are unaffected', () => {
  it('invoice_date and due_date on clearly separate lines both resolve to read, neither suppressed', () => {
    // Both dates unambiguous (day > 12): this test is about the overlap
    // guard, not about orientation evidence.
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Invoice date 21/02/2025', 10), mkLine('Due date 15/03/2025', 40)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    const dueDate = fields.find((f) => f.name === 'due_date')!
    expect(invoiceDate.state).toBe('read')
    expect(dueDate.state).toBe('read')
    expect(dueDate.value).toBe('2025-03-15')
  })
})

// --- False-alarm protection: F002's deglue does not break a normally
// spaced total line, and correctly maps offsets through TWO glue points
// earlier in the same line. -------------------------------------------

describe('F002 false-alarm + robustness checks', () => {
  it('a normally spaced total line is unaffected by deglueForMoney', () => {
    const page = { page: 1, width: 600, height: 800, items: [], lines: [mkLine('Total Due: 1,148.72', 10)] }
    const fields = extractHeaderFields([page as any], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
  })

  it('a second, earlier letter-digit glue point in the same line does not shift the provenance offset of the real match', () => {
    const text = 'A1 GRAND TOTAL1,148.72'
    const page = { page: 1, width: 600, height: 800, items: [], lines: [mkLine(text, 10)] }
    const fields = extractHeaderFields([page as any], 'text')
    const total = fields.find((f) => f.name === 'total')!
    expect(total.state).toBe('read')
    expect(total.value).toBe('1148.72')
    expect(total.provenance).not.toBeNull()
    expect(total.provenance!.bbox.x).toBe(text.indexOf('1,148.72'))
  })
})

// --- F003 false-alarm: a same-line label+value is not overridden by an
// unrelated date on the next line. -----------------------------------------

describe('F003 false-alarm check: same-line date wins, next-line fallback does not interfere', () => {
  it('a same-line "Invoice date: 2025-01-01" is read from that line, ignoring an unrelated date on the following line', () => {
    const page = {
      page: 1, width: 600, height: 800, items: [],
      lines: [mkLine('Invoice date: 2025-01-01', 10), mkLine('Printed 2099-12-31', 24)],
    }
    const fields = extractHeaderFields([page as any], 'text')
    const invoiceDate = fields.find((f) => f.name === 'invoice_date')!
    expect(invoiceDate.state).toBe('read')
    expect(invoiceDate.value).toBe('2025-01-01')
  })
})
