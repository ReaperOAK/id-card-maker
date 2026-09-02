import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { parseLayout } from '../src/layout.js'
import { runPreflight, summarise } from '../src/preflight.js'
import type { PhotoEntry } from '../src/photos.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))
let fonts: FontRegistry

beforeAll(async () => {
  fonts = await FontRegistry.load(layout().fonts, await PDFDocument.create())
})

const photo = (id: string, width: number, height: number): PhotoEntry => ({ path: `${id}.jpg`, id, width, height })

describe('runPreflight', () => {
  it('blocks a student with no photo', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar' } }],
      photos: new Map(),
      fonts,
    })
    const missing = issues.filter((i) => i.code === 'photo-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.level).toBe('block')
  })

  it('blocks duplicate ids on every affected row', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [
        { index: 2, values: { 'ID No.': '102', Name: 'A' } },
        { index: 3, values: { 'ID No.': '0102', Name: 'B' } },
      ],
      photos: new Map([['102', photo('102', 132, 172)]]),
      fonts,
    })
    expect(issues.filter((i) => i.code === 'id-duplicate')).toHaveLength(2)
  })

  it('warns below the target dpi and blocks below 150', () => {
    const l = layout()
    const photos = new Map([['101', photo('101', 60, 80)]])
    const issues = runPreflight({ layout: l, rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A' } }], photos, fonts })
    const dpi = issues.find((i) => i.code === 'photo-dpi')
    expect(dpi?.level).toBe('block')

    const okish = new Map([['101', photo('101', 120, 160)]])
    const warn = runPreflight({ layout: l, rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A' } }], photos: okish, fonts })
    expect(warn.find((i) => i.code === 'photo-dpi')?.level).toBe('warn')
  })

  it('blocks a required field left empty and does not block one with a fallback', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: '', 'Blood Group': '' } }],
      photos: new Map([['101', photo('101', 132, 172)]]),
      fonts,
    })
    expect(issues.some((i) => i.code === 'field-empty' && i.field === 'name')).toBe(true)
    expect(issues.some((i) => i.code === 'field-empty' && i.field === 'blood')).toBe(false)
  })

  it('warns when text has to shrink past its minimum', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'X'.repeat(200) } }],
      photos: new Map([['101', photo('101', 132, 172)]]),
      fonts,
    })
    expect(issues.some((i) => i.code === 'text-overflow' && i.level === 'warn')).toBe(true)
  })
})

describe('summarise', () => {
  it('counts blocking and warning issues separately', () => {
    const counts = summarise([
      { level: 'block', code: 'photo-missing', row: 2, message: '' },
      { level: 'warn', code: 'photo-dpi', row: 3, message: '' },
      { level: 'warn', code: 'photo-dpi', row: 4, message: '' },
    ])
    expect(counts.blocking).toBe(1)
    expect(counts.warnings).toBe(2)
    expect(counts.byCode.get('photo-dpi')).toBe(2)
  })
})
