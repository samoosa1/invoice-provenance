/**
 * The one line every run ends with, verbatim from coverageLine(), plus each
 * bucket as a labelled figure so the arithmetic is visible, not just stated.
 */
import { coverageLine, type Coverage } from '../domain/coverage'

export function CoverageLine({ coverage }: { coverage: Coverage }) {
  const unaccounted = coverage.total - (coverage.read + coverage.corrected + coverage.uncertain + coverage.not_found)
  return (
    <div className="coverage" aria-live="polite">
      <p className="mono">{coverageLine(coverage)}</p>
      <ul className="buckets">
        <li>
          <span className="tag ok">read</span> {coverage.read}
        </li>
        <li>
          <span className="tag human">corrected</span> {coverage.corrected}
        </li>
        <li>
          <span className="tag warn">uncertain</span> {coverage.uncertain}
        </li>
        <li>
          <span className="tag idle">not found</span> {coverage.not_found}
        </li>
        <li className={unaccounted === 0 ? 'faint' : 'bad'}>{unaccounted} unaccounted</li>
      </ul>
    </div>
  )
}
