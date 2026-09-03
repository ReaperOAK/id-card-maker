import { projectStore, useProject } from './state/project'
import { tauriFs } from './tauri-io'
import { ProjectOpen } from './components/ProjectOpen'

const store = projectStore(tauriFs)

export default function App() {
  const layout = useProject(store, (s) => s.layout)
  const rows = useProject(store, (s) => s.rows)

  if (!layout) {
    return <ProjectOpen store={store} />
  }

  return (
    <main className="p-6 font-sans text-lg">
      {layout.name} — {rows.length} rows
    </main>
  )
}
