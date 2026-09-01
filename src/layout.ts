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
