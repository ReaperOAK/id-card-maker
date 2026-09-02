import { z } from 'zod'

const rect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
})

export const colourSchema = z.discriminatedUnion('space', [
  z.object({ space: z.literal('rgb'), r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1) }),
  z.object({
    space: z.literal('cmyk'),
    c: z.number().min(0).max(1),
    m: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    k: z.number().min(0).max(1),
  }),
  z.object({ space: z.literal('gray'), k: z.number().min(0).max(1) }),
])

const bindingSchema = z.object({
  column: z.string().min(1),
  transform: z.enum(['upper', 'title', 'date']).optional(),
  format: z.string().optional(),
  /** Absence makes the field required; presence supplies a value when the cell is empty. */
  fallback: z.string().optional(),
})

const textStyleSchema = z.object({
  fontId: z.string().min(1),
  /**
   * The element's designed size. Shrink-to-fit may draw glyphs smaller than
   * this, but the baseline is always anchored on `size`, never on whatever
   * size the text actually shrank to — see the `box.y` contract documented
   * on `elementSchema` below. Anchoring on the shrunk size instead would move
   * the baseline every time shrink-to-fit kicks in, so a card whose value
   * shrank would draw at a different baseline than a neighbouring card whose
   * value did not, even though both share the same `box.y`.
   */
  size: z.number().positive(),
  color: colourSchema,
  align: z.enum(['left', 'center', 'right']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  fit: z.enum(['shrink', 'clip', 'wrap']).default('shrink'),
  minSize: z.number().positive(),
  lineHeight: z.number().positive(),
  maxLines: z.number().int().positive().default(1),
  firstLineIndent: z.number().default(0),
})

const page = z.enum(['front', 'back'])

/**
 * The `box.y` contract for `text` and `static` elements (the two kinds that
 * carry a `style: TextStyle`).
 *
 * `box` is a top-left, points rect, but `box.y` is not itself a drawing
 * origin — it is the top of the *line box*. The renderer (`drawCard` in
 * card.ts) draws the first line's baseline at
 * `box.y + ascent(bound font, style.size)`, and every subsequent line
 * `style.lineHeight` further down. `style.size` is the element's *designed*
 * size: shrink-to-fit may draw a smaller glyph, but it never moves the
 * baseline.
 *
 * `ascent` is a metric of the specific font file bound to `style.fontId`,
 * not a layout constant — it is not even the same across two Latin
 * text fonts at the same nominal size (Liberation Sans 9pt and Times New
 * Roman 9pt do not share an ascent). A layout's `box.y` values are therefore
 * only correct for the font that layout actually binds. Porting a layout to
 * a different overlay font — or re-deriving `box.y` from a fresh set of
 * measurements without accounting for the new font's ascent — without
 * recomputing `box.y` silently shifts every baseline on every card.
 *
 * A `photo` element's `box` carries no such contract: its `y` is a plain box
 * top, used only to place and clip the image.
 */
const elementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), id: z.string().min(1), page, box: rect, bind: bindingSchema, style: textStyleSchema }),
  z.object({
    kind: z.literal('photo'),
    id: z.string().min(1),
    page,
    box: rect,
    fit: z.enum(['cover', 'contain']).default('cover'),
  }),
  z.object({ kind: z.literal('static'), id: z.string().min(1), page, box: rect, text: z.string(), style: textStyleSchema }),
])

export const layoutSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  templateFront: z.string().min(1),
  templateBack: z.string().optional(),
  /** Page box of the template PDF, points. */
  pageBox: z.object({ w: z.number().positive(), h: z.number().positive() }),
  /** Trim rectangle inside the page box, top-left origin, points. */
  trim: rect,
  bleed: z.number().min(0).default(0),
  photoTargetDpi: z.number().positive().default(200),
  /** Column in the data source that names photo files and identifies a student. */
  idColumn: z.string().min(1),
  fonts: z.record(z.string(), z.string()),
  front: z.array(elementSchema),
  back: z.array(elementSchema).default([]),
})

export type Colour = z.infer<typeof colourSchema>
export type Binding = z.infer<typeof bindingSchema>
export type TextStyle = z.infer<typeof textStyleSchema>
export type Element = z.infer<typeof elementSchema>
export type TextElement = Extract<Element, { kind: 'text' }>
export type PhotoElement = Extract<Element, { kind: 'photo' }>
export type StaticElement = Extract<Element, { kind: 'static' }>
export type Layout = z.infer<typeof layoutSchema>

export function parseLayout(input: unknown): Layout {
  return layoutSchema.parse(input)
}
