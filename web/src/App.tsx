import { useCallback, useEffect, useMemo, useState } from 'react'

import './App.css'
import { coverageLine, coverageOf } from './domain/coverage'
import type { Field } from './domain/types'
import { ApiError, getRun, persistRun, type RunSummary } from './lib/api'
import { DropZone } from './ui/DropZone'
import { FieldTable, type Selection } from './ui/FieldTable'
import { LineItemTable } from './ui/LineItemTable'
import { PageViewer } from './ui/PageViewer'
import { readDocument, loadSampleFiles, type ExtractedDocument } from './ui/pipeline'

type Stage = 'idle' | 'reading' | 'results'
type ReadDoc = ExtractedDocument & { file: File }

const CLIENT_VERSION = 'web-0.3' // bumped when what the browser sends changes shape
const LAST_RUN_KEY = 'invoice-provenance:last-run'

export default function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [docs, setDocs] = useState<ReadDoc[]>([])
  const [pending, setPending] = useState(0)
  const [selection, setSelection] = useState<Selection>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<{ id: string } | { error: string } | null>(null)
  const [lastRun, setLastRun] = useState<RunSummary | null>(null)

  // What survived the last refresh: the most recent run this browser
  // saved, read back from Postgres. Nothing is shown if the API is down.
  useEffect(() => {
    const id = localStorage.getItem(LAST_RUN_KEY)
    if (!id) return
    getRun(id)
      .then(setLastRun)
      .catch(() => setLastRun(null))
  }, [saved])

  const reset = useCallback(() => {
    setStage('idle')
    setDocs([])
    setPending(0)
    setSelection(null)
    setError(null)
    setSaved(null)
    setBusy(false)
  }, [])

  const start = useCallback(async (files: File[]) => {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    if (pdfs.length === 0) {
      setError('No PDFs found. Drop invoice PDFs (text or scanned).')
      return
    }
    setError(null)
    setBusy(true)
    setSaved(null)
    setDocs([])
    setSelection(null)
    setPending(pdfs.length)
    setStage('reading')
    const read: ReadDoc[] = []
    try {
      // Sequential on purpose: a 2-core machine and an OCR engine that is a
      // memory hog gain nothing from overlapping documents.
      for (const file of pdfs) {
        try {
          const result = await readDocument(file)
          read.push({ ...result, file })
        } catch (e) {
          setError(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
        setDocs([...read])
        setPending((n) => n - 1)
      }
      setStage('results')
      if (read.length > 0) {
        setSelection({ doc: 0, name: 'total' })
        try {
          const id = await persistRun(read, CLIENT_VERSION)
          localStorage.setItem(LAST_RUN_KEY, id)
          setSaved({ id })
        } catch (e) {
          setSaved({ error: e instanceof ApiError ? e.message : `API unreachable: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const handleSample = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      await start(await loadSampleFiles(import.meta.env.BASE_URL))
    } catch (e) {
      setError(`Could not load the sample data: ${e instanceof Error ? e.message : String(e)}`)
      setBusy(false)
    }
  }, [start])

  const selectHeader = useCallback((doc: number, name: string) => setSelection({ doc, name }), [])

  const allFields = useMemo(() => docs.flatMap((d) => d.fields), [docs])
  const coverage = useMemo(() => (allFields.length ? coverageOf(allFields) : null), [allFields])
  const selectedDoc = selection ? docs[selection.doc] : undefined
  const selectedField: Field | undefined = selectedDoc?.fields.find((f) => f.name === selection!.name)

  return (
    <div className="shell">
      <aside className="rail">
        <div className="masthead">
          <h1>Every value, back to its pixels</h1>
          <p>
            Drop invoice PDFs. Each field comes back read, uncertain or not found, and a click on any value lights up the exact place on the page it was
            read from.
          </p>
        </div>

        <DropZone onFiles={(f) => void start(f)} onTrySample={() => void handleSample()} busy={busy} />

        {stage !== 'idle' && (
          <button className="btn" type="button" onClick={reset}>
            Start over
          </button>
        )}

        <p className="privacy">
          <strong>Your documents stay in this browser.</strong> Only the values you review are saved.
        </p>

        {lastRun && (
          <p className="lastrun muted">
            Last saved run: {lastRun.n_documents} document{lastRun.n_documents === 1 ? '' : 's'}
            {lastRun.coverage ? `, ${coverageLine(lastRun.coverage)}` : ''} <span className="mono faint">{lastRun.id.slice(0, 8)}</span>
          </p>
        )}
      </aside>

      <main className="stage">
        {error && (
          <p className="notice bad" role="alert">
            {error}
          </p>
        )}

        {stage === 'idle' && <EmptyState />}

        {stage !== 'idle' && (
          <>
            <div className="stage-head">
              <h2>{stage === 'reading' ? `Reading ${docs.length + pending} document${docs.length + pending === 1 ? '' : 's'}` : `${docs.length} document${docs.length === 1 ? '' : 's'}`}</h2>
              {coverage && (
                <p className="coverage mono" aria-live="polite">
                  {coverageLine(coverage)}
                </p>
              )}
            </div>

            {saved && (
              <p className={`notice ${'id' in saved ? 'ok' : 'warn'}`} role="status">
                {'id' in saved ? (
                  <>
                    Run saved to Postgres as <span className="mono">{saved.id.slice(0, 8)}</span>. Refresh the page: it is still there.
                  </>
                ) : (
                  <>Run not saved: {saved.error}. The extraction above is complete regardless.</>
                )}
              </p>
            )}

            <div className="results">
              <div className="tables">
                <FieldTable docs={docs} pending={pending} selection={selection} onSelect={selectHeader} />
                {selectedDoc && (
                  <section className="lineitems">
                    <h3>
                      Line items <span className="faint">{selectedDoc.fileName}</span>
                    </h3>
                    <LineItemTable fields={selectedDoc.fields} selectedName={selection?.name ?? null} onSelect={(name) => setSelection({ doc: selection!.doc, name })} />
                  </section>
                )}
              </div>
              <aside className="viewer-pane">
                {selectedDoc ? (
                  <>
                    <p className="viewer-caption muted">
                      {selectedField ? (
                        selectedField.provenance ? (
                          <>
                            <strong>{selectedField.name}</strong> on page {selectedField.provenance.page}
                            {selectedField.state !== 'read' && ' (the region it was torn over)'}
                          </>
                        ) : (
                          <>
                            <strong>{selectedField.name}</strong>: nothing to point at on the page
                          </>
                        )
                      ) : (
                        selectedDoc.fileName
                      )}
                    </p>
                    <PageViewer file={selectedDoc.file} highlight={selectedField?.provenance ?? null} />
                  </>
                ) : (
                  <div className="viewer-empty" aria-hidden="true" />
                )}
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/**
 * Names the three states before any file is dropped, in the tags they will
 * wear in the table, so the output area is legible before it has output.
 */
function EmptyState() {
  return (
    <section className="empty rise">
      <h2>Three states, nothing else</h2>
      <ol>
        <li>
          <span className="tag ok">read</span>
          <span className="detail">The value, with the box on the page it came from. Click it and see.</span>
        </li>
        <li>
          <span className="tag warn">uncertain</span>
          <span className="detail">Two readings disagree, or OCR is not confident. Goes to review, never to the output.</span>
        </li>
        <li>
          <span className="tag idle">not found</span>
          <span className="detail">The page prints no such value. Said plainly, not filled in.</span>
        </li>
      </ol>
      <p className="muted" style={{ marginTop: 'var(--sp-5)' }}>
        Every run ends with one line: how many fields went in, and how many came out as each state. The four always add up, or the run refuses to
        report.
      </p>
    </section>
  )
}
