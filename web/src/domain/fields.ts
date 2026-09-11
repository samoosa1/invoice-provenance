// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/**
 * Pulls the eight header fields out of a page's assembled lines. The label
 * patterns, money parsing and vendor heuristics below are copied from
 * ledger-reconciler's domain/extract.ts (see the attribution above); what's
 * new here is running them per LINE instead of over one flattened string,
 * so every match can carry a `boxFor`-computed provenance box back to the
 * pixels it came from, and the six-clause read/uncertain/not_found rule in
 * `resolveField` that decides what a field is allowed to claim.
 */

import { boxFor } from './spans'
import { parseDate, toISO, type PlainDate } from './dates'
import type { BBox, Field, FieldSource, Line, PdfPage } from './types'

// --- copied verbatim from ledger-reconciler/web/src/domain/extract.ts -----

/**
 * A money value in any of the three common shapes, with optional sign,
 * symbol and ISO code around it. Group 1 is the numeric part.
 */
const MONEY = String.raw`(?:[-−]\s*)?(?:[$€£₺]\s*)?(?:[A-Z]{3}\s*)?(-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|-?\d+[.,]\d{2})(?:\s*[A-Z]{3})?`

/**
 * '1,234.56' / '1.234,56' / '1234.56' / '16.396,10' -> number. The LAST
 * separator and the digit count after it decide which one is the decimal
 * point; a lone separator followed by exactly three digits is a thousands
 * group. Anything else is null, never a guess.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '').replace(/−/g, '-')
  const neg = s.startsWith('-')
  s = s.replace(/^-+/, '')
  if (!s) return null
  const pos = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','))
  let digits: string
  if (pos === -1) {
    digits = s
  } else {
    const tail = s.slice(pos + 1)
    if (tail.length === 2) digits = s.slice(0, pos).replace(/[.,]/g, '') + '.' + tail
    else if (tail.length === 3) digits = s.replace(/[.,]/g, '')
    else return null
  }
  if (!/^\d+(\.\d+)?$/.test(digits)) return null
  const v = Number(digits)
  return neg ? -v : v
}

const DATE_VALUE = String.raw`(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`

/**
 * `[ \t]*` (never `\s*`) between label and value: text extraction of a
 * multi-column layout puts the NEXT column's label or value on the line
 * below, so crossing a newline reads a customer number as the invoice
 * number. The value must contain a digit, so "Invoice date" is never read
 * as an invoice number.
 */
