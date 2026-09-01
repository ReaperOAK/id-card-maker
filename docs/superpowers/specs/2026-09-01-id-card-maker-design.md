# ID Card Maker — Design Spec

**Date:** 2026-09-01
**Status:** Approved, pending implementation plan

---

## 1. Problem

A print shop produces school ID cards. Current workflow, entirely manual in CorelDRAW X3 (v13, 2006):

1. Design one card template in CorelDRAW.
2. Copy-paste it 25 times into a 5x5 grid on an 18x12 inch sheet.
3. For each student, copy data from an Excel sheet into the card by hand.
4. Place each student's photo by hand.
5. Print, cut, deliver.

Volume is roughly 1000 students per school. The two dominant time sinks, confirmed with the operator, are **photo handling** and **manual text entry**. CorelDRAW X3's Print Merge cannot merge variable images at all, which is precisely why the existing tooling does not solve this.

## 2. Goals

- Eliminate per-student manual data entry and photo placement.
- Produce print-ready, vector-quality PDFs imposed onto an 18x12 inch sheet.
- Support duplex cards with correct front/back registration.
- Work with templates the developer has never seen, so the tool is sellable beyond the first shop.
- Handle 1000 students, duplex, in under 3 minutes end to end.

## 3. Non-goals for v1

Deliberately excluded. The architecture leaves seams for these; the features are not built.

- QR codes and barcodes
- Google Sheets or database data sources
- Conditional/logic fields in templates
- Individual per-student PDF export
- Multi-template libraries and template marketplace
- Licensing, activation, or any SaaS layer
- A general-purpose design editor. The tool does not compete with CorelDRAW.

## 4. Key decisions

### 4.1 Rejected: a CorelDRAW extension

A VBA/GMS macro inside CorelDRAW was considered and rejected.

- CorelDRAW X3 is 32-bit with a ~2GB memory ceiling. Placing 1000 photos inside the application will crawl and very likely crash mid-job.
- VBA 6 on 2006-era software is a poor development and debugging environment.
- It is unsellable: every customer would need CorelDRAW, and the macro would break across versions.

### 4.2 Template ingestion: PDF background plus overlay (approach A), with placeholder auto-detection layered on (approach C)

The template arrives as a **PDF exported from any design tool**. CorelDRAW X3's SVG export is unreliable (SVG 1.1, degrades text-on-path, transparency, PowerClip, lens effects); its PDF export preserves true vectors and embeds fonts. PDF is therefore the ingestion format, and the source design tool becomes irrelevant to the application.

**Approach A (base):** the PDF page is the card's static art layer. The user drags text and photo boxes on top of it in the app, binding each to an Excel column.

**Approach C (layered on):** on template load, scan the PDF's text objects for `{{token}}` patterns. Each hit auto-creates a text element with position, font, size and colour lifted from the PDF, pre-bound to the matching Excel column by name. Detection failures fall back to A's manual editing; the data model and editor are identical in both paths.

Photo frames are always drawn manually. PDF has no reliable way to mark a rectangle as a photo slot.

**Verification required before implementation:** export one card from CorelDRAW X3 as PDF and confirm vectors, embedded fonts, and correct page dimensions. The X3 behaviour described here is from knowledge of the product, not tested.

## 5. Architecture

```
+------------------- React / TS (UI) ---------------------+
|  template editor - field mapping - preflight - preview  |
+------------------------+--------------------------------+
                         | Tauri IPC
+------------------------+--------------------------------+
|                    Rust (workers)                       |
|  xlsx parse (calamine) - photo pipeline (image + ort)   |
|  face detect (YuNet ONNX) - crop - resize - encode      |
+------------------------+--------------------------------+
                         |
+------------------------+--------------------------------+
|              PDF assembly (pdf-lib + fontkit)           |
|   embed card art ONCE -> stamp Nx -> overlay per-card   |
+---------------------------------------------------------+
```

**Shell:** Tauri v2 + React + TypeScript + Tailwind. Windows-first desktop.

Rejected alternatives: a web app (1000 local photos should not cross a network), and Electron (ships a browser runtime that provides no value here).

**PDF assembly:** pdf-lib's `embedPage` embeds the card PDF as a **single reusable XObject**, referenced once per card position. The vector art is stored once, not 1000 times. Output stays small and stays vector. Text and photos draw as a thin overlay on top of each stamp.

**Excel:** `calamine` in Rust, not SheetJS. SheetJS's npm package is stale and its distribution has moved off the registry, which is unwanted supply-chain risk in a product intended for sale. calamine reads both `.xlsx` and `.xls`; legacy `.xls` support matters for this customer base.

**Photos:** `image` crate plus YuNet face detection via ONNX (`ort`). YuNet is ~100KB, CPU-only, ships inside the application. No Python, no OpenCV install, no network access.

**Storage: a project is a folder on disk.**

```
Sunrise School 2026/
  template-front.pdf
  template-back.pdf      (optional)
  layout.json
  students.xlsx
  photos/
  output/
```

One app-level `library.json` records each school's template path, field mapping, card size and photo-naming convention, so a returning school is a matter of dropping in a new spreadsheet. No database: a folder can be copied to a pendrive and backed up trivially, and SQLite would buy query power this workload does not need.

