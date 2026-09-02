import { describe, expect, it } from 'vitest'
import { buildPhotoIndex, effectiveDpi } from '../src/photos.js'

describe('buildPhotoIndex', () => {
  it('matches filenames to ids despite leading zeros', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos')
    expect(byId.has('101')).toBe(true)
    expect(byId.has('102')).toBe(true) // from 0102.jpg
    expect(byId.get('101')?.width).toBe(132)
    expect(byId.get('101')?.height).toBe(172)
  })

  it('keeps files whose stem is not a usable id available for manual pairing', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos')
    expect(byId.has('junk')).toBe(true)
  })
})

describe('effectiveDpi', () => {
  it('computes dpi from pixels over the printed box size', () => {
    // The reference photo frame is 47.78 x 62.53pt; 132px across 47.78pt is ~199dpi.
    const dpi = effectiveDpi({ path: 'x', id: '101', width: 132, height: 172 }, { x: 0, y: 0, w: 47.78, h: 62.53 })
    expect(dpi).toBeGreaterThan(195)
    expect(dpi).toBeLessThan(205)
  })

  it('uses the more constrained axis', () => {
    const dpi = effectiveDpi({ path: 'x', id: 'a', width: 1000, height: 10 }, { x: 0, y: 0, w: 72, h: 72 })
    expect(dpi).toBe(10)
  })
})
