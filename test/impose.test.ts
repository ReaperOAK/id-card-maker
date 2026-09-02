import { describe, expect, it } from 'vitest'
import { cellRect, solveGrid } from '../src/grid.js'
import { cropMarkRects, mirrorIndex, sheetCount } from '../src/impose.js'
import { inches, mm, type Rect } from '../src/units.js'

const SHEET = { w: inches(18), h: inches(12) }

const grid = solveGrid({
  sheet: SHEET,
  card: { w: 238.296, h: 155.045 },
  gutter: mm(3),
  minMargin: mm(5),
})

describe('mirrorIndex', () => {
  it('reverses columns for a long-edge flip and leaves rows alone', () => {
    // Front row 0 reads 0 1 2 3 4; the back sheet must read 4 3 2 1 0.
    expect(mirrorIndex(grid, 0, 'long-edge')).toBe(4)
    expect(mirrorIndex(grid, 4, 'long-edge')).toBe(0)
    expect(mirrorIndex(grid, 5, 'long-edge')).toBe(9)
    expect(mirrorIndex(grid, 12, 'long-edge')).toBe(12)
  })

  it('reverses rows for a short-edge flip and leaves columns alone', () => {
    expect(mirrorIndex(grid, 0, 'short-edge')).toBe(20)
    expect(mirrorIndex(grid, 20, 'short-edge')).toBe(0)
    expect(mirrorIndex(grid, 12, 'short-edge')).toBe(12)
  })

  it('is its own inverse on both axes', () => {
    for (let i = 0; i < grid.perSheet; i++) {
      expect(mirrorIndex(grid, mirrorIndex(grid, i, 'long-edge'), 'long-edge')).toBe(i)
      expect(mirrorIndex(grid, mirrorIndex(grid, i, 'short-edge'), 'short-edge')).toBe(i)
    }
  })
})

describe('sheetCount', () => {
  it('rounds up for a partial final sheet', () => {
    expect(sheetCount(1000, 25)).toBe(40)
    expect(sheetCount(1001, 25)).toBe(41)
    expect(sheetCount(0, 25)).toBe(0)
  })
})

/** True when two top-left rects share any interior area (touching edges do not count). */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

describe('cropMarkRects', () => {
  // Zero gutter: adjacent cards butt against each other with no room to cut between them.
  const buttCutGrid = solveGrid({ sheet: SHEET, card: { w: 140, h: 90 }, gutter: 0, minMargin: 0 })

  it('never draws a mark inside a card, for the reference grid', () => {
    const marks = cropMarkRects(grid, SHEET)
    for (let i = 0; i < grid.perSheet; i++) {
      const cell = cellRect(grid, i)
      for (const mark of marks) {
        expect(rectsOverlap(mark, cell)).toBe(false)
      }
    }
  })

  it('never draws a mark inside a card, for a zero-gutter (butt-cut) grid', () => {
    const marks = cropMarkRects(buttCutGrid, SHEET)
    for (let i = 0; i < buttCutGrid.perSheet; i++) {
      const cell = cellRect(buttCutGrid, i)
      for (const mark of marks) {
        expect(rectsOverlap(mark, cell)).toBe(false)
      }
    }
  })

  it('omits interior marks on a butt-cut grid, leaving strictly fewer marks than a generous gutter', () => {
    // Same card, but a margin floor tight enough to rule out the 14x6 packing
    // solveGrid would otherwise prefer (which, like the butt-cut grid, cannot
    // fit gutter room above the 4pt survival threshold). At 13x5 there is
    // enough sheet slack left for a real ~5.7pt gutter, so interior marks
    // actually get to survive here.
    const generousGutterGrid = solveGrid({ sheet: SHEET, card: { w: 140, h: 90 }, gutter: mm(8), minMargin: mm(10) })
    expect(generousGutterGrid.gutter).toBeGreaterThan(4) // sanity: interior marks can actually fit

    const buttCutMarks = cropMarkRects(buttCutGrid, SHEET)
    const generousMarks = cropMarkRects(generousGutterGrid, SHEET)

    expect(buttCutMarks.length).toBeLessThan(generousMarks.length)

    // Every surviving butt-cut mark must sit in the outer margin band on some
    // side of the sheet — nothing is left over from an omitted interior edge.
    for (const mark of buttCutMarks) {
      const inTopMargin = mark.y + mark.h <= buttCutGrid.originY
      const inBottomMargin = mark.y >= SHEET.h - buttCutGrid.originY
      const inLeftMargin = mark.x + mark.w <= buttCutGrid.originX
      const inRightMargin = mark.x >= SHEET.w - buttCutGrid.originX
      expect(inTopMargin || inBottomMargin || inLeftMargin || inRightMargin).toBe(true)
    }
  })

  it('keeps every mark on the sheet for a tight margin grid', () => {
    // The same fixture as the grid.test.ts "reduces the gutter before losing a
    // column" case: originX is squeezed down to roughly 6.165pt.
    const card = { w: (inches(18) - mm(10)) / 5, h: 100 }
    const tightGrid = solveGrid({ sheet: SHEET, card, gutter: mm(3), minMargin: mm(2) })

    const marks = cropMarkRects(tightGrid, SHEET)
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) {
      expect(mark.x).toBeGreaterThanOrEqual(0)
      expect(mark.y).toBeGreaterThanOrEqual(0)
      expect(mark.x + mark.w).toBeLessThanOrEqual(SHEET.w)
      expect(mark.y + mark.h).toBeLessThanOrEqual(SHEET.h)
    }
  })
})
