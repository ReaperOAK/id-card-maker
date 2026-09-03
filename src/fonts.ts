import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'
import type { FileSystem } from './io.js'

/** Loads font files once per document and hands out embedded pdf-lib fonts by id. */
export class FontRegistry {
  private constructor(private readonly fonts: Map<string, PDFFont>) {}

  static async load(ids: Record<string, string>, doc: PDFDocument, fs: FileSystem): Promise<FontRegistry> {
    doc.registerFontkit(fontkit)
    const fonts = new Map<string, PDFFont>()
    for (const [id, path] of Object.entries(ids)) {
      let bytes: Uint8Array
      try {
        bytes = await fs.readFile(path)
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
