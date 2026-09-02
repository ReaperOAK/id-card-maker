import type { Rect } from './units.js'

export interface SheetSpec {
  w: number
  h: number
}

export interface GridOptions {
  sheet: SheetSpec
  card: SheetSpec
  gutter: number
  minMargin: number
}

export interface Grid {
  cols: number
  rows: number
  perSheet: number
  cellW: number
  cellH: number
  originX: number
  originY: number
  gutter: number
  rotated: boolean
}

interface Fit {
  cols: number
  rows: number
  gutter: number
}

/** Largest count that fits `span` given a card size and gutter, honouring the margin floor. */
function countFor(span: number, card: number, gutter: number, minMargin: number): number {
  const usable = span - 2 * minMargin
  if (usable < card) return 0
  return Math.max(0, Math.floor((usable + gutter) / (card + gutter)))
}

function bestFit(sheet: SheetSpec, card: SheetSpec, gutter: number, minMargin: number): Fit | null {
  let best: Fit | null = null
  // Walk from the requested gutter down to butt-cut, keeping whichever gutter
  // yields the most cards. Ties keep the largest gutter, which is seen first:
  // a wider gutter is easier to cut cleanly, so it wins when the yield is equal.
  for (let g = gutter; g >= 0; g = Math.max(0, g - 0.5)) {
    const cols = countFor(sheet.w, card.w, g, minMargin)
    const rows = countFor(sheet.h, card.h, g, minMargin)
    if (cols > 0 && rows > 0 && (best === null || cols * rows > best.cols * best.rows)) {
      best = { cols, rows, gutter: g }
    }
    if (g === 0) break
  }
  return best
}

/**
 * Solve the sheet layout. Both orientations are evaluated because rotation can
 * win outright for some card sizes; ties go to the upright orientation so the
 * output matches how the template was designed.
 *
 * Margins are always symmetric. Duplex registration depends on it: with unequal
 * left and right margins, every card on every mirrored back sheet is offset by
 * the difference.
 */
export function solveGrid(opts: GridOptions): Grid {
  const { sheet, card, gutter, minMargin } = opts

  const upright = bestFit(sheet, card, gutter, minMargin)
  const turned = bestFit(sheet, { w: card.h, h: card.w }, gutter, minMargin)

  const uprightCount = upright ? upright.cols * upright.rows : 0
  const turnedCount = turned ? turned.cols * turned.rows : 0

  if (uprightCount === 0 && turnedCount === 0) {
    throw new Error(
      `Card ${card.w.toFixed(2)} x ${card.h.toFixed(2)}pt does not fit sheet ${sheet.w.toFixed(2)} x ${sheet.h.toFixed(2)}pt with a ${minMargin.toFixed(2)}pt margin`,
    )
  }

  const rotated = turnedCount > uprightCount
  const fit = (rotated ? turned : upright)!
  const cellW = rotated ? card.h : card.w
  const cellH = rotated ? card.w : card.h

  const usedW = fit.cols * cellW + (fit.cols - 1) * fit.gutter
  const usedH = fit.rows * cellH + (fit.rows - 1) * fit.gutter

  return {
    cols: fit.cols,
    rows: fit.rows,
    perSheet: fit.cols * fit.rows,
    cellW,
    cellH,
    originX: (sheet.w - usedW) / 2,
    originY: (sheet.h - usedH) / 2,
    gutter: fit.gutter,
    rotated,
  }
}

/** Position of cell `index` within a sheet, row-major from the top-left. */
export function cellRect(grid: Grid, index: number): Rect {
  const col = index % grid.cols
  const row = Math.floor(index / grid.cols)
  return {
    x: grid.originX + col * (grid.cellW + grid.gutter),
    y: grid.originY + row * (grid.cellH + grid.gutter),
    w: grid.cellW,
    h: grid.cellH,
  }
}
