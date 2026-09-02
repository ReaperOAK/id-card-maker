import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { applyTransform, ascentAtSize, capHeightAtSize, drawCard, resolveText } from '../src/card.js'
import type { Element, TextStyle } from '../src/layout.js'
import { parseLayout } from '../src/layout.js'
import { rasterize } from '../src/raster.js'
import { fitText } from '../src/text-fit.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))

// A 1x1 red PNG (alpha 127/255, so it composites to (255,128,128) over a
// white background). Scaled to cover, it floods the photo box with that
// pinkish-red, so any matching pixel outside that box means the nested clip
// failed.
const RED_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('applyTransform', () => {
  it('upper-cases and title-cases', () => {
    expect(applyTransform('rahul kumar', { column: 'Name', transform: 'upper' })).toBe('RAHUL KUMAR')
    expect(applyTransform('rahul kumar', { column: 'Name', transform: 'title' })).toBe('Rahul Kumar')
  })

  it('leaves values alone when no transform is set', () => {
    expect(applyTransform('X-A', { column: 'Class' })).toBe('X-A')
  })
})

describe('applyTransform date (F4)', () => {
  it('parses DD.MM.YYYY, the shape cellText emits for a genuine Excel Date cell', () => {
    expect(applyTransform('12.04.2010', { column: 'DOB', transform: 'date', format: 'YYYY-MM-DD' })).toBe(
      '2010-04-12',
    )
  })

  it('parses DD/MM/YYYY', () => {
    expect(applyTransform('12/04/2010', { column: 'DOB', transform: 'date', format: 'YYYY-MM-DD' })).toBe(
      '2010-04-12',
    )
  })

  it('parses DD-MM-YYYY', () => {
    expect(applyTransform('12-04-2010', { column: 'DOB', transform: 'date', format: 'YYYY-MM-DD' })).toBe(
      '2010-04-12',
    )
  })

  it('parses ISO YYYY-MM-DD', () => {
    expect(applyTransform('2010-04-12', { column: 'DOB', transform: 'date', format: 'DD/MM/YYYY' })).toBe(
      '12/04/2010',
    )
  })

  it('substitutes each format token (DD, MM, YYYY, YY)', () => {
    expect(applyTransform('05.09.2010', { column: 'DOB', transform: 'date', format: 'DD' })).toBe('05')
    expect(applyTransform('05.09.2010', { column: 'DOB', transform: 'date', format: 'MM' })).toBe('09')
    expect(applyTransform('05.09.2010', { column: 'DOB', transform: 'date', format: 'YYYY' })).toBe('2010')
    expect(applyTransform('05.09.2010', { column: 'DOB', transform: 'date', format: 'YY' })).toBe('10')
    // A format mixing every token with literal separators, to prove YYYY is
    // consumed whole rather than as two overlapping YY matches.
    expect(applyTransform('05.09.2010', { column: 'DOB', transform: 'date', format: 'YYYY/YY-MM.DD' })).toBe(
      '2010/10-09.05',
    )
  })

  it('defaults to DD.MM.YYYY when format is absent', () => {
    expect(applyTransform('2010-04-12', { column: 'DOB', transform: 'date' })).toBe('12.04.2010')
  })

  it('returns an unparseable value unchanged rather than throwing or emitting a wrong date', () => {
    expect(applyTransform('not a date', { column: 'DOB', transform: 'date', format: 'YYYY-MM-DD' })).toBe(
      'not a date',
    )
    expect(applyTransform('', { column: 'DOB', transform: 'date' })).toBe('')
    // Out-of-range month/day: shape matches but the value is not a real date.
    expect(applyTransform('32.13.2010', { column: 'DOB', transform: 'date' })).toBe('32.13.2010')
  })
})

describe('resolveText', () => {
  it('flags an empty required field as missing', () => {
    const r = resolveText({ index: 2, values: { Name: '' } }, { column: 'Name' })
    expect(r.missing).toBe(true)
  })

  it('uses the fallback and does not flag when one is declared', () => {
    const r = resolveText({ index: 2, values: { 'Blood Group': '' } }, { column: 'Blood Group', fallback: '-' })
    expect(r).toEqual({ text: '-', missing: false })
  })
})

