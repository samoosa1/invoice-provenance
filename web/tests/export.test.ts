/** The export carries every field, and the CSV guards what a person typed. */
import { describe, expect, it } from 'vitest'

import { EXPORT_HEADERS, exportRows, guardFormula, toCsv } from '../src/domain/exportRows'
import type { Field } from '../src/domain/types'

function field(name: string, over: Partial<Field> = {}): Field {
  return { name, value: '1.00', state: 'read', source: 'text', provenance: { page: 1, bbox: { x: 1.234, y: 2, width: 3, height: 4 } }, confidence: null, candidates: null, ...over }
}

describe('exportRows', () => {
  it('one row per field in document order, whatever its state; boxes to 2dp; candidates joined', () => {
    const rows = exportRows([
      { fileName: 'a.pdf', fields: [field('total'), field('currency', { value: null, state: 'uncertain', candidates: ['USD', 'AUD'], provenance: null })] },
      { fileName: 'b.pdf', fields: [field('due_date', { value: null, state: 'not_found', provenance: null })] },
    ])
    expect(rows).toEqual([
      ['a.pdf', 'total', '1.00', 'read', 'text', 1, 1.23, 2, 3, 4, null],
      ['a.pdf', 'currency', null, 'uncertain', 'text', null, null, null, null, null, 'USD | AUD'],
      ['b.pdf', 'due_date', null, 'not_found', 'text', null, null, null, null, null, null],
    ])
    expect(rows[0]).toHaveLength(EXPORT_HEADERS.length)
  })
})

describe('CSV formula-injection guard', () => {
  it('guards = + - @ and tab/CR at the start of a value', () => {
    for (const v of ['=SUM(A1:A9)', '+1', '-1', '@cmd', '\tx', '\rx']) expect(guardFormula(v)).toBe(`'${v}`)
    expect(guardFormula('Bluefern Supplies Ltd')).toBe('Bluefern Supplies Ltd')
    expect(guardFormula('1,234.56')).toBe('1,234.56')
  })

  it('applies to human-typed values only; extractor values and other columns are untouched', () => {
    const csv = toCsv(
      exportRows([
        {
          fileName: 'a.pdf',
          fields: [field('vendor', { value: '=HYPERLINK("http://x")', source: 'human' }), field('tax', { value: '-12.00' }), field('note', { value: '-typed', source: 'human', state: 'uncertain' })],
        },
      ]),
    )
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(EXPORT_HEADERS.join(','))
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"")"`) // guarded, then CSV-quoted for the quotes it contains
    expect(lines[2]).toContain(',-12.00,read,text,') // extractor value, not guarded
    expect(lines[3]).toContain(",'-typed,uncertain,human,")
  })

  it('quotes cells holding commas, quotes or newlines', () => {
    const csv = toCsv([['a,b', 'say "hi"', 'x\ny', null, 1, null, null, null, null, null, null]])
    expect(csv.split('\r\n')[1]).toBe('"a,b","say ""hi""","x\ny",,1,,,,,,')
  })
})
