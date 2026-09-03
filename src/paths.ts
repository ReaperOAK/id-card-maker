/** Forward-slash path helpers that work identically in Node and the webview. */
export function joinPath(...parts: string[]): string {
  const joined = parts.filter((p) => p !== '').join('/')
  return joined.replace(/\/{2,}/g, '/')
}

export function extname(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

export function stem(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return p.slice(0, i)
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/

export function resolvePath(base: string, p: string): string {
  return ABSOLUTE.test(p) ? p : joinPath(base, p)
}
