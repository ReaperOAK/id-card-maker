import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLayout } from '../src/layout.js'

const fixture = () => JSON.parse(readFileSync('fixtures/layout.json', 'utf8'))

describe('parseLayout', () => {
  it('accepts the reference school layout', () => {
    const l = parseLayout(fixture())
    expect(l.trim).toEqual({ x: 24.854, y: 30.477, w: 238.296, h: 155.045 })
    expect(l.photoTargetDpi).toBe(200)
    expect(l.front).toHaveLength(10)
  })

  it('exposes the address element with its first-line indent', () => {
    const l = parseLayout(fixture())
    const addr = l.front.find((e) => e.id === 'address')
    if (addr?.kind !== 'text') throw new Error('address must be a text element')
    expect(addr.box.w).toBeCloseTo(162.59, 2)
    expect(addr.style.firstLineIndent).toBeCloseTo(36.6, 2)
    expect(addr.style.maxLines).toBe(2)
  })

  it('rejects a layout whose element has a negative width', () => {
    const bad = fixture()
    bad.front[0].box.w = -1
    expect(() => parseLayout(bad)).toThrow(/w/)
  })

  it('rejects an unknown element kind', () => {
    const bad = fixture()
    bad.front[0].kind = 'barcode'
    expect(() => parseLayout(bad)).toThrow()
  })
})
