import { createStore, useStore } from 'zustand'
import type { FileSystem } from '@engine/io.js'
import { parseLayout, type Layout, type Element } from '@engine/layout.js'
import { loadRows, type Row } from '@engine/data.js'
import { buildPhotoIndex, PhotoDirectoryNotFoundError, type PhotoIndex } from '@engine/photos.js'
import { joinPath, resolvePath } from '@engine/paths.js'

export type Side = 'front' | 'back'

const emptyPhotoIndex = (): PhotoIndex => ({ byId: new Map(), unmatched: [], collisions: new Map() })

export interface ProjectState {
  fs: FileSystem
  dir: string | null
  error: string | null
  /**
   * Non-fatal conditions surfaced from the last successful `open()` (e.g. a
   * missing `photos/` folder). Cleared and repopulated on every `open()`
   * call that reaches the point of writing state; left untouched when
   * `open()` fails, same as every other loaded field.
   */
  notices: string[]
  layout: Layout | null
  templateFront: Uint8Array | null
  templateBack: Uint8Array | null
  headers: string[]
  rows: Row[]
  photos: PhotoIndex | null
  side: Side
  selectedId: string | null
  selectedRow: number
  open(dir: string): Promise<void>
  setLayout(l: Layout): void
  updateElement(id: string, patch: Partial<Element>): void
  addElement(el: Element): void
  removeElement(id: string): void
  select(id: string | null): void
  setSide(s: Side): void
  setSelectedRow(i: number): void
  save(): Promise<void>
}

export function createProjectStore(fs: FileSystem) {
  return createStore<ProjectState>((set, get) => ({
    fs, dir: null, error: null, notices: [], layout: null, templateFront: null, templateBack: null,
    headers: [], rows: [], photos: null, side: 'front', selectedId: null, selectedRow: 0,

    async open(dir) {
      try {
        const layoutPath = joinPath(dir, 'layout.json')
        if (!(await fs.exists(layoutPath))) throw new Error(`No layout.json in ${dir}`)
        const layout = parseLayout(JSON.parse(new TextDecoder().decode(await fs.readFile(layoutPath))))
        const templateFront = await fs.readFile(resolvePath(dir, layout.templateFront))
        const templateBack = layout.templateBack ? await fs.readFile(resolvePath(dir, layout.templateBack)) : null
        const { headers, rows } = await loadRows(joinPath(dir, 'students.xlsx'), fs)

        // A project without a photos/ folder yet is still a project the
        // operator can open and author a layout against — preflight (a
        // later task) is where a missing photo folder actually blocks
        // rendering. Only buildPhotoIndex's "directory does not exist"
        // error is swallowed here; anything else (e.g. a corrupt image)
        // still fails `open` via the outer catch.
        const notices: string[] = []
        let photos: PhotoIndex
        try {
          photos = await buildPhotoIndex(joinPath(dir, 'photos'), fs)
        } catch (e) {
          if (e instanceof PhotoDirectoryNotFoundError) {
            photos = emptyPhotoIndex()
            notices.push(`No photos folder found at ${e.dir} — add one before rendering.`)
          } else {
            throw e
          }
        }

        set({ dir, layout, templateFront, templateBack, headers, rows, photos, error: null, notices, selectedId: null, selectedRow: 0 })
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) })
      }
    },

    setLayout: (layout) => set({ layout }),

    updateElement(id, patch) {
      const l = get().layout; if (!l) return
      const apply = (els: Element[]) => els.map((e) => (e.id === id ? ({ ...e, ...patch } as Element) : e))
      set({ layout: { ...l, front: apply(l.front), back: apply(l.back) } })
    },

    addElement(el) {
      const l = get().layout; if (!l) return
      set({ layout: el.page === 'front' ? { ...l, front: [...l.front, el] } : { ...l, back: [...l.back, el] }, selectedId: el.id })
    },

    removeElement(id) {
      const l = get().layout; if (!l) return
      set({ layout: { ...l, front: l.front.filter((e) => e.id !== id), back: l.back.filter((e) => e.id !== id) }, selectedId: null })
    },

    select: (selectedId) => set({ selectedId }),
    setSide: (side) => set({ side, selectedId: null }),
    setSelectedRow: (selectedRow) => set({ selectedRow }),

    async save() {
      const { dir, layout } = get()
      if (!dir || !layout) return
      await fs.writeFile(joinPath(dir, 'layout.json'), new TextEncoder().encode(JSON.stringify(layout, null, 2)))
    },
  }))
}

export type ProjectStore = ReturnType<typeof createProjectStore>
let singleton: ProjectStore | null = null
export function projectStore(fs: FileSystem): ProjectStore { return (singleton ??= createProjectStore(fs)) }
export function useProject<T>(store: ProjectStore, sel: (s: ProjectState) => T): T { return useStore(store, sel) }
