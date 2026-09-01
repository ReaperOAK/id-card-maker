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
