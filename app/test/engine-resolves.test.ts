import { describe, expect, it } from 'vitest'
import { solveGrid } from '@engine/grid.js'
import { inches } from '@engine/units.js'

describe('engine resolves through the @engine alias', () => {
  it('solves the reference card to a 5x5 grid', () => {
    const g = solveGrid({
      sheet: { w: inches(18), h: inches(12) },
      card: { w: 238.296, h: 155.045 },
      gutter: 8.5,
      minMargin: 14,
    })
    expect(g.cols).toBe(5)
    expect(g.rows).toBe(5)
  })
})
