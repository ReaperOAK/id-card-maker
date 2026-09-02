import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { applyTransform, ascentAtSize, drawCard, resolveText } from '../src/card.js'
import type { Element } from '../src/layout.js'
import { parseLayout } from '../src/layout.js'
import { rasterize } from '../src/raster.js'

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
})
