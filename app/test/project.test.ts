// @vitest-environment node
//
// This file has no DOM dependency, and exceljs resolves its `browser` field
// under jsdom (vitest applies browser conditions for the jsdom environment),
// which breaks `wb.xlsx.load`. Forcing the node environment for this file
// avoids that without touching the app-wide jsdom default other tests need.
import { describe, expect, it } from 'vitest'
import { createProjectStore } from '../src/state/project'
import type { FileSystem } from '@engine/io.js'
import { readFileSync } from 'node:fs'

function memFs(files: Record<string, Uint8Array>): FileSystem {
  return {
    readFile: async (p) => { const f = files[p]; if (!f) throw new Error(`ENOENT ${p}`); return f },
    readDir: async (p) => Object.keys(files).filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1)).filter((k) => !k.includes('/')),
    writeFile: async (p, b) => { files[p] = b },
    mkdir: async () => {},
    exists: async (p) => p in files || Object.keys(files).some((k) => k.startsWith(p + '/')),
  }
}

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)))

describe('project store', () => {
  it('opens a folder, parsing layout, rows, photos and the template', async () => {
    const fs = memFs({
      '/p/layout.json': new TextEncoder().encode(readFileSync(new URL('../../fixtures/layout.json', import.meta.url), 'utf8')),
      '/p/template.pdf': fixture('template.pdf'),
      '/p/students.xlsx': fixture('students.xlsx'),
      '/p/photos/101.jpg': fixture('photos/101.jpg'),
    })
    const store = createProjectStore(fs)
    await store.getState().open('/p')
    const s = store.getState()
    expect(s.dir).toBe('/p')
    expect(s.layout?.name).toBe('Adarsha Balika Vidyalaya')
    expect(s.rows).toHaveLength(4)
    expect(s.headers).toContain('Name')
    expect(s.photos?.byId.has('101')).toBe(true)
    expect(s.templateFront?.byteLength).toBeGreaterThan(100)
    expect(s.error).toBeNull()
  })

  it('reports a missing layout as an error rather than throwing', async () => {
    const store = createProjectStore(memFs({}))
    await store.getState().open('/empty')
    expect(store.getState().error).toMatch(/layout\.json/)
  })

  it('save() writes the current layout back as JSON', async () => {
    const files: Record<string, Uint8Array> = {
      '/p/layout.json': new TextEncoder().encode(readFileSync(new URL('../../fixtures/layout.json', import.meta.url), 'utf8')),
      '/p/template.pdf': fixture('template.pdf'),
      '/p/students.xlsx': fixture('students.xlsx'),
    }
    const store = createProjectStore(memFs(files))
    await store.getState().open('/p')
    store.getState().setLayout({ ...store.getState().layout!, name: 'Renamed' })
    await store.getState().save()
    expect(JSON.parse(new TextDecoder().decode(files['/p/layout.json']!)).name).toBe('Renamed')
  })

  it('opens a folder with no photos/ directory, succeeding with an empty photo index and a notice', async () => {
    const files: Record<string, Uint8Array> = {
      '/p/layout.json': new TextEncoder().encode(readFileSync(new URL('../../fixtures/layout.json', import.meta.url), 'utf8')),
      '/p/template.pdf': fixture('template.pdf'),
      '/p/students.xlsx': fixture('students.xlsx'),
    }
    const store = createProjectStore(memFs(files))
    await store.getState().open('/p')
    const s = store.getState()
    expect(s.error).toBeNull()
    expect(s.layout?.name).toBe('Adarsha Balika Vidyalaya')
    expect(s.rows).toHaveLength(4)
    expect(s.photos?.byId.size).toBe(0)
    expect(s.notices.some((n) => /photos/i.test(n))).toBe(true)
  })
})
