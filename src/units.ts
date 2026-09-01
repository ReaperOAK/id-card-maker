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

/**
 * Inverse of toPdfRect. Involutive: applying both returns the original, so
 * this delegates to toPdfRect rather than repeating its body.
 */
export function fromPdfRect(r: Rect, pageHeight: number): Rect {
  return toPdfRect(r, pageHeight)
}
