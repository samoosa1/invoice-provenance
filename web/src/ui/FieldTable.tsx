/**
 * One row per document, one column per header field. Clicking a cell
 * selects that field, and the PageViewer draws its box.
 *
 * Rows are memoised (React.memo on Row, stable callbacks) so hovering or
 * selecting one cell does not re-render 25 x 8 cells: only the row that
 * lost the selection and the row that gained it render again.
 *
 * Each state carries a tooltip that says what the state means, because a
 * word on its own ("uncertain") tells the visitor what happened, not what
 * to do about it or what the tool is promising.
 */
import { memo } from 'react'

import { HEADER_FIELDS } from '../domain/accuracy'
import type { Field } from '../domain/types'
import { stateTitle } from './stateTitle'

export type Selection = { doc: number; name: string } | null

export type TableDocument = {
  fileName: string
  source: 'text' | 'ocr' | 'human'
  fields: Field[]
  flags: string[]
}

const LABEL: Record<(typeof HEADER_FIELDS)[number], string> = {
  invoice_number: 'Invoice no.',
  vendor: 'Vendor',
  invoice_date: 'Date',
  due_date: 'Due',
  currency: 'Ccy',
  subtotal: 'Subtotal',
  tax: 'Tax',
  total: 'Total',
}

const MONEY = new Set(['subtotal', 'tax', 'total'])

type RowProps = {
  index: number
  doc: TableDocument
  selectedName: string | null
  onSelect: (doc: number, name: string) => void
}

const Row = memo(function Row({ index, doc, selectedName, onSelect }: RowProps) {
  const byName = new Map(doc.fields.map((f) => [f.name, f]))
  return (
    <tr>
      <td className="file">
        <span className="clip" title={doc.fileName}>
          {doc.fileName}
        </span>
        <span className={`tag ${doc.source === 'ocr' ? 'live' : 'idle'}`} title={doc.source === 'ocr' ? 'No text layer: read by OCR in this browser' : 'Text layer read directly'}>
          {doc.source}
        </span>
        {doc.flags.map((flag) => (
          <span key={flag} className="tag warn" title={flag === 'line_sum_mismatch' ? 'The line items do not add up to the subtotal' : 'Line items could not be checked against the subtotal'}>
            {flag.replace(/_/g, ' ')}
          </span>
        ))}
      </td>
      {HEADER_FIELDS.map((name) => {
        const f = byName.get(name)
        if (!f) return <td key={name} />
        const selected = selectedName === name
        return (
          <td key={name} className={MONEY.has(name) ? 'num' : undefined}>
            <button
              type="button"
              className={`cell ${f.state}${selected ? ' selected' : ''}${f.provenance ? '' : ' noloc'}`}
              title={stateTitle(f)}
              aria-pressed={selected}
              onClick={() => onSelect(index, name)}
            >
              {f.state === 'read' ? (
                <span className={MONEY.has(name) || name === 'invoice_date' || name === 'due_date' ? 'mono' : undefined}>{f.value}</span>
              ) : (
                <span className={`tag ${f.state === 'uncertain' ? 'warn' : 'idle'}`}>{f.state === 'uncertain' ? 'uncertain' : 'not found'}</span>
              )}
            </button>
          </td>
        )
      })}
    </tr>
  )
})

type Props = {
  docs: TableDocument[]
  pending: number // skeleton rows still to come
  selection: Selection
  onSelect: (doc: number, name: string) => void
}

export function FieldTable({ docs, pending, selection, onSelect }: Props) {
  return (
    <div className="table-scroll">
      <table className="grid fields">
        <thead>
          <tr>
            <th>File</th>
            {HEADER_FIELDS.map((n) => (
              <th key={n} className={MONEY.has(n) ? 'num' : undefined}>
                {LABEL[n]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {docs.map((d, i) => (
            <Row key={d.fileName + i} index={i} doc={d} selectedName={selection?.doc === i ? selection.name : null} onSelect={onSelect} />
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <tr key={`skeleton-${i}`} className="skeleton" aria-hidden="true">
              <td>
                <span className="bone" style={{ width: '9ch' }} />
              </td>
              {HEADER_FIELDS.map((n) => (
                <td key={n}>
                  <span className="bone" style={{ width: MONEY.has(n) ? '6ch' : '5ch' }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
