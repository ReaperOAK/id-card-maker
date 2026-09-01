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
