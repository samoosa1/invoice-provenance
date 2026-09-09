/**
 * Every field is accounted for, or the run raises.
 *
 * Ported from docguard's coverage.py (same author). The lesson there was
 * about classification: an `if/elif/else: skip` eventually meets a record
 * shaped slightly differently and drops it silently, and nobody notices
 * until a total does not add up, months later, by accident.
 *
 * The same failure is what a client means by "no silent drops". So the
 * count is not a summary computed at the end for display: it is an
 * invariant. A field is read, corrected, uncertain or not_found. Nothing
 * else exists, and the four must sum to the number of fields that went in.
 * The API asserts the same thing again on write, because a browser is not
 * a trusted narrator of its own totals.
 */

import type { Field } from './types'

export class CoverageError extends Error {}

export type Coverage = {
  total: number
  read: number
  corrected: number
  uncertain: number
  not_found: number
}

export function coverageOf(fields: Field[]): Coverage {
  const c: Coverage = { total: fields.length, read: 0, corrected: 0, uncertain: 0, not_found: 0 }
  const unplaced: string[] = []

  for (const f of fields) {
    // A human-sourced value is `corrected` whatever state the extractor
    // left it in: that is the distinction the export and the accuracy
    // table both turn on.
    if (f.source === 'human') c.corrected++
    else if (f.state === 'read') c.read++
    else if (f.state === 'uncertain') c.uncertain++
    else if (f.state === 'not_found') c.not_found++
    else unplaced.push(f.name)
  }

  if (unplaced.length > 0) {
    throw new CoverageError(`${unplaced.length} field(s) matched no state: ${unplaced.slice(0, 8).join(', ')}`)
  }
  assertCovers(c)
  return c
}

/** Throws unless the four buckets account for every field. */
export function assertCovers(c: Coverage): void {
  const sum = c.read + c.corrected + c.uncertain + c.not_found
  if (sum !== c.total) {
    throw new CoverageError(`coverage does not tie: ${sum} accounted for, ${c.total} fields in (${c.total - sum} unaccounted)`)
  }
}

/** The line the console prints, verbatim. */
export function coverageLine(c: Coverage): string {
  const unaccounted = c.total - (c.read + c.corrected + c.uncertain + c.not_found)
  return `${c.total} fields: ${c.read} read, ${c.corrected} corrected, ${c.uncertain} uncertain, ${c.not_found} not found. ${unaccounted} unaccounted.`
}
