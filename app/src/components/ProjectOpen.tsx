import { open } from '@tauri-apps/plugin-dialog'
import type { ProjectStore } from '../state/project'
import { useProject } from '../state/project'

export function ProjectOpen({ store }: { store: ProjectStore }) {
  const error = useProject(store, (s) => s.error)
  const dir = useProject(store, (s) => s.dir)
  return (
    <div className="p-6 space-y-3">
      <button
        className="rounded bg-blue-600 px-4 py-2 text-white"
        onClick={async () => {
          const picked = await open({ directory: true, multiple: false })
          if (typeof picked === 'string') await store.getState().open(picked)
        }}
      >
        Open project folder…
      </button>
      {dir && <div className="text-sm text-gray-600">{dir}</div>}
      {error && <div className="rounded bg-red-50 p-3 text-red-800">{error}</div>}
    </div>
  )
}