**Known setup risk:** overlay text requires the actual font file on disk to embed. Fonts bundled with CorelDRAW X3 must be located as `.ttf`/`.otf`. This is the most likely first-run obstacle.

## 6. Template editor and layout model

The template PDF is rasterized once with pdf.js as a **screen backdrop only**. All output uses the original vector page. The preview raster must never enter the output path.

```
+--------------+----------------------------+--------------+
|  Fields      |                            |  Properties  |
|              |    +------------------+    |              |
| [ ] name     |    |   photo frame    |    | Bind: Name   |
| [ ] roll     |    |                  |    | Font: Arial  |
| [ ] class    |    |  [ name ]        |    | Size: 9pt    |
| [ ] father   |    |  [ roll ]        |    | Align: ctr   |
| [x] photo    |    +------------------+    | Fit: shrink  |
|              |      card @ actual size    | Case: UPPER  |
| + add field  |                            |              |
+--------------+----------------------------+--------------+
        < Front | Back >       preview with: [ Rahul K. ]
```

Live preview binds a real student row while editing, so the operator sees the actual longest name in the actual box.

**Coordinate system.** pdf-lib's origin is bottom-left; UI frameworks are top-left. Internal storage is **points, top-left origin**, flipped exactly once inside the renderer, in a single unit-tested conversion function. This is a known bug factory and is isolated deliberately.

**Element model:**

```ts
type Element =
  | { kind: 'text';   id: string; page: 'front'|'back'; box: Rect; bind: Binding; style: TextStyle }
  | { kind: 'photo';  id: string; page: 'front'|'back'; box: Rect; fit: 'cover'|'contain'; radius?: number }
  | { kind: 'static'; id: string; page: 'front'|'back'; box: Rect; text: string; style: TextStyle }

type Binding = {
  column: string
  transform?: 'upper' | 'title' | 'date'
  format?: string        // e.g. 'DD/MM/YYYY' when transform is 'date'
  fallback?: string      // used when the cell is empty; absence makes the field required
}

type TextStyle = {
  fontFile: string
  size: number
  color: CMYK            // CMYK, not hex. See 8.4.
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  fit: 'shrink' | 'clip' | 'wrap'
  minSize: number
  lineHeight: number
}

type CMYK = { c: number; m: number; y: number; k: number }   // each 0..1
```

**`fit: 'shrink'` is a correctness feature, not a convenience.** "Om Jha" and "Lakshmi Priyadarshini Venkataraghavan" occupy the same box. Behaviour: shrink toward `minSize` to fit the box width; below that, wrap; if it still does not fit, **fail the card into preflight**. Silent overflow on card 700 of 1000 is discovered only after cutting.

**Back side:** a second tab with its own PDF and its own elements. Front-only schools leave it empty.

## 7. Photo pipeline

Six stages, all in Rust, all cached by content hash so re-runs only process new or changed photos.

**7.1 Match.** Filename stem against the ID column, normalized: trim, lowercase, strip non-alphanumerics, compare leading-zero-insensitively (`0101.jpg` matches `101`). Excel strips leading zeros from roll numbers routinely, so this case is the norm rather than the exception. Unmatched files fall to a fuzzy pass (token overlap on the name column), then to a manual pairing grid: unmatched photos on one side, photo-less students on the other. With ID-named files this grid should be nearly empty.

**7.2 EXIF orientation.** Applied before anything else. Phone photos carry rotation in metadata; ignoring it produces a sheet of sideways faces.

**7.3 Face detection.** YuNet ONNX returns a face bounding box plus five landmarks (eyes, nose, mouth corners).

**7.4 Passport crop**, derived from landmarks rather than the raw box:

- eye line at ~40% of frame height from the top
- headroom above the crown ~10% of frame height
- face width ~55% of frame width
- final aspect forced to the template's photo frame

Clamped to image bounds. If the head cannot be framed without running out of pixels, the card is flagged into preflight rather than fudged.

**7.5 Quality gates:**

| Check | Rule |
|---|---|
| Resolution | cropped region must reach >=300dpi at printed size |
| Blur | variance-of-Laplacian below threshold |
| Faces found | 0 -> manual crop required; 2+ -> largest chosen, flagged |
| Exposure | clipped highlights or crushed shadows |

The resolution gate is the sharpest. A 0.9-inch photo frame at 300dpi needs >=270px in the **cropped** region, which a wide classroom photo cropped to one face will not deliver.

**7.6 Review contact sheet.** Every crop shown in a grid, flagged items sorted first. Drag to re-centre, scroll to zoom. The pipeline's purpose is to make 950 crops correct so the operator only touches 50; it is not to remove human review.

**Fallback with no face detected:** centre-crop to frame aspect and flag for review. Never silently skip the card, never leave a slot blank without reporting it.

## 8. Imposition, duplex and cutting

### 8.1 Grid

Computed, never hardcoded. Given sheet 18x12 inches, card W x H, and gutter g, solve for the maximum columns and rows that fit, then centre the block on the sheet.

