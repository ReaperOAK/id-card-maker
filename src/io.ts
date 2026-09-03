/**
 * The only file-system surface the engine uses. Node implements it for the
 * CLI and tests; the desktop app implements it over Tauri's fs plugin. The
 * engine itself never imports node:fs.
 */
export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>
  /** Entry names only, not paths. Rejects if the directory does not exist. */
  readDir(path: string): Promise<string[]>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  /** Recursive; succeeds if the directory already exists. */
  mkdir(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}
