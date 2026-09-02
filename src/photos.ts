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
function jpegSize(b: Buffer, path: string): { width: number; height: number } {
  let i = 2
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]!
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (i + 3 >= b.length) break
    const len = b.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 8 >= b.length) break
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (len < 2) break
    i += 2 + len
  }
  throw new Error(`jpegSize: no SOF marker found in ${path} (truncated or not a JPEG)`)
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
    const size = ext === '.png' ? pngSize(bytes) : jpegSize(bytes, path)
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