**Margins must be symmetric** — equal left/right, equal top/bottom. This is a correctness requirement for duplex registration, not an aesthetic preference.

### 8.2 Duplex mirroring

Fronts are printed, the stack is flipped, backs are printed. A long-edge flip reverses column order:

```
FRONT sheet              BACK sheet (column-mirrored)
+-----------------+      +-----------------+
| 1  2  3  4  5   |      | 5  4  3  2  1   |
| 6  7  8  9  10  |      | 10 9  8  7  6   |
| 11 12 13 14 15  | ---> | 15 14 13 12 11  |
| 16 17 18 19 20  | flip | 20 19 18 17 16  |
| 21 22 23 24 25  |      | 25 24 23 22 21  |
+-----------------+      +-----------------+
```

Row order is unchanged. A short-edge flip mirrors rows instead of columns, so flip axis is a setting defaulting to long-edge. With symmetric margins the mirror registers exactly; with asymmetric margins every card is offset by the margin difference on every sheet.

### 8.3 Gutter and marks

Default gutter 3mm with crop marks placed in the gutter: two cuts per line, the sliver discarded, no neighbour bleed contaminating a card edge. The current school's geometry affords this: five CR80-width cards (3.375in each) span 16.875 inches of the 18-inch sheet, leaving 1.125 inches for margins and four gutters. Other card sizes yield different slack, so the solver reduces the gutter toward the butt-cut case when a size does not leave room for the default. Butt-cut (gutter 0) remains selectable, with its trade-off stated in the UI.

**Sheet slug**, printed outside the trim area: job name, `Sheet 7 of 40`, `FRONT` or `BACK`, timestamp. On a 40-sheet duplex job, unlabelled sheets get mixed up, and one misplaced back sheet ruins 25 cards.

### 8.4 Colour space

The template PDF from CorelDRAW is likely CMYK and passes through untouched inside the embedded XObject. Overlay text, however, would default to RGB, and `rgb(0,0,0)` converts at the RIP to four-colour rich black: muddy, with registration fringing on small text.

Overlay text therefore draws **K-only**, via pdf-lib's `cmyk(0, 0, 0, 1)`. `TextStyle.color` carries CMYK rather than hex for this reason. Photos remain RGB JPEG; RIP conversion handles those acceptably.

### 8.5 Output

Two files: `job-fronts.pdf` and `job-backs.pdf`. Print all fronts, flip the stack once, print all backs. Interleaved single-file output is available as an option but is wrong as a default for hand-fed 18x12 sheets.

Partial final sheets are populated row-major and left blank in the remaining positions, so the same cutting setup applies.

## 9. Preflight and failure handling

**Governing rule: nothing degrades silently.** Every failure either blocks generation or surfaces as a warning requiring dismissal.

```
Students in sheet              1000
Cards ready                     961
------------------------------------
X Missing photo                  12   BLOCK
X Duplicate roll number           2   BLOCK
X Required field empty            5   BLOCK
! Photo below 300dpi             14   warn
! Name shrunk past 6pt            6   warn
! Face not detected               9   warn
------------------------------------                    [ Generate ]  blocked
```

Every row drills into the exact student list. Blocking items must be resolved or explicitly overridden; overrides are recorded in the job.

| Failure | Class | Behaviour |
|---|---|---|
| Photo file missing | block | list students; override prints placeholder |
| Duplicate ID | block | otherwise two cards for one student, or a swapped photo |
| Required bound field empty | block | unless the binding defines a `fallback` |
| Photo below print DPI | warn | shows actual vs required |
| Text will not fit at `minSize` | warn | preview shows the offending card |
| Font file not found | block | cannot embed, cannot render |
| Template PDF encrypted or empty | block | fails at load, not at generate |
| Back card size != front | block | duplex would never register |

## 10. Reprints

Every generated card records its source row and a content hash. When corrections arrive, the operator fixes the spreadsheet and the app diffs against the previous run: changed rows are identified, and a reprint sheet is generated containing only those cards, positioned on the normal grid so the existing cutting setup applies.

Without this, a 14-card correction means re-running 40 sheets or hand-assembling a one-off in CorelDRAW, which is the workflow being eliminated.

## 11. Testing

- **Golden PDF tests.** Fixture job -> generate -> rasterize with pdfium -> pixel-diff against a committed reference. This is the primary safety net: it catches coordinate flips, mirror regressions, and text placement drift.
- **Property tests** on geometry: the grid solver never overlaps cards and never exceeds the sheet; margins are always symmetric; `mirror(mirror(grid)) == grid`; top-left/bottom-left conversion round-trips.
- **Unit tests** on ID normalization including the leading-zero case, shrink-to-fit, EXIF orientation, date formatting.
- **Photo fixtures**, deliberately adversarial: sideways phone photo, group shot, blurry, no face, two faces, sub-threshold resolution. Each must land in the correct preflight bucket.
- **One manual physical test** before the first production job: print a sheet, cut it, measure against the CorelDRAW original. No automated test catches a RIP colour shift or a scaling error.

## 12. Performance target

1000 students, duplex, end to end in under 3 minutes on the operator's Windows machine. Photo processing dominates; PDF assembly should complete in seconds.
