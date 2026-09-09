// Reused from ledger-reconciler (https://github.com/samoosa1/ledger-reconciler), same author, MIT.
/**
 * A faithful port of Python's `difflib.SequenceMatcher(None, a, b).ratio()`.
 *
 * Why port it rather than reach for a library: the Python original uses the
 * Ratcliff-Obershelp algorithm, and the popular JS packages compute
 * something else entirely. `string-similarity` gives the Dice coefficient;
 * most others give a Levenshtein-derived ratio. Those produce different
 * numbers for the same pair of strings, so swapping one in would silently
 * change which vendors match and break the property that this port can be
 * diffed against the reference implementation.
 *
 * ratio() = 2 * M / T, where M is the total size of all matching blocks and
 * T is the combined length of both sequences.
 */

interface MatchBlock {
  aStart: number
  bStart: number
  size: number
}

/**
 * Index of b: element -> positions. Mirrors SequenceMatcher.__chain_b.
 *
 * The autojunk heuristic is reproduced for faithfulness even though it
 * cannot trigger on this project's inputs (it needs a sequence of 200+
 * elements; vendor names and ledger descriptions are far shorter). Leaving
 * it out would make the port diverge on any future long input, which is
 * exactly the kind of silent drift this module exists to prevent.
 */
function chainB(b: string, autojunk: boolean): Map<string, number[]> {
  const b2j = new Map<string, number[]>()
  for (let i = 0; i < b.length; i++) {
    const ch = b[i]
    const at = b2j.get(ch)
    if (at) at.push(i)
    else b2j.set(ch, [i])
  }

  if (autojunk && b.length >= 200) {
    const nTest = Math.floor(b.length / 100) + 1
    for (const [ch, idxs] of [...b2j.entries()]) {
      if (idxs.length > nTest) b2j.delete(ch)
    }
  }
  return b2j
}

/** Mirrors SequenceMatcher.find_longest_match over a[aLo:aHi], b[bLo:bHi]. */
function findLongestMatch(
  a: string, b: string, b2j: Map<string, number[]>,
  aLo: number, aHi: number, bLo: number, bHi: number,
): MatchBlock {
  let bestI = aLo
  let bestJ = bLo
  let bestSize = 0
  let j2len = new Map<number, number>()

  for (let i = aLo; i < aHi; i++) {
    const newJ2len = new Map<number, number>()
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < bLo) continue
      if (j >= bHi) break
      const k = (j2len.get(j - 1) ?? 0) + 1
      newJ2len.set(j, k)
      if (k > bestSize) {
        bestI = i - k + 1
        bestJ = j - k + 1
        bestSize = k
      }
    }
    j2len = newJ2len
  }

  // With isjunk=None and no autojunk purge on short inputs there is no junk
  // to skip, so the two junk-extension passes in CPython collapse into this
  // single non-junk extension.
  while (bestI > aLo && bestJ > bLo && a[bestI - 1] === b[bestJ - 1]) {
    bestI--
    bestJ--
    bestSize++
  }
  while (
    bestI + bestSize < aHi && bestJ + bestSize < bHi &&
    a[bestI + bestSize] === b[bestJ + bestSize]
  ) {
    bestSize++
  }

  return { aStart: bestI, bStart: bestJ, size: bestSize }
}

/** Total size of all matching blocks. Mirrors get_matching_blocks. */
function totalMatches(a: string, b: string, autojunk = true): number {
  const b2j = chainB(b, autojunk)
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  let matched = 0

  while (queue.length > 0) {
    const [aLo, aHi, bLo, bHi] = queue.pop()!
    const m = findLongestMatch(a, b, b2j, aLo, aHi, bLo, bHi)
    if (m.size === 0) continue

    matched += m.size
    if (aLo < m.aStart && bLo < m.bStart) {
      queue.push([aLo, m.aStart, bLo, m.bStart])
    }
    if (m.aStart + m.size < aHi && m.bStart + m.size < bHi) {
      queue.push([m.aStart + m.size, aHi, m.bStart + m.size, bHi])
    }
  }
  return matched
}

/** Equivalent to SequenceMatcher(None, a, b).ratio(), in [0, 1]. */
export function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length
  if (total === 0) return 1
  return (2 * totalMatches(a, b)) / total
}
