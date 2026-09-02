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

  it('defaults overflow to shrink, and marks name/guardian abbreviate-then-shrink', () => {
    const l = parseLayout(fixture())
    const name = l.front.find((e) => e.id === 'name')
    const guardian = l.front.find((e) => e.id === 'guardian')
    const idNo = l.front.find((e) => e.id === 'id_no')
    if (name?.kind !== 'text' || guardian?.kind !== 'text' || idNo?.kind !== 'text') {
      throw new Error('expected text elements')
    }
    expect(name.style.overflow).toBe('abbreviate-then-shrink')
    expect(guardian.style.overflow).toBe('abbreviate-then-shrink')
    // Every other field is left on the default — id_no was never mentioned
    // in the fixture edit, so it must still fall back to 'shrink'.
    expect(idNo.style.overflow).toBe('shrink')
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
