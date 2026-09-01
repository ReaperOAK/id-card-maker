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
