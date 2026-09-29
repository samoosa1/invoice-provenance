/**
 * The browser's half of the wire. What crosses it is exactly what
 * api/app/schemas.py accepts: per-field {name, value, state, source, page,
 * bbox, confidence, candidates} plus a fingerprint and a file name. No page
 * text, no bytes. The server recounts every coverage line it is sent and
 * refuses the write (422) if the browser's arithmetic and its own disagree.
 */

import { coverageOf, type Coverage } from '../domain/coverage'
import type { Field } from '../domain/types'

/** One shared workspace token for the demo (multi-tenant is out of scope).
 * The dev server and the dev API both default to this value. A production
 * build refuses to run without VITE_WORKSPACE_TOKEN (see vite.config.ts), so
 * the fallback below is only ever reached in dev. */
const TOKEN: string = import.meta.env.VITE_WORKSPACE_TOKEN ?? 'dev-token-change-me'

export class ApiError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(`API ${status}: ${detail}`)
    this.status = status
    this.detail = detail
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j = (await res.json()) as { detail?: unknown }
      if (j.detail !== undefined) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* no JSON body */
    }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as T
}

export type PersistableDocument = {
  fileName: string
  fingerprint: string
  pageCount: number
  fields: Field[]
}

export type RunSummary = {
  id: string
  n_documents: number
  client_version: string | null
  coverage: Coverage | null
  field_counts: Record<string, number>
}

/** Field -> FieldIn. Provenance is flattened to page + bbox. */
function toWire(f: Field) {
  return {
    name: f.name,
    value: f.value,
    state: f.state,
    source: f.source,
    page: f.provenance?.page ?? null,
    bbox: f.provenance?.bbox ?? null,
    confidence: f.confidence,
    candidates: f.candidates,
  }
}

/**
 * Creates a run, upserts each document by fingerprint, writes its fields
 * with its own coverage line. Sequential: the API is one transaction per
 * call and the point is a readable failure, not throughput.
 */
export type PersistedRun = {
  runId: string
  /** fieldIds[d][i] is the server id of docs[d].fields[i]. */
  fieldIds: string[][]
}

export async function persistRun(docs: PersistableDocument[], clientVersion: string): Promise<PersistedRun> {
  const all = docs.flatMap((d) => d.fields)
  const { id: runId } = await call<{ id: string }>('POST', '/api/runs', {
    n_documents: docs.length,
    client_version: clientVersion,
    coverage: coverageOf(all),
  })
  const fieldIds: string[][] = []
  for (const d of docs) {
    const { id: documentId } = await call<{ id: string }>('POST', `/api/runs/${runId}/documents`, {
      fingerprint: d.fingerprint,
      file_name: d.fileName,
      page_count: d.pageCount,
    })
    const { ids } = await call<{ written: number; ids: string[] }>('POST', `/api/runs/${runId}/fields`, {
      document_id: documentId,
      coverage: coverageOf(d.fields),
      fields: d.fields.map(toWire),
    })
    fieldIds.push(ids)
  }
  return { runId, fieldIds }
}

export type CorrectionAction = 'accept' | 'correct' | 'unreadable'

type WireField = ReturnType<typeof toWire> & { id: string }

/** One review ruling. Returns the field as the server now holds it and the run's recounted coverage. */
export async function postCorrection(fieldId: string, action: CorrectionAction, value: string | null): Promise<{ field: Field; runCoverage: Coverage }> {
  const out = await call<{ field: WireField; run_coverage: Coverage }>('POST', `/api/fields/${fieldId}/corrections`, { action, value })
  const f = out.field
  return {
    field: {
      name: f.name,
      value: f.value,
      state: f.state,
      source: f.source,
      provenance: f.page !== null && f.bbox ? { page: f.page, bbox: f.bbox } : null,
      confidence: f.confidence,
      candidates: f.candidates,
    },
    runCoverage: out.run_coverage,
  }
}

export function getRun(runId: string): Promise<RunSummary> {
  return call<RunSummary>('GET', `/api/runs/${runId}`)
}
