import type { PDFFont } from 'pdf-lib'
import type { TextStyle } from './layout.js'

export interface FitResult {
  lines: string[]
  size: number
  /** True when the text does not fit even at minSize. The card goes to preflight. */
  overflow: boolean
  /** Middle names reduced to initials to make the text fit. */
  abbreviated: boolean
}

const STEP = 0.25

/** A token that is already a bare initial ("P" or "P.") — abbreviating it again yields nothing. */
const ALREADY_INITIAL = /^[A-Za-z]\.?$/

function abbreviateToken(token: string): string {
  return `${token[0]!.toUpperCase()}.`
}

/**
 * The abbreviation ladder for `overflow: 'abbreviate-then-shrink'`: the
 * original text, then one middle token at a time reduced to an initial, left
 * to right, until every abbreviable middle token is spent. The first and
 * last tokens are never touched. Fewer than three tokens means there is no
 * middle, so the ladder is just the original text. A middle token that is
 * already an initial is skipped — it yields no new rung, since abbreviating
 * it again produces the same text.
 */
function abbreviationLadder(trimmed: string): { text: string; abbreviated: boolean }[] {
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const rungs: { text: string; abbreviated: boolean }[] = [{ text: trimmed, abbreviated: false }]
  if (tokens.length < 3) return rungs

  const current = tokens.slice()
  for (let i = 1; i < tokens.length - 1; i++) {
    if (ALREADY_INITIAL.test(current[i]!)) continue
    current[i] = abbreviateToken(current[i]!)
    rungs.push({ text: current.join(' '), abbreviated: true })
  }
  return rungs
}

/** Greedy wrap. Returns null when a line count budget is blown, so the caller can shrink and retry. */
function wrap(text: string, font: PDFFont, size: number, widths: number[], maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''

  const widthFor = (i: number) => widths[Math.min(i, widths.length - 1)] ?? 0

  for (let w = 0; w < words.length; w++) {
    const word = words[w]!
    const candidate = current === '' ? word : `${current} ${word}`
    if (font.widthOfTextAtSize(candidate, size) <= widthFor(lines.length)) {
      current = candidate
      continue
    }
    if (current !== '') {
      lines.push(current)
      current = ''
      if (lines.length >= maxLines) return null
      w--
      continue
    }
    // A single word wider than the line: hard-break it so we cannot loop forever.
    // cut is floored at 1 (not 0): once only one character of `word` remains,
    // word.length - 1 is 0, the `cut > 1` guard below never runs, and
    // word.slice(0, 0) === '' with word.slice(cut) === word would push an empty
    // line and leave `word` untouched — an infinite loop, since no character is
    // ever consumed. Flooring at 1 guarantees every hard-break iteration
    // consumes at least one character, even if that character alone still
    // overflows the line (nothing smaller can be rendered).
    let cut = Math.max(1, word.length - 1)
    while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > widthFor(lines.length)) cut--
    lines.push(word.slice(0, cut))
    if (lines.length >= maxLines) return null
    words[w] = word.slice(cut)
    w--
  }
  if (current !== '') lines.push(current)
  return lines.length <= maxLines ? lines : null
}

/**
 * Fit text into a box of the given width. Tries the designed size first and
 * steps down toward minSize. Wrapping is attempted at every size, so a
 * single-line field (maxLines 1) shrinks while an address wraps then shrinks.
 * Returning overflow rather than drawing outside the box is the point: a name
 * that silently overflows on card 700 is not discovered until after cutting.
 */
export function fitText(text: string, style: TextStyle, boxWidth: number, font: PDFFont): FitResult {
  const trimmed = text.trim()
  if (trimmed === '') return { lines: [''], size: style.size, overflow: false, abbreviated: false }

  // A non-positive box cannot fit anything. Return through the overflow path
  // rather than letting wrap() spin on a negative width budget. The
  // `.slice(0, style.maxLines)` below is a no-op here in practice — this
  // array always holds exactly one element and maxLines is always at least
  // 1 (see textStyleSchema) — kept only for shape-symmetry with the other
  // overflow return sites, which do slice a genuinely longer array.
  if (boxWidth <= 0) {
    return { lines: [trimmed].slice(0, style.maxLines), size: style.minSize, overflow: true, abbreviated: false }
  }

  const widths = style.firstLineIndent > 0 ? [boxWidth - style.firstLineIndent, boxWidth] : [boxWidth]

  if (style.fit === 'clip') {
    return {
      lines: [trimmed],
      size: style.size,
      overflow: font.widthOfTextAtSize(trimmed, style.size) > boxWidth,
      abbreviated: false,
    }
  }

  if (style.fit === 'wrap') {
    const lines = wrap(trimmed, font, style.size, widths, style.maxLines)
    if (lines) return { lines, size: style.size, overflow: false, abbreviated: false }
    const all = wrap(trimmed, font, style.size, widths, Number.MAX_SAFE_INTEGER) ?? [trimmed]
    return { lines: all.slice(0, style.maxLines), size: style.size, overflow: true, abbreviated: false }
  }

  // 'abbreviate-then-shrink': shrinking is the last resort. Walk the ladder of
  // candidate texts — the original, then one middle token at a time reduced
  // to an initial — at the *designed* size only; nothing shrinks until
  // abbreviation is exhausted. Only then does the final (most abbreviated)
  // rung run through the same shrink loop 'shrink' always has.
  if (style.overflow === 'abbreviate-then-shrink') {
    const rungs = abbreviationLadder(trimmed)
    for (const rung of rungs) {
      const lines = wrap(rung.text, font, style.size, widths, style.maxLines)
      if (lines) return { lines, size: style.size, overflow: false, abbreviated: rung.abbreviated }
    }

    const last = rungs[rungs.length - 1]!
    for (let size = style.size; size >= style.minSize - 1e-9; size -= STEP) {
      const lines = wrap(last.text, font, size, widths, style.maxLines)
      if (lines) return { lines, size: Number(size.toFixed(4)), overflow: false, abbreviated: last.abbreviated }
    }

    const fallback = wrap(last.text, font, style.minSize, widths, Number.MAX_SAFE_INTEGER) ?? [last.text]
    return {
      lines: fallback.slice(0, style.maxLines),
      size: style.minSize,
      overflow: true,
      abbreviated: last.abbreviated,
    }
  }

  for (let size = style.size; size >= style.minSize - 1e-9; size -= STEP) {
    const lines = wrap(trimmed, font, size, widths, style.maxLines)
    if (lines) return { lines, size: Number(size.toFixed(4)), overflow: false, abbreviated: false }
  }

  const fallback = wrap(trimmed, font, style.minSize, widths, Number.MAX_SAFE_INTEGER) ?? [trimmed]
  return { lines: fallback.slice(0, style.maxLines), size: style.minSize, overflow: true, abbreviated: false }
}
