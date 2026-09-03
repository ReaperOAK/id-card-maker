import { normaliseId } from './data.js'
import type { FileSystem } from './io.js'
import { extname, joinPath, stem } from './paths.js'
import type { Rect } from './units.js'

export interface PhotoEntry {
  path: string
  /** Normalised filename stem, used to match the id column. */
  id: string
  width: number
  height: number
}

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png'])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Read IHDR width/height, after verifying the PNG signature and first chunk type. */
function pngSize(b: Buffer, path: string): { width: number; height: number } {
  const truncatedOrNotPng = (): Error =>
    new Error(`pngSize: ${path} is truncated or not a PNG`)
  if (b.length < 24) throw truncatedOrNotPng()
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) throw truncatedOrNotPng()
  if (b.toString('ascii', 12, 16) !== 'IHDR') throw truncatedOrNotPng()
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

export interface PhotoIndex {
  byId: Map<string, PhotoEntry>
  unmatched: PhotoEntry[]
  /** Normalised ids claimed by more than one file, mapped to every path that claimed them. */
  collisions: Map<string, string[]>
}

/**
 * Thrown by `buildPhotoIndex` when `dir` does not exist. Kept distinct from
 * other `readdir` failures (and from a legitimately empty directory, which is
 * not an error) so a caller can tell "typo'd path" apart from "no photos yet"
 * instead of both silently producing an empty index.
 */
export class PhotoDirectoryNotFoundError extends Error {
  constructor(public readonly dir: string) {
    super(`Photo directory not found: ${dir}`)
    this.name = 'PhotoDirectoryNotFoundError'
  }
}

export async function buildPhotoIndex(dir: string, fs: FileSystem): Promise<PhotoIndex> {
  const byId = new Map<string, PhotoEntry>()
  const unmatched: PhotoEntry[] = []
  const collisions = new Map<string, string[]>()

  // Checked explicitly, rather than catching a readDir rejection, so the
  // Tauri implementation can behave identically without needing to match
  // Node's ENOENT error code. A legitimate empty directory still exists and
  // falls through to the loop below with an empty `names`, producing a
  // genuinely empty index rather than an error.
  if (!(await fs.exists(dir))) {
    throw new PhotoDirectoryNotFoundError(dir)
  }

  // Sort so "first file wins on collision" is deterministic rather than dependent
  // on filesystem readDir order.
  const names = [...(await fs.readDir(dir))].sort()

  for (const name of names) {
    const ext = extname(name)
    if (!SUPPORTED.has(ext)) continue
    const path = joinPath(dir, name)
    const bytes = await fs.readFile(path)
    // pngSize/jpegSize use Buffer-specific byte-reading methods; wrap the
    // FileSystem's plain Uint8Array in a zero-copy Buffer view to reach them.
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = ext === '.png' ? pngSize(buf, path) : jpegSize(buf, path)
    const id = normaliseId(stem(name))
    const entry: PhotoEntry = { path, id, ...size }
    if (id === '') {
      unmatched.push(entry)
      continue
    }
    const existing = byId.get(id)
    if (existing === undefined) {
      byId.set(id, entry)
      continue
    }
    const claimants = collisions.get(id)
    if (claimants === undefined) collisions.set(id, [existing.path, path])
    else claimants.push(path)
  }

  return { byId, unmatched, collisions }
}

/**
 * Printed resolution of a photo placed in `box`, in dots per inch.
 * The more constrained axis governs, because cover-fit crops the other one.
 */
export function effectiveDpi(entry: Pick<PhotoEntry, 'width' | 'height'>, box: Rect): number {
  // A non-positive box dimension means the photo cannot be placed at all. Without this
  // guard both axes evaluate to Infinity, which passes every ">=" resolution gate instead
  // of failing all of them.
  if (box.w <= 0 || box.h <= 0) return 0
  const across = entry.width / (box.w / 72)
  const down = entry.height / (box.h / 72)
  return Math.min(across, down)
}
