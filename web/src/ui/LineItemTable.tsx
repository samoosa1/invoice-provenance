/** The selected document's line items, one row per item, each cell selectable like a header field. */
import { LINE_ITEM_FIELDS, parseLineItemName } from '../domain/lineItems'
import type { Field } from '../domain/types'
import { stateTitle } from './stateTitle'

type Props = {
  fields: Field[]
  selectedName: string | null
  onSelect: (name: string) => void
}

export function LineItemTable({ fields, selectedName, onSelect }: Props) {
  const rows = new Map<number, Map<string, Field>>()
  for (const f of fields) {
    const p = parseLineItemName(f.name)
    if (!p) continue
    if (!rows.has(p.index)) rows.set(p.index, new Map())
    rows.get(p.index)!.set(p.column, f)
  }
  if (rows.size === 0) return <p className="muted">No line items were found on this document.</p>
  return (
    <div className="table-scroll">
      <table className="grid items">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {[...rows.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([i, cells]) => (
              <tr key={i}>
                <td className="faint mono">{i + 1}</td>
                {LINE_ITEM_FIELDS.map((column) => {
                  const f = cells.get(column)
                  if (!f) return <td key={column} />
                  const selected = selectedName === f.name
                  return (
                    <td key={column} className={column === 'description' ? undefined : 'num'}>
                      <button type="button" className={`cell ${f.state}${selected ? ' selected' : ''}`} title={stateTitle(f)} aria-pressed={selected} onClick={() => onSelect(f.name)}>
                        {f.state === 'read' ? (
                          <span className={column === 'description' ? undefined : 'mono'}>{f.value}</span>
                        ) : f.state === 'uncertain' ? (
                          <span className="tag warn">uncertain</span>
                        ) : (
                          <span className="faint">–</span>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
