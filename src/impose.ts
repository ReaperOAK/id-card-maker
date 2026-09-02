import { rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { cellRect, type Grid } from './grid.js'
import { toPdfRect, type Rect } from './units.js'

export type FlipAxis = 'long-edge' | 'short-edge'

/**
 * Position a card must occupy on the back sheet so it lands behind its front.
 *
 * Fronts are printed, the stack is flipped once, backs are printed. A long-edge
 * flip turns the sheet about its vertical axis, so column 0 becomes the last
 * column; rows are untouched. A short-edge flip does the same to rows.
 *
 * This is exact only because grid margins are symmetric. With unequal margins
 * every card on every back sheet is offset by the difference.
 */
export function mirrorIndex(grid: Grid, index: number, axis: FlipAxis): number {
  const col = index % grid.cols
  const row = Math.floor(index / grid.cols)
  return axis === 'long-edge'
    ? row * grid.cols + (grid.cols - 1 - col)
    : (grid.rows - 1 - row) * grid.cols + col
}

export function sheetCount(total: number, perSheet: number): number {
  return Math.ceil(total / perSheet)
}

const MARK_LEN = 6
const MARK_GAP = 2

/** Crop marks sit in the gutter and margin, never inside the card. */
export function drawCropMarks(page: PDFPage, grid: Grid, sheet: { w: number; h: number }): void {
  const colour = rgb(0, 0, 0)
  const line = (r: Rect) => {
    const p = toPdfRect(r, sheet.h)
    page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: colour })
  }

  for (let i = 0; i < grid.perSheet; i++) {
    const c = cellRect(grid, i)
    for (const x of [c.x, c.x + c.w]) {
      line({ x: x - 0.25, y: c.y - MARK_GAP - MARK_LEN, w: 0.5, h: MARK_LEN })
      line({ x: x - 0.25, y: c.y + c.h + MARK_GAP, w: 0.5, h: MARK_LEN })
    }
    for (const y of [c.y, c.y + c.h]) {
      line({ x: c.x - MARK_GAP - MARK_LEN, y: y - 0.25, w: MARK_LEN, h: 0.5 })
      line({ x: c.x + c.w + MARK_GAP, y: y - 0.25, w: MARK_LEN, h: 0.5 })
    }
  }
}

/**
 * Job name, sheet number and side, printed in the margin outside every card.
 * On a forty-sheet duplex job, unlabelled sheets get mixed up and one misplaced
 * back sheet ruins a full sheet of cards.
 *
 * Positioned in top-left points, like every other drawing site in this
 * codebase, and converted to PDF's bottom-left space through `toPdfRect` —
 * this module has no bespoke Y arithmetic of its own.
 */
export function drawSlug(page: PDFPage, text: string, sheet: { w: number; h: number }, font: PDFFont, margin: number): void {
  const size = Math.min(7, Math.max(4, margin - 4))
  // The bottom margin band (below the grid) runs from `sheet.h - margin` to
  // `sheet.h`. Centre the text's box vertically within it, top-left Y of the
  // box, then clamp so the box never crosses within 2pt of the physical
  // bottom edge on a very tight margin.
  const bandTop = sheet.h - margin
  const centred = bandTop + margin / 2 - size / 2
  const topY = Math.min(centred, sheet.h - 2 - size)
  const p = toPdfRect({ x: margin, y: topY, w: 0, h: size }, sheet.h)
  page.drawText(text, { x: p.x, y: p.y, size, font, color: rgb(0.4, 0.4, 0.4) })
}
