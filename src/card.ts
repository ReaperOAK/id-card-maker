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

export function applyTransform(value: string, binding: Binding): string {
  switch (binding.transform) {
    case 'upper':
      return value.toUpperCase()
    case 'title':
      return value.replace(/\S+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
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
  embedder: { font: { ascent: number; unitsPerEm: number } }
}

export function ascentAtSize(font: PDFFont, size: number): number {
  const fk = (font as unknown as CustomEmbedderInternals).embedder.font
  return (fk.ascent / fk.unitsPerEm) * size
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

    const ascent = ascentAtSize(font, fit.size)
    // Position the whole block of lines within box.h per valign, then lay
    // lines out top-down from that offset. Offset is computed once for the
    // block, not per line, so line spacing within the block is unaffected.
    const blockHeight = fit.lines.length * el.style.lineHeight
    const valignOffset =
      el.style.valign === 'middle'
        ? (box.h - blockHeight) / 2
        : el.style.valign === 'bottom'
          ? box.h - blockHeight
          : 0
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
  }

  page.pushOperators(popGraphicsState())
  return { overflowed, missing }
}