describe('ascentAtSize', () => {
  it('reads the true ascent, which pdf-lib heightAtSize gets wrong for this font', async () => {
    const doc = await PDFDocument.create()
    const reg = await FontRegistry.load(
      { value: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf' },
      doc,
    )
    const font = reg.get('value')
    // LiberationSans: unitsPerEm 2048, ascender 1854 => (1854/2048)*9 = 8.1475pt.
    // pdf-lib 1.17.1's heightAtSize(9, {descender:false}) returns 6.1489 here,
    // because it subtracts a raw descent from an already-scaled height — which
    // only cancels when unitsPerEm is 1000. A 2pt baseline shift on every card.
    expect(ascentAtSize(font, 9)).toBeCloseTo(8.1475, 3)
    expect(ascentAtSize(font, 18)).toBeCloseTo(16.295, 3)
  })
})

describe('drawCard', () => {
  it('paints nothing outside the destination cell', async () => {
    const l = layout()
    // The noisy fixture has magenta ink in its page surround, entirely outside
    // the trim box. Without the clip path, offsetting the page so trim aligns
    // with the cell would carry that mark outside the cell and onto whatever
    // sits next to it on the sheet.
    const templateBytes = new Uint8Array(readFileSync('fixtures/template-noisy.pdf'))

    const out = await PDFDocument.create()
    const page = out.addPage([400, 400])
    const fonts = await FontRegistry.load(l.fonts, out)
    const [embedded] = await out.embedPdf(templateBytes, [0])

    drawCard({
      page,
      embedded: embedded!,
      layout: l,
      elements: l.front,
      fonts,
      row: { index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar', Address: '12 Park Street' } },
      cell: { x: 100, y: 100, w: l.trim.w, h: l.trim.h },
      photo: null,
    })

    const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
    let magenta = 0
    for (let i = 0; i < raster.rgba.length; i += 4) {
      if ((raster.rgba[i + 3] ?? 0) === 0) continue
      const r = raster.rgba[i] ?? 0
      const g = raster.rgba[i + 1] ?? 0
      const b = raster.rgba[i + 2] ?? 0
      if (r > 200 && g < 80 && b > 200) magenta++
    }
    // The noisy template's magenta mark lives in the page surround, outside the
    // trim box. Offsetting the page so trim aligns with the cell puts that mark
    // outside the cell, so the clip path must remove every pixel of it.
    expect(magenta).toBe(0)
  })

  it('reports overflow for a name that cannot fit', async () => {
    const l = layout()
    const out = await PDFDocument.create()
    const page = out.addPage([400, 400])
    const fonts = await FontRegistry.load(l.fonts, out)
    const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])

    const result = drawCard({
      page,
      embedded: embedded!,
      layout: l,
      elements: l.front,
      fonts,
      row: { index: 4, values: { 'ID No.': '103', Name: 'LAKSHMI PRIYADARSHINI VENKATARAGHAVAN'.repeat(3) } },
      cell: { x: 0, y: 0, w: l.trim.w, h: l.trim.h },
      photo: null,
    })

    expect(result.overflowed).toContain('name')
    expect(result.missing).toContain('guardian')
  })

  it('fills the photo box and paints no photo ink outside it', async () => {
    const l = layout()
    const out = await PDFDocument.create()
    const page = out.addPage([400, 400])
    const fonts = await FontRegistry.load(l.fonts, out)
    const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])
    const photo = await out.embedPng(Buffer.from(RED_PIXEL_PNG, 'base64'))

    const cell = { x: 0, y: 0, w: l.trim.w, h: l.trim.h }
    drawCard({
      page, embedded: embedded!, layout: l, elements: l.front, fonts,
      row: { index: 2, values: { 'ID No.': '101', Name: 'A' } },
      cell, photo,
    })

    const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
    const photoEl = l.front.find((e) => e.id === 'photo')
    if (photoEl?.kind !== 'photo') throw new Error('photo element missing from fixture')
    // Photo element boxes are in template page coordinates; the cell is placed
    // at the trim origin, so subtract the trim offset to get sheet coordinates.
    const bx = cell.x - l.trim.x + photoEl.box.x
    const by = cell.y - l.trim.y + photoEl.box.y

    let inside = 0
    let outside = 0
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const i = (y * raster.width + x) * 4
        if ((raster.rgba[i + 3] ?? 0) === 0) continue
        const r = raster.rgba[i] ?? 0
        const g = raster.rgba[i + 1] ?? 0
        const b = raster.rgba[i + 2] ?? 0
        // The fixture PNG's actual composited colour, over white, is
        // (255,128,128) — see the RED_PIXEL_PNG comment above.
        if (!(r > 240 && g > 100 && g < 160 && b > 100 && b < 160)) continue
        const within = x >= bx - 1 && x <= bx + photoEl.box.w + 1 && y >= by - 1 && y <= by + photoEl.box.h + 1
        if (within) inside++
        else outside++
      }
    }
    // A flat pixel-count floor (e.g. > 1000) does not discriminate a
    // Math.max/Math.min swap in the cover branch here: with a 1x1 (square)
    // source image, an accidentally-`contain`-like scale still produces a
    // same-aspect-ratio rectangle comfortably over 1000 px, just smaller than
    // the box. `cover` must fill the box entirely, so assert coverage as a
    // fraction of the box's own area instead — this does drop measurably
    // under the swap (see the discrimination check in the task report).
    const boxArea = photoEl.box.w * photoEl.box.h
    expect(inside).toBeGreaterThan(boxArea * 0.9)
    expect(outside).toBe(0)
  })

  describe('valign', () => {
    // A text element independent of the layout fixture, isolated to a blank
    // area of the box so only this element's ink is on the page. A single
    // line in a box far taller than lineHeight, so top/middle/bottom offsets
    // (0, (h - lineHeight) / 2, h - lineHeight) land far apart on the page.
    const textElement = (id: string, valign: 'top' | 'middle' | 'bottom'): Element => ({
      kind: 'text',
      id,
      page: 'front',
      box: { x: 50, y: 60, w: 150, h: 100 },
      bind: { column: 'Name' },
      style: {
        fontId: 'value',
        size: 24,
        color: { space: 'rgb', r: 0, g: 0, b: 1 },
        align: 'left',
        valign,
        fit: 'clip',
        minSize: 24,
        lineHeight: 24,
        maxLines: 1,
        firstLineIndent: 0,
      },
    })

    // Topmost raster row (smallest y) containing pure-blue ink, i.e. this
    // element's text and nothing from the template artwork.
    async function topInkRow(valign: 'top' | 'middle' | 'bottom'): Promise<number> {
      const l = layout()
      const out = await PDFDocument.create()
      const page = out.addPage([400, 400])
      const fonts = await FontRegistry.load(l.fonts, out)
      const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])

      drawCard({
        page,
        embedded: embedded!,
        layout: l,
        elements: [textElement('valign_test', valign)],
        fonts,
        row: { index: 1, values: { Name: 'Hi' } },
        cell: { x: 0, y: 0, w: l.trim.w, h: l.trim.h },
        photo: null,
      })

      const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
      for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
          const i = (y * raster.width + x) * 4
          if ((raster.rgba[i + 3] ?? 0) === 0) continue
          const r = raster.rgba[i] ?? 0
          const g = raster.rgba[i + 1] ?? 0
          const b = raster.rgba[i + 2] ?? 0
          if (b > 200 && r < 80 && g < 80) return y
        }
      }
      throw new Error(`no ink found for valign=${valign}`)
    }

    it('places middle- and bottom-aligned text lower on the page than top', async () => {
      const topRow = await topInkRow('top')
      const middleRow = await topInkRow('middle')
      const bottomRow = await topInkRow('bottom')

      expect(middleRow).toBeGreaterThan(topRow)
      expect(bottomRow).toBeGreaterThan(middleRow)
    })
  })

  describe('baseline anchoring (F1)', () => {
    // Every element here draws only the glyph 'H': flat-topped, with no part
    // of the glyph rising above cap height, so the topmost row of ink is
    // predictable — exactly capHeight above the baseline, at whatever size
    // the text actually ends up drawn at.
    const hStyle = (minSize: number): TextStyle => ({
      fontId: 'value',
      size: 24,
      color: { space: 'rgb', r: 0, g: 0, b: 0 },
      align: 'left',
      valign: 'top',
      fit: 'shrink',
      minSize,
      lineHeight: 30,
      maxLines: 1,
      firstLineIndent: 0,
    })

    const hElement = (id: string, text: string, boxW: number, minSize: number): Element => ({
      kind: 'static',
      id,
      page: 'front',
      box: { x: 40, y: 60, w: boxW, h: 40 },
      text,
      style: hStyle(minSize),
    })

    async function renderAndFindTopInkRow(el: Element) {
      const l = layout()
      const out = await PDFDocument.create()
      const page = out.addPage([400, 400])
      const fonts = await FontRegistry.load(l.fonts, out)
      const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])
      const cell = { x: 0, y: 0, w: l.trim.w, h: l.trim.h }

      drawCard({
        page,
        embedded: embedded!,
        layout: l,
        elements: [el],
        fonts,
        row: { index: 1, values: {} },
        cell,
        photo: null,
      })

      const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
      for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
          const i = (y * raster.width + x) * 4
          if ((raster.rgba[i + 3] ?? 0) === 0) continue
          const r = raster.rgba[i] ?? 255
          const g = raster.rgba[i + 1] ?? 255
          const b = raster.rgba[i + 2] ?? 255
          if (r < 40 && g < 40 && b < 40) return { topRow: y, font: fonts.get('value'), l, cell }
        }
      }
      throw new Error('no ink found')
    }

    it('draws the topmost ink row where box.y + ascent - capHeight predicts, within ~1pt', async () => {
      const style = hStyle(6)
      const el = hElement('h_pin', 'H', 300, 6)
      const { topRow, font, l, cell } = await renderAndFindTopInkRow(el)
      // box.y is in template page coordinates; drawCard offsets it by the
      // cell/trim placement before drawing, so the prediction must too.
      const boxY = cell.y - l.trim.y + el.box.y
      const predicted = boxY + ascentAtSize(font, style.size) - capHeightAtSize(font, style.size)
      expect(Math.abs(topRow - predicted)).toBeLessThanOrEqual(1)
    })

    it('anchors a value that shrinks at the same baseline as one that does not — the regression guard for F1(a)', async () => {
      const style = hStyle(6)
      const noShrink = hElement('h_full', 'H', 300, 6)
      const shrunk = hElement('h_shrunk', 'HHHHHH', 60, 6)

      const a = await renderAndFindTopInkRow(noShrink)
      const b = await renderAndFindTopInkRow(shrunk)

      const fitA = fitText('H', style, 300, a.font)
      const fitB = fitText('HHHHHH', style, 60, b.font)
      // Confirms the fixture actually exercises shrink-to-fit; otherwise this
      // test would pass vacuously regardless of which size the baseline is
      // anchored on.
      expect(fitB.size).toBeLessThan(fitA.size)

      // topRow + capHeight(at the size actually drawn) recovers the baseline
      // each element was drawn at. Anchoring the baseline on the shrunk size
      // (F1's regression) would separate these by the gap between the two
      // capHeights — several points for this font and box, not noise.
      const baselineA = a.topRow + capHeightAtSize(a.font, fitA.size)
      const baselineB = b.topRow + capHeightAtSize(b.font, fitB.size)
      expect(Math.abs(baselineA - baselineB)).toBeLessThanOrEqual(1)
    })
  })

  describe('fit: clip (F5)', () => {
    it('draws no ink from a clip element outside its own box', async () => {
      const l = layout()
      const out = await PDFDocument.create()
      const page = out.addPage([400, 400])
      const fonts = await FontRegistry.load(l.fonts, out)
      const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])
      const cell = { x: 0, y: 0, w: l.trim.w, h: l.trim.h }

      const el: Element = {
        kind: 'static',
        id: 'clip_overflow',
        page: 'front',
        // A narrow box holding a string many times wider than it, at a fit
        // mode ('clip') that never shrinks or wraps — fitText hands back the
        // whole overflowing string and only reports overflow: true, relying
        // on the caller to actually clip it.
        box: { x: 60, y: 80, w: 40, h: 20 },
        text: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
        style: {
          fontId: 'value',
          size: 20,
          color: { space: 'rgb', r: 0, g: 0, b: 1 },
          align: 'left',
          valign: 'top',
          fit: 'clip',
          minSize: 20,
          lineHeight: 24,
          maxLines: 1,
          firstLineIndent: 0,
        },
      }

      drawCard({
        page,
        embedded: embedded!,
        layout: l,
        elements: [el],
        fonts,
        row: { index: 1, values: {} },
        cell,
        photo: null,
      })

      const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
      const bx = cell.x - l.trim.x + el.box.x
      const by = cell.y - l.trim.y + el.box.y

      let inside = 0
      let outside = 0
      for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
          const i = (y * raster.width + x) * 4
          if ((raster.rgba[i + 3] ?? 0) === 0) continue
          const r = raster.rgba[i] ?? 0
          const g = raster.rgba[i + 1] ?? 0
          const b = raster.rgba[i + 2] ?? 0
          if (!(b > 200 && r < 80 && g < 80)) continue
          const within = x >= bx - 1 && x <= bx + el.box.w + 1 && y >= by - 1 && y <= by + el.box.h + 1
          if (within) inside++
          else outside++
        }
      }
      // The string is wide enough that, unclipped, it would draw ink far past
      // the right edge of a 40pt box — confirm some ink was actually drawn
      // (the test would prove nothing if the string were invisible), and that
      // every drawn pixel is contained in the box.
      expect(inside).toBeGreaterThan(0)
      expect(outside).toBe(0)
    })
  })

  describe('valignOffset clamp (Minor 7)', () => {
    it('never draws a block above the top of its own box, even when the block is taller than the box', async () => {
      const l = layout()
      const out = await PDFDocument.create()
      const page = out.addPage([400, 400])
      const fonts = await FontRegistry.load(l.fonts, out)
      const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])
      const cell = { x: 0, y: 0, w: l.trim.w, h: l.trim.h }

      const el: Element = {
        kind: 'static',
        id: 'overflow_block',
        page: 'front',
        // box.h (10) is far shorter than a single line at this lineHeight
        // (60), so blockHeight - box.h is deeply negative (-50) for valign
        // 'bottom'. Unclamped, that pushes the block 50pt upward out of the
        // box; clamped, the block starts flush with the top of the box.
        box: { x: 50, y: 100, w: 150, h: 10 },
        text: 'AB',
        style: {
          fontId: 'value',
          size: 18,
          color: { space: 'rgb', r: 0, g: 0, b: 1 },
          align: 'left',
          valign: 'bottom',
          fit: 'shrink',
          minSize: 18,
          lineHeight: 60,
          maxLines: 1,
          firstLineIndent: 0,
        },
      }

      drawCard({
        page,
        embedded: embedded!,
        layout: l,
        elements: [el],
        fonts,
        row: { index: 1, values: {} },
        cell,
        photo: null,
      })

      const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
      let topRow: number | null = null
      outer: for (let y = 0; y < raster.height; y++) {
        for (let x = 0; x < raster.width; x++) {
          const i = (y * raster.width + x) * 4
          if ((raster.rgba[i + 3] ?? 0) === 0) continue
          const r = raster.rgba[i] ?? 0
          const g = raster.rgba[i + 1] ?? 0
          const b = raster.rgba[i + 2] ?? 0
          if (b > 200 && r < 80 && g < 80) {
            topRow = y
            break outer
          }
        }
      }
      expect(topRow).not.toBeNull()

      const boxY = cell.y - l.trim.y + el.box.y
      // A clamped offset of 0 still lets the line's ascent draw a little
      // above box.y (bounded by the font's ascent, a few pt for an 18pt
      // font); an unclamped offset of box.h - blockHeight (-50) would push
      // the block a further 50pt above that. The threshold sits strictly
      // between the two predictions.
      expect(topRow!).toBeGreaterThan(boxY - 15)
    })
  })
})
