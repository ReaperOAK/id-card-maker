# ID Card Maker — Design Spec

**Date:** 2026-09-01
**Status:** Approved, pending implementation plan

---

## 1. Problem

A print shop produces school ID cards. Current workflow, entirely manual in CorelDRAW 12 (2003):

1. Design one card template in CorelDRAW.
2. Copy-paste it 25 times into a 5x5 grid on an 18x12 inch sheet.
3. For each student, copy data from an Excel sheet into the card by hand.
4. Place each student's photo by hand.
5. Print, cut, deliver.

Volume is roughly 1000 students per school. The two dominant time sinks, confirmed with the operator, are **photo handling** and **manual text entry**. CorelDRAW 12's Print Merge cannot merge variable images at all, which is precisely why the existing tooling does not solve this.

## 2. Goals

- Eliminate per-student manual data entry and photo placement.
- Produce print-ready PDFs imposed onto an 18x12 inch sheet, preserving whatever fidelity the source template carries and adding no degradation of its own.
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

- CorelDRAW 12 is 32-bit with a ~2GB memory ceiling. Placing 1000 photos inside the application will crawl and very likely crash mid-job.
- VBA 6 on 2006-era software is a poor development and debugging environment.
- It is unsellable: every customer would need CorelDRAW, and the macro would break across versions.

### 4.2 Template ingestion: PDF background plus overlay (approach A), with placeholder auto-detection layered on (approach C)

The template arrives as a **PDF exported from any design tool**. CorelDRAW 12's SVG export is unreliable (degrades text-on-path, transparency, PowerClip, lens effects); its PDF export embeds fonts and preserves vector geometry for vector objects. PDF is therefore the ingestion format, and the source design tool becomes irrelevant to the application.

**Approach A (base):** the PDF page is the card's static art layer. The user drags text and photo boxes on top of it in the app, binding each to an Excel column.

**Approach C (layered on):** on template load, scan the PDF's text objects for `{{token}}` patterns. Each hit auto-creates a text element with position, font, size and colour lifted from the PDF, pre-bound to the matching Excel column by name. Detection failures fall back to A's manual editing; the data model and editor are identical in both paths.

**Photo frames are proposed automatically.** Image XObject placements are extracted from the content stream and ranked as photo-slot candidates by portrait aspect ratio and area; the user confirms or overrides. Manual drawing remains available when no placed image exists.

**Trim box detection.** The PDF page is not the card. The application computes the artwork's ink bounding box, subtracts half the border stroke width where a border path is identified, and presents the result as the trim rectangle for the user to confirm or type over. All imposition works from the trim box, never the page box.

**Text extraction uses pdf.js, not a hand-written content-stream parser.** Embedded fonts may carry no ToUnicode CMap, in which case glyph codes decode only by reverse-engineering the embedded CFF program. pdf.js `getTextContent()` already does this; `getOperatorList()` supplies fill colour. Hand-parsing the content stream would work on some templates and silently fail on others.

### 4.3 Verification against a real template

A production template (`template.pdf`, Adarsha Balika Vidyalaya) was measured on 2026-09-01. Full measurements are in Appendix A. Outcome:

| Assumption | Result |
|---|---|
| CorelDRAW 13 | Corel 12. PDF 1.3, Corel PDF Engine 1.0.0.458 |
| Fonts embedded | Confirmed. Five faces, CID Type 0C, Identity-H |
| PDF export preserves vectors | Partly. Logo and signature are vector; header band and two panels are 200dpi JPEGs |
| Page box equals card | False. Page 288x216pt, artwork 238.30x155.05pt, centred |
| Template is CMYK | False. RGB throughout, with no pure black anywhere |
| 5x5 on an 18x12 sheet | Confirmed against the trim size |

The two false assumptions produced the trim-box requirement above and the colour rule in 8.4. The partial-vector result means output quality for this template is capped at 200dpi in its raster regions, matching current production rather than improving on it. This must not be described as lossless.

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

**PDF assembly:** pdf-lib's `embedPage` embeds the card PDF as a **single reusable XObject**, referenced once per card position. The card art is stored once, not 1000 times, and passes through byte-identical: vector objects stay vector, raster objects keep their original resolution, and nothing is re-encoded. Output stays small. Text and photos draw as a thin overlay on top of each stamp.

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

