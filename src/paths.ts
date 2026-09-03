/** Forward-slash path helpers that work identically in Node and the webview. */

/**
 * Windows paths (from node:path's `resolve` in cli.ts, and from Tauri's
 * directory dialog) arrive with backslash separators. Every function below
 * normalises to forward slashes before doing any splitting so a Windows
 * input never silently produces a wrong-but-plausible result (e.g. dirname
 * collapsing to '.').
 */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .map(toForwardSlashes)
    .filter((p) => p !== '')
    .join('/')
  return joined.replace(/\/{2,}/g, '/')
}

export function extname(p: string): string {
  const norm = toForwardSlashes(p)
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function stem(p: string): string {
  const norm = toForwardSlashes(p)
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

export function dirname(p: string): string {
  const norm = toForwardSlashes(p)
  const i = norm.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return norm.slice(0, i)
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/

export function resolvePath(base: string, p: string): string {
  return ABSOLUTE.test(p) ? toForwardSlashes(p) : joinPath(base, p)
}
