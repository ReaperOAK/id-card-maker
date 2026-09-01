import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PDFFont } from 'pdf-lib'
import { FontRegistry } from '../src/fonts.js'
import { fitText } from '../src/text-fit.js'
import type { TextStyle } from '../src/layout.js'

const LIBERATION_SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'

let arial: PDFFont

beforeAll(async () => {
  const doc = await PDFDocument.create()
  const reg = await FontRegistry.load({ value: LIBERATION_SANS }, doc)
  arial = reg.get('value')
})

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  fontId: 'value',
  size: 9,
  color: { space: 'rgb', r: 0, g: 0, b: 0 },
  align: 'left',
  valign: 'top',
  fit: 'shrink',
  minSize: 6,
  lineHeight: 10.555,
  maxLines: 1,
  firstLineIndent: 0,
  ...over,
})

describe('fitText', () => {
  it('leaves short text at its designed size', () => {
    const r = fitText('Rahul Kumar', style(), 112.5, arial)
    expect(r.size).toBe(9)
    expect(r.lines).toEqual(['Rahul Kumar'])
    expect(r.overflow).toBe(false)
  })

  it('confirms the reference template metric: x is 4.5pt at Arial 9', () => {
    // Appendix A of the spec derives every field budget from this.
    expect(arial.widthOfTextAtSize('x', 9)).toBeCloseTo(4.5, 2)
  })

  it('shrinks a long name to fit rather than overflowing', () => {
    const r = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style(), 112.5, arial)
    expect(r.size).toBeLessThan(9)
    expect(r.size).toBeGreaterThanOrEqual(6)
    expect(r.lines).toHaveLength(1)
    expect(arial.widthOfTextAtSize(r.lines[0]!, r.size)).toBeLessThanOrEqual(112.5)
  })

  it('reports overflow when even minSize will not fit', () => {
    const r = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style(), 20, arial)
    expect(r.overflow).toBe(true)
    expect(r.size).toBe(6)
  })

  it('wraps an address across two lines with the first line indented', () => {
    const r = fitText('12 Park Street, Kolkata 700016', style({ maxLines: 2, firstLineIndent: 36.6 }), 162.59, arial)
    expect(r.overflow).toBe(false)
    expect(r.lines.length).toBeLessThanOrEqual(2)
    // First line is shortened by the indent; second line uses the full width.
    expect(arial.widthOfTextAtSize(r.lines[0]!, r.size)).toBeLessThanOrEqual(162.59 - 36.6)
  })

  it('breaks a single unbreakable token rather than looping forever', () => {
    const r = fitText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', style({ maxLines: 2 }), 30, arial)
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThanOrEqual(2)
  })
})
