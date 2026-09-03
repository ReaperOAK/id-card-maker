import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { parseLayout } from '../src/layout.js'
import { nodeFs } from '../src/node-io.js'
import { runPreflight, summarise } from '../src/preflight.js'
import type { PhotoEntry } from '../src/photos.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))
let fonts: FontRegistry

beforeAll(async () => {
  fonts = await FontRegistry.load(layout().fonts, await PDFDocument.create(), nodeFs)
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
    const dup = issues.filter((i) => i.code === 'id-duplicate')
    expect(dup).toHaveLength(2)
    expect(dup.every((i) => i.level === 'block')).toBe(true)
  })

  it('pluralises "rows" when a duplicate id spans more than two other rows', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [
        { index: 2, values: { 'ID No.': '102', Name: 'A' } },
        { index: 3, values: { 'ID No.': '102', Name: 'B' } },
        { index: 9, values: { 'ID No.': '102', Name: 'C' } },
      ],
      photos: new Map([['102', photo('102', 132, 172)]]),
      fonts,
    })
    const dup = issues.filter((i) => i.code === 'id-duplicate')
    expect(dup).toHaveLength(3)
    const byRow = new Map(dup.map((i) => [i.row, i.message]))
    expect(byRow.get(2)).toContain('rows 3, 9')
    expect(byRow.get(3)).toContain('rows 2, 9')
    expect(byRow.get(9)).toContain('rows 2, 3')
  })

  it('does not also report a missing photo for a row whose id is blank', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '', Name: 'A' } }],
      photos: new Map(),
      fonts,
    })
    expect(issues.some((i) => i.code === 'id-empty')).toBe(true)
    // The id is the thing that is wrong; reporting a missing photo as well
    // sends the operator hunting for a file that was never named.
    expect(issues.some((i) => i.code === 'photo-missing')).toBe(false)
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

  it('shows a dpi figure that does not contradict the threshold it failed', () => {
    // 100x130px in the reference 47.78x62.53pt frame is 149.69dpi — just under
    // the floor. Rounded to whole numbers it would print as "150dpi ... below
    // the 150dpi floor", which reads as a bug to the operator.
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A' } }],
      photos: new Map([['101', photo('101', 100, 130)]]),
      fonts,
    })
    const dpiIssue = issues.find((i) => i.code === 'photo-dpi')
    expect(dpiIssue?.level).toBe('block')
    expect(dpiIssue?.message).toContain('149.7')
    expect(dpiIssue?.message).not.toMatch(/\b150dpi at printed size/)
  })

  it('blocks a required field left empty and does not block one with a fallback', () => {
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: '', 'Blood Group': '' } }],
      photos: new Map([['101', photo('101', 132, 172)]]),
      fonts,
    })
    const nameIssue = issues.find((i) => i.code === 'field-empty' && i.field === 'name')
    expect(nameIssue?.level).toBe('block')
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

  it('warns and names the before/after text when a name is abbreviated to fit', () => {
    // fixtures/layout.json's `name` element is overflow: 'abbreviate-then-shrink'
    // with a 112.5pt box: "Ramesh Chandra Bhattacharjee" overflows the box in
    // full but fits once the middle name is reduced to an initial, at the
    // designed size — no shrink needed, so text-overflow must not also fire.
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'Ramesh Chandra Bhattacharjee' } }],
      photos: new Map([['101', photo('101', 132, 172)]]),
      fonts,
    })
    const abbreviated = issues.find((i) => i.code === 'text-abbreviated' && i.field === 'name')
    expect(abbreviated?.level).toBe('warn')
    expect(abbreviated?.message).toContain('"Ramesh Chandra Bhattacharjee"')
    expect(abbreviated?.message).toContain('"Ramesh C. Bhattacharjee"')
    expect(issues.some((i) => i.code === 'text-overflow' && i.field === 'name')).toBe(false)
  })

  it('does not warn text-abbreviated for a field left at overflow: shrink', () => {
    // The 'class' element keeps the schema default (overflow: 'shrink'), so
    // a long value there must shrink, never abbreviate.
    const issues = runPreflight({
      layout: layout(),
      rows: [{ index: 2, values: { 'ID No.': '101', Name: 'A', Class: 'A Very Long Class Name' } }],
      photos: new Map([['101', photo('101', 132, 172)]]),
      fonts,
    })
    expect(issues.some((i) => i.code === 'text-abbreviated' && i.field === 'class')).toBe(false)
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
