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
      // The property, not the formula: what is left of the block equals what is
      // right of it. Duplex back sheets are produced by mirroring cell positions,
      // so any asymmetry offsets every card on every back sheet.
      expect(SHEET.w - g.originX - usedW).toBeCloseTo(g.originX, 6)
      expect(SHEET.h - g.originY - usedH).toBeCloseTo(g.originY, 6)
      expect(g.originX).toBeGreaterThanOrEqual(mm(5) - 1e-6)
      expect(g.originY).toBeGreaterThanOrEqual(mm(5) - 1e-6)
    }
  })

  it('rotates the card when rotation yields more cards per sheet', () => {
    const g = solveGrid({ sheet: SHEET, card: { w: 140, h: 90 }, gutter: 0, minMargin: 0 })
    // 140x90 upright fits 9x9 = 81. Turned, 90 wide by 140 tall, it fits
    // 14x6 = 84 — so a solver that never rotates loses 3 cards per sheet.
    expect(g.rotated).toBe(true)
    expect(g.cols).toBe(14)
    expect(g.rows).toBe(6)
    expect(g.perSheet).toBe(84)
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
