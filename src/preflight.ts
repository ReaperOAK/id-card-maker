import { findDuplicateIds, normaliseId, type Row } from './data.js'
import type { FontRegistry } from './fonts.js'
import type { Layout } from './layout.js'
import { effectiveDpi, type PhotoEntry } from './photos.js'
import { resolveText } from './card.js'
import { fitText } from './text-fit.js'

export type IssueLevel = 'block' | 'warn'

export interface Issue {
  level: IssueLevel
  code: 'photo-missing' | 'photo-dpi' | 'id-duplicate' | 'id-empty' | 'field-empty' | 'text-overflow'
  /** Source spreadsheet row number. */
  row: number
  /** Layout element id, where the issue belongs to one field. */
  field?: string
  message: string
}

export interface PreflightArgs {
  layout: Layout
  rows: Row[]
  photos: Map<string, PhotoEntry>
  fonts: FontRegistry
}

/** Below this, a photo is unusable at any size and generation is blocked. */
const DPI_FLOOR = 150
/** Above this, no warning is raised regardless of the template's target. */
const DPI_IDEAL = 300

/**
 * Collect every reason a job should not print. Nothing here degrades silently:
 * an issue either blocks generation or is surfaced as a warning to dismiss.
 */
export function runPreflight(args: PreflightArgs): Issue[] {
  const { layout, rows, photos, fonts } = args
  const issues: Issue[] = []

  const duplicates = findDuplicateIds(rows, layout.idColumn)
  for (const [id, rowNumbers] of duplicates) {
    for (const row of rowNumbers) {
      const others = rowNumbers.filter((r) => r !== row)
      const noun = others.length === 1 ? 'row' : 'rows'
      issues.push({
        level: 'block',
        code: 'id-duplicate',
        row,
        message: `id "${id}" also appears on ${noun} ${others.join(', ')}`,
      })
    }
  }

  const photoElements = [...layout.front, ...layout.back].filter((e) => e.kind === 'photo')
  const textElements = [...layout.front, ...layout.back].filter((e) => e.kind === 'text')

  for (const row of rows) {
    const rawId = (row.values[layout.idColumn] ?? '').trim()
    const id = normaliseId(rawId)
    if (id === '') {
      issues.push({ level: 'block', code: 'id-empty', row: row.index, message: `column "${layout.idColumn}" is empty` })
    }

    // An empty id already produced id-empty above; a row with no id cannot be
    // matched to any photo file, so skipping this block avoids a redundant
    // (and misleading) photo-missing on top of it.
    if (photoElements.length > 0 && id !== '') {
      const entry = photos.get(id)
      if (!entry) {
        issues.push({ level: 'block', code: 'photo-missing', row: row.index, message: `no photo file matching id "${rawId}"` })
      } else {
        for (const el of photoElements) {
          const dpi = effectiveDpi(entry, el.box)
          if (dpi < DPI_FLOOR) {
            issues.push({
              level: 'block',
              code: 'photo-dpi',
              row: row.index,
              field: el.id,
              message: `photo is ${dpi.toFixed(1)}dpi at printed size, below the ${DPI_FLOOR}dpi floor`,
            })
          } else if (dpi < Math.min(DPI_IDEAL, Math.max(layout.photoTargetDpi, DPI_FLOOR))) {
            issues.push({
              level: 'warn',
              code: 'photo-dpi',
              row: row.index,
              field: el.id,
              message: `photo is ${dpi.toFixed(1)}dpi, below the ${layout.photoTargetDpi}dpi target`,
            })
          }
        }
      }
    }

    for (const el of textElements) {
      const { text, missing } = resolveText(row, el.bind)
      if (missing) {
        issues.push({
          level: 'block',
          code: 'field-empty',
          row: row.index,
          field: el.id,
          message: `required column "${el.bind.column}" is empty`,
        })
        continue
      }
      if (text === '') continue
      const fit = fitText(text, el.style, el.box.w, fonts.get(el.style.fontId))
      if (fit.overflow) {
        issues.push({
          level: 'warn',
          code: 'text-overflow',
          row: row.index,
          field: el.id,
          message: `"${text}" does not fit ${el.box.w.toFixed(1)}pt even at ${el.style.minSize}pt`,
        })
      }
    }
  }

  return issues
}

export function summarise(issues: Issue[]): { blocking: number; warnings: number; byCode: Map<string, number> } {
  const byCode = new Map<string, number>()
  let blocking = 0
  let warnings = 0
  for (const i of issues) {
    byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1)
    if (i.level === 'block') blocking++
    else warnings++
  }
  return { blocking, warnings, byCode }
}
