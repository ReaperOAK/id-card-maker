import ExcelJS from 'exceljs'

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
  const stripped = cleaned.replace(/\d+/g, (match) => {
    const stripped = match.replace(/^0+/, '')
    return stripped === '' ? '0' : stripped
  })
  return stripped === '' ? '0' : stripped
}

/** Curly apostrophes and stray whitespace are the usual header mismatches. */
export function normaliseHeader(raw: string): string {
  return raw.replace(/'/g, "'").replace(/\s+/g, ' ').trim()
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
    if (v.result !== undefined) return String(v.result)
    return ''
  }
  return String(value).trim()
}

export async function loadRows(path: string): Promise<{ headers: string[]; rows: Row[] }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
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
