import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { cellRect, solveGrid } from '../src/grid.js'
import { mirrorIndex } from '../src/impose.js'
import { parseLayout } from '../src/layout.js'
import { nodeFs } from '../src/node-io.js'
import { buildPhotoIndex } from '../src/photos.js'
import { renderJob } from '../src/render-job.js'
import { rasterize } from '../src/raster.js'
import { inches, mm } from '../src/units.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))

describe('renderJob', () => {
  it('imposes 25 cards per sheet and rounds up for a partial sheet', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      index: i + 2,
      values: {
        'ID No.': String(101 + i),
        Name: `Student ${i + 1}`,
        "Guardian's Name": 'Guardian',
        Class: 'X-A',
        'R.No.': String(i + 1),
        DOB: '01.01.2010',
        'Blood Group': 'O+',
        'Contact No.': '9830000000',
        Address: '12 Park Street, Kolkata 700016',
      },
    }))

    const result = await renderJob({
      layout: layout(),
      templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')),
      templateBack: null,
      rows,
      photos: new Map(),
      jobName: 'Test Job',
      allowOverrides: true, fs: nodeFs,
    })

    expect(result.cards).toBe(30)
    expect(result.sheets).toBe(2)
    expect(result.backPdf).toBeNull()

    const doc = await PDFDocument.load(result.frontPdf)
    expect(doc.getPageCount()).toBe(2)
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()]
    expect(w).toBeCloseTo(1296, 6)
    expect(h).toBeCloseTo(864, 6)
  })

  it('refuses to generate when blocking issues exist and overrides are off', async () => {
    await expect(
      renderJob({
        layout: layout(),
        templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')),
        templateBack: null,
        rows: [{ index: 2, values: { 'ID No.': '', Name: '' } }],
        photos: new Map(),
        jobName: 'Bad Job',
        allowOverrides: false, fs: nodeFs,
      }),
    ).rejects.toThrow(/blocking/)
  })

  it('embeds the card art once no matter how many cards are stamped', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      index: i + 2,
      values: { 'ID No.': String(200 + i), Name: 'A', "Guardian's Name": 'B', Class: 'X', 'R.No.': '1', DOB: '01.01.2010', 'Contact No.': '1', Address: 'C' },
    }))
    const one = await renderJob({
      layout: layout(), templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')), templateBack: null,
      rows: rows.slice(0, 1), photos: new Map(), jobName: 'J', allowOverrides: true, fs: nodeFs,
    })
    const many = await renderJob({
      layout: layout(), templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')), templateBack: null,
      rows, photos: new Map(), jobName: 'J', allowOverrides: true, fs: nodeFs,
    })
    // 25 cards must not cost 25 copies of the artwork.
    expect(many.frontPdf.byteLength).toBeLessThan(one.frontPdf.byteLength * 4)
  })

  it('renders a sheet whose top-left card region is not blank', async () => {
    const l = layout()
    const rows = [{ index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar', "Guardian's Name": 'R', Class: 'X', 'R.No.': '1', DOB: '01.01.2010', 'Contact No.': '1', Address: 'Park Street' } }]
    const result = await renderJob({
      layout: l, templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')), templateBack: null,
      rows, photos: new Map(), jobName: 'J', allowOverrides: true, fs: nodeFs,
    })
    const raster = await rasterize(result.frontPdf, 0, 72)

    // dpi 72 == 72pt/in, so raster pixels line up 1:1 with the grid's
    // top-left point coordinates: no unit conversion needed to find the cell.
    const grid = solveGrid({
      sheet: { w: inches(18), h: inches(12) },
      card: { w: l.trim.w, h: l.trim.h },
      gutter: mm(3),
      minMargin: mm(5),
    })
    const cell = cellRect(grid, 0)

    // Count only opaque, non-white pixels inside the first card's own cell.
    // The old whole-sheet scan was satisfied by the transparent page
    // background alone (alpha 0 reads as black in the red channel, which the
    // old check never looked at), and by crop marks sitting outside any card.
    let ink = 0
    for (let y = Math.floor(cell.y); y < Math.ceil(cell.y + cell.h); y++) {
      for (let x = Math.floor(cell.x); x < Math.ceil(cell.x + cell.w); x++) {
        const i = (y * raster.width + x) * 4
        if ((raster.rgba[i + 3] ?? 0) === 0) continue
        if ((raster.rgba[i] ?? 255) > 240 && (raster.rgba[i + 1] ?? 255) > 240 && (raster.rgba[i + 2] ?? 255) > 240) continue
        ink++
      }
    }
    // The card template art alone (no text/photo elements drawn at all)
    // still fills this cell with ~12,171 such pixels, since drawCard stamps
    // the template page regardless of `elements`; this row's rendered text
    // pushes it to ~12,870. The threshold sits strictly between the two, so
    // a renderer that silently stopped drawing elements would fail this.
    expect(ink).toBeGreaterThan(12500)
  })

  it('mirrors the back sheet so a flipped stack registers', async () => {
    const l = layout()
    const template = new Uint8Array(readFileSync('fixtures/template.pdf'))
    const back = {
      ...l,
      templateBack: 'template.pdf',
      back: [
        {
          kind: 'text' as const,
          id: 'back_name',
          page: 'back' as const,
          box: { x: 59.01, y: 104.65, w: 112.5, h: 10.555 },
          bind: { column: 'Name' },
          style: { ...(l.front.find((e) => e.id === 'name') as { style: object }).style },
        },
      ],
    } as typeof l

    const result = await renderJob({
      layout: back,
      templateFront: template,
      templateBack: template,
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar' } }],
      photos: new Map(),
      jobName: 'Duplex',
      allowOverrides: true, fs: nodeFs,
    })
    expect(result.backPdf).not.toBeNull()

    const grid = solveGrid({
      sheet: { w: inches(18), h: inches(12) },
      card: { w: l.trim.w, h: l.trim.h },
      gutter: mm(3),
      minMargin: mm(5),
    })
    const frontCell = cellRect(grid, 0)
    const backCell = cellRect(grid, mirrorIndex(grid, 0, 'long-edge'))
    expect(backCell.x).toBeGreaterThan(frontCell.x)

    // The card's own artwork is what moves, so compare where each sheet's ink
    // actually lands rather than trusting the index arithmetic twice over.
    //
    // A whole-sheet ink box does not discriminate here: drawCropMarks stamps
    // marks for every one of the grid's 25 cells regardless of occupancy, and
    // those marks sit at the same pixel positions on both front and back (they
    // are never mirrored), so a rightmost-column tick mark pins maxX to the
    // same value — 1268 — on both sheets even when the card body itself moved.
    // Restrict the scan to a vertical band strictly inside the first grid
    // row's cell (shrunk 3pt off each edge) so it never touches a crop mark:
    // the "above"/"below" marks live outside the cell entirely (in the
    // gutter/margin), and the "left"/"right" marks sit only in the 0.5pt-tall
    // strip exactly at the cell's top and bottom edges.
    const inkBox = async (pdf: Uint8Array) => {
      const r = await rasterize(pdf, 0, 72)
      const yStart = Math.floor(frontCell.y) + 3
      const yEnd = Math.ceil(frontCell.y + frontCell.h) - 3
      let minX = r.width
      let maxX = -1
      for (let y = yStart; y < yEnd; y++) {
        for (let x = 0; x < r.width; x++) {
          const i = (y * r.width + x) * 4
          if ((r.rgba[i + 3] ?? 0) === 0) continue
          if ((r.rgba[i] ?? 255) > 240 && (r.rgba[i + 1] ?? 255) > 240 && (r.rgba[i + 2] ?? 255) > 240) continue
          if (x < minX) minX = x
          if (x > maxX) maxX = x
        }
      }
      return { minX, maxX }
    }

    const f = await inkBox(result.frontPdf)
    const b = await inkBox(result.backPdf!)
    // The back sheet's card must start (and end) well to the right of the
    // front sheet's — front sits in column 0, back is mirrored to column 4.
    expect(b.maxX).toBeGreaterThan(f.maxX)
    expect(b.minX).toBeGreaterThan(f.minX)
  })

  it('does not embed photos for ids absent from the rows', async () => {
    const rows = [{ index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar', "Guardian's Name": 'R', Class: 'X', 'R.No.': '1', DOB: '01.01.2010', 'Contact No.': '1', Address: 'Park Street' } }]
    const template = new Uint8Array(readFileSync('fixtures/template.pdf'))

    const index = await buildPhotoIndex('fixtures/photos', nodeFs)
    // "102" (fixtures/photos/0102.jpg) is a real photo in the index, but no
    // row above carries that id.
    const unusedPhoto = index.byId.get('102')
    expect(unusedPhoto).toBeDefined()
    const photos = new Map([['102', unusedPhoto!]])

    const withUnusedPhoto = await renderJob({
      layout: layout(), templateFront: template, templateBack: null,
      rows, photos, jobName: 'J', allowOverrides: true, fs: nodeFs,
    })
    const withoutPhoto = await renderJob({
      layout: layout(), templateFront: template, templateBack: null,
      rows, photos: new Map(), jobName: 'J', allowOverrides: true, fs: nodeFs,
    })

    // A real JPEG is several hundred bytes at minimum, so if the unused
    // photo were embedded, the two outputs could not match byte for byte.
    expect(withUnusedPhoto.frontPdf.byteLength).toBe(withoutPhoto.frontPdf.byteLength)
  })

  it('throws rather than silently cropping when the grid would require a rotated card (F2)', async () => {
    // 140x90 upright fits 9x9 = 81 on this sheet with no gutter/margin; turned
    // 90 wide by 140 tall it fits 14x6 = 84 — solveGrid prefers rotation (see
    // grid.test.ts), but drawCard always stamps the template unrotated.
    const templateDoc = await PDFDocument.create()
    templateDoc.addPage([140, 90])
    const template = await templateDoc.save()

    const base = layout()
    const rotatedLayout = {
      ...base,
      pageBox: { w: 140, h: 90 },
      trim: { x: 0, y: 0, w: 140, h: 90 },
      front: [],
      back: [],
    } as typeof base

    await expect(
      renderJob({
        layout: rotatedLayout,
        templateFront: template,
        templateBack: null,
        rows: [{ index: 2, values: { 'ID No.': '1' } }],
        photos: new Map(),
        jobName: 'Rotated',
        allowOverrides: true, fs: nodeFs,
        gutter: 0,
        minMargin: 0,
      }),
    ).rejects.toThrow(/rotat/i)
  })

  it('throws when the front template page size does not match layout.pageBox (F3)', async () => {
    const mismatchedDoc = await PDFDocument.create()
    mismatchedDoc.addPage([288 * 2, 216 * 2]) // layout.json declares pageBox 288x216
    const mismatched = await mismatchedDoc.save()

    await expect(
      renderJob({
        layout: layout(),
        templateFront: mismatched,
        templateBack: null,
        rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A' } }],
        photos: new Map(),
        jobName: 'Bad front size',
        allowOverrides: true, fs: nodeFs,
      }),
    ).rejects.toThrow(/page size/i)
  })

  it('throws when the back template page size does not match the front template (F3)', async () => {
    const front = new Uint8Array(readFileSync('fixtures/template.pdf')) // 288x216, matches layout.json's pageBox
    const backDoc = await PDFDocument.create()
    backDoc.addPage([300, 216]) // differs from the front by more than the 0.5pt tolerance
    const back = await backDoc.save()

    await expect(
      renderJob({
        layout: layout(),
        templateFront: front,
        templateBack: back,
        rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A' } }],
        photos: new Map(),
        jobName: 'Bad back size',
        allowOverrides: true, fs: nodeFs,
      }),
    ).rejects.toThrow(/back/i)
  })
})
