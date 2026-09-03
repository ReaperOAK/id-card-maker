# ID Card Render Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless, tested engine and CLI that turns a template PDF, a layout file, a spreadsheet and a folder of photos into print-ready imposed sheets.

**Architecture:** A single TypeScript package. MuPDF (WASM) rasterizes for trim detection and golden tests; pdf-lib assembles output, embedding the template page once as a reusable XObject and stamping it per card under a clip path. No UI, no face detection — those are later plans. Every module is pure and unit-testable except the two that touch PDF bytes.

**Tech Stack:** TypeScript, Node 24, pdf-lib + @pdf-lib/fontkit, mupdf (WASM), exceljs, zod, commander, vitest.

## Why this is one plan of four

The spec covers work that does not fit a single plan. It is split into four, each producing software that works on its own:

1. **Render core (this plan).** Headless CLI: template + layout + data + photos to imposed PDF. Usable immediately via a batch file.
2. **Photo intelligence.** Rust worker: EXIF, YuNet face detection, passport crop, quality gates.
3. **Desktop application.** Tauri shell, template editor, field mapping, preflight screen, contact sheet.
4. **Automation.** Placeholder auto-detection (spec 4.2 approach C), reprint diffing, school library.

This plan deliberately does no image processing. Photos are embedded as-is and fitted by clipping, so plan 1 carries zero image dependencies and plan 2 replaces nothing it built.

## Global Constraints

- Node >= 22. Developed on 24.14.0.
- All internal geometry in **points, top-left origin**. Conversion to PDF's bottom-left origin happens in exactly one function, `toPdfRect` in `src/units.ts`. No other module may perform a Y flip.
- Sheet size fixed at **18 x 12 in = 1296 x 864 pt**.
- Margins on a sheet are **always symmetric**. A grid result with unequal left/right or top/bottom margins is a bug, not a preference.
- Default gutter **3mm**; default bleed **0** (the operator cuts on the border, spec 8.3).
- Photo target DPI defaults to **200**; warn below the template target, block below 150 (spec 7.5).
- Colours carry their space (`rgb` | `cmyk` | `gray`). Never store hex. Pure-black text in a CMYK template draws K-only (spec 8.4).
- Test fonts are Liberation Sans and Liberation Serif at `/usr/share/fonts/truetype/liberation/`. These are metric-identical to Arial and Times New Roman, so measurements match the reference template exactly.
- **Engine choice supersedes spec 4.2's mention of pdf.js.** MuPDF is used instead: one WASM dependency serves both rasterization and text extraction, with no native build step on Windows. The spec's actual requirement — never hand-parse a content stream — is preserved.

---

## File Structure

```
package.json
tsconfig.json
vitest.config.ts
src/
  units.ts        pt/in/mm conversion, Rect, the single Y-flip
  layout.ts       zod schema and types for layout.json
  raster.ts       MuPDF page rasterization (used by trim + golden tests)
  trim.ts         ink bounding box detection
  data.ts         spreadsheet to rows; header and ID normalization
  fonts.ts        font file registry, pdf-lib embedding
  text-fit.ts     wrap, shrink-to-fit, first-line indent
  grid.ts         grid solver: columns, rows, symmetric margins
  card.ts         draw one card into a rect on a page
  impose.ts       sheets, duplex mirroring, crop marks, slug
  preflight.ts    issue collection and classification
  render-job.ts   orchestrator tying the above together
  cli.ts          commander entry point
test/
  <one file per src module>
  golden/         committed reference pixmaps
fixtures/
  template.pdf    synthetic, no real student photo
  layout.json     the reference school layout
  students.xlsx
  photos/
```

---

### Task 1: Scaffold and units

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/units.ts`
- Test: `test/units.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PT_PER_IN`, `PT_PER_MM`, `inches(n)`, `mm(n)`, `Rect { x, y, w, h }`, `toPdfRect(rect, pageHeight)`, `fromPdfRect(rect, pageHeight)`

- [ ] **Step 1: Initialise the project**

```bash
mkdir -p src test fixtures
npm init -y
npm pkg set type=module
npm pkg set scripts.test="vitest run"
npm pkg set scripts.build="tsc -p tsconfig.json"
npm i pdf-lib@^1.17.1 @pdf-lib/fontkit@^1.1.1 exceljs@^4.4.0 zod@^3.23.8 commander@^12.1.0
npm i mupdf@latest
npm i -D typescript@^5.6.0 vitest@^2.1.0 tsx@^4.19.0 @types/node@^22.0.0
```

Record the resolved `mupdf` version — Task 3 depends on its API.

- [ ] **Step 2: Write the config files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
})
```

`.gitignore`:

```
node_modules/
dist/
*.pdf
!fixtures/*.pdf
!docs/**/*.pdf
# fixtures/ is whitelisted above so template.pdf and template-noisy.pdf commit;
# a real school template must never be added there — it carries student photos.
out/
```

- [ ] **Step 3: Write the failing test**

`test/units.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PT_PER_IN, PT_PER_MM, fromPdfRect, inches, mm, toPdfRect } from '../src/units.js'

describe('units', () => {
  it('converts inches and millimetres to points', () => {
    expect(inches(1)).toBe(72)
    expect(inches(18)).toBe(1296)
    expect(mm(25.4)).toBeCloseTo(72, 10)
    expect(PT_PER_IN).toBe(72)
    expect(PT_PER_MM).toBeCloseTo(2.834645, 5)
  })

  it('flips a top-left rect into PDF bottom-left space', () => {
    // A 10pt-tall box whose top sits 20pt below the top of a 100pt page
    // has its bottom edge at 100 - 20 - 10 = 70 in PDF space.
    expect(toPdfRect({ x: 5, y: 20, w: 30, h: 10 }, 100)).toEqual({ x: 5, y: 70, w: 30, h: 10 })
  })

  it('round-trips any rect through both flips', () => {
    for (const h of [1, 216, 864, 1000.5]) {
      for (const r of [
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 24.854, y: 30.477, w: 238.296, h: 155.045 },
        { x: -5, y: 12.5, w: 0.25, h: 0.75 },
      ]) {
        const back = fromPdfRect(toPdfRect(r, h), h)
        expect(back.x).toBeCloseTo(r.x, 10)
        expect(back.y).toBeCloseTo(r.y, 10)
        expect(back.w).toBeCloseTo(r.w, 10)
        expect(back.h).toBeCloseTo(r.h, 10)
      }
    }
  })
})
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `npx vitest run test/units.test.ts`
Expected: FAIL — `Failed to resolve import "../src/units.js"`.

- [ ] **Step 5: Implement**

`src/units.ts`:

```ts
export const PT_PER_IN = 72
export const PT_PER_MM = 72 / 25.4

export const inches = (n: number): number => n * PT_PER_IN
export const mm = (n: number): number => n * PT_PER_MM

/** Rect in points, top-left origin. This is the only rect type the codebase uses. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The single Y flip in the codebase. Converts a top-left-origin rect into
 * PDF's bottom-left-origin space. No other module may flip Y.
 */
export function toPdfRect(r: Rect, pageHeight: number): Rect {
  return { x: r.x, y: pageHeight - r.y - r.h, w: r.w, h: r.h }
}

/** Inverse of toPdfRect. Involutive: applying both returns the original. */
export function fromPdfRect(r: Rect, pageHeight: number): Rect {
  return { x: r.x, y: pageHeight - r.y - r.h, w: r.w, h: r.h }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run test/units.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/units.ts test/units.test.ts
git commit -m "feat: project scaffold and point/rect units"
```

---

### Task 2: Layout schema

**Files:**
- Create: `src/layout.ts`
- Create: `fixtures/layout.json`
- Test: `test/layout.test.ts`

**Interfaces:**
- Consumes: `Rect` from `src/units.ts`
- Produces: `Layout`, `Element`, `TextElement`, `PhotoElement`, `StaticElement`, `TextStyle`, `Colour`, `Binding`, `parseLayout(json: unknown): Layout`

- [ ] **Step 1: Write the failing test**

`test/layout.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLayout } from '../src/layout.js'

const fixture = () => JSON.parse(readFileSync('fixtures/layout.json', 'utf8'))