const NUMBER_PATTERNS = [
  /\b(?:invoice|receipt|credit\s*note|credit\s*memo|tax\s*invoice|bill)[ \t]*(?:number|no\.?|nr\.?|num\.?|#|id)[ \t]*[:.]?[ \t]*([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)/gi,
  /\b(?:ref(?:erence)?|our[ \t]*ref)[ \t]*(?:number|no\.?|#)?[ \t]*[:.]?[ \t]*([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)/gi,
  /\b(?:invoice|receipt)[ \t]*#?[ \t]*([A-Z]{1,5}[-/]?\d[A-Z0-9/-]*|\d{3,})\b(?![ \t]*(?:date|due))/gi,
]

/**
 * Ordered from most to least specific. "Subtotal" is excluded by the
 * lookbehind so a subtotal line can never be mistaken for the total. JUNK
 * absorbs OCR debris between a label and its value ('- °  « ') but never
 * letters or digits, so a total label cannot reach past a real word.
 */
const TOTAL_LABELS = [
  String.raw`total\s*payable`, String.raw`total\s*amount\s*due`, String.raw`balance\s*due`,
  String.raw`amount\s*due`, String.raw`total\s*due`, String.raw`grand\s*total`,
  String.raw`(?<!sub)(?<!sub\s)total\s*(?:incl\.?\s*(?:vat|tax|gst)|ttc|brutto)?`,
]
const JUNK = String.raw`[^\w\n]{0,14}?`
const AMOUNT_PATTERNS = TOTAL_LABELS.map((lab) => new RegExp(String.raw`\b` + lab + String.raw`\b` + JUNK + MONEY, 'i'))
AMOUNT_PATTERNS.push(new RegExp(MONEY + String.raw`\s*due\b`, 'i')) // "$875.00 due"

const DATE_LABEL_PATTERNS = [
  new RegExp(String.raw`\b(?:invoice\s*date|issue\s*date|issued|date\s*of\s*issue|tax\s*point)\s*[:.]?\s*` + DATE_VALUE, 'gi'),
  new RegExp(String.raw`(?<!due\s)(?<!due)\bdate\s*[:.]?\s*` + DATE_VALUE, 'gi'),
  new RegExp(String.raw`\breceipt\s*#?\s*\d+\s+` + DATE_VALUE, 'gi'), // thermal: "Receipt #478 01/16/25"
]
/** Last resort: an unlabelled, unambiguous (year-first) date alone on a line. */
const DATE_BARE_LINE = /^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*$/m

const VENDOR_LABEL_SAMELINE = /^(?:vendor|from|sold\s*by|supplier|company)\s*:?\s*(\S.*)$/im
// Kept for parity with the original (its `$\n` dependency doesn't survive
// per-line matching); VENDOR_LABEL_ONLY below is its per-line equivalent.
const VENDOR_LABEL_NEXTLINE: RegExp = /^(?:vendor|from|sold\s*by|supplier|company)\s*:?\s*$\n(.+)$/im
void VENDOR_LABEL_NEXTLINE

/** A line starting with any of these is boilerplate, not a company name. */
const BOILERPLATE_START = [
  'invoice', 'receipt', 'bill to', 'ship to', 'page', 'payment', 'customer', 'credit',
  'contact', 'thanks', 'please', 'terms', 'note', 'due', 'total', 'order', 'tax invoice',
  'date', 'ref', 'document', 'account', 'register', 'for ', 'issued', 'commercial',
]
const VENDOR_SCAN_WINDOW = 6
// No bare `$` alternative here: `\b\$` is NOT unreachable (a `\b` holds
// whenever a word character immediately precedes `$`, which a glued run
// like "GST$762.68" produces), so a lone `$` inside a table cell used to
// flip preferUS, and every ambiguous date in the whole document, for the
// entire document (see R012). `$` is not a US-specific signal on its own.
const US_HINTS = /\b(?:USD|EIN|Sales tax|Net 30|, [A-Z]{2} \d{5})/i

// Symmetric non-US evidence, built next to CURRENCY_HINTS below from signals
// the module already derives: a non-US currency symbol/ISO code, or a
// tax-registration token that only appears on non-US documents. Measured
// against all 20 text-layer sample invoices: US_HINTS fires on 8, NON_US_HINTS
// on 12, neither fires on both or on neither, so 'none' below is the genuine
// empty-evidence case in this corpus, not a fallback we're papering over.
const NON_US_HINTS = /[£€₺]|\b(?:GBP|EUR|AUD|TRY|NOK|SEK|CHF)\b|VAT\s*Reg\s*No|MwSt|USt-IdNr|\bABN\b|\bGST\b/
const ABBREV_END = /\b(?:ltd|inc|co|corp|gmbh|a\.ş|s\.a|s\.r\.l|as|llc|plc|pty|bv|nv|oy|ab|sas|sarl|kg|ag)\.$/i

/** Python's str.isupper(): all cased chars upper, and at least one exists. */
function isUpper(s: string): boolean {
  return /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s)
}

function looksLikeAName(line: string): boolean {
  const low = line.toLowerCase()
  if (BOILERPLATE_START.some((w) => low.startsWith(w))) return false
  const words = line.trim().split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 6) return false
  if (!/\p{L}/u.test(line)) return false
  if (line === low || (words.length === 1 && !/^\p{Lu}/u.test(line))) return false // "name": a column label
  if (words.length === 1 && ['name', 'address', 'number', 'total', 'amount', 'description', 'quantity'].includes(low)) return false
  if ((line.match(/\d/g) ?? []).length > 3) return false // addresses, tax ids, phone numbers
  const letters = (line.match(/\p{L}/gu) ?? []).length
  if (letters / Math.max(1, line.replace(/\s/g, '').length) < 0.75) return false // OCR debris
  if (words.filter((w) => w.length >= 3).length < Math.max(1, Math.floor(words.length / 2))) return false
  if (low.endsWith('.') && !isUpper(line) && !ABBREV_END.test(low)) return false
  return true
}

