import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { PDFImage } from 'pdf-lib'
import { drawCard } from './card.js'
import type { Row } from './data.js'
import { normaliseId } from './data.js'
import { FontRegistry } from './fonts.js'
import { cellRect, solveGrid, type Grid } from './grid.js'
import { drawCropMarks, drawSlug, mirrorIndex, sheetCount, type FlipAxis } from './impose.js'
import type { FileSystem } from './io.js'
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
  fs: FileSystem
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

/** How far a measured page size may drift from what the layout expects before it counts as a mismatch. */
const PAGE_SIZE_TOLERANCE_PT = 0.5

interface PageSize {
  w: number
  h: number
}

function formatSize(s: PageSize): string {
  return `${s.w.toFixed(2)}x${s.h.toFixed(2)}pt`
}

function sizesMismatch(a: PageSize, b: PageSize): boolean {
  return Math.abs(a.w - b.w) > PAGE_SIZE_TOLERANCE_PT || Math.abs(a.h - b.h) > PAGE_SIZE_TOLERANCE_PT
}

/** The real page size of a template PDF's first page, read without stamping it onto anything. */
async function templatePageSize(templateBytes: Uint8Array): Promise<PageSize> {
  const doc = await PDFDocument.load(templateBytes)
  const page = doc.getPage(0)
  return { w: page.getWidth(), h: page.getHeight() }
}

async function embedPhoto(doc: PDFDocument, entry: PhotoEntry, fs: FileSystem): Promise<PDFImage> {
  const bytes = await fs.readFile(entry.path)
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
  const fonts = await FontRegistry.load(args.layout.fonts, doc, args.fs)
  const slugFont = await doc.embedFont(StandardFonts.Helvetica)
  const [embedded] = await doc.embedPdf(templateBytes, [0])
  const elements = side === 'front' ? args.layout.front : args.layout.back
  const axis = args.flipAxis ?? 'long-edge'

  // Only embed photos this side can actually draw. A standing photo library
  // shared across jobs can hold thousands of ids that never appear in this
  // job's rows, and a side with no photo element (a text-only back, say)
  // can't draw any photo at all — embedding them anyway bloats the PDF with
  // pictures of students who were never in this print run.
  const images = new Map<string, PDFImage>()
  const hasPhotoElement = elements.some((el) => el.kind === 'photo')
  if (hasPhotoElement) {
    const rowIds = new Set(args.rows.map((row) => normaliseId(row.values[args.layout.idColumn] ?? '')))
    for (const [id, entry] of photoCache) {
      if (rowIds.has(id)) images.set(id, await embedPhoto(doc, entry, args.fs))
    }
  }

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
  const fonts = await FontRegistry.load(args.layout.fonts, fontDoc, args.fs)
  const issues = runPreflight({ layout: args.layout, rows: args.rows, photos: args.photos, fonts })

  const { blocking } = summarise(issues)
  if (blocking > 0 && !args.allowOverrides) {
    throw new Error(`Preflight found ${blocking} blocking issue(s). Resolve them or re-run with overrides enabled.`)
  }

  // page.drawPage scales the embedded template to whatever width/height it is
  // given — drawCard passes layout.pageBox for that, trusting it unchecked.
  // If the real template page is a different size, every card is silently
  // rescaled while element boxes stay put, and the cell clip hides the
  // overflow so the card looks normal from outside. Catch that here, before
  // any drawing happens, rather than let it ship on every card in the job.
  const frontSize = await templatePageSize(args.templateFront)
  if (sizesMismatch(frontSize, args.layout.pageBox)) {
    throw new Error(
      `Front template page size ${formatSize(frontSize)} does not match layout.pageBox ${formatSize(args.layout.pageBox)}. ` +
        `Every element box would be scaled against the wrong page.`,
    )
  }
  if (args.templateBack) {
    const backSize = await templatePageSize(args.templateBack)
    if (sizesMismatch(backSize, frontSize)) {
      throw new Error(
        `Back template page size ${formatSize(backSize)} does not match front template page size ${formatSize(frontSize)}. ` +
          `Duplex registration requires both sides to be the same size.`,
      )
    }
  }

  const grid = solveGrid({
    sheet: SHEET,
    card: { w: args.layout.trim.w, h: args.layout.trim.h },
    gutter: args.gutter ?? mm(3),
    minMargin: args.minMargin ?? mm(5),
  })

  // solveGrid can choose a rotated orientation when it packs more cards, but
  // drawCard always stamps the template unrotated — nothing in this renderer
  // can rotate a card. Rendering anyway would silently crop every card on
  // the sheet down to a fragment, with no error and no preflight issue.
  if (grid.rotated) {
    throw new Error(
      `Rotated imposition is not supported yet: card ${args.layout.trim.w.toFixed(2)}x${args.layout.trim.h.toFixed(2)}pt ` +
        `only reaches its best fit on sheet ${SHEET.w.toFixed(2)}x${SHEET.h.toFixed(2)}pt when rotated 90 degrees, ` +
        `and this renderer cannot draw a rotated card.`,
    )
  }

  const frontPdf = await buildSide(args, args.templateFront, 'front', grid, args.photos)
  const backPdf =
    args.templateBack && args.layout.back.length > 0
      ? await buildSide(args, args.templateBack, 'back', grid, args.photos)
      : null

  return { frontPdf, backPdf, sheets: sheetCount(args.rows.length, grid.perSheet), cards: args.rows.length, issues }
}
