import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PDFFont } from 'pdf-lib'
import { FontRegistry } from '../src/fonts.js'
import { nodeFs } from '../src/node-io.js'
import { fitText } from '../src/text-fit.js'
import type { TextStyle } from '../src/layout.js'

const LIBERATION_SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'

let arial: PDFFont

beforeAll(async () => {
  const doc = await PDFDocument.create()
  const reg = await FontRegistry.load({ value: LIBERATION_SANS }, doc, nodeFs)
  arial = reg.get('value')
})

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  fontId: 'value',
  size: 9,
  color: { space: 'rgb', r: 0, g: 0, b: 0 },
  align: 'left',
  valign: 'top',
  fit: 'shrink',
  overflow: 'shrink',
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
    // At boxWidth 20 the hard-break fallback finds the maximal prefix that still
    // FITS ("LAKSH", ~19.7pt) — by construction that never exceeds the box, since
    // the whole point of the hard-break search is to stop shrinking once a prefix
    // fits. A returned line only genuinely exceeds the box in the narrower case
    // below, where the box is smaller than even one glyph and the cut-floor-of-1
    // guarantee (see wrap()'s hard-break comment) forces a character through
    // regardless of whether it fits.
    const tiny = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style(), 2, arial)
    expect(tiny.overflow).toBe(true)
    expect(arial.widthOfTextAtSize(tiny.lines[0]!, tiny.size)).toBeGreaterThan(2)
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

  it('wraps at the design size without shrinking when fit is wrap', () => {
    const wrapped = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style({ fit: 'wrap' }), 112.5, arial)
    expect(wrapped.size).toBe(9)
    expect(wrapped.overflow).toBe(true)

    const shrunk = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style({ fit: 'shrink' }), 112.5, arial)
    expect(shrunk.size).toBeLessThan(9)
  })
})

// The reference name box: 112.5pt at Liberation Sans, the same field width
// carried by fixtures/layout.json's `name` element. Every case below is
// measured against the real font metrics, not a stub.
const NAME_BOX = 112.5
const abbrev = (over: Partial<TextStyle> = {}) => style({ overflow: 'abbreviate-then-shrink', ...over })

describe('fitText overflow: abbreviate-then-shrink', () => {
  it('leaves a name that already fits untouched, unabbreviated', () => {
    const r = fitText('Anil Kumar Sharma', abbrev(), NAME_BOX, arial)
    expect(r.size).toBe(9)
    expect(r.lines).toEqual(['Anil Kumar Sharma'])
    expect(r.overflow).toBe(false)
    expect(r.abbreviated).toBe(false)
  })

  it('abbreviates the single middle name, keeping first and last intact', () => {
    // Full text (128.6pt) overflows the 112.5pt box at 9; abbreviating the
    // one middle token to an initial (103.1pt) fits at the designed size —
    // no shrink needed.
    const r = fitText('Ramesh Chandra Bhattacharjee', abbrev(), NAME_BOX, arial)
    expect(r.size).toBe(9)
    expect(r.lines).toEqual(['Ramesh C. Bhattacharjee'])
    expect(r.overflow).toBe(false)
    expect(r.abbreviated).toBe(true)
  })

  it('proves the ladder order: abbreviates at full size rather than shrinking, even though shrinking alone would fit', () => {
    const text = 'Ramesh Chandra Bhattacharjee'

    // Confirms the premise: shrinking the full, unabbreviated text alone
    // (today's 'shrink' behaviour) already succeeds, at ~7.75pt. A naive
    // implementation that shrinks before abbreviating would stop here,
    // never abbreviate, and still pass a weaker "does it fit" assertion.
    const shrunkAlone = fitText(text, style({ overflow: 'shrink' }), NAME_BOX, arial)
    expect(shrunkAlone.overflow).toBe(false)
    expect(shrunkAlone.size).toBeLessThan(9)

    // The actual ladder must not take that route: it abbreviates the middle
    // name and fits at the *designed* size, never touching minSize.
    const ladder = fitText(text, abbrev(), NAME_BOX, arial)
    expect(ladder.size).toBe(9)
    expect(ladder.abbreviated).toBe(true)
    expect(ladder.lines).toEqual(['Ramesh C. Bhattacharjee'])
  })

  it('abbreviates two middle names left to right, one at a time, stopping as soon as it fits', () => {
    const full = 'Anitha Lakshmi Priyadarshini Narasimhan'
    const afterFirstOnly = 'Anitha L. Priyadarshini Narasimhan'

    // Full text overflows, and so does abbreviating only the first middle
    // name — the ladder must not stop there.
    expect(arial.widthOfTextAtSize(full, 9)).toBeGreaterThan(NAME_BOX)
    expect(arial.widthOfTextAtSize(afterFirstOnly, 9)).toBeGreaterThan(NAME_BOX)

    const r = fitText(full, abbrev(), NAME_BOX, arial)
    expect(r.size).toBe(9)
    expect(r.lines).toEqual(['Anitha L. P. Narasimhan'])
    expect(r.overflow).toBe(false)
    expect(r.abbreviated).toBe(true)
  })

  it('falls straight through to shrinking for a two-token name — no middle to abbreviate', () => {
    const r = fitText('Venkataraghavan Subramaniam', abbrev(), NAME_BOX, arial)
    expect(r.abbreviated).toBe(false)
    expect(r.size).toBeLessThan(9)
    expect(r.size).toBe(7.75)
    expect(r.lines).toEqual(['Venkataraghavan Subramaniam'])
  })

  it('handles a single-token name: unabbreviated whether it fits or must shrink', () => {
    const fits = fitText('Om', abbrev(), NAME_BOX, arial)
    expect(fits.size).toBe(9)
    expect(fits.abbreviated).toBe(false)
    expect(fits.lines).toEqual(['Om'])

    const mustShrink = fitText('Venkataraghavansubramaniam', abbrev(), NAME_BOX, arial)
    expect(mustShrink.abbreviated).toBe(false)
    expect(mustShrink.size).toBe(8)
    expect(mustShrink.lines).toEqual(['Venkataraghavansubramaniam'])
  })

  it('does not re-abbreviate a name that already contains an initial', () => {
    // The middle token is already "P." — abbreviating it again yields
    // nothing, so the ladder has no rung beyond the original text and goes
    // straight to shrinking, exactly as if there were no middle at all.
    const r = fitText('Lakshmi P. Venkataraghavan', abbrev(), NAME_BOX, arial)
    expect(r.abbreviated).toBe(false)
    expect(r.overflow).toBe(false)
    expect(r.size).toBe(8.5)
    expect(r.lines).toEqual(['Lakshmi P. Venkataraghavan'])
  })

  it('shrinks after abbreviation is exhausted, and still reports overflow when minSize is not enough', () => {
    // First and last are themselves long enough that even the fully
    // abbreviated form cannot fit the 112.5pt box at minSize.
    const text = 'Venkataraghavansubramaniam Priyadarshini Padmanabhachandrasekharan'
    const r = fitText(text, abbrev(), NAME_BOX, arial)
    expect(r.abbreviated).toBe(true)
    expect(r.overflow).toBe(true)
    expect(r.size).toBe(6)
    expect(r.lines[0]).toContain('P.')
  })
})