function cleanVendor(name: string): string {
  let s = name.replace(/^[^\p{L}\p{N}(]+/u, '') // OCR debris in front
  s = s.replace(/\s*[·|\-–—:.]*\s*(?:tax\s*)?(?:invoice|credit\s*note|receipt|statement)\s*$/i, '')
  // a logo square or stamp in front of the letterhead comes out as "P|", "@B", "(BB";
  // a glued table header comes out as "Pinehollow Office Co Document type"
  s = s.split(/\s+(?:Document|Invoice|Customer|Tax\s+invoice|Date|VAT|Bill\s+to)\b/i)[0]
  const tokens = s.split(/\s+/).filter(Boolean)
  while (tokens.length > 1 && (/[^\p{L}\p{N}&'.-]/u.test(tokens[0]) || (tokens[0].length <= 2 && !['A', 'I'].includes(tokens[0])))) {
    tokens.shift()
  }
  while (tokens.length && (!/\p{L}/u.test(tokens[tokens.length - 1]) || /[+?*=<>|~^_@#%]/.test(tokens[tokens.length - 1]))) {
    tokens.pop()
  }
  s = tokens.join(' ').replace(/\s{2,}/g, ' ').replace(/^[\s,\-·]+|[\s,\-·]+$/g, '')
  if (s.endsWith('.') && !ABBREV_END.test(s)) s = s.slice(0, -1)
  return s
}

/**
 * Normalises line endings (VENDOR_LABEL_NEXTLINE depends on `$\n`) and
 * separates a label glued to its value ("Invoice numberWS-0622"), which
 * both pypdf and pdf.js produce for tightly set table cells.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/([a-z])([A-Z]{2,}|\d)/g, '$1 $2')
    .replace(/ /g, ' ')
}

// --- new for this task: per-line matching with per-value provenance -------

export type Candidate = {
  value: string
  raw: string
  page: number
  bbox: BBox | null
  confidence: number | null
  patternRank: number
}

/** Tesseract's own conventional confidence floor; below this, treat an OCR read as unreliable. */
export const OCR_CONFIDENCE_FLOOR = 70

/** The guard appended after every money-valued pattern below, so a percentage
 * is never read as an amount: without it, `TAX 8.875%` yields 8.87 because
 * MONEY is unanchored and happily matches the digits before the `%`. */
const MONEY_GUARD = String.raw`(?![\d%])`

type PatternDef = { rank: number; re: RegExp }

/** Runs every pattern against every line of a page, in line-then-rank order. */
function scanPage<T>(page: PdfPage, patterns: PatternDef[], build: (m: RegExpExecArray, line: Line, rank: number) => T | null): T[] {
  const out: T[] = []
  for (const line of page.lines) {
    for (const { rank, re } of patterns) {
      for (const m of line.text.matchAll(re)) {
        const c = build(m as RegExpExecArray, line, rank)
        if (c) out.push(c)
      }
    }
  }
  return out
}

/**
 * Re-establishes normalise()'s label/value de-gluing for the money patterns,
 * which are the only ones that need it: a TOTAL/SUBTOTAL/TAX label pattern
 * ends in `\b`, and a label glued straight to its digits ("TOTAL DUE1,148.72")
 * has no boundary between a letter and a digit (both are `\w`), so the label
 * never matches. Mirrors BOTH of normalise()'s glue classes
 * (`([a-z])([A-Z]{2,}|\d)`): letter-then-digit ("Invoice numberWS-0622") AND
 * lowercase-then-ALLCAPS ("Total for ServicesTOTAL DUE"), so a label like
 * "TOTAL DUE" glued to the preceding word also gets its own boundary and can
 * match. Inserts a single space at every such boundary and returns a mapper
 * from an offset in the deglued text back to the ORIGINAL line text, so
 * boxFor still resolves to the right characters. The inserted space can only
 * ever land right before a digit run or an uppercase run, never inside one,
 * and a captured money value is digits and punctuation only, so the mapping
 * is always exact.
 */
function deglueForMoney(text: string): { text: string; toOriginal: (i: number) => number } {
  let out = ''
  const map: number[] = [0] // map[k] = original index just past out[0..k)
  for (let i = 0; i < text.length; i++) {
    const glueDigit = i > 0 && /[A-Za-z]/.test(text[i - 1]) && /\d/.test(text[i])
    const glueAllCaps = i > 0 && /[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]) && /[A-Z]/.test(text[i + 1] ?? '')
    if (glueDigit || glueAllCaps) {
      out += ' '
      map.push(i)
    }
    out += text[i]
    map.push(i + 1)
  }
  return { text: out, toOriginal: (k) => map[Math.max(0, Math.min(k, map.length - 1))] }
}

/** Same as scanPage, but matches against each line's deglued text (see
 * deglueForMoney) and passes the offset mapper so callers can translate
 * captured indices back to the original line before calling boxFor. */
function scanMoneyPage<T>(
  page: PdfPage,
  patterns: PatternDef[],
  build: (m: RegExpExecArray, line: Line, rank: number, toOriginal: (i: number) => number) => T | null,
): T[] {
  const out: T[] = []
  for (const line of page.lines) {
    const { text: degText, toOriginal } = deglueForMoney(line.text)
    for (const { rank, re } of patterns) {
      for (const m of degText.matchAll(re)) {
        const c = build(m as RegExpExecArray, line, rank, toOriginal)
        if (c) out.push(c)
      }
    }
  }
  return out
}

/** Stops at the first page that yields at least one candidate. */
function collectPerPage(pages: PdfPage[], fn: (page: PdfPage) => Candidate[]): Candidate[] {
  for (const page of pages) {
    const found = fn(page)
    if (found.length > 0) return found
  }
  return []
}

/** Same best-rank-group logic resolveField uses to pick a winner; shared so
 * currency can look at whichever line actually won the `total` field. */
function winningCandidate(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null
  const minRank = Math.min(...candidates.map((c) => c.patternRank))
  const group = candidates.filter((c) => c.patternRank === minRank)
  const distinct = [...new Set(group.map((c) => c.value))]
  return distinct.length === 1 ? group[0] : null
}

/**
 * The six-clause uncertainty rule: no candidates -> not_found; the best
 * (lowest) patternRank group disagreeing on value -> uncertain; otherwise
 * that group's (topmost) winner -> read, unless the source is OCR below the
 * confidence floor or the winner has no box, in which case -> uncertain.
 */
export function resolveField(name: string, candidates: Candidate[], source: FieldSource): Field {
  if (candidates.length === 0) {
    return { name, value: null, state: 'not_found', source, provenance: null, confidence: null, candidates: null }
  }

  const minRank = Math.min(...candidates.map((c) => c.patternRank))
  const group = candidates.filter((c) => c.patternRank === minRank)
  const distinctValues = [...new Set(group.map((c) => c.value))]

  if (distinctValues.length > 1) {
    const withBox = group.find((c) => c.bbox !== null) ?? null
    return {
      name,
      value: null,
      state: 'uncertain',
      source,
      provenance: withBox ? { page: withBox.page, bbox: withBox.bbox as BBox } : null,
      confidence: null,
      candidates: distinctValues,
    }
  }

  const winner = group[0] // topmost occurrence in the best-rank group

  if (source === 'ocr' && winner.confidence !== null && winner.confidence < OCR_CONFIDENCE_FLOOR) {
    return { name, value: null, state: 'uncertain', source, provenance: null, confidence: winner.confidence, candidates: [winner.value] }
  }

  if (winner.bbox === null) {
    return { name, value: null, state: 'uncertain', source, provenance: null, confidence: winner.confidence, candidates: [winner.value] }
  }

  return {
    name,
    value: winner.value,
    state: 'read',
    source,
    provenance: { page: winner.page, bbox: winner.bbox },
    confidence: winner.confidence,
    candidates: null,
  }
}

// --- invoice_number ---------------------------------------------------

const NUMBER_PATTERN_DEFS: PatternDef[] = NUMBER_PATTERNS.map((re, rank) => ({ rank, re: new RegExp(re.source, 'gid') }))

function invoiceNumberCandidates(page: PdfPage): Candidate[] {
  return scanPage(page, NUMBER_PATTERN_DEFS, (m, line, rank) => {
    const cand = m[1].replace(/[.,:]+$/, '')
    if (parseDate(cand, true) !== null) return null // that was a date, not a number
    if (cand.length < 3) return null
    const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]
    return {
      value: cand.toUpperCase(),
      raw: m[1],
      page: page.page,
      bbox: boxFor(line, indices[0], indices[1]),
      confidence: null,
      patternRank: rank,
    }
  })
}

// --- vendor -------------------------------------------------------------

const VENDOR_LABEL_ONLY = /^(?:vendor|from|sold\s*by|supplier|company)\s*:?\s*$/i

function vendorCandidatesForPage(page: PdfPage): Candidate[] {
  const out: Candidate[] = []
  const lines = page.lines

  // rank 0: label and value on the same line. Stops at the first hit, exactly
  // as ledger-reconciler's extractVendor does (a single `.exec`, not a scan).
  for (const line of lines) {
    const m = VENDOR_LABEL_SAMELINE.exec(line.text)
    if (m && looksLikeAName(m[1].trim())) {
      // Provenance is the whole line's box, not a span box: a name cannot be
      // located character-exactly once cleanVendor has stripped things off it.
      out.push({ value: cleanVendor(m[1]), raw: m[1], page: page.page, bbox: line.bbox, confidence: null, patternRank: 0 })
      break
    }
  }

  // rank 1: a label-only line, then the next non-empty line (per-line
  // equivalent of VENDOR_LABEL_NEXTLINE, which depends on a literal `$\n`)
  for (let i = 0; i < lines.length; i++) {
    if (!VENDOR_LABEL_ONLY.test(lines[i].text)) continue
    const next = lines.slice(i + 1).find((l) => l.text.trim() !== '')
    if (next && looksLikeAName(next.text.trim())) {
      out.push({ value: cleanVendor(next.text), raw: next.text, page: page.page, bbox: next.bbox, confidence: null, patternRank: 1 })
      break
    }
  }

  // rank 2: positional letterhead scan over the first few non-empty lines.
  // Stops at the first line that reads like a name, exactly as
  // ledger-reconciler's positional loop does (it `return`s on first hit).
  const window = lines.filter((l) => l.text.trim() !== '').slice(0, VENDOR_SCAN_WINDOW)
  for (const line of window) {
    const cand = cleanVendor(line.text)
    if (cand && looksLikeAName(cand)) {
      out.push({ value: cand, raw: line.text, page: page.page, bbox: line.bbox, confidence: null, patternRank: 2 })
      break
    }
  }

  return out
}

// --- invoice_date / due_date --------------------------------------------

// The label-only-then-next-line fallback (added below) sits at rank
// DATE_LABEL_PATTERNS.length, ahead of the unlabelled DATE_BARE_LINE catch-all.
const INVOICE_DATE_PATTERN_DEFS: PatternDef[] = [
  ...DATE_LABEL_PATTERNS.map((re, rank) => ({ rank, re: new RegExp(re.source, 'gid') })),
  { rank: DATE_LABEL_PATTERNS.length + 1, re: new RegExp(DATE_BARE_LINE.source, 'gd') },
]

/** True when `raw` is a numeric (non year-first) date whose two leading
 * components are both <=12, so a day-first and a month-first reading are
 * both grammatically valid: the value alone cannot decide between them. */
function isAmbiguousNumericDate(raw: string): boolean {
  const text = raw.trim().replace(/[.,]$/, '')
  const numeric = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(text)
  if (!numeric) return false
  const a = Number(numeric[1])
  const b = Number(numeric[2])
  return a <= 12 && b <= 12
}

/** Document-wide orientation evidence: 'us' when US_HINTS fires, 'non_us'
 * when the symmetric NON_US_HINTS fires, 'none' when neither does. Both
 * firing at once is a genuine conflict, not "no evidence", so it also
 * resolves to 'none' (review), never a guess either way - see US_HINTS /
 * NON_US_HINTS above. */
export type Orientation = 'us' | 'non_us' | 'none'

/** Builds the candidate(s) for one date match. `orientation` is the
 * document-wide evidence from extractHeaderFields, not a per-value guess -
 * 'us' reads month-first, 'non_us' reads day-first, and 'none' means there
 * is no basis to pick a reading. Per F004 / the six-clause rule ("Anything
 * else is null, never a guess"), an ambiguous value under 'none' comes back
 * as separate same-rank candidates so resolveField's own disagreement
 * branch turns them into 'uncertain' with both as candidates, instead of
 * silently defaulting to one reading and reporting 'read'. */
function dateCandidatesFor(m: RegExpExecArray, line: Line, rank: number, page: PdfPage, orientation: Orientation): Candidate[] {
  const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]
  const bbox = boxFor(line, indices[0], indices[1])
  if (orientation === 'none' && isAmbiguousNumericDate(m[1])) {
    const readings = [parseDate(m[1], false), parseDate(m[1], true)]
    const values = [...new Set(readings.filter((d): d is PlainDate => d !== null).map(toISO))]
    return values.map((value) => ({ value, raw: m[1], page: page.page, bbox, confidence: null, patternRank: rank }))
  }
  const d: PlainDate | null = parseDate(m[1], orientation === 'us')
  if (!d) return []
  return [{ value: toISO(d), raw: m[1], page: page.page, bbox, confidence: null, patternRank: rank }]
}

function dateCandidatesFrom(page: PdfPage, patterns: PatternDef[], orientation: Orientation): Candidate[] {
  const out: Candidate[] = []
  for (const line of page.lines) {
    for (const { rank, re } of patterns) {
      for (const m of line.text.matchAll(re)) {
        out.push(...dateCandidatesFor(m as RegExpExecArray, line, rank, page, orientation))
      }
    }
  }
  return out
}

// A label alone on its own line ("Invoice date" with nothing after it), the
// stacked layout DATE_LABEL_PATTERNS can no longer catch now that patterns
// run per line instead of over one flattened string. Per-line equivalent of
// VENDOR_LABEL_ONLY / "next non-empty line", the one fallback dates lost
// (see R012 there): money never crossed a newline even before the refactor,
// so dates are the sole field with an unreplaced loss.
const INVOICE_DATE_LABEL_ONLY = /^\s*(?:invoice\s*date|issue\s*date|issued|date\s*of\s*issue|tax\s*point|date)\s*[:.]?\s*$/i
const DUE_DATE_LABEL_ONLY = /^\s*(?:due\s*date|payment\s*due|due\s*by|due|terms?)\s*[:.]?\s*$/i
const DATE_VALUE_ANYWHERE = new RegExp(DATE_VALUE, 'di')

/** A line matching `labelOnly` with no value of its own, followed by the
 * next non-empty line carrying a bare date value: provenance comes from
 * that next line's own characters, never the label line's. */
function labelThenNextLineDate(page: PdfPage, labelOnly: RegExp, rank: number, orientation: Orientation): Candidate[] {
  const out: Candidate[] = []
  const lines = page.lines
  for (let i = 0; i < lines.length; i++) {
    if (!labelOnly.test(lines[i].text)) continue
    const next = lines.slice(i + 1).find((l) => l.text.trim() !== '')
    if (!next) continue
    const m = DATE_VALUE_ANYWHERE.exec(next.text)
    if (!m) continue
    out.push(...dateCandidatesFor(m as RegExpExecArray, next, rank, page, orientation))
  }
  return out
}

function invoiceDateCandidates(page: PdfPage, orientation: Orientation): Candidate[] {
  return [
    ...dateCandidatesFrom(page, INVOICE_DATE_PATTERN_DEFS, orientation),
    ...labelThenNextLineDate(page, INVOICE_DATE_LABEL_ONLY, DATE_LABEL_PATTERNS.length, orientation),
  ]
}

// Rank 0 requires an explicit due label; rank 1 is the bare `due` / `terms?`
// form that covers "Issued <date> · Due <date>" rows, where "due" carries no
// "date" suffix at all.
const DUE_DATE_PATTERN_DEFS: PatternDef[] = [
  { rank: 0, re: new RegExp(String.raw`\b(?:due\s*date|payment\s*due|due\s*by)\s*[:.]?\s*` + DATE_VALUE, 'gid') },
  { rank: 1, re: new RegExp(String.raw`\b(?:due|terms?)\b\s*[:.]?\s*` + DATE_VALUE, 'gid') },
]

function dueDateCandidates(page: PdfPage, orientation: Orientation): Candidate[] {
  return [
    ...dateCandidatesFrom(page, DUE_DATE_PATTERN_DEFS, orientation),
    ...labelThenNextLineDate(page, DUE_DATE_LABEL_ONLY, DUE_DATE_PATTERN_DEFS.length, orientation),
  ]
}

function overlaps(a: BBox, b: BBox): boolean {
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return xOverlap > 0 && yOverlap > 0
}

/** If due_date and invoice_date resolved to overlapping boxes on the same
 * page (a mislabelled `due` catching the invoice's own date), the reader
 * cannot tell the two dates apart. That is not a claim that the page prints
 * no due date, so it comes back 'uncertain' with the disputed value kept as
 * a candidate, rather than 'not_found'. */
function suppressOverlap(dueDate: Field, invoiceDate: Field): Field {
  // Already 'uncertain' (rank-tied candidates disagreeing) before this check
  // ever runs: it already carries the real disputed readings as candidates,
  // value is already null. Overwriting candidates here would destroy that
  // disagreement and replace it with a single [null] entry - the opposite
  // of what this function exists to surface.
  if (dueDate.state === 'uncertain') return dueDate
  if (!dueDate.provenance || !invoiceDate.provenance) return dueDate
  if (dueDate.provenance.page !== invoiceDate.provenance.page) return dueDate
  if (!overlaps(dueDate.provenance.bbox, invoiceDate.provenance.bbox)) return dueDate
  return { ...dueDate, state: 'uncertain', value: null, candidates: [dueDate.value as string], confidence: null }
}

// --- subtotal / tax -------------------------------------------------------

const SUBTOTAL_LABELS = [
  String.raw`subtotal\s*\([^)]*\)`,
  String.raw`subtotal`,
  String.raw`goods\s*[/-]?\s*services\s*total`,
  String.raw`tax\s*base`,
  String.raw`net\s*total`,
  String.raw`total\s*ex(?:cl)?\.?\s*(?:vat|tax|gst)`,
]
const SUBTOTAL_PATTERN_DEFS: PatternDef[] = SUBTOTAL_LABELS.map((lab, rank) => ({
  rank,
  re: new RegExp(String.raw`\b` + lab + JUNK + MONEY + MONEY_GUARD, 'gid'),
}))

const TAX_LABEL_CORE = String.raw`(?:VAT|MwSt\.?|MVA|TVA|KDV|GST|Sales\s*tax|Tax)`
// Either order: "VAT 20%" and "KDV %20" both appear across these templates.
const PERCENT = String.raw`(?:%\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*%)`
const TAX_PATTERN_DEFS: PatternDef[] = [
  { rank: 0, re: new RegExp(String.raw`\b` + TAX_LABEL_CORE + String.raw`\s*` + PERCENT + JUNK + MONEY + MONEY_GUARD, 'gid') },
  { rank: 1, re: new RegExp(String.raw`\btax\s*amount` + JUNK + MONEY + MONEY_GUARD, 'gid') },
  { rank: 2, re: new RegExp(String.raw`\b` + TAX_LABEL_CORE + JUNK + MONEY + MONEY_GUARD, 'gid') },
]

function moneyCandidatesForPage(page: PdfPage, patterns: PatternDef[]): Candidate[] {
  return scanMoneyPage(page, patterns, (m, line, rank, toOriginal) => {
    const amount = parseAmount(m[1])
    if (amount === null) return null
    const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]
    return {
      value: amount.toFixed(2),
      raw: m[1],
      page: page.page,
      bbox: boxFor(line, toOriginal(indices[0]), toOriginal(indices[1])),
      confidence: null,
      patternRank: rank,
    }
  })
}

// --- total ----------------------------------------------------------------

// AMOUNT_PATTERNS above is the byte-identical copy; the guarded versions used
// for actual extraction are rebuilt from the same TOTAL_LABELS/JUNK/MONEY so
// the copy stays untouched (R005) while extraction gets the R015 guard (R016).
const TOTAL_PATTERN_DEFS: PatternDef[] = [
  ...TOTAL_LABELS.map((lab, rank) => ({ rank, re: new RegExp(String.raw`\b` + lab + String.raw`\b` + JUNK + MONEY + MONEY_GUARD, 'gid') })),
  { rank: TOTAL_LABELS.length, re: new RegExp(MONEY + MONEY_GUARD + String.raw`\s*due\b`, 'gid') },
]

/** Collects total candidates from every page (a multi-page invoice carries
 * its total last), keeping each candidate's source line alongside it so
 * currency can inspect whichever line actually won. */
function totalCandidatesWithLines(pages: PdfPage[]): { candidates: Candidate[]; lines: Line[] } {
  const candidates: Candidate[] = []
  const lines: Line[] = []
  for (const page of pages) {
    const perLine = scanMoneyPage(page, TOTAL_PATTERN_DEFS, (m, line, rank, toOriginal) => {
      const amount = parseAmount(m[1])
      if (amount === null) return null
      const indices = (m as RegExpExecArray & { indices: Array<[number, number]> }).indices[1]
      const c: Candidate = {
        value: amount.toFixed(2),
        raw: m[1],
        page: page.page,
        bbox: boxFor(line, toOriginal(indices[0]), toOriginal(indices[1])),
        confidence: null,
        patternRank: rank,
      }
      return { candidate: c, line }
    })
    for (const { candidate, line } of perLine) {
      candidates.push(candidate)
      lines.push(line)
    }
  }
  return { candidates, lines }
}

// --- currency ---------------------------------------------------------

const SYMBOL_CURRENCY: Record<string, string> = { '£': 'GBP', '€': 'EUR', '₺': 'TRY' }

// Document-level tax-id hints. Used as rank 2's fallback source when nothing
// else in the document carries an ISO code or a symbol, and to narrow a `$`
// tie (ranks 1 and 2) when the iso/symbol evidence disagrees. Because a hint
// can DECIDE a currency, every token here must be specific to one country:
// ABN is Australian and EIN is American, but GST is printed in New Zealand,
// Canada, Singapore and India too, so it is deliberately absent; a `$` invoice
// whose only corroboration is GST stays 'uncertain {USD, AUD}' rather than
// becoming a confident AUD.
const CURRENCY_HINTS: Array<{ re: RegExp; currency: string }> = [
  { re: /MwSt|USt/d, currency: 'EUR' },
  { re: /VAT\s*Reg\s*No/d, currency: 'GBP' },
  { re: /\bABN\b/d, currency: 'AUD' },
  { re: /\bEIN\b/d, currency: 'USD' },
]

const ISO_CODE_RE = /\b(USD|EUR|GBP|AUD|TRY|NOK|SEK|CHF|CAD)\b/d
const CURRENCY_SYMBOL_RE = /([£€₺$])/d

function currencyCandidates(pages: PdfPage[], winner: Candidate | null, winnerLine: Line | null): Candidate[] {
  const out: Candidate[] = []

  if (winner && winnerLine) {
    // rank 0: an explicit ISO code on the total's own line (also covers the
    // "TOTAL <CODE>" form, e.g. "TOTAL USD 3,820.96")
    const isoM = ISO_CODE_RE.exec(winnerLine.text)
    if (isoM?.indices) {
      const [s, e] = isoM.indices[1]!
      out.push({ value: isoM[1], raw: isoM[1], page: winner.page, bbox: boxFor(winnerLine, s, e), confidence: null, patternRank: 0 })
      return out
    }

    // rank 1: a currency symbol on the total's own line. `$` is ambiguous
    // between USD and AUD in this sample set; before emitting both at the
    // SAME rank, the document-wide EIN/ABN hints get a chance to narrow
    // it to one, exactly like rank 2 narrows its own iso/sym ties. Without
    // this, a hint elsewhere in the document is unreachable whenever `$`
    // happens to sit on the winning total line itself.
    const symM = CURRENCY_SYMBOL_RE.exec(winnerLine.text)
    if (symM?.indices) {
      const [s, e] = symM.indices[1]!
      const bbox = boxFor(winnerLine, s, e)
      const sym = symM[1]
      if (sym === '$') {
        const hint = collectHints(pages)
        const narrowed = ['USD', 'AUD'].filter((c) => hint.has(c))
        if (narrowed.length === 1) {
          out.push({ value: narrowed[0], raw: sym, page: winner.page, bbox, confidence: null, patternRank: 1 })
        } else {
          out.push({ value: 'USD', raw: sym, page: winner.page, bbox, confidence: null, patternRank: 1 })
          out.push({ value: 'AUD', raw: sym, page: winner.page, bbox, confidence: null, patternRank: 1 })
        }
      } else {
        out.push({ value: SYMBOL_CURRENCY[sym], raw: sym, page: winner.page, bbox, confidence: null, patternRank: 1 })
      }
      return out
    }
  }

  // rank 2: document-wide evidence, collected then narrowed (see
  // decideDocumentCurrency for the rule).
  out.push(...decideDocumentCurrency(pages))
  return out
}

/**
 * ISO code sitting right next to an amount, either side: 'TRY 1,234.00' or
 * '1,234.00 TRY'. A bare code loose in prose ('Please TRY to pay') matches
 * neither shape and is not evidence.
 */
const ISO_NEAR_AMOUNT_RE = /\b(USD|EUR|GBP|AUD|TRY|NOK|SEK|CHF|CAD)\s*[\d.,]+\d\b|\d[\d.,]*\s*\b(USD|EUR|GBP|AUD|TRY|NOK|SEK|CHF|CAD)\b/gd

// Every currency a symbol could mean; `$` stays ambiguous between USD/AUD
// until a hint narrows it.
const SYMBOL_CURRENCIES: Record<string, string[]> = { '£': ['GBP'], '€': ['EUR'], '₺': ['TRY'], $: ['USD', 'AUD'] }

type DocEvidence = { currency: string; page: number; bbox: BBox | null }

/**
 * Document-wide CURRENCY_HINTS scan, shared by rank 1 (to narrow an
 * ambiguous `$` found on the winning total line itself) and rank 2's
 * decideDocumentCurrency (to narrow its own iso/sym ties).
 */
function collectHints(pages: PdfPage[]): Map<string, DocEvidence> {
  const hint = new Map<string, DocEvidence>()
  for (const page of pages) {
    for (const line of page.lines) {
      for (const h of CURRENCY_HINTS) {
        if (hint.has(h.currency)) continue
        const m = h.re.exec(line.text)
        if (m?.indices) {
          const [s, e] = m.indices[0]!
          hint.set(h.currency, { currency: h.currency, page: page.page, bbox: boxFor(line, s, e) })
        }
      }
    }
  }
  return hint
}

/**
 * Rank 2 in full: collects three document-wide evidence sets (ISO code next
 * to an amount, currency symbol, tax-label/tax-id hint) before deciding,
 * instead of returning on the first thing found. Candidates start as
 * whichever set is non-empty in iso -> sym -> hint order; if that set still
 * disagrees (more than one currency) and a hint exists, it narrows the set
 * to its intersection with the hint (e.g. `$` = {USD, AUD} narrowed to
 * {AUD} by an ABN hint). One Candidate per surviving currency, all at
 * patternRank 2, so resolveField reads a lone survivor and reports
 * 'uncertain' with the rest. Pure aside from `boxFor`, so it is testable in
 * isolation from PDF plumbing.
 */
function decideDocumentCurrency(pages: PdfPage[]): Candidate[] {
  const iso = new Map<string, DocEvidence>()
  const sym = new Map<string, DocEvidence>()

  for (const page of pages) {
    for (const line of page.lines) {
      for (const m of line.text.matchAll(ISO_NEAR_AMOUNT_RE)) {
        const code = m[1] ?? m[2]
        if (!code || iso.has(code)) continue
        const groupIndex = m[1] ? 1 : 2
        const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[groupIndex]!
        iso.set(code, { currency: code, page: page.page, bbox: boxFor(line, indices[0], indices[1]) })
      }
      for (const m of line.text.matchAll(/([£€₺$])/gd)) {
        const symbol = m[1]!
        const indices = (m as RegExpMatchArray & { indices: Array<[number, number]> }).indices[1]!
        for (const currency of SYMBOL_CURRENCIES[symbol]) {
          if (sym.has(currency)) continue
          sym.set(currency, { currency, page: page.page, bbox: boxFor(line, indices[0], indices[1]) })
        }
      }
    }
  }
  const hint = collectHints(pages)

  let candidates = iso.size > 0 ? iso : sym.size > 0 ? sym : hint
  if (candidates.size > 1 && hint.size > 0) {
    const narrowed = new Map([...candidates].filter(([currency]) => hint.has(currency)))
    if (narrowed.size > 0) candidates = narrowed
  }

  return [...candidates.values()].map((e) => ({
    value: e.currency,
    raw: e.currency,
    page: e.page,
    bbox: e.bbox,
    confidence: null,
    patternRank: 2,
  }))
}

// --- top-level assembly ----------------------------------------------------

const FIELD_NAMES = ['invoice_number', 'vendor', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total'] as const

/**
 * Runs every field's extraction and returns exactly eight Fields, always in
 * FIELD_NAMES order. `normalise()` is only ever applied to the document-wide
 * text used for the `US_HINTS` / `NON_US_HINTS` orientation decision, never
 * to a line whose offsets feed a box: it inserts characters ("Invoice
 * numberWS-0622" -> "Invoice number WS-0622"), which would shift every span
 * in that line and put every provenance box in the wrong place while the
 * value still looked right.
 */
/**
 * A candidate's confidence is the MINIMUM over the OCR words its box covers:
 * a value is only as trustworthy as its worst character. Text-layer words
 * carry no confidence, so the result stays null there and resolveField's
 * floor never engages.
 *
 * "Covers" means the word's centre lies inside the candidate's box, not any
 * overlap: on the scanned 23_AF-00503 tesseract reads a table rule as the
 * word "ee" at confidence 4, 252pt wide and 7pt tall, and its edge grazes
 * both the tax line and the total line. Any-overlap sent two correct values
 * to review on the strength of a line that is not text.
 */
function coveringConfidence(pages: PdfPage[], c: Candidate): number | null {
  if (!c.bbox) return null
  const page = pages.find((p) => p.page === c.page)
  if (!page) return null
  const b = c.bbox
  let min: number | null = null
  for (const item of page.items) {
    if (item.confidence === undefined) continue
    const cx = item.bbox.x + item.bbox.width / 2
    const cy = item.bbox.y + item.bbox.height / 2
    const inside = cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
    if (inside && (min === null || item.confidence < min)) min = item.confidence
  }
  return min
}

export function extractHeaderFields(pages: PdfPage[], source: FieldSource): Field[] {
  const resolve = (name: string, candidates: Candidate[]) =>
    resolveField(name, candidates.map((c) => ({ ...c, confidence: c.confidence ?? coveringConfidence(pages, c) })), source)

  const docText = pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n')
  const normalisedDocText = normalise(docText)
  const isUS = US_HINTS.test(normalisedDocText)
  const isNonUS = NON_US_HINTS.test(normalisedDocText)
  const orientation: Orientation = isUS && !isNonUS ? 'us' : isNonUS && !isUS ? 'non_us' : 'none'

  const invoiceNumber = resolve('invoice_number', collectPerPage(pages, invoiceNumberCandidates))
  const vendor = resolve('vendor', collectPerPage(pages, vendorCandidatesForPage))
  const invoiceDate = resolve('invoice_date', collectPerPage(pages, (p) => invoiceDateCandidates(p, orientation)))

  const dueDateRaw = resolve('due_date', collectPerPage(pages, (p) => dueDateCandidates(p, orientation)))
  const dueDate = suppressOverlap(dueDateRaw, invoiceDate)

  const { candidates: totalCandidates, lines: totalLines } = totalCandidatesWithLines(pages)
  const total = resolve('total', totalCandidates)
  const winner = winningCandidate(totalCandidates)
  const winnerIdx = winner ? totalCandidates.indexOf(winner) : -1
  const winnerLine = winnerIdx >= 0 ? totalLines[winnerIdx] : null

  const currency = resolve('currency', currencyCandidates(pages, winner, winnerLine))
  const subtotal = resolve('subtotal', collectPerPage(pages, (p) => moneyCandidatesForPage(p, SUBTOTAL_PATTERN_DEFS)))
  const tax = resolve('tax', collectPerPage(pages, (p) => moneyCandidatesForPage(p, TAX_PATTERN_DEFS)))

  const byName: Record<(typeof FIELD_NAMES)[number], Field> = {
    invoice_number: invoiceNumber,
    vendor,
    invoice_date: invoiceDate,
    due_date: dueDate,
    currency,
    subtotal,
    tax,
    total,
  }
  return FIELD_NAMES.map((n) => byName[n])
}
