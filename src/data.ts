import ExcelJS from 'exceljs'
import type { FileSystem } from './io.js'

export interface Row {
  /** 1-based row number in the source sheet, so error messages match what the operator sees. */
  index: number
  values: Record<string, string>
}

/**
 * Photo filenames and spreadsheet ids drift apart in predictable ways:
 * case, punctuation, and Excel eating leading zeros. Normalise all three away.
 */
export function normaliseId(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (cleaned === '') return ''
  // Strip leading zeros at the start of each digit run: 0101 -> 101, adm007 -> adm7.
  // An id that is all zeros collapses to a single 0 rather than to nothing, so it
  // stays distinguishable from a genuinely missing id.
  return cleaned.replace(/(^|[a-z])0+(\d)/g, '$1$2')
}

/** Curly apostrophes and stray whitespace are the usual header mismatches. */
export function normaliseHeader(raw: string): string {
  // \u2018 = LEFT SINGLE QUOTATION MARK, \u2019 = RIGHT SINGLE QUOTATION MARK.
  // Written as escapes (not literal characters) so an editor or copy/paste
  // cannot silently flatten them to ASCII apostrophes, which would turn
  // this fold into a no-op.
  return raw.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim()
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, '0')
    const m = String(value.getMonth() + 1).padStart(2, '0')
    return `${d}.${m}.${value.getFullYear()}`
  }
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown }
    if (v.richText) return v.richText.map((t) => t.text).join('')
    if (typeof v.text === 'string') return v.text
    if (v.result !== undefined) {
      if (typeof v.result === 'object' && v.result !== null && 'error' in v.result) return ''
      return String(v.result)
    }
    return ''
  }
  return String(value).trim()
}

export async function loadRows(path: string, fs: FileSystem): Promise<{ headers: string[]; rows: Row[] }> {
  const wb = new ExcelJS.Workbook()
  const bytes = await fs.readFile(path)
  // exceljs's typings say Buffer — but exceljs/index.d.ts declares its own
  // module-local `Buffer extends ArrayBuffer` interface, which shadows
  // Node's global Buffer inside that file. Casting to the ambient `Buffer`
  // therefore does not structurally satisfy `load`'s parameter type, so the
  // cast target is pulled from the call signature itself instead of naming
  // "Buffer" directly. At runtime, exceljs hands the bytes straight to
  // JSZip, which accepts a Uint8Array in both Node and the browser.
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.worksheets[0]
  if (!ws) throw new Error(`loadRows: ${path} contains no worksheet`)

  const headerRow = ws.getRow(1)
  const headers: string[] = []
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col - 1] = normaliseHeader(cellText(cell.value))
  })

  const rows: Row[] = []
  for (let n = 2; n <= ws.rowCount; n++) {
    const r = ws.getRow(n)
    const values: Record<string, string> = {}
    let any = false
    headers.forEach((h, i) => {
      if (!h) return
      const text = cellText(r.getCell(i + 1).value)
      values[h] = text
      if (text !== '') any = true
    })
    if (any) rows.push({ index: n, values })
  }

  return { headers: headers.filter(Boolean), rows }
}

/** Returns normalised id to the source row numbers that carry it, for ids seen more than once. */
export function findDuplicateIds(rows: Row[], idColumn: string): Map<string, number[]> {
  const seen = new Map<string, number[]>()
  for (const row of rows) {
    const id = normaliseId(row.values[idColumn] ?? '')
    if (id === '') continue
    const list = seen.get(id)
    if (list) list.push(row.index)
    else seen.set(id, [row.index])
  }
  return new Map([...seen].filter(([, v]) => v.length > 1))
}
