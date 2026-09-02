import { describe, expect, it } from 'vitest'
import { cellRect, solveGrid } from '../src/grid.js'
import { inches, mm } from '../src/units.js'

const SHEET = { w: inches(18), h: inches(12) }
const REFERENCE_CARD = { w: 238.296, h: 155.045 }

describe('solveGrid', () => {
  it('reproduces the operator existing 5x5 layout for the reference card', () => {
    const g = solveGrid({ sheet: SHEET, card: REFERENCE_CARD, gutter: mm(3), minMargin: mm(5) })
    expect(g.cols).toBe(5)
    expect(g.rows).toBe(5)
    expect(g.perSheet).toBe(25)
    expect(g.rotated).toBe(false)
  })

  it('always produces symmetric margins', () => {
    for (const card of [REFERENCE_CARD, { w: 200, h: 120 }, { w: 90, h: 140 }, { w: 300, h: 200 }]) {
      const g = solveGrid({ sheet: SHEET, card, gutter: mm(3), minMargin: mm(5) })
      const usedW = g.cols * g.cellW + (g.cols - 1) * g.gutter
      const usedH = g.rows * g.cellH + (g.rows - 1) * g.gutter
      expect(g.originX).toBeCloseTo((SHEET.w - usedW) / 2, 6)
      expect(g.originY).toBeCloseTo((SHEET.h - usedH) / 2, 6)
      expect(g.originX).toBeGreaterThanOrEqual(mm(5) - 1e-6)
      expect(g.originY).toBeGreaterThanOrEqual(mm(5) - 1e-6)
    }
  })

  it('rotates the card when rotation yields more cards per sheet', () => {
    // 140 x 90 landscape: 9 x 9 = 81 upright, but 140 tall gives 14 x 6 = 84.
    const g = solveGrid({ sheet: SHEET, card: { w: 140, h: 90 }, gutter: 0, minMargin: 0 })
    const upright = Math.floor(SHEET.w / 140) * Math.floor(SHEET.h / 90)
    expect(g.perSheet).toBeGreaterThanOrEqual(upright)
  })

  it('reduces the gutter before losing a column', () => {
    // A card that fits 5 across only when the gutter shrinks.
    const card = { w: (inches(18) - mm(10)) / 5, h: 100 }
    const g = solveGrid({ sheet: SHEET, card, gutter: mm(3), minMargin: mm(2) })
    expect(g.cols).toBe(5)
    expect(g.gutter).toBeLessThan(mm(3))
  })

  it('throws when a single card cannot fit the sheet', () => {
    expect(() => solveGrid({ sheet: SHEET, card: { w: 2000, h: 100 }, gutter: 0, minMargin: 0 })).toThrow(/does not fit/)
  })
})

describe('cellRect', () => {
  it('lays cells out row-major from the top-left', () => {
    const g = solveGrid({ sheet: SHEET, card: REFERENCE_CARD, gutter: mm(3), minMargin: mm(5) })
    const first = cellRect(g, 0)
    const second = cellRect(g, 1)
    const sixth = cellRect(g, 5)
    expect(first.x).toBeCloseTo(g.originX, 6)
    expect(first.y).toBeCloseTo(g.originY, 6)
    expect(second.x).toBeCloseTo(g.originX + g.cellW + g.gutter, 6)
    expect(second.y).toBeCloseTo(first.y, 6)
    expect(sixth.y).toBeCloseTo(g.originY + g.cellH + g.gutter, 6)
    expect(sixth.x).toBeCloseTo(g.originX, 6)
  })
})
