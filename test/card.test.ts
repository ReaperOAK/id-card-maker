import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { applyTransform, drawCard, resolveText } from '../src/card.js'
import { parseLayout } from '../src/layout.js'
import { rasterize } from '../src/raster.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))

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
})
