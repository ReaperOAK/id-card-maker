import { describe, expect, it } from 'vitest'
import { PT_PER_IN, PT_PER_MM, flipY, fromPdfRect, inches, mm, toPdfRect } from '../src/units.js'

describe('units', () => {
  it('converts inches and millimetres to points', () => {
    expect(inches(1)).toBe(72)
    expect(inches(18)).toBe(1296)
    expect(mm(25.4)).toBeCloseTo(72, 10)
    expect(PT_PER_IN).toBe(72)
    expect(PT_PER_MM).toBeCloseTo(2.834645, 5)
  })

  it('flips a top-left rect into PDF bottom-left space', () => {
    // A 10pt-tall box whose top sits 20pt below the top of a 100pt page
    // has its bottom edge at 100 - 20 - 10 = 70 in PDF space.
    expect(toPdfRect({ x: 5, y: 20, w: 30, h: 10 }, 100)).toEqual({ x: 5, y: 70, w: 30, h: 10 })
  })

  it('flips a single top-left-origin Y coordinate into PDF bottom-left space (Minor 8)', () => {
    // A point 20pt below the top of a 100pt-tall page sits 80pt above the
    // bottom of the page in PDF space — the same arithmetic toPdfRect uses,
    // pinned directly since flipY is one of the two functions (alongside
    // toPdfRect) the codebase's coordinate discipline rests on.
    expect(flipY(100, 20)).toBe(80)
    // The top of the page (y = 0 in top-left space) sits at the full page
    // height in PDF space.
    expect(flipY(216, 0)).toBe(216)
    // The bottom of the page (y = pageHeight in top-left space) sits at 0.
    expect(flipY(216, 216)).toBe(0)
  })

  it('round-trips any rect through both flips', () => {
    for (const h of [1, 216, 864, 1000.5]) {
      for (const r of [
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 24.854, y: 30.477, w: 238.296, h: 155.045 },
        { x: -5, y: 12.5, w: 0.25, h: 0.75 },
      ]) {
        const back = fromPdfRect(toPdfRect(r, h), h)
        expect(back.x).toBeCloseTo(r.x, 10)
        expect(back.y).toBeCloseTo(r.y, 10)
        expect(back.w).toBeCloseTo(r.w, 10)
        expect(back.h).toBeCloseTo(r.h, 10)
      }
    }
  })
})
