import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { parseLayout } from '../src/layout.js'
import { renderJob } from '../src/render-job.js'
import { rasterize } from '../src/raster.js'

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
      allowOverrides: true,
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
        allowOverrides: false,
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
      rows: rows.slice(0, 1), photos: new Map(), jobName: 'J', allowOverrides: true,
    })
    const many = await renderJob({
      layout: layout(), templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')), templateBack: null,
      rows, photos: new Map(), jobName: 'J', allowOverrides: true,
    })
    // 25 cards must not cost 25 copies of the artwork.
    expect(many.frontPdf.byteLength).toBeLessThan(one.frontPdf.byteLength * 4)
  })

  it('renders a sheet whose top-left card region is not blank', async () => {
    const rows = [{ index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar', "Guardian's Name": 'R', Class: 'X', 'R.No.': '1', DOB: '01.01.2010', 'Contact No.': '1', Address: 'Park Street' } }]
    const result = await renderJob({
      layout: layout(), templateFront: new Uint8Array(readFileSync('fixtures/template.pdf')), templateBack: null,
      rows, photos: new Map(), jobName: 'J', allowOverrides: true,
    })
    const raster = await rasterize(result.frontPdf, 0, 72)
    let ink = 0
    for (let i = 0; i < raster.rgba.length; i += 4) if ((raster.rgba[i] ?? 255) < 240) ink++
    expect(ink).toBeGreaterThan(500)
  })
})
