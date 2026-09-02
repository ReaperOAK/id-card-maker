import { describe, expect, it } from 'vitest'
import { solveGrid } from '../src/grid.js'
import { mirrorIndex, sheetCount } from '../src/impose.js'
import { inches, mm } from '../src/units.js'

const grid = solveGrid({
  sheet: { w: inches(18), h: inches(12) },
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
