import { exists, mkdir, readDir, readFile, writeFile } from '@tauri-apps/plugin-fs'
import type { FileSystem } from '@engine/io.js'

export const tauriFs: FileSystem = {
  readFile: (p) => readFile(p),
  readDir: async (p) => (await readDir(p)).map((e) => e.name),
  writeFile: (p, b) => writeFile(p, b),
  mkdir: (p) => mkdir(p, { recursive: true }),
  exists: (p) => exists(p),
}
