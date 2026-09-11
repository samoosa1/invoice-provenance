/**
 * Everything that did not reach the output: every `uncertain` and
 * `not_found` field, across documents, with the three actions. Accept a
 * candidate, type a value, or say the page cannot be read. Each ruling is
 * POSTed, the field flips to `source: human`, the coverage line moves one
 * from its old bucket into `corrected`.
 *
 * On OCR, `not_found` is weaker than on a text layer (the scan may print a
 * value tesseract missed), which is why OCR not_found sits in this queue
 * too rather than being trusted as "the page prints nothing".
 */
import { useState } from 'react'

import type { Field } from '../domain/types'
import { type CorrectionAction } from '../lib/api'

export type ReviewItem = { doc: number; fileName: string; index: number; field: Field }

type Props = {
  items: ReviewItem[]
  /** null while the run is not saved: rulings have nowhere to go. */
  canPersist: boolean
  onRule: (item: ReviewItem, action: CorrectionAction, value: string | null) => Promise<void>
  onFocus: (item: ReviewItem) => void
  focused: { doc: number; name: string } | null
}

export function ReviewQueue({ items, canPersist, onRule, onFocus, focused }: Props) {
  // A text layer is exact: its not_found means the page prints nothing, and
  // there is nothing for a person to rule on unless they disagree. Those sit
  // folded at the bottom; OCR not_found and every uncertain field stay open.
  const active = items.filter((i) => !(i.field.state === 'not_found' && i.field.source === 'text'))
  const absent = items.filter((i) => i.field.state === 'not_found' && i.field.source === 'text')
  if (items.length === 0) {
    return (
      <section className="review">
        <h3>Review queue</h3>
        <p className="muted">Nothing waiting. Every field either read or was ruled on.</p>
      </section>
    )
  }
  return (
    <section className="review">
      <h3>
        Review queue <span className="faint">{active.length} waiting</span>
      </h3>
      {!canPersist && <p className="notice warn">The run was not saved, so rulings cannot be stored. Start the API and run again.</p>}
      {active.length === 0 && <p className="muted">Nothing uncertain is waiting.</p>}
      <ul className="review-list">
        {active.map((item) => (
          <ReviewRow
            key={`${item.doc}:${item.field.name}`}
            item={item}
            disabled={!canPersist}
            onRule={onRule}
            onFocus={onFocus}
            focused={focused?.doc === item.doc && focused.name === item.field.name}
          />
        ))}
      </ul>
      {absent.length > 0 && (
        <details className="review-absent">
          <summary>
            {absent.length} field{absent.length === 1 ? '' : 's'} the page does not print (text layer, certain). Open to overrule one.
          </summary>
          <ul className="review-list">
            {absent.map((item) => (
              <ReviewRow
                key={`${item.doc}:${item.field.name}`}
                item={item}
                disabled={!canPersist}
                onRule={onRule}
                onFocus={onFocus}
                focused={focused?.doc === item.doc && focused.name === item.field.name}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function ReviewRow({
  item,
  disabled,
  onRule,
  onFocus,
  focused,
}: {
  item: ReviewItem
  disabled: boolean
  onRule: Props['onRule']
  onFocus: Props['onFocus']
  focused: boolean
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const f = item.field

  const rule = async (action: CorrectionAction, value: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await onRule(item, action, value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`review-item${focused ? ' focused' : ''}`}>
      <button type="button" className="review-target" onClick={() => onFocus(item)} title="Show on the page">
        <span className="clip">{item.fileName}</span>
        <span className="mono">{f.name}</span>
        <span className={`tag ${f.state === 'uncertain' ? 'warn' : 'idle'}`}>{f.state === 'uncertain' ? 'uncertain' : 'not found'}</span>
        {f.source === 'ocr' && <span className="tag live">ocr</span>}
      </button>
      <div className="review-actions">
        {(f.candidates ?? []).map((c) => (
          <button key={c} type="button" className="btn small" disabled={disabled || busy} onClick={() => void rule('accept', c)} title="Accept this reading">
            Accept <span className="mono">{c}</span>
          </button>
        ))}
        <form
          className="review-type"
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim()) void rule('correct', typed.trim())
          }}
        >
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type the value"
            aria-label={`Correct ${f.name} of ${item.fileName}`}
            disabled={disabled || busy}
            maxLength={512}
          />
          <button type="submit" className="btn small primary" disabled={disabled || busy || !typed.trim()}>
            Save
          </button>
        </form>
        <button type="button" className="btn small" disabled={disabled || busy} onClick={() => void rule('unreadable', null)} title="Record that a person could not read it either">
          Unreadable
        </button>
      </div>
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
