import {
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  cmyk,
  grayscale,
  rgb,
} from 'pdf-lib'
import type { Color, PDFEmbeddedPage, PDFFont, PDFImage, PDFPage } from 'pdf-lib'
import type { Binding, Colour, Element, Layout } from './layout.js'
import type { Row } from './data.js'
import type { FontRegistry } from './fonts.js'
import { fitText } from './text-fit.js'
import { flipY, toPdfRect, type Rect } from './units.js'

export interface DrawCardArgs {
  page: PDFPage
  embedded: PDFEmbeddedPage
  layout: Layout
  elements: Element[]
  fonts: FontRegistry
  row: Row
  /** Destination rect on the sheet, top-left origin. */
  cell: Rect
  photo: PDFImage | null
}

export interface DrawCardResult {
  /** Element ids whose text did not fit even at minSize. */
  overflowed: string[]
  /** Element ids whose bound column was empty and had no fallback. */
  missing: string[]
}

/**
 * Parsed calendar date, used only by the 'date' transform below. Deliberately
 * not a `Date` object: nothing here needs to reason about time zones, DST, or
 * "now" — only to read three numbers back out in a different order — and a
 * `Date` would add implicit local-time interpretation for no benefit.
 */
interface ParsedDate {
  day: number
  month: number
  year: number
}

/**
 * Every shape the 'date' transform accepts, tried in this order. These cover
 * what `cellText` in data.ts emits for a genuine Excel Date cell
 * (`DD.MM.YYYY`) and the formats schools typically type by hand.
 */
const DATE_INPUT_PATTERNS: { re: RegExp; dayGroup: number; monthGroup: number; yearGroup: number }[] = [
  { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, dayGroup: 1, monthGroup: 2, yearGroup: 3 }, // DD.MM.YYYY
  { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, dayGroup: 1, monthGroup: 2, yearGroup: 3 }, // DD/MM/YYYY
  { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, dayGroup: 1, monthGroup: 2, yearGroup: 3 }, // DD-MM-YYYY
  { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, dayGroup: 3, monthGroup: 2, yearGroup: 1 }, // ISO YYYY-MM-DD
]

/** Returns null, rather than throwing, for anything that isn't one of the accepted shapes. */
function parseDateValue(value: string): ParsedDate | null {
  const trimmed = value.trim()
  for (const { re, dayGroup, monthGroup, yearGroup } of DATE_INPUT_PATTERNS) {
    const m = re.exec(trimmed)
    if (!m) continue
    const day = Number(m[dayGroup])
    const month = Number(m[monthGroup])
    const year = Number(m[yearGroup])
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    return { day, month, year }
  }
  return null
}

/**
 * Substitutes DD/MM/YYYY/YY tokens for literal separators. YYYY is tried
 * before YY in the alternation so a format string's "YYYY" is consumed whole
 * by one match rather than as two adjacent "YY" matches.
 */
function formatDateValue(date: ParsedDate, format: string): string {
  const dd = String(date.day).padStart(2, '0')
  const mm = String(date.month).padStart(2, '0')
  const yyyy = String(date.year).padStart(4, '0')
  const yy = yyyy.slice(-2)
  return format.replace(/YYYY|MM|DD|YY/g, (token) => {
    switch (token) {
      case 'DD':
        return dd
      case 'MM':
        return mm
      case 'YYYY':
        return yyyy
      case 'YY':
        return yy
      default:
        return token
    }
  })
}

