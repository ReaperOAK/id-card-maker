import { useEffect, useState } from 'react'
import { inches } from '@engine/units.js'
import { solveGrid } from '@engine/grid.js'

export default function App() {
  const [msg, setMsg] = useState('…')
  useEffect(() => {
    const g = solveGrid({ sheet: { w: inches(18), h: inches(12) }, card: { w: 238.296, h: 155.045 }, gutter: 8.5, minMargin: 14 })
    setMsg(`engine ok — reference grid ${g.cols}x${g.rows}`)
  }, [])
  return <main className="p-6 font-sans text-lg">{msg}</main>
}
