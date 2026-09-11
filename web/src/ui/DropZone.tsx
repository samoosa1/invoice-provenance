// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
import { useCallback, useRef, useState } from 'react'

interface Props {
  onFiles: (files: File[]) => void
  onTrySample: () => void
  busy: boolean
}

/**
 * One drop target. It is a real <button>, not a div with a click handler,
 * so it is keyboard-operable and announced correctly without reimplementing
 * those affordances by hand.
 */
export function DropZone({ onFiles, onTrySample, busy }: Props) {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setOver(false)
      if (busy) return
      onFiles([...e.dataTransfer.files])
    },
    [onFiles, busy],
  )

  return (
    <div>
      <button
        type="button"
        className={`dropzone${over ? ' over' : ''}${busy ? ' busy' : ''}`}
        disabled={busy}
        onDragOver={(e) => {
          e.preventDefault()
          if (!busy) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,application/pdf"
          hidden
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])])
            // Reset so re-selecting the same files fires change again.
            e.target.value = ''
          }}
        />
        <span className="drop-title">Drop invoice PDFs</span>
        <span className="drop-sub">Text PDFs or scans, one or many, or click to browse</span>
      </button>

      <p className="drop-alt">
        or{' '}
        <button type="button" className="link-btn" onClick={onTrySample} disabled={busy}>
          try it with sample data
        </button>
      </p>
    </div>
  )
}