export function applyTransform(value: string, binding: Binding): string {
  switch (binding.transform) {
    case 'upper':
      return value.toUpperCase()
    case 'title':
      return value.replace(/\S+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    case 'date': {
      const parsed = parseDateValue(value)
      // A value that doesn't parse is returned unchanged rather than thrown or
      // reformatted into something wrong: a mangled date printed on a card is
      // worse than an unformatted one, and preflight already reports fields
      // that don't fit their box.
      if (!parsed) return value
      return formatDateValue(parsed, binding.format ?? 'DD.MM.YYYY')
    }
    default:
      return value
  }
}

export function resolveText(row: Row, binding: Binding): { text: string; missing: boolean } {
  const raw = (row.values[binding.column] ?? '').trim()
  if (raw === '') {
    if (binding.fallback !== undefined) return { text: binding.fallback, missing: false }
    return { text: '', missing: true }
  }
  return { text: applyTransform(raw, binding), missing: false }
}

function toPdfColor(c: Colour): Color {
  switch (c.space) {
    case 'rgb':
      return rgb(c.r, c.g, c.b)
    case 'cmyk':
      return cmyk(c.c, c.m, c.y, c.k)
    case 'gray':
      return grayscale(1 - c.k)
  }
}

/**
 * pdf-lib 1.17.1's `PDFFont.heightAtSize(size, { descender: false })` is
 * documented to return the font's height at `size` with the descender
 * excluded (i.e. the ascent). For custom-embedded fonts it does not: internally
 * (`CustomFontEmbedder.heightOfFontAtSize`) it rescales ascent/descent from
 * font units to a 1000-units-per-em space, then subtracts the font's *raw,
 * unscaled* descent from that rescaled height. The subtraction only cancels
 * correctly when the font's unitsPerEm happens to be 1000; for any other
 * unitsPerEm (2048 is typical for TrueType fonts, including this project's
 * LiberationSans-Regular.ttf) it silently returns the wrong number.
 *
 * Measured against LiberationSans-Regular.ttf (unitsPerEm 2048, ascent 1854)
 * at size 9: `heightAtSize(9, { descender: false })` returns 6.1487, but the
 * correct ascent is `(1854 / 2048) * 9` = 8.1475 — a ~2pt error that would
 * shift every baseline on every card.
 *
 * There is no public pdf-lib API that returns the correct value, so this
 * reads the ascent straight from the fontkit font object that pdf-lib already
 * holds on `PDFFont.embedder.font` (true for every font this registry embeds,
 * since FontRegistry only ever calls `doc.embedFont`, never
 * `embedStandardFont`).
 */
interface CustomEmbedderInternals {
  embedder: { font: { ascent: number; capHeight: number; unitsPerEm: number } }
}

export function ascentAtSize(font: PDFFont, size: number): number {
  const fk = (font as unknown as CustomEmbedderInternals).embedder.font
  return (fk.ascent / fk.unitsPerEm) * size
}

/**
 * Same rationale and access path as `ascentAtSize` above — there is no public
 * pdf-lib API for it either. Exposed for tests that need to predict where a
 * capital letter's top row of ink lands, since that is `baseline - capHeight`.
 */
export function capHeightAtSize(font: PDFFont, size: number): number {
  const fk = (font as unknown as CustomEmbedderInternals).embedder.font
  return (fk.capHeight / fk.unitsPerEm) * size
}

/** Push a rectangular clip in PDF space. Everything drawn until popGraphicsState is confined to it. */
function clipTo(page: PDFPage, r: Rect, pageHeight: number): void {
  const p = toPdfRect(r, pageHeight)
  page.pushOperators(
    pushGraphicsState(),
    moveTo(p.x, p.y),
    lineTo(p.x + p.w, p.y),
    lineTo(p.x + p.w, p.y + p.h),
    lineTo(p.x, p.y + p.h),
    closePath(),
    clip(),
    endPath(),
  )
}

/**
 * Draw one card into `cell`.
 *
 * The template's page box is larger than its trim box, so the embedded page is
 * offset so that the trim's top-left lands on the cell's top-left, and the whole
 * card is clipped to the cell. Without the clip the page's white surround paints
 * over neighbouring cards.
 */
export function drawCard(args: DrawCardArgs): DrawCardResult {
  const { page, embedded, layout, elements, fonts, row, cell, photo } = args
  const pageHeight = page.getHeight()
  const overflowed: string[] = []
  const missing: string[] = []

  clipTo(page, cell, pageHeight)

  // Offset so the trim box, not the page box, aligns with the cell.
  const artRect: Rect = {
    x: cell.x - layout.trim.x,
    y: cell.y - layout.trim.y,
    w: layout.pageBox.w,
    h: layout.pageBox.h,
  }
  const art = toPdfRect(artRect, pageHeight)
  page.drawPage(embedded, { x: art.x, y: art.y, width: art.w, height: art.h })

  for (const el of elements) {
    // Element boxes are stored in template page coordinates.
    const box: Rect = {
      x: cell.x - layout.trim.x + el.box.x,
      y: cell.y - layout.trim.y + el.box.y,
      w: el.box.w,
      h: el.box.h,
    }

    if (el.kind === 'photo') {
      if (!photo) continue
      clipTo(page, box, pageHeight)
      const scale =
        el.fit === 'cover'
          ? Math.max(box.w / photo.width, box.h / photo.height)
          : Math.min(box.w / photo.width, box.h / photo.height)
      const dw = photo.width * scale
      const dh = photo.height * scale
      const placed = toPdfRect({ x: box.x + (box.w - dw) / 2, y: box.y + (box.h - dh) / 2, w: dw, h: dh }, pageHeight)
      page.drawImage(photo, { x: placed.x, y: placed.y, width: placed.w, height: placed.h })
      page.pushOperators(popGraphicsState())
      continue
    }

    let text: string
    if (el.kind === 'static') {
      text = el.text
    } else {
      const resolved = resolveText(row, el.bind)
      if (resolved.missing) {
        missing.push(el.id)
        continue
      }
      text = resolved.text
    }
    if (text === '') continue

    const font = fonts.get(el.style.fontId)
    const fit = fitText(text, el.style, box.w, font)
    if (fit.overflow) overflowed.push(el.id)

    // Anchor on the element's *designed* size, never the shrunk size.
    // Shrinking must change the glyph size, not the baseline — anchoring on
    // fit.size here would move the baseline whenever shrink-to-fit kicks in,
    // so a card whose name shrank would draw at a different baseline than
    // its neighbour whose name did not, even though both share the same
    // box.y. See the box.y contract documented on elementSchema in layout.ts.
    const ascent = ascentAtSize(font, el.style.size)
    // Position the whole block of lines within box.h per valign, then lay
    // lines out top-down from that offset. Offset is computed once for the
    // block, not per line, so line spacing within the block is unaffected.
    // Clamped at 0: a block taller than its box (more lines than the box was
    // designed to hold) would otherwise produce a negative offset for
    // middle/bottom, drawing the block upward out of the box and into
    // whatever sits above it.
    const blockHeight = fit.lines.length * el.style.lineHeight
    const valignOffset = Math.max(
      0,
      el.style.valign === 'middle'
        ? (box.h - blockHeight) / 2
        : el.style.valign === 'bottom'
          ? box.h - blockHeight
          : 0,
    )

    // fitText's 'clip' mode returns the full (possibly overflowing) string
    // unshrunk and un-wrapped and relies on the caller to actually clip it —
    // fitText itself only reports whether it overflows. Without this, a
    // clip-fit box draws every glyph the string contains, however far past
    // the box edge that runs, straight across whatever field is next to it.
    const clipped = el.style.fit === 'clip'
    if (clipped) clipTo(page, box, pageHeight)
    fit.lines.forEach((line, i) => {
      const indent = i === 0 ? el.style.firstLineIndent : 0
      const lineWidth = font.widthOfTextAtSize(line, fit.size)
      const available = box.w - indent
      const dx =
        el.style.align === 'center' ? (available - lineWidth) / 2 : el.style.align === 'right' ? available - lineWidth : 0
      const topY = box.y + valignOffset + i * el.style.lineHeight
      page.drawText(line, {
        x: box.x + indent + dx,
        y: flipY(pageHeight, topY + ascent),
        size: fit.size,
        font,
        color: toPdfColor(el.style.color),
      })
    })
    if (clipped) page.pushOperators(popGraphicsState())
  }

  page.pushOperators(popGraphicsState())
  return { overflowed, missing }
}
