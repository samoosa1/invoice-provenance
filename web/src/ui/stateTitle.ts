/**
 * Each state carries a tooltip that says what the state means, because a
 * word on its own ("uncertain") tells the visitor what happened, not what
 * to do about it or what the tool is promising.
 */
import type { Field } from '../domain/types'

export function stateTitle(f: Field): string {
  switch (f.state) {
    case 'read':
      return f.source === 'ocr'
        ? `Read by OCR at ${f.confidence ?? '?'}% confidence. Click to see where on the page.`
        : 'Read from the page. Click to see exactly where.'
    case 'uncertain':
      return f.candidates && f.candidates.length > 1
        ? `Torn between ${f.candidates.join(' and ')}. Goes to review, never to the output.`
        : f.candidates && f.candidates.length === 1
          ? `Found "${f.candidates[0]}" but not confidently enough. Goes to review, never to the output.`
          : 'Could not be read. Goes to review, never to the output.'
    case 'not_found':
      return f.source === 'ocr' ? 'OCR found no such value; the scan may still print one. Goes to review.' : 'The page prints no such value.'
  }
}
