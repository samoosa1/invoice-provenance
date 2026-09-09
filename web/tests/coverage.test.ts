import { describe, expect, it } from 'vitest'

import { CoverageError, assertCovers, coverageLine, coverageOf } from '../src/domain/coverage'
import type { Field } from '../src/domain/types'

const field = (over: Partial<Field>): Field => ({
  name: 'total', value: '10.00', state: 'read', source: 'text',
  provenance: { page: 1, bbox: { x: 0, y: 0, width: 1, height: 1 } },
  confidence: null, candidates: null, ...over,
})

describe('coverageOf', () => {
  it('counts each field once and ties to the input', () => {
    const c = coverageOf([
      field({ name: 'a' }),
      field({ name: 'b', state: 'uncertain', value: null, candidates: ['1', '2'] }),
      field({ name: 'c', state: 'not_found', value: null, provenance: null }),
      field({ name: 'd', source: 'human' }),
    ])
    expect(c).toEqual({ total: 4, read: 1, corrected: 1, uncertain: 1, not_found: 1 })
    expect(coverageLine(c)).toBe('4 fields: 1 read, 1 corrected, 1 uncertain, 1 not found. 0 unaccounted.')
  })

  it('counts a human value as corrected even when the extractor had read it', () => {
    const c = coverageOf([field({ state: 'read', source: 'human' })])
    expect(c).toEqual({ total: 1, read: 0, corrected: 1, uncertain: 0, not_found: 0 })
  })

  it('refuses a field in a state nobody declared', () => {
    const rogue = field({ name: 'ghost', state: 'skipped' as unknown as Field['state'] })
    expect(() => coverageOf([rogue])).toThrow(CoverageError)
    expect(() => coverageOf([rogue])).toThrow(/ghost/)
  })

  it('is empty-safe', () => {
    expect(coverageOf([])).toEqual({ total: 0, read: 0, corrected: 0, uncertain: 0, not_found: 0 })
  })
})

describe('assertCovers', () => {
  it('rejects a count that does not tie', () => {
    expect(() => assertCovers({ total: 9, read: 4, corrected: 1, uncertain: 1, not_found: 1 }))
      .toThrow(/2 unaccounted/)
  })
})