describe('fitText overflow: shrink (regression guard)', () => {
  it('behaves exactly as before — the schema default and an explicit shrink are identical and never abbreviate', () => {
    const cases: Array<[string, number]> = [
      ['Rahul Kumar', 112.5],
      ['LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', 112.5],
      ['Ramesh Chandra Bhattacharjee', 112.5],
    ]
    for (const [text, box] of cases) {
      const withDefault = fitText(text, style(), box, arial)
      const withExplicitShrink = fitText(text, style({ overflow: 'shrink' }), box, arial)
      expect(withExplicitShrink).toEqual(withDefault)
      expect(withExplicitShrink.abbreviated).toBe(false)
    }
  })

  it('never abbreviates a name that abbreviate-then-shrink would have shortened, shrinking instead', () => {
    const text = 'Ramesh Chandra Bhattacharjee'
    const r = fitText(text, style({ overflow: 'shrink' }), 112.5, arial)
    expect(r.abbreviated).toBe(false)
    expect(r.lines[0]).not.toContain('.')
    expect(r.lines).toEqual(['Ramesh Chandra Bhattacharjee'])
    expect(r.size).toBeLessThan(9)
  })
})

// Load-bearing against real regressions: "narrower than one character" and the
// w = -5 case pin the hard-break floor and the non-positive-box guard
// respectively; "re-enters the hard break on every line" pins the floor across
// multiple lines. The remaining cases are characterisation of degenerate input
// and would pass against the pre-fix code.
describe('fitText termination', () => {
  it('returns rather than hanging when the line is narrower than one character', () => {
    const r = fitText('AAAA', style({ maxLines: 2 }), 0.5, arial)
    expect(r.overflow).toBe(true)
    expect(r.lines.length).toBeGreaterThan(0)
  })

  it('re-enters the hard break on every line without hanging', () => {
    // firstLineIndent is 0, so every line shares the same sub-glyph budget and
    // the hard-break floor is exercised repeatedly — not just on line one, which
    // is the only case the indent test reaches.
    const r = fitText('AAAA BBBB CCCC', style({ maxLines: 3, firstLineIndent: 0 }), 0.5, arial)
    expect(r.overflow).toBe(true)
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThanOrEqual(3)
  })

  it('returns rather than throwing for a non-positive box', () => {
    for (const w of [0, -5]) {
      const r = fitText('AB CD', style({ maxLines: 3 }), w, arial)
      expect(r.overflow).toBe(true)
      expect(r.lines.length).toBeGreaterThan(0)
    }
  })

  it('handles a single word wider than the whole line on one line', () => {
    const r = fitText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', style({ maxLines: 1 }), 20, arial)
    expect(r.overflow).toBe(true)
    expect(r.lines).toHaveLength(1)
  })

  it('handles empty and whitespace-only input without overflowing', () => {
    expect(fitText('', style(), 100, arial).overflow).toBe(false)
    expect(fitText('   ', style(), 100, arial).overflow).toBe(false)
  })

  it('handles a first-line indent wider than the box', () => {
    const r = fitText('Hello world', style({ maxLines: 2, firstLineIndent: 200 }), 100, arial)
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThanOrEqual(2)
  })
})
