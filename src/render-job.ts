import { readFile } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PDFImage } from 'pdf-lib'
import { drawCard } from './card.js'
import type { Row } from './data.js'
import { normaliseId } from './data.js'
import { FontRegistry } from './fonts.js'
import { cellRect, solveGrid, type Grid } from './grid.js'
import { drawCropMarks, drawSlug, mirrorIndex, sheetCount, type FlipAxis } from './impose.js'
import type { Layout } from './layout.js'
import type { PhotoEntry } from './photos.js'
import { runPreflight, summarise, type Issue } from './preflight.js'
import { inches, mm } from './units.js'

export interface RenderJobArgs {
  layout: Layout
  templateFront: Uint8Array
  templateBack: Uint8Array | null
  rows: Row[]
  photos: Map<string, PhotoEntry>
  jobName: string
  /** When false, any blocking preflight issue aborts the job. */
  allowOverrides: boolean
  flipAxis?: FlipAxis
  gutter?: number
  minMargin?: number
}

export interface JobResult {
  frontPdf: Uint8Array
  backPdf: Uint8Array | null
  sheets: number
  cards: number
  issues: Issue[]
}

const SHEET = { w: inches(18), h: inches(12) }

async function embedPhoto(doc: PDFDocument, entry: PhotoEntry): Promise<PDFImage> {
  const bytes = await readFile(entry.path)
  return entry.path.toLowerCase().endsWith('.png') ? doc.embedPng(bytes) : doc.embedJpg(bytes)
}

async function buildSide(
  args: RenderJobArgs,
  templateBytes: Uint8Array,
  side: 'front' | 'back',
  grid: Grid,
  photoCache: Map<string, PhotoEntry>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await FontRegistry.load(args.layout.fonts, doc)
  const slugFont = await doc.embedFont(StandardFonts.Helvetica)
  const [embedded] = await doc.embedPdf(templateBytes, [0])
  const elements = side === 'front' ? args.layout.front : args.layout.back
  const axis = args.flipAxis ?? 'long-edge'

  const images = new Map<string, PDFImage>()
  for (const [id, entry] of photoCache) images.set(id, await embedPhoto(doc, entry))

  const total = sheetCount(args.rows.length, grid.perSheet)
  for (let s = 0; s < total; s++) {
    const page = doc.addPage([SHEET.w, SHEET.h])
    for (let slot = 0; slot < grid.perSheet; slot++) {
      const row = args.rows[s * grid.perSheet + slot]
      if (!row) continue
      const position = side === 'front' ? slot : mirrorIndex(grid, slot, axis)
      const id = normaliseId(row.values[args.layout.idColumn] ?? '')
      drawCard({
        page,
        embedded: embedded!,
        layout: args.layout,
        elements,
        fonts,
        row,
        cell: cellRect(grid, position),
        photo: images.get(id) ?? null,
      })
    }
    drawCropMarks(page, grid, SHEET)
    drawSlug(page, `${args.jobName} — sheet ${s + 1} of ${total} — ${side.toUpperCase()}`, SHEET, slugFont, grid.originY)
  }

  return doc.save()
}

/**
 * Render a whole job. Fronts and backs are separate files: the operator prints
 * all fronts, flips the stack once, then prints all backs.
 */
export async function renderJob(args: RenderJobArgs): Promise<JobResult> {
  const fontDoc = await PDFDocument.create()
  const fonts = await FontRegistry.load(args.layout.fonts, fontDoc)
  const issues = runPreflight({ layout: args.layout, rows: args.rows, photos: args.photos, fonts })

  const { blocking } = summarise(issues)
  if (blocking > 0 && !args.allowOverrides) {
    throw new Error(`Preflight found ${blocking} blocking issue(s). Resolve them or re-run with overrides enabled.`)
  }

  const grid = solveGrid({
    sheet: SHEET,
    card: { w: args.layout.trim.w, h: args.layout.trim.h },
    gutter: args.gutter ?? mm(3),
    minMargin: args.minMargin ?? mm(5),
  })

  const frontPdf = await buildSide(args, args.templateFront, 'front', grid, args.photos)
  const backPdf =
    args.templateBack && args.layout.back.length > 0
      ? await buildSide(args, args.templateBack, 'back', grid, args.photos)
      : null

  return { frontPdf, backPdf, sheets: sheetCount(args.rows.length, grid.perSheet), cards: args.rows.length, issues }
}
