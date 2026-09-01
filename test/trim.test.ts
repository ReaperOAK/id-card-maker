import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rasterize } from '../src/raster.js'
import { detectTrim } from '../src/trim.js'

const bytes = () => new Uint8Array(readFileSync('fixtures/template.pdf'))

describe('rasterize', () => {
  it('renders the page at the requested dpi', async () => {
    const r = await rasterize(bytes(), 0, 150)
    // 288pt x 216pt at 150dpi = 600 x 450 px
    expect(r.width).toBe(600)
    expect(r.height).toBe(450)
    expect(r.rgba.length).toBe(600 * 450 * 4)
  })
})

describe('detectTrim', () => {
  it('finds the card inside a larger page box', async () => {
    const trim = await detectTrim(bytes(), { dpi: 300 })
    // The detected box includes the 0.5pt border stroke's outer edge, so it runs
    // ~0.5pt large. One 300dpi pixel is 0.24pt. 1pt covers both.
    expect(Math.abs(trim.x - 24.854)).toBeLessThan(1)
    expect(Math.abs(trim.y - 30.477)).toBeLessThan(1)
    expect(Math.abs(trim.w - 238.296)).toBeLessThan(1)
    expect(Math.abs(trim.h - 155.045)).toBeLessThan(1)
  })

  it('centres the detected trim on the page, as the reference template does', async () => {
    const trim = await detectTrim(bytes(), { dpi: 300 })
    expect(Math.abs(trim.x - (288 - trim.x - trim.w))).toBeLessThan(1)
    expect(Math.abs(trim.y - (216 - trim.y - trim.h))).toBeLessThan(1)
  })
})
