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
 * Compose and the dev API both default to this value; a deployment sets
 * VITE_WORKSPACE_TOKEN at build time to match its WORKSPACE_TOKEN. */
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
export async function persistRun(docs: PersistableDocument[], clientVersion: string): Promise<string> {
  const all = docs.flatMap((d) => d.fields)
  const { id: runId } = await call<{ id: string }>('POST', '/api/runs', {
    n_documents: docs.length,
    client_version: clientVersion,
    coverage: coverageOf(all),
  })
  for (const d of docs) {
    const { id: documentId } = await call<{ id: string }>('POST', `/api/runs/${runId}/documents`, {
      fingerprint: d.fingerprint,
      file_name: d.fileName,
      page_count: d.pageCount,
    })
    await call('POST', `/api/runs/${runId}/fields`, {
      document_id: documentId,
      coverage: coverageOf(d.fields),
      fields: d.fields.map(toWire),
    })
  }
  return runId
}

export function getRun(runId: string): Promise<RunSummary> {
  return call<RunSummary>('GET', `/api/runs/${runId}`)
}
