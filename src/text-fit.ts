import type { PDFFont } from 'pdf-lib'
import type { TextStyle } from './layout.js'

export interface FitResult {
  lines: string[]
  size: number
  /** True when the text does not fit even at minSize. The card goes to preflight. */
  overflow: boolean
}

const STEP = 0.25

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
  if (trimmed === '') return { lines: [''], size: style.size, overflow: false }

  // A non-positive box cannot fit anything. Return through the overflow path
  // rather than letting wrap() spin on a negative width budget. Slice to
  // maxLines like the other overflow paths, so a caller drawing r.lines[i] at
  // i * lineHeight never draws past the bottom of the box.
  if (boxWidth <= 0) {
    return { lines: [trimmed].slice(0, style.maxLines), size: style.minSize, overflow: true }
  }

  const widths = style.firstLineIndent > 0 ? [boxWidth - style.firstLineIndent, boxWidth] : [boxWidth]

  if (style.fit === 'clip') {
    return { lines: [trimmed], size: style.size, overflow: font.widthOfTextAtSize(trimmed, style.size) > boxWidth }
  }

  if (style.fit === 'wrap') {
    const lines = wrap(trimmed, font, style.size, widths, style.maxLines)
    if (lines) return { lines, size: style.size, overflow: false }
    const all = wrap(trimmed, font, style.size, widths, Number.MAX_SAFE_INTEGER) ?? [trimmed]
    return { lines: all.slice(0, style.maxLines), size: style.size, overflow: true }
  }

  for (let size = style.size; size >= style.minSize - 1e-9; size -= STEP) {
    const lines = wrap(trimmed, font, size, widths, style.maxLines)
    if (lines) return { lines, size: Number(size.toFixed(4)), overflow: false }
  }

  const fallback = wrap(trimmed, font, style.minSize, widths, Number.MAX_SAFE_INTEGER) ?? [trimmed]
  return { lines: fallback.slice(0, style.maxLines), size: style.minSize, overflow: true }
}