**Known setup risk:** overlay text requires the actual font file on disk to embed. Fonts bundled with CorelDRAW must be located as `.ttf`/`.otf`. This is the most likely first-run obstacle.

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
  color: Colour          // device colour, see 8.4
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  fit: 'shrink' | 'clip' | 'wrap'
  minSize: number
  lineHeight: number
  firstLineIndent: number   // points; 0 for most fields
}

type Colour =
  | { space: 'rgb';  r: number; g: number; b: number }        // each 0..1
  | { space: 'cmyk'; c: number; m: number; y: number; k: number }
  | { space: 'gray'; k: number }
```

**`fit: 'shrink'` is a correctness feature, not a convenience.** "Om Jha" and "Lakshmi Priyadarshini Venkataraghavan" occupy the same box. Behaviour: shrink toward `minSize` to fit the box width; below that, wrap; if it still does not fit, **fail the card into preflight**. Silent overflow on card 700 of 1000 is discovered only after cutting.

**`firstLineIndent` exists for wrapped fields that begin beside their label.** In the reference template the address runs two lines: line one starts after "Address :" at x=63.37, line two returns to the left margin at x=26.77. This is one text box of width 162.59 with a 36.60pt first-line indent, not two hand-split fields. Splitting it manually would push the wrap decision onto the operator for every student.

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
| Resolution | cropped region measured against the template's target DPI (see below) |
| Blur | variance-of-Laplacian below threshold |
| Faces found | 0 -> manual crop required; 2+ -> largest chosen, flagged |
| Exposure | clipped highlights or crushed shadows |

**DPI thresholds are calibrated to real production, not to the 300dpi ideal.** The reference template's photo frame is 0.664 x 0.869 inches and its embedded photo is 132x172px, an effective 199ppi. A flat 300dpi gate would flag every photo currently in use and train the operator to ignore the warning, which is worse than having no gate.

Rules: warn below 300dpi, block below 150dpi, with the target DPI a per-template setting defaulting to 200. A warning nobody can act on is noise, and noise is what makes real warnings invisible.

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

Default gutter 3mm with crop marks placed in the gutter: two cuts per line, the sliver discarded, no neighbour artwork contaminating a card edge. The reference template affords this comfortably, with 104.5pt of horizontal and 88.8pt of vertical slack after a 5x5 layout (Appendix A). Other card sizes yield different slack, so the solver reduces the gutter toward the butt-cut case when a size does not leave room for the default. Butt-cut (gutter 0) remains selectable, with its trade-off stated in the UI.

**Bleed defaults to zero, deliberately.** The operator cuts strictly on the printed border and leaves no surrounding space. The reference template carries no bleed, so any outward drift of the blade leaves a white sliver on the card edge. This is the established practice of a shop that has run this workflow for years, and the tool follows it rather than fighting it. Bleed is a per-template setting, available for operators who want it, defaulting to 0.

Because there is no bleed, a positive gutter is the safer default: each cut is aimed independently at one card's own border, so blade drift damages one edge rather than two. Butt-cut halves the number of cuts and doubles the blast radius of a drifting blade.

**Sheet slug**, printed outside the trim area: job name, `Sheet 7 of 40`, `FRONT` or `BACK`, timestamp. On a 40-sheet duplex job, unlabelled sheets get mixed up, and one misplaced back sheet ruins 25 cards.

### 8.4 Colour space

The template's colour space is whatever the source tool produced and must not be assumed. The reference template is **RGB throughout**, with no CMYK operator and no pure black anywhere; its labels are navy `rgb(0.16, 0.09, 0.44)`. An earlier assumption that CorelDRAW output would be CMYK was wrong.

Rules:

1. Overlay colour defaults to the colour detected on the corresponding placeholder text, in its original space. Matching the template beats imposing a house convention.
2. Where a template does use CMYK, pure-black overlay text draws **K-only** (`cmyk(0, 0, 0, 1)`), never `rgb(0, 0, 0)`. RGB black converts at the RIP into four-colour rich black: muddy, with registration fringing on small text. This case does not arise in the reference template, but will arise the first time a template is exported from a print-oriented tool.
3. `TextStyle.color` therefore carries a tagged `Colour`, not a hex string, so the space survives the round trip.

Photos remain RGB JPEG; RIP conversion handles those acceptably.

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
! Photo below target DPI         14   warn
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
| Photo below target DPI | warn | shows actual vs target; blocks below 150dpi |
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


---

## Appendix A: Reference template measurements

Source: `template.pdf`, Adarsha Balika Vidyalaya school ID. Measured 2026-09-01 with poppler and Ghostscript. These numbers are the fixture for the golden PDF tests in section 11.

**Document**

| Property | Value |
|---|---|
| Producer | Corel PDF Engine 1.0.0.458, CorelDRAW 12 |
| PDF version | 1.3 |
| Page box | 288 x 216pt (4.000 x 3.000in) |
| Ink bounding box | 24.854, 30.477 to 263.150, 185.523 (PDF origin) |
| Trim size | 238.296 x 155.045pt = 3.3097 x 2.1534in |
| Card position | centred on the page: 24.85pt left/right, 30.48pt top/bottom |
| Colour space | RGB only |
| Bleed | none |

**Fonts** — all embedded, CID Type 0C, Identity-H, no ToUnicode CMap.

| Face | Role | Size |
|---|---|---|
| TimesNewRomanPSMT,Bold | field labels | 9pt |
| ArialMT | field values | 9pt |
| TimesNewRomanPSMT | address block, e-mail | 9-10pt |
| TimesNewRomanPSMT,BoldItalic | "Estd : 1969" | 8.741pt |
| MonotypeCorsiva,Italic | school name | 18pt |

Both value and label faces are Windows stock, so the font-availability risk noted in section 5 is low for this template.

**Field boxes** — page coordinates, top-left origin, points. Subtract (24.85, 30.48) for trim-relative coordinates.

| Field | x | y | width | operator's budget |
|---|---:|---:|---:|---:|
| ID No. | 59.77 | 94.09 | 58.50 | 13 chars |
| Name | 59.01 | 104.65 | 112.50 | 25 chars |
| Guardian's Name | 102.69 | 115.21 | 108.00 | 24 chars |
| Class | 59.27 | 125.76 | 18.00 | 4 chars |
| R.No. | 118.02 | 125.76 | 13.50 | 3 chars |
| DOB | 60.52 | 136.32 | 45.00 | 10 chars |
| Blood Group | 169.87 | 136.32 | 13.50 | 3 chars |
| Contact No. | 80.26 | 146.87 | 54.00 | 12 chars |
| Address | 26.77 | 157.43 | 162.59 | 28 + 27 chars, 2 lines, indent 36.60 |

The operator expressed each budget as a run of `x` characters in the template. Every `x` measures exactly 4.50pt (Arial 9pt, 0.5em), and line advance is 10.555pt.

**The budget is points, not characters.** Lowercase `x` sits at roughly the average glyph width, so 25 of them approximate 25 mixed-case characters. Capitals in Arial average about 0.68em, so the Name box holds only about 18 upper-case characters. Schools that submit names in capitals will exercise shrink-to-fit heavily, and the preflight warning threshold should be set with that in mind.

**Placed images**

| Object | x | y | w | h | aspect | role |
|---|---:|---:|---:|---:|---:|---|
| Im26 | 71.47 | 11.50 | 191.57 | 58.23 | 3.290 | header band, 200ppi JPEG |
| Im27 | 167.77 | 59.13 | 94.18 | 29.11 | 3.235 | panel, 200ppi JPEG |
| Im46 | 215.26 | 92.23 | 47.78 | 62.53 | 0.764 | **photo slot** |

`Im46` is the photo frame: 0.664 x 0.869in, holding a 132x172px image at an effective 199ppi. Its portrait aspect and modest area are what the photo-slot detector in 4.2 ranks on.

**Sheet fit, 18 x 12in (1296 x 864pt)**

| Orientation | Columns | Rows | Cards | Slack |
|---|---:|---:|---:|---|
| As designed | 5 | 5 | **25** | 104.5pt horizontal, 88.8pt vertical |
| Rotated 90 degrees | 8 | 3 | 24 | 55.6pt horizontal, 149.1pt vertical |

The as-designed orientation wins and reproduces the operator's existing 5x5 layout exactly. The solver still evaluates both, because for other card sizes rotation can win outright.

With a 3mm gutter: side margins 0.49in, top and bottom margins 0.38in. Comfortable.

**Privacy note:** the reference template contains a real student's photograph. It must be replaced with a synthetic placeholder before this file is committed to any repository or shipped as a sample.