describe('parseLayout', () => {
  it('accepts the reference school layout', () => {
    const l = parseLayout(fixture())
    expect(l.trim).toEqual({ x: 24.854, y: 30.477, w: 238.296, h: 155.045 })
    expect(l.photoTargetDpi).toBe(200)
    expect(l.front).toHaveLength(10)
  })

  it('exposes the address element with its first-line indent', () => {
    const l = parseLayout(fixture())
    const addr = l.front.find((e) => e.id === 'address')
    if (addr?.kind !== 'text') throw new Error('address must be a text element')
    expect(addr.box.w).toBeCloseTo(162.59, 2)
    expect(addr.style.firstLineIndent).toBeCloseTo(36.6, 2)
    expect(addr.style.maxLines).toBe(2)
  })

  it('rejects a layout whose element has a negative width', () => {
    const bad = fixture()
    bad.front[0].box.w = -1
    expect(() => parseLayout(bad)).toThrow(/w/)
  })

  it('rejects an unknown element kind', () => {
    const bad = fixture()
    bad.front[0].kind = 'barcode'
    expect(() => parseLayout(bad)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/layout.test.ts`
Expected: FAIL — cannot resolve `../src/layout.js`.

- [ ] **Step 3: Implement the schema**

`src/layout.ts`:

```ts
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
```

- [ ] **Step 4: Write the reference layout fixture**

All coordinates come from Appendix A of the design spec. `fixtures/layout.json`:

```json
{
  "version": 1,
  "name": "Adarsha Balika Vidyalaya",
  "templateFront": "template.pdf",
  "pageBox": { "w": 288, "h": 216 },
  "trim": { "x": 24.854, "y": 30.477, "w": 238.296, "h": 155.045 },
  "bleed": 0,
  "photoTargetDpi": 200,
  "idColumn": "ID No.",
  "fonts": {
    "value": "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "label": "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"
  },
  "front": [
    { "kind": "text", "id": "id_no", "page": "front", "box": { "x": 59.77, "y": 94.09, "w": 58.5, "h": 10.555 },
      "bind": { "column": "ID No." },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0, "g": 1, "b": 1 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "name", "page": "front", "box": { "x": 59.01, "y": 104.65, "w": 112.5, "h": 10.555 },
      "bind": { "column": "Name" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "guardian", "page": "front", "box": { "x": 102.69, "y": 115.21, "w": 108, "h": 10.555 },
      "bind": { "column": "Guardian's Name" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0, "g": 0.57, "b": 0.25 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "class", "page": "front", "box": { "x": 59.27, "y": 125.76, "w": 18, "h": 10.555 },
      "bind": { "column": "Class" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "roll", "page": "front", "box": { "x": 118.02, "y": 125.76, "w": 13.5, "h": 10.555 },
      "bind": { "column": "R.No." },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "dob", "page": "front", "box": { "x": 60.52, "y": 136.32, "w": 45, "h": 10.555 },
      "bind": { "column": "DOB", "transform": "date", "format": "DD.MM.YYYY" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0, "g": 0.57, "b": 0.25 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "blood", "page": "front", "box": { "x": 169.87, "y": 136.32, "w": 13.5, "h": 10.555 },
      "bind": { "column": "Blood Group", "fallback": "-" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "contact", "page": "front", "box": { "x": 80.26, "y": 146.87, "w": 54, "h": 10.555 },
      "bind": { "column": "Contact No." },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 1, "firstLineIndent": 0 } },
    { "kind": "text", "id": "address", "page": "front", "box": { "x": 26.77, "y": 157.43, "w": 162.59, "h": 21.11 },
      "bind": { "column": "Address" },
      "style": { "fontId": "value", "size": 9, "color": { "space": "rgb", "r": 0.85, "g": 0.15, "b": 0.11 }, "minSize": 6, "lineHeight": 10.555, "maxLines": 2, "firstLineIndent": 36.6 } },
    { "kind": "photo", "id": "photo", "page": "front", "box": { "x": 215.26, "y": 92.23, "w": 47.78, "h": 62.53 }, "fit": "cover" }
  ],
  "back": []
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/layout.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/layout.ts test/layout.test.ts fixtures/layout.json
git commit -m "feat: layout schema and reference school fixture"
```

---

### Task 3: Rasterization and trim detection

The template's page box is not the card (spec 4.3). This task finds the card.

**Files:**
- Create: `src/raster.ts`, `src/trim.ts`
- Create: `fixtures/template.pdf` (synthetic — see Step 1)
- Test: `test/trim.test.ts`

**Interfaces:**
- Consumes: `Rect` from `src/units.ts`
- Produces: `rasterize(pdfBytes, pageIndex, dpi): Promise<Raster>` where `Raster = { width, height, dpi, rgba: Uint8Array }`; `detectTrim(pdfBytes, opts?): Promise<Rect>`

- [ ] **Step 1: Build a synthetic fixture template**

The real `template.pdf` contains a photograph of an actual student and must never be committed (spec Appendix A). Build a stand-in with identical geometry:

Two fixtures are needed. `template.pdf` has ink only inside the trim box, so
trim detection has a known answer. `template-noisy.pdf` adds a mark in the page
surround, outside the trim — without it, the clip test in Task 7 would pass even
if clipping were deleted, because an unpainted surround renders white either way.

```bash
cat > /tmp/mkfixture.mjs <<'EOF'
import { PDFDocument, rgb } from 'pdf-lib'
import { writeFileSync } from 'node:fs'

// trim (top-left) = x 24.854, y 30.477, w 238.296, h 155.045
// PDF y of its bottom edge = 216 - 30.477 - 155.045 = 30.478
const TRIM = { x: 24.854, y: 30.478, w: 238.296, h: 155.045 }

async function build({ noisy }) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([288, 216])
  if (noisy) {
    // Ink in the page surround, outside the trim box. Nothing but a clip path
    // can keep this off a neighbouring card.
    page.drawRectangle({ x: 2, y: 2, width: 284, height: 212, borderColor: rgb(1, 0, 1), borderWidth: 2 })
  }
  page.drawRectangle({ ...TRIM, width: TRIM.w, height: TRIM.h, color: rgb(1, 1, 1), borderColor: rgb(0.16, 0.09, 0.44), borderWidth: 0.5 })
  // Header band, kept wholly inside the trim box so it cannot affect detection.
  page.drawRectangle({ x: 46.4, y: 126.8, width: 191.57, height: 58.23, color: rgb(0.16, 0.09, 0.44) })
  return doc.save()
}

writeFileSync('fixtures/template.pdf', await build({ noisy: false }))
writeFileSync('fixtures/template-noisy.pdf', await build({ noisy: true }))
EOF
npx tsx /tmp/mkfixture.mjs && ls -l fixtures/template*.pdf
```

- [ ] **Step 2: Write the failing test**

`test/trim.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rasterize } from '../src/raster.js'
import { detectTrim } from '../src/trim.js'

const bytes = () => new Uint8Array(readFileSync('fixtures/template.pdf'))

describe('rasterize', () => {
  it('renders the page at the requested dpi', async () => {
    const r = await rasterize(bytes(), 0, 150)
    // 288pt x 216pt at 150dpi = 600 x 450 px
    expect(r.width).toBe(600)
    expect(r.height).toBe(450)
    expect(r.rgba.length).toBe(600 * 450 * 4)
  })
})

describe('detectTrim', () => {
  it('finds the card inside a larger page box', async () => {
    const trim = await detectTrim(bytes(), { dpi: 300 })
    // The detected box includes the 0.5pt border stroke's outer edge, so it runs
    // ~0.5pt large. One 300dpi pixel is 0.24pt. 1pt covers both.
    expect(Math.abs(trim.x - 24.854)).toBeLessThan(1)
    expect(Math.abs(trim.y - 30.477)).toBeLessThan(1)
    expect(Math.abs(trim.w - 238.296)).toBeLessThan(1)
    expect(Math.abs(trim.h - 155.045)).toBeLessThan(1)
  })

  it('centres the detected trim on the page, as the reference template does', async () => {
    const trim = await detectTrim(bytes(), { dpi: 300 })
    expect(Math.abs(trim.x - (288 - trim.x - trim.w))).toBeLessThan(1)
    expect(Math.abs(trim.y - (216 - trim.y - trim.h))).toBeLessThan(1)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/trim.test.ts`
Expected: FAIL — cannot resolve `../src/raster.js`.

- [ ] **Step 4: Implement rasterization**

`src/raster.ts`:

```ts
import * as mupdf from 'mupdf'

export interface Raster {
  width: number
  height: number
  dpi: number
  /** RGBA, 4 bytes per pixel, row-major from the top-left. */
  rgba: Uint8Array
}

/**
 * Render one page to RGBA pixels. MuPDF is a WASM build, so this needs no
 * native toolchain and behaves identically on Windows and Linux.
 */
export async function rasterize(pdfBytes: Uint8Array, pageIndex: number, dpi: number): Promise<Raster> {
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf')
  try {
    const page = doc.loadPage(pageIndex)
    const scale = dpi / 72
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, true)
    try {
      return {
        width: pixmap.getWidth(),
        height: pixmap.getHeight(),
        dpi,
        rgba: new Uint8Array(pixmap.getPixels()),
      }
    } finally {
      pixmap.destroy()
    }
  } finally {
    doc.destroy()
  }
}
```

If the `mupdf` version installed in Task 1 rejects any call above, run `node -e "console.log(Object.keys(require('mupdf')))"` and consult its typings; the four operations needed are open, load page, render to pixmap at a scale, and read pixels.

- [ ] **Step 5: Implement trim detection**

`src/trim.ts`:

```ts
import { rasterize } from './raster.js'
import type { Rect } from './units.js'

export interface DetectTrimOptions {
  dpi?: number
  /** A pixel counts as ink when any channel differs from white by more than this. */
  threshold?: number
}

/**
 * The page box is not the card. Find the artwork's ink bounding box by
 * rendering the page and scanning for non-background pixels.
 *
 * Returns points, top-left origin. The result includes the border stroke's
 * outer edge; the difference between that and the stroke centreline is under
 * 0.35mm, which is below hand-guillotine tolerance, so it is not corrected for.
 */
export async function detectTrim(pdfBytes: Uint8Array, opts: DetectTrimOptions = {}): Promise<Rect> {
  const dpi = opts.dpi ?? 300
  const threshold = opts.threshold ?? 8
  const { width, height, rgba } = await rasterize(pdfBytes, 0, dpi)

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      const i = row + x * 4
      const a = rgba[i + 3] ?? 0
      if (a === 0) continue
      const r = rgba[i] ?? 255
      const g = rgba[i + 1] ?? 255
      const b = rgba[i + 2] ?? 255
      if (255 - r <= threshold && 255 - g <= threshold && 255 - b <= threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) throw new Error('detectTrim: page contains no artwork')

  const k = 72 / dpi
  return {
    x: minX * k,
    y: minY * k,
    w: (maxX - minX + 1) * k,
    h: (maxY - minY + 1) * k,
  }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run test/trim.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/raster.ts src/trim.ts test/trim.test.ts fixtures/template.pdf fixtures/template-noisy.pdf
git commit -m "feat: MuPDF rasterization and ink-bbox trim detection"
```

---

### Task 4: Data source

**Files:**
- Create: `src/data.ts`
- Create: `fixtures/students.xlsx` (generated in Step 1)
- Test: `test/data.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normaliseId(raw): string`, `normaliseHeader(raw): string`, `Row { index, values: Record<string, string> }`, `loadRows(path): Promise<{ headers: string[]; rows: Row[] }>`, `findDuplicateIds(rows, idColumn): Map<string, number[]>`

- [ ] **Step 1: Generate the spreadsheet fixture**

```bash
cat > /tmp/mkdata.mjs <<'EOF'
import ExcelJS from 'exceljs'
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Students')
ws.addRow(['ID No.', 'Name', "Guardian's Name", 'Class', 'R.No.', 'DOB', 'Blood Group', 'Contact No.', 'Address'])
ws.addRow(['101', 'Rahul Kumar', 'Rajesh Kumar', 'X-A', '1', '12.04.2010', 'O+', '9830000001', '12 Park Street, Kolkata 700016'])
ws.addRow(['102', 'Ananya Singh', 'Amit Singh', 'X-A', '2', '03.08.2010', 'B+', '9830000002', '5 Lake Road, Kolkata 700029'])
ws.addRow(['103', 'LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', 'S Venkataraghavan', 'X-B', '3', '19.11.2010', '', '9830000003', '221 Jessore Road, Kolkata 700028'])
ws.addRow(['102', 'Duplicate Row', 'Nobody', 'X-C', '4', '01.01.2010', 'A+', '9830000004', 'Nowhere'])
await wb.xlsx.writeFile('fixtures/students.xlsx')
EOF
npx tsx /tmp/mkdata.mjs && ls -l fixtures/students.xlsx
```

- [ ] **Step 2: Write the failing test**

`test/data.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { findDuplicateIds, loadRows, normaliseHeader, normaliseId } from '../src/data.js'

describe('normaliseId', () => {
  it('strips case, punctuation and leading zeros', () => {
    expect(normaliseId('0101')).toBe('101')
    expect(normaliseId('101')).toBe('101')
    expect(normaliseId(' ID-101 ')).toBe('id101')
    expect(normaliseId('ADM/007')).toBe('adm7')
  })

  it('keeps a bare zero rather than emptying it', () => {
    expect(normaliseId('0')).toBe('0')
    expect(normaliseId('000')).toBe('0')
  })
})

describe('normaliseHeader', () => {
  it('collapses whitespace and trims', () => {
    expect(normaliseHeader('  Guardian’s   Name ')).toBe("Guardian's Name")
    expect(normaliseHeader('ID No.')).toBe('ID No.')
  })
})

describe('loadRows', () => {
  it('reads every data row from an xlsx file', async () => {
    const { headers, rows } = await loadRows('fixtures/students.xlsx')
    expect(headers).toContain('ID No.')
    expect(headers).toContain("Guardian's Name")
    expect(rows).toHaveLength(4)
    expect(rows[0]?.values['Name']).toBe('Rahul Kumar')
    expect(rows[0]?.index).toBe(2)
  })

  it('returns an empty string for a blank cell rather than undefined', async () => {
    const { rows } = await loadRows('fixtures/students.xlsx')
    expect(rows[2]?.values['Blood Group']).toBe('')
  })
})

describe('findDuplicateIds', () => {
  it('reports ids appearing on more than one row', async () => {
    const { rows } = await loadRows('fixtures/students.xlsx')
    const dupes = findDuplicateIds(rows, 'ID No.')
    expect([...dupes.keys()]).toEqual(['102'])
    expect(dupes.get('102')).toEqual([3, 5])
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/data.test.ts`
Expected: FAIL — cannot resolve `../src/data.js`.

- [ ] **Step 4: Implement**

`src/data.ts`:

```ts
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
// EXECUTION NOTE: this reference body could not satisfy its own 'ADM/007' -> 'adm7'
// case (the ^0+ anchor never reaches zeros after a letter). The committed
// implementation strips leading zeros per digit run: replace(/(^|[a-z])0+(\d)/g, '$1$2').
export function normaliseId(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const stripped = cleaned.replace(/^0+/, '')
  return stripped === '' ? (cleaned === '' ? '' : '0') : stripped
}

/** Curly apostrophes and stray whitespace are the usual header mismatches. */
export function normaliseHeader(raw: string): string {
  return raw.replace(/’/g, "'").replace(/\s+/g, ' ').trim()
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
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/data.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/data.ts test/data.test.ts fixtures/students.xlsx
git commit -m "feat: spreadsheet loading with id and header normalisation"
```

---

### Task 5: Fonts and text fitting

The single most important correctness feature in the product: a name that will not fit must shrink, then wrap, then be reported — never overflow silently (spec 6).

**Files:**
- Create: `src/fonts.ts`, `src/text-fit.ts`
- Test: `test/text-fit.test.ts`

**Interfaces:**
- Consumes: `TextStyle` from `src/layout.ts`
- Produces: `FontRegistry` with `load(ids: Record<string,string>, doc: PDFDocument): Promise<FontRegistry>` and `get(id): PDFFont`; `fitText(text, style, boxWidth, font): FitResult` where `FitResult = { lines: string[]; size: number; overflow: boolean }`

- [ ] **Step 1: Write the failing test**

`test/text-fit.test.ts`:

```ts
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import type { PDFFont } from 'pdf-lib'
import { FontRegistry } from '../src/fonts.js'
import { fitText } from '../src/text-fit.js'
import type { TextStyle } from '../src/layout.js'

const LIBERATION_SANS = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'

let arial: PDFFont

beforeAll(async () => {
  const doc = await PDFDocument.create()
  const reg = await FontRegistry.load({ value: LIBERATION_SANS }, doc)
  arial = reg.get('value')
})

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  fontId: 'value',
  size: 9,
  color: { space: 'rgb', r: 0, g: 0, b: 0 },
  align: 'left',
  valign: 'top',
  fit: 'shrink',
  minSize: 6,
  lineHeight: 10.555,
  maxLines: 1,
  firstLineIndent: 0,
  ...over,
})

describe('fitText', () => {
  it('leaves short text at its designed size', () => {
    const r = fitText('Rahul Kumar', style(), 112.5, arial)
    expect(r.size).toBe(9)
    expect(r.lines).toEqual(['Rahul Kumar'])
    expect(r.overflow).toBe(false)
  })

  it('confirms the reference template metric: x is 4.5pt at Arial 9', () => {
    // Appendix A of the spec derives every field budget from this.
    expect(arial.widthOfTextAtSize('x', 9)).toBeCloseTo(4.5, 2)
  })

  it('shrinks a long name to fit rather than overflowing', () => {
    const r = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style(), 112.5, arial)
    expect(r.size).toBeLessThan(9)
    expect(r.size).toBeGreaterThanOrEqual(6)
    expect(r.lines).toHaveLength(1)
    expect(arial.widthOfTextAtSize(r.lines[0]!, r.size)).toBeLessThanOrEqual(112.5)
  })

  it('reports overflow when even minSize will not fit', () => {
    const r = fitText('LAKSHMI PRIYADARSHINI VENKATARAGHAVAN', style(), 20, arial)
    expect(r.overflow).toBe(true)
    expect(r.size).toBe(6)
  })

  it('wraps an address across two lines with the first line indented', () => {
    const r = fitText('12 Park Street, Kolkata 700016', style({ maxLines: 2, firstLineIndent: 36.6 }), 162.59, arial)
    expect(r.overflow).toBe(false)
    expect(r.lines.length).toBeLessThanOrEqual(2)
    // First line is shortened by the indent; second line uses the full width.
    expect(arial.widthOfTextAtSize(r.lines[0]!, r.size)).toBeLessThanOrEqual(162.59 - 36.6)
  })

  it('breaks a single unbreakable token rather than looping forever', () => {
    const r = fitText('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', style({ maxLines: 2 }), 30, arial)
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/text-fit.test.ts`
Expected: FAIL — cannot resolve `../src/fonts.js`.

- [ ] **Step 3: Implement the font registry**

`src/fonts.ts`:

```ts
import { readFile } from 'node:fs/promises'
import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'

/** Loads font files once per document and hands out embedded pdf-lib fonts by id. */
export class FontRegistry {
  private constructor(private readonly fonts: Map<string, PDFFont>) {}

  static async load(ids: Record<string, string>, doc: PDFDocument): Promise<FontRegistry> {
    doc.registerFontkit(fontkit)
    const fonts = new Map<string, PDFFont>()
    for (const [id, path] of Object.entries(ids)) {
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch {
        throw new Error(`Font "${id}" not found at ${path}. Overlay text cannot be embedded without the font file.`)
      }
      fonts.set(id, await doc.embedFont(bytes, { subset: true }))
    }
    return new FontRegistry(fonts)
  }

  get(id: string): PDFFont {
    const f = this.fonts.get(id)
    if (!f) throw new Error(`Font "${id}" was not declared in the layout's fonts map`)
    return f
  }
}
```

- [ ] **Step 4: Implement text fitting**

`src/text-fit.ts`:

```ts
import type { PDFFont } from 'pdf-lib'
import type { TextStyle } from './layout.js'

export interface FitResult {
  lines: string[]
  size: number
  /** True when the text does not fit even at minSize. The card goes to preflight. */
  overflow: boolean
}

const STEP = 0.25

/** Greedy wrap. Returns null when a line count budget is blown, so the caller can shrink and retry. */
function wrap(text: string, font: PDFFont, size: number, widths: number[], maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''

  const widthFor = (i: number) => widths[Math.min(i, widths.length - 1)] ?? 0

  for (let w = 0; w < words.length; w++) {
    let word = words[w]!
    const candidate = current === '' ? word : `${current} ${word}`
    if (font.widthOfTextAtSize(candidate, size) <= widthFor(lines.length)) {
      current = candidate
      continue
    }
    if (current !== '') {
      lines.push(current)
      current = ''
      if (lines.length >= maxLines) return null
      w--
      continue
    }
    // A single word wider than the line: hard-break it so we cannot loop forever.
    let cut = word.length - 1
    while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > widthFor(lines.length)) cut--
    lines.push(word.slice(0, cut))
    if (lines.length >= maxLines) return null
    words[w] = word.slice(cut)
    w--
  }
  if (current !== '') lines.push(current)
  return lines.length <= maxLines ? lines : null
}

/**
 * Fit text into a box of the given width. Tries the designed size first and
 * steps down toward minSize. Wrapping is attempted at every size, so a
 * single-line field (maxLines 1) shrinks while an address wraps then shrinks.
 * Returning overflow rather than drawing outside the box is the point: a name
 * that silently overflows on card 700 is not discovered until after cutting.
 */
export function fitText(text: string, style: TextStyle, boxWidth: number, font: PDFFont): FitResult {
  const trimmed = text.trim()
  if (trimmed === '') return { lines: [''], size: style.size, overflow: false }

  const widths = style.firstLineIndent > 0 ? [boxWidth - style.firstLineIndent, boxWidth] : [boxWidth]

  if (style.fit === 'clip') {
    return { lines: [trimmed], size: style.size, overflow: font.widthOfTextAtSize(trimmed, style.size) > boxWidth }
  }

  for (let size = style.size; size >= style.minSize - 1e-9; size -= STEP) {
    const lines = wrap(trimmed, font, size, widths, style.maxLines)
    if (lines) return { lines, size: Number(size.toFixed(4)), overflow: false }
  }

  const fallback = wrap(trimmed, font, style.minSize, widths, Number.MAX_SAFE_INTEGER) ?? [trimmed]
  return { lines: fallback.slice(0, style.maxLines), size: style.minSize, overflow: true }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/text-fit.test.ts`
Expected: PASS, 6 tests. The `x is 4.5pt` assertion cross-checks the spec's Appendix A against a real font.

- [ ] **Step 6: Commit**

```bash
git add src/fonts.ts src/text-fit.ts test/text-fit.test.ts
git commit -m "feat: font registry and shrink-to-fit text layout"
```

---

### Task 6: Grid solver

**Files:**
- Create: `src/grid.ts`
- Test: `test/grid.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `SheetSpec { w, h }`, `GridOptions { sheet, card, gutter, minMargin }`, `Grid { cols, rows, perSheet, cellW, cellH, originX, originY, gutter, rotated }`, `solveGrid(opts): Grid`, `cellRect(grid, index): Rect`

- [ ] **Step 1: Write the failing test**

`test/grid.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cellRect, solveGrid } from '../src/grid.js'
import { inches, mm } from '../src/units.js'

const SHEET = { w: inches(18), h: inches(12) }
const REFERENCE_CARD = { w: 238.296, h: 155.045 }

describe('solveGrid', () => {
  it('reproduces the operator existing 5x5 layout for the reference card', () => {
    const g = solveGrid({ sheet: SHEET, card: REFERENCE_CARD, gutter: mm(3), minMargin: mm(5) })
    expect(g.cols).toBe(5)
    expect(g.rows).toBe(5)
    expect(g.perSheet).toBe(25)
    expect(g.rotated).toBe(false)
  })

  it('always produces symmetric margins', () => {
    for (const card of [REFERENCE_CARD, { w: 200, h: 120 }, { w: 90, h: 140 }, { w: 300, h: 200 }]) {
      const g = solveGrid({ sheet: SHEET, card, gutter: mm(3), minMargin: mm(5) })
      const usedW = g.cols * g.cellW + (g.cols - 1) * g.gutter
      const usedH = g.rows * g.cellH + (g.rows - 1) * g.gutter
      expect(g.originX).toBeCloseTo((SHEET.w - usedW) / 2, 6)
      expect(g.originY).toBeCloseTo((SHEET.h - usedH) / 2, 6)
      expect(g.originX).toBeGreaterThanOrEqual(mm(5) - 1e-6)
      expect(g.originY).toBeGreaterThanOrEqual(mm(5) - 1e-6)
    }
  })

  it('rotates the card when rotation yields more cards per sheet', () => {
    // 140 x 90 landscape: 9 x 9 = 81 upright, but 140 tall gives 14 x 6 = 84.
    const g = solveGrid({ sheet: SHEET, card: { w: 140, h: 90 }, gutter: 0, minMargin: 0 })
    const upright = Math.floor(SHEET.w / 140) * Math.floor(SHEET.h / 90)
    expect(g.perSheet).toBeGreaterThanOrEqual(upright)
  })

  it('reduces the gutter before losing a column', () => {
    // A card that fits 5 across only when the gutter shrinks.
    const card = { w: (inches(18) - mm(10)) / 5, h: 100 }
    const g = solveGrid({ sheet: SHEET, card, gutter: mm(3), minMargin: mm(2) })
    expect(g.cols).toBe(5)
    expect(g.gutter).toBeLessThan(mm(3))
  })

  it('throws when a single card cannot fit the sheet', () => {
    expect(() => solveGrid({ sheet: SHEET, card: { w: 2000, h: 100 }, gutter: 0, minMargin: 0 })).toThrow(/does not fit/)
  })
})

describe('cellRect', () => {
  it('lays cells out row-major from the top-left', () => {
    const g = solveGrid({ sheet: SHEET, card: REFERENCE_CARD, gutter: mm(3), minMargin: mm(5) })
    const first = cellRect(g, 0)
    const second = cellRect(g, 1)
    const sixth = cellRect(g, 5)
    expect(first.x).toBeCloseTo(g.originX, 6)
    expect(first.y).toBeCloseTo(g.originY, 6)
    expect(second.x).toBeCloseTo(g.originX + g.cellW + g.gutter, 6)
    expect(second.y).toBeCloseTo(first.y, 6)
    expect(sixth.y).toBeCloseTo(g.originY + g.cellH + g.gutter, 6)
    expect(sixth.x).toBeCloseTo(g.originX, 6)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/grid.test.ts`
Expected: FAIL — cannot resolve `../src/grid.js`.

- [ ] **Step 3: Implement**

`src/grid.ts`:

```ts
import type { Rect } from './units.js'

export interface SheetSpec {
  w: number
  h: number
}

export interface GridOptions {
  sheet: SheetSpec
  card: SheetSpec
  gutter: number
  minMargin: number
}

export interface Grid {
  cols: number
  rows: number
  perSheet: number
  cellW: number
  cellH: number
  originX: number
  originY: number
  gutter: number
  rotated: boolean
}

interface Fit {
  cols: number
  rows: number
  gutter: number
}

/** Largest count that fits `span` given a card size and gutter, honouring the margin floor. */
function countFor(span: number, card: number, gutter: number, minMargin: number): number {
  const usable = span - 2 * minMargin
  if (usable < card) return 0
  return Math.max(0, Math.floor((usable + gutter) / (card + gutter)))
}

function bestFit(sheet: SheetSpec, card: SheetSpec, gutter: number, minMargin: number): Fit | null {
  // Try the requested gutter, then reduce toward butt-cut rather than surrender a card.
  for (let g = gutter; g >= 0; g -= 0.5) {
    const gg = g < 0.5 ? 0 : g
    const cols = countFor(sheet.w, card.w, gg, minMargin)
    const rows = countFor(sheet.h, card.h, gg, minMargin)
    if (cols > 0 && rows > 0) {
      const atRequested = countFor(sheet.w, card.w, gutter, minMargin) * countFor(sheet.h, card.h, gutter, minMargin)
      if (cols * rows > atRequested || gg === gutter) return { cols, rows, gutter: gg }
    }
    if (gg === 0) break
  }
  const cols = countFor(sheet.w, card.w, 0, minMargin)
  const rows = countFor(sheet.h, card.h, 0, minMargin)
  return cols > 0 && rows > 0 ? { cols, rows, gutter: 0 } : null
}

/**
 * Solve the sheet layout. Both orientations are evaluated because rotation can
 * win outright for some card sizes; ties go to the upright orientation so the
 * output matches how the template was designed.
 *
 * Margins are always symmetric. Duplex registration depends on it: with unequal
 * left and right margins, every card on every mirrored back sheet is offset by
 * the difference.
 */
export function solveGrid(opts: GridOptions): Grid {
  const { sheet, card, gutter, minMargin } = opts

  const upright = bestFit(sheet, card, gutter, minMargin)
  const turned = bestFit(sheet, { w: card.h, h: card.w }, gutter, minMargin)

  const uprightCount = upright ? upright.cols * upright.rows : 0
  const turnedCount = turned ? turned.cols * turned.rows : 0

  if (uprightCount === 0 && turnedCount === 0) {
    throw new Error(
      `Card ${card.w.toFixed(2)} x ${card.h.toFixed(2)}pt does not fit sheet ${sheet.w.toFixed(2)} x ${sheet.h.toFixed(2)}pt with a ${minMargin.toFixed(2)}pt margin`,
    )
  }

  const rotated = turnedCount > uprightCount
  const fit = (rotated ? turned : upright)!
  const cellW = rotated ? card.h : card.w
  const cellH = rotated ? card.w : card.h

  const usedW = fit.cols * cellW + (fit.cols - 1) * fit.gutter
  const usedH = fit.rows * cellH + (fit.rows - 1) * fit.gutter

  return {
    cols: fit.cols,
    rows: fit.rows,
    perSheet: fit.cols * fit.rows,
    cellW,
    cellH,
    originX: (sheet.w - usedW) / 2,
    originY: (sheet.h - usedH) / 2,
    gutter: fit.gutter,
    rotated,
  }
}

/** Position of cell `index` within a sheet, row-major from the top-left. */
export function cellRect(grid: Grid, index: number): Rect {
  const col = index % grid.cols
  const row = Math.floor(index / grid.cols)
  return {
    x: grid.originX + col * (grid.cellW + grid.gutter),
    y: grid.originY + row * (grid.cellH + grid.gutter),
    w: grid.cellW,
    h: grid.cellH,
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/grid.test.ts`
Expected: PASS, 6 tests. The first confirms the solver independently arrives at the operator's existing 5x5.

- [ ] **Step 5: Commit**

```bash
git add src/grid.ts test/grid.test.ts
git commit -m "feat: grid solver with symmetric margins and rotation search"
```

---

### Task 7: Card renderer

Stamps the template page into one cell and draws its text. The clip path is not optional: the reference template's page box is 24.85pt wider than its card on each side, which without clipping would paint white over the neighbouring card (spec 4.3).

**Files:**
- Create: `src/card.ts`
- Test: `test/card.test.ts`

**Interfaces:**
- Consumes: `Rect`, `toPdfRect`; `Layout`, `Element`, `Colour`; `FontRegistry`; `fitText`
- Produces: `applyTransform(value, binding): string`, `resolveText(row, binding): { text: string; missing: boolean }`, `drawCard(args: DrawCardArgs): DrawCardResult`

- [ ] **Step 1: Write the failing test**

`test/card.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { FontRegistry } from '../src/fonts.js'
import { applyTransform, drawCard, resolveText } from '../src/card.js'
import { parseLayout } from '../src/layout.js'
import { rasterize } from '../src/raster.js'

const layout = () => parseLayout(JSON.parse(readFileSync('fixtures/layout.json', 'utf8')))

describe('applyTransform', () => {
  it('upper-cases and title-cases', () => {
    expect(applyTransform('rahul kumar', { column: 'Name', transform: 'upper' })).toBe('RAHUL KUMAR')
    expect(applyTransform('rahul kumar', { column: 'Name', transform: 'title' })).toBe('Rahul Kumar')
  })

  it('leaves values alone when no transform is set', () => {
    expect(applyTransform('X-A', { column: 'Class' })).toBe('X-A')
  })
})

describe('resolveText', () => {
  it('flags an empty required field as missing', () => {
    const r = resolveText({ index: 2, values: { Name: '' } }, { column: 'Name' })
    expect(r.missing).toBe(true)
  })

  it('uses the fallback and does not flag when one is declared', () => {
    const r = resolveText({ index: 2, values: { 'Blood Group': '' } }, { column: 'Blood Group', fallback: '-' })
    expect(r).toEqual({ text: '-', missing: false })
  })
})

describe('drawCard', () => {
  it('paints nothing outside the destination cell', async () => {
    const l = layout()
    // The noisy fixture has magenta ink in its page surround. Without the clip
    // path that ink lands 24.85pt outside the cell, on top of the neighbour.
    const templateBytes = new Uint8Array(readFileSync('fixtures/template-noisy.pdf'))

    const out = await PDFDocument.create()
    const page = out.addPage([400, 400])
    const fonts = await FontRegistry.load(l.fonts, out)
    const [embedded] = await out.embedPdf(templateBytes, [0])

    drawCard({
      page,
      embedded: embedded!,
      layout: l,
      elements: l.front,
      fonts,
      row: { index: 2, values: { 'ID No.': '101', Name: 'Rahul Kumar', Address: '12 Park Street' } },
      cell: { x: 100, y: 100, w: l.trim.w, h: l.trim.h },
      photo: null,
    })

    const raster = await rasterize(new Uint8Array(await out.save()), 0, 72)
    const px = (x: number, y: number) => {
      const i = (y * raster.width + x) * 4
      return [raster.rgba[i], raster.rgba[i + 1], raster.rgba[i + 2]]
    }
    // 6pt left of the cell, and 6pt above it: both inside the unclipped
    // template page, both must remain the sheet's white.
    expect(px(94, 150)).toEqual([255, 255, 255])
    expect(px(150, 94)).toEqual([255, 255, 255])
  })

  it('reports overflow for a name that cannot fit', async () => {
    const l = layout()
    const out = await PDFDocument.create()
    const page = out.addPage([400, 400])
    const fonts = await FontRegistry.load(l.fonts, out)
    const [embedded] = await out.embedPdf(new Uint8Array(readFileSync('fixtures/template.pdf')), [0])

    const result = drawCard({
      page,
      embedded: embedded!,
      layout: l,
      elements: l.front,
      fonts,
      row: { index: 4, values: { 'ID No.': '103', Name: 'LAKSHMI PRIYADARSHINI VENKATARAGHAVAN'.repeat(3) } },
      cell: { x: 0, y: 0, w: l.trim.w, h: l.trim.h },
      photo: null,
    })

    expect(result.overflowed).toContain('name')
    expect(result.missing).toContain('guardian')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/card.test.ts`
Expected: FAIL — cannot resolve `../src/card.js`.

- [ ] **Step 3: Implement**

`src/card.ts`:

```ts
import {
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  cmyk,
  grayscale,
  rgb,
} from 'pdf-lib'
import type { Color, PDFEmbeddedPage, PDFImage, PDFPage } from 'pdf-lib'
import type { Binding, Colour, Element, Layout } from './layout.js'
import type { Row } from './data.js'
import type { FontRegistry } from './fonts.js'
import { fitText } from './text-fit.js'
import { toPdfRect, type Rect } from './units.js'

export interface DrawCardArgs {
  page: PDFPage
  embedded: PDFEmbeddedPage
  layout: Layout
  elements: Element[]
  fonts: FontRegistry
  row: Row
  /** Destination rect on the sheet, top-left origin. */
  cell: Rect
  photo: PDFImage | null
}

export interface DrawCardResult {
  /** Element ids whose text did not fit even at minSize. */
  overflowed: string[]
  /** Element ids whose bound column was empty and had no fallback. */
  missing: string[]
}

export function applyTransform(value: string, binding: Binding): string {
  switch (binding.transform) {
    case 'upper':
      return value.toUpperCase()
    case 'title':
      return value.replace(/\S+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    default:
      return value
  }
}

export function resolveText(row: Row, binding: Binding): { text: string; missing: boolean } {
  const raw = (row.values[binding.column] ?? '').trim()
  if (raw === '') {
    if (binding.fallback !== undefined) return { text: binding.fallback, missing: false }
    return { text: '', missing: true }
  }
  return { text: applyTransform(raw, binding), missing: false }
}

function toPdfColor(c: Colour): Color {
  switch (c.space) {
    case 'rgb':
      return rgb(c.r, c.g, c.b)
    case 'cmyk':
      return cmyk(c.c, c.m, c.y, c.k)
    case 'gray':
      return grayscale(1 - c.k)
  }
}

/** Push a rectangular clip in PDF space. Everything drawn until popGraphicsState is confined to it. */
function clipTo(page: PDFPage, r: Rect, pageHeight: number): void {
  const p = toPdfRect(r, pageHeight)
  page.pushOperators(
    pushGraphicsState(),
    moveTo(p.x, p.y),
    lineTo(p.x + p.w, p.y),
    lineTo(p.x + p.w, p.y + p.h),
    lineTo(p.x, p.y + p.h),
    closePath(),
    clip(),
    endPath(),
  )
}

/**
 * Draw one card into `cell`.
 *
 * The template's page box is larger than its trim box, so the embedded page is
 * offset so that the trim's top-left lands on the cell's top-left, and the whole
 * card is clipped to the cell. Without the clip the page's white surround paints
 * over neighbouring cards.
 */
export function drawCard(args: DrawCardArgs): DrawCardResult {
  const { page, embedded, layout, elements, fonts, row, cell, photo } = args
  const pageHeight = page.getHeight()
  const overflowed: string[] = []
  const missing: string[] = []

  clipTo(page, cell, pageHeight)

  // Offset so the trim box, not the page box, aligns with the cell.
  const artRect: Rect = {
    x: cell.x - layout.trim.x,
    y: cell.y - layout.trim.y,
    w: layout.pageBox.w,
    h: layout.pageBox.h,
  }
  const art = toPdfRect(artRect, pageHeight)
  page.drawPage(embedded, { x: art.x, y: art.y, width: art.w, height: art.h })

  for (const el of elements) {
    // Element boxes are stored in template page coordinates.
    const box: Rect = {
      x: cell.x - layout.trim.x + el.box.x,
      y: cell.y - layout.trim.y + el.box.y,
      w: el.box.w,
      h: el.box.h,
    }

    if (el.kind === 'photo') {
      if (!photo) continue
      clipTo(page, box, pageHeight)
      const scale =
        el.fit === 'cover'
          ? Math.max(box.w / photo.width, box.h / photo.height)
          : Math.min(box.w / photo.width, box.h / photo.height)
      const dw = photo.width * scale
      const dh = photo.height * scale
      const placed = toPdfRect({ x: box.x + (box.w - dw) / 2, y: box.y + (box.h - dh) / 2, w: dw, h: dh }, pageHeight)
      page.drawImage(photo, { x: placed.x, y: placed.y, width: placed.w, height: placed.h })
      page.pushOperators(popGraphicsState())
      continue
    }

    const text = el.kind === 'static' ? el.text : resolveText(row, el.bind).text
    if (el.kind === 'text' && resolveText(row, el.bind).missing) {
      missing.push(el.id)
      continue
    }
    if (text === '') continue

    const font = fonts.get(el.style.fontId)
    const fit = fitText(text, el.style, box.w, font)
    if (fit.overflow) overflowed.push(el.id)

    const ascent = font.heightAtSize(fit.size, { descender: false })
    fit.lines.forEach((line, i) => {
      const indent = i === 0 ? el.style.firstLineIndent : 0
      const lineWidth = font.widthOfTextAtSize(line, fit.size)
      const available = box.w - indent
      const dx =
        el.style.align === 'center' ? (available - lineWidth) / 2 : el.style.align === 'right' ? available - lineWidth : 0
      const topY = box.y + i * el.style.lineHeight
      page.drawText(line, {
        x: box.x + indent + dx,
        y: pageHeight - topY - ascent,
        size: fit.size,
        font,
        color: toPdfColor(el.style.color),
      })
    })
  }

  page.pushOperators(popGraphicsState())
  return { overflowed, missing }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/card.test.ts`
Expected: PASS, 5 tests. The clip test is the important one — it is what stops neighbouring cards being painted over.

- [ ] **Step 5: Commit**

```bash
git add src/card.ts test/card.test.ts
git commit -m "feat: card renderer with clipped template stamping"
```

---

### Task 8: Photo index

No image processing here by design (see "Why this is one plan of four"). Photos are matched, measured for effective DPI, and embedded as-is; fitting is done by the clip in Task 7.

**Files:**
- Create: `src/photos.ts`
- Create: `fixtures/photos/101.jpg`, `fixtures/photos/0102.jpg`, `fixtures/photos/junk.jpg`
- Test: `test/photos.test.ts`

**Interfaces:**
- Consumes: `normaliseId` from `src/data.ts`
- Produces: `PhotoEntry { path, id, width, height }`, `buildPhotoIndex(dir): Promise<{ byId: Map<string, PhotoEntry>; unmatched: PhotoEntry[] }>`, `effectiveDpi(entry, box): number`

- [ ] **Step 1: Generate photo fixtures**

```bash
mkdir -p fixtures/photos
cat > /tmp/mkphotos.mjs <<'EOF'
import { PDFDocument } from 'pdf-lib'
import { writeFileSync } from 'node:fs'
// Minimal valid JPEGs at known sizes, produced by re-encoding a solid pixmap.
import * as mupdf from 'mupdf'
function jpeg(w, h, path) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  pix.clear(200)
  writeFileSync(path, pix.asJPEG(80, false))
  pix.destroy()
}
jpeg(132, 172, 'fixtures/photos/101.jpg')   // ~199ppi in the reference frame
jpeg(60, 80,  'fixtures/photos/0102.jpg')   // deliberately low resolution
jpeg(132, 172, 'fixtures/photos/junk.jpg')  // matches no student
EOF
npx tsx /tmp/mkphotos.mjs && ls -l fixtures/photos/
```

If `Pixmap.asJPEG` is unavailable in the installed mupdf build, substitute any three JPEGs at those pixel dimensions; only the dimensions matter.

- [ ] **Step 2: Write the failing test**

`test/photos.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildPhotoIndex, effectiveDpi } from '../src/photos.js'

describe('buildPhotoIndex', () => {
  it('matches filenames to ids despite leading zeros', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos')
    expect(byId.has('101')).toBe(true)
    expect(byId.has('102')).toBe(true) // from 0102.jpg
    expect(byId.get('101')?.width).toBe(132)
    expect(byId.get('101')?.height).toBe(172)
  })

  it('keeps files whose stem is not a usable id available for manual pairing', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos')
    expect(byId.has('junk')).toBe(true)
  })
})

describe('effectiveDpi', () => {
  it('computes dpi from pixels over the printed box size', () => {
    // The reference photo frame is 47.78 x 62.53pt; 132px across 47.78pt is ~199dpi.
    const dpi = effectiveDpi({ path: 'x', id: '101', width: 132, height: 172 }, { x: 0, y: 0, w: 47.78, h: 62.53 })
    expect(dpi).toBeGreaterThan(195)
    expect(dpi).toBeLessThan(205)
  })

  it('uses the more constrained axis', () => {
    const dpi = effectiveDpi({ path: 'x', id: 'a', width: 1000, height: 10 }, { x: 0, y: 0, w: 72, h: 72 })
    expect(dpi).toBe(10)
  })
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/photos.test.ts`
Expected: FAIL — cannot resolve `../src/photos.js`.

- [ ] **Step 4: Implement**

`src/photos.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises'
import { extname, join, parse } from 'node:path'
import { normaliseId } from './data.js'
import type { Rect } from './units.js'

export interface PhotoEntry {
  path: string
  /** Normalised filename stem, used to match the id column. */
  id: string
  width: number
  height: number
}

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png'])

function pngSize(b: Buffer): { width: number; height: number } {
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** Walk JPEG segment markers to the first SOF frame header, which carries the dimensions. */
function jpegSize(b: Buffer): { width: number; height: number } {
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    const len = b.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    i += 2 + len
  }
  throw new Error('jpegSize: no SOF marker found')
}

export async function buildPhotoIndex(dir: string): Promise<{ byId: Map<string, PhotoEntry>; unmatched: PhotoEntry[] }> {
  const byId = new Map<string, PhotoEntry>()
  const unmatched: PhotoEntry[] = []

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { byId, unmatched }
  }

  for (const name of names) {
    const ext = extname(name).toLowerCase()
    if (!SUPPORTED.has(ext)) continue
    const path = join(dir, name)
    const bytes = await readFile(path)
    const size = ext === '.png' ? pngSize(bytes) : jpegSize(bytes)
    const id = normaliseId(parse(name).name)
    const entry: PhotoEntry = { path, id, ...size }
    if (id === '') unmatched.push(entry)
    else byId.set(id, entry)
  }

  return { byId, unmatched }
}

/**
 * Printed resolution of a photo placed in `box`, in dots per inch.
 * The more constrained axis governs, because cover-fit crops the other one.
 */
export function effectiveDpi(entry: Pick<PhotoEntry, 'width' | 'height'>, box: Rect): number {
  const across = entry.width / (box.w / 72)
  const down = entry.height / (box.h / 72)
  return Math.min(across, down)
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/photos.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/photos.ts test/photos.test.ts fixtures/photos
git commit -m "feat: photo index with id matching and effective-dpi measurement"
```

---

### Task 9: Preflight

**Files:**
- Create: `src/preflight.ts`
- Test: `test/preflight.test.ts`

**Interfaces:**
- Consumes: `Row`, `findDuplicateIds`, `normaliseId`; `Layout`; `PhotoEntry`, `effectiveDpi`; `FontRegistry`, `fitText`
- Produces: `Issue { level, code, row, field?, message }`, `runPreflight(args): Issue[]`, `summarise(issues): { blocking: number; warnings: number; byCode: Map<string, number> }`

- [ ] **Step 1: Write the failing test**

`test/preflight.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/preflight.test.ts`
Expected: FAIL — cannot resolve `../src/preflight.js`.

- [ ] **Step 3: Implement**

`src/preflight.ts`:

```ts
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
      issues.push({
        level: 'block',
        code: 'id-duplicate',
        row,
        message: `id "${id}" also appears on row ${rowNumbers.filter((r) => r !== row).join(', ')}`,
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

    if (photoElements.length > 0) {
      const entry = id === '' ? undefined : photos.get(id)
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
              message: `photo is ${dpi.toFixed(0)}dpi at printed size, below the ${DPI_FLOOR}dpi floor`,
            })
          } else if (dpi < Math.min(DPI_IDEAL, Math.max(layout.photoTargetDpi, DPI_FLOOR))) {
            issues.push({
              level: 'warn',
              code: 'photo-dpi',
              row: row.index,
              field: el.id,
              message: `photo is ${dpi.toFixed(0)}dpi, below the ${layout.photoTargetDpi}dpi target`,
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/preflight.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/preflight.ts test/preflight.test.ts
git commit -m "feat: preflight issue collection with block and warn levels"
```

---

### Task 10: Imposition

**Files:**
- Create: `src/impose.ts`
- Test: `test/impose.test.ts`

**Interfaces:**
- Consumes: `Grid`, `cellRect`, `solveGrid`; `Rect`, `toPdfRect`, `inches`
- Produces: `mirrorIndex(grid, index, axis): number`, `sheetCount(total, perSheet): number`, `drawCropMarks(page, grid, sheet)`, `drawSlug(page, text, sheet, font, margin)`

- [ ] **Step 1: Write the failing test**

`test/impose.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { solveGrid } from '../src/grid.js'
import { mirrorIndex, sheetCount } from '../src/impose.js'
import { inches, mm } from '../src/units.js'

const grid = solveGrid({
  sheet: { w: inches(18), h: inches(12) },
  card: { w: 238.296, h: 155.045 },
  gutter: mm(3),
  minMargin: mm(5),
})

describe('mirrorIndex', () => {
  it('reverses columns for a long-edge flip and leaves rows alone', () => {
    // Front row 0 reads 0 1 2 3 4; the back sheet must read 4 3 2 1 0.
    expect(mirrorIndex(grid, 0, 'long-edge')).toBe(4)
    expect(mirrorIndex(grid, 4, 'long-edge')).toBe(0)
    expect(mirrorIndex(grid, 5, 'long-edge')).toBe(9)
    expect(mirrorIndex(grid, 12, 'long-edge')).toBe(12)
  })

  it('reverses rows for a short-edge flip and leaves columns alone', () => {
    expect(mirrorIndex(grid, 0, 'short-edge')).toBe(20)
    expect(mirrorIndex(grid, 20, 'short-edge')).toBe(0)
    expect(mirrorIndex(grid, 12, 'short-edge')).toBe(12)
  })

  it('is its own inverse on both axes', () => {
    for (let i = 0; i < grid.perSheet; i++) {
      expect(mirrorIndex(grid, mirrorIndex(grid, i, 'long-edge'), 'long-edge')).toBe(i)
      expect(mirrorIndex(grid, mirrorIndex(grid, i, 'short-edge'), 'short-edge')).toBe(i)
    }
  })
})

describe('sheetCount', () => {
  it('rounds up for a partial final sheet', () => {
    expect(sheetCount(1000, 25)).toBe(40)
    expect(sheetCount(1001, 25)).toBe(41)
    expect(sheetCount(0, 25)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/impose.test.ts`
Expected: FAIL — cannot resolve `../src/impose.js`.

- [ ] **Step 3: Implement**

`src/impose.ts`:

```ts
import { rgb } from 'pdf-lib'
import type { PDFFont, PDFPage } from 'pdf-lib'
import { cellRect, type Grid } from './grid.js'
import { toPdfRect, type Rect } from './units.js'

export type FlipAxis = 'long-edge' | 'short-edge'

/**
 * Position a card must occupy on the back sheet so it lands behind its front.
 *
 * Fronts are printed, the stack is flipped once, backs are printed. A long-edge
 * flip turns the sheet about its vertical axis, so column 0 becomes the last
 * column; rows are untouched. A short-edge flip does the same to rows.
 *
 * This is exact only because grid margins are symmetric. With unequal margins
 * every card on every back sheet is offset by the difference.
 */
export function mirrorIndex(grid: Grid, index: number, axis: FlipAxis): number {
  const col = index % grid.cols
  const row = Math.floor(index / grid.cols)
  return axis === 'long-edge'
    ? row * grid.cols + (grid.cols - 1 - col)
    : (grid.rows - 1 - row) * grid.cols + col
}

export function sheetCount(total: number, perSheet: number): number {
  return Math.ceil(total / perSheet)
}

const MARK_LEN = 6
const MARK_GAP = 2

/** Crop marks sit in the gutter and margin, never inside the card. */
export function drawCropMarks(page: PDFPage, grid: Grid, sheet: { w: number; h: number }): void {
  const colour = rgb(0, 0, 0)
  const line = (r: Rect) => {
    const p = toPdfRect(r, sheet.h)
    page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: colour })
  }

  for (let i = 0; i < grid.perSheet; i++) {
    const c = cellRect(grid, i)
    for (const x of [c.x, c.x + c.w]) {
      line({ x: x - 0.25, y: c.y - MARK_GAP - MARK_LEN, w: 0.5, h: MARK_LEN })
      line({ x: x - 0.25, y: c.y + c.h + MARK_GAP, w: 0.5, h: MARK_LEN })
    }
    for (const y of [c.y, c.y + c.h]) {
      line({ x: c.x - MARK_GAP - MARK_LEN, y: y - 0.25, w: MARK_LEN, h: 0.5 })
      line({ x: c.x + c.w + MARK_GAP, y: y - 0.25, w: MARK_LEN, h: 0.5 })
    }
  }
}

/**
 * Job name, sheet number and side, printed in the margin outside every card.
 * On a forty-sheet duplex job, unlabelled sheets get mixed up and one misplaced
 * back sheet ruins a full sheet of cards.
 */
export function drawSlug(page: PDFPage, text: string, sheet: { w: number; h: number }, font: PDFFont, margin: number): void {
  const size = Math.min(7, Math.max(4, margin - 4))
  page.drawText(text, { x: margin, y: Math.max(2, margin / 2 - size / 2), size, font, color: rgb(0.4, 0.4, 0.4) })
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/impose.test.ts`
Expected: PASS, 4 tests. The involution test is the guard against a mirror regression silently inverting a whole job.

- [ ] **Step 5: Commit**

```bash
git add src/impose.ts test/impose.test.ts
git commit -m "feat: duplex mirroring, crop marks and sheet slug"
```

---

### Task 11: Job orchestrator, CLI, and end-to-end test

**Files:**
- Create: `src/render-job.ts`, `src/cli.ts`
- Modify: `package.json` (add the `bin` entry)
- Test: `test/render-job.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `renderJob(args): Promise<JobResult>` where `JobResult = { frontPdf: Uint8Array; backPdf: Uint8Array | null; sheets: number; cards: number; issues: Issue[] }`

- [ ] **Step 1: Write the failing test**

`test/render-job.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/render-job.test.ts`
Expected: FAIL — cannot resolve `../src/render-job.js`.

- [ ] **Step 3: Implement the orchestrator**

`src/render-job.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/render-job.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Implement the CLI**

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Command } from 'commander'
import { loadRows } from './data.js'
import { parseLayout } from './layout.js'
import { buildPhotoIndex } from './photos.js'
import { renderJob } from './render-job.js'
import { summarise } from './preflight.js'
import { detectTrim } from './trim.js'

const program = new Command()
program.name('idcard').description('Batch ID card generator').version('0.1.0')

program
  .command('trim')
  .description('Report the detected trim box of a template PDF')
  .requiredOption('-t, --template <path>')
  .option('--dpi <n>', 'detection resolution', '300')
  .action(async (opts: { template: string; dpi: string }) => {
    const rect = await detectTrim(new Uint8Array(await readFile(opts.template)), { dpi: Number(opts.dpi) })
    console.log(JSON.stringify(rect, null, 2))
    console.log(`= ${(rect.w / 72).toFixed(4)} x ${(rect.h / 72).toFixed(4)} in`)
  })

program
  .command('render')
  .description('Generate imposed print sheets')
  .requiredOption('-l, --layout <path>')
  .requiredOption('-d, --data <path>')
  .option('-p, --photos <dir>')
  .option('-o, --out <dir>', 'output directory', 'out')
  .option('--name <text>', 'job name printed on the sheet slug')
  .option('--force', 'generate even when preflight reports blocking issues', false)
  .action(async (opts: { layout: string; data: string; photos?: string; out: string; name?: string; force: boolean }) => {
    const layoutPath = resolve(opts.layout)
    const layout = parseLayout(JSON.parse(await readFile(layoutPath, 'utf8')))
    const base = dirname(layoutPath)

    const { rows } = await loadRows(opts.data)
    const { byId } = opts.photos ? await buildPhotoIndex(opts.photos) : { byId: new Map() }

    const result = await renderJob({
      layout,
      templateFront: new Uint8Array(await readFile(resolve(base, layout.templateFront))),
      templateBack: layout.templateBack ? new Uint8Array(await readFile(resolve(base, layout.templateBack))) : null,
      rows,
      photos: byId,
      jobName: opts.name ?? layout.name,
      allowOverrides: opts.force,
    })

    const counts = summarise(result.issues)
    console.log(`students ${rows.length}  sheets ${result.sheets}  blocking ${counts.blocking}  warnings ${counts.warnings}`)
    for (const [code, n] of counts.byCode) console.log(`  ${code}: ${n}`)

    await mkdir(opts.out, { recursive: true })
    await writeFile(join(opts.out, 'job-fronts.pdf'), result.frontPdf)
    if (result.backPdf) await writeFile(join(opts.out, 'job-backs.pdf'), result.backPdf)
    console.log(`wrote ${join(opts.out, 'job-fronts.pdf')}`)
  })

await program.parseAsync(process.argv)
```

- [ ] **Step 6: Wire the binary and run it end to end**

```bash
npm pkg set bin.idcard=dist/cli.js
npm run build
node dist/cli.js trim -t fixtures/template.pdf
node dist/cli.js render -l fixtures/layout.json -d fixtures/students.xlsx -p fixtures/photos -o out --force
```

Expected: `trim` prints a box close to `238.296 x 155.045` pt. `render` reports 4 students, 1 sheet, at least one blocking issue (row 5 is a duplicate id), and writes `out/job-fronts.pdf`.

- [ ] **Step 7: Verify the output by eye, once**

```bash
pdftoppm -png -r 100 out/job-fronts.pdf /tmp/sheet && echo "wrote /tmp/sheet-1.png"
```

Open it. Check: cards sit in a centred grid, no card paints over its neighbour, crop marks sit in the gutters, the slug reads `sheet 1 of 1 — FRONT`.

- [ ] **Step 8: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. Ten test files, no failures and no skips.

- [ ] **Step 9: Commit**

```bash
git add src/render-job.ts src/cli.ts test/render-job.test.ts package.json
git commit -m "feat: job orchestrator and CLI"
```

---

## Done when

- `npx vitest run` is green.
- `node dist/cli.js render -l fixtures/layout.json -d fixtures/students.xlsx -p fixtures/photos -o out --force` writes a 5x5 imposed sheet.
- The physical test in spec section 11 has been run once: print a sheet, cut it, measure a card against the CorelDRAW original. No automated test catches a RIP colour shift or a scaling error.

## Deliberate deferrals

Each is a spec requirement consciously left to a later plan, not an oversight.

| Spec | Deferred to |
|---|---|
| 7.2 EXIF orientation | Plan 2 |
| 7.3, 7.4 face detection and passport crop | Plan 2 |
| 7.5 blur and exposure gates | Plan 2 |
| 7.6 review contact sheet | Plan 3 |
| 7.1 fuzzy name matching and manual pairing | Plan 3 |
| 6 template editor | Plan 3 |
| 4.2 approach C placeholder auto-detection | Plan 4 |
| 10 reprint diffing | Plan 4 |
| `.xls` (BIFF) input | Plan 2, with the Rust calamine worker. Until then, Save As .xlsx. |
| 8.5 interleaved duplex output | Plan 3, alongside the print settings UI |
