import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { FileSystem } from './io.js'

export const nodeFs: FileSystem = {
  async readFile(path) {
    const b = await readFile(path)
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  },
  readDir: (path) => readdir(path),
  writeFile: (path, bytes) => writeFile(path, bytes),
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
  async exists(path) {
    try { await stat(path); return true } catch { return false }
  },
}
