import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFs } from '../src/node-io.js'
import { buildPhotoIndex, effectiveDpi, PhotoDirectoryNotFoundError } from '../src/photos.js'

describe('buildPhotoIndex', () => {
  it('matches filenames to ids despite leading zeros', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos', nodeFs)
    expect(byId.has('101')).toBe(true)
    expect(byId.has('102')).toBe(true) // from 0102.jpg
    expect(byId.get('101')?.width).toBe(132)
    expect(byId.get('101')?.height).toBe(172)
  })

  it('keeps files whose stem is not a usable id available for manual pairing', async () => {
    const { byId } = await buildPhotoIndex('fixtures/photos', nodeFs)
    expect(byId.has('junk')).toBe(true)
  })

  it('produces no collisions entry when every fixture id is unique', async () => {
    const { collisions } = await buildPhotoIndex('fixtures/photos', nodeFs)
    expect(collisions.size).toBe(0)
  })

  describe('with malformed and colliding files in a temp directory', () => {
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'photos-test-'))
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('throws naming the file for a non-PNG file named .png, rather than fabricating dimensions', async () => {
      // 40 bytes of 0x41 ('A'). readUInt32BE at offset 16 on unvalidated bytes like this
      // yields 0x41414141 = 1094795585 — the exact bogus width the reviewer observed live.
      const path = join(dir, 'not-a-photo.png')
      await writeFile(path, Buffer.alloc(40, 0x41))

      await expect(buildPhotoIndex(dir, nodeFs)).rejects.toThrow(path)
    })

    it('throws a named error, not a raw RangeError, for a truncated .png', async () => {
      const path = join(dir, 'truncated.png')
      await writeFile(path, Buffer.alloc(12, 0)) // shorter than the 24 bytes IHDR needs

      let caught: unknown
      try {
        await buildPhotoIndex(dir, nodeFs)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(RangeError)
      expect((caught as Error).message).toContain(path)
    })

    it('records a collision when two files normalise to the same id, keeping one byId entry', async () => {
      await copyFile('fixtures/photos/101.jpg', join(dir, '101.jpg'))
      await copyFile('fixtures/photos/101.jpg', join(dir, '0101.jpg'))

      const { byId, collisions } = await buildPhotoIndex(dir, nodeFs)

      expect(byId.has('101')).toBe(true)
      expect(collisions.has('101')).toBe(true)
      const claimants = collisions.get('101')!
      expect(claimants).toHaveLength(2)
      expect(claimants).toContain(join(dir, '101.jpg'))
      expect(claimants).toContain(join(dir, '0101.jpg'))

      // buildPhotoIndex sorts filenames before indexing, so "first file wins"
      // means alphabetically first ('0101.jpg' < '101.jpg'). The CLI's
      // collision message promises the operator "first file wins" — if the
      // winner ever silently flipped to the other file, that message would
      // become a lie and a student would get someone else's face on their
      // card, so pin which path actually won rather than only that a winner
      // exists (Minor 9).
      const alphabeticallyFirst = [join(dir, '101.jpg'), join(dir, '0101.jpg')].sort()[0]!
      expect(byId.get('101')!.path).toBe(alphabeticallyFirst)
    })

    it('reports no collision for a single file', async () => {
      await copyFile('fixtures/photos/101.jpg', join(dir, '101.jpg'))

      const { collisions } = await buildPhotoIndex(dir, nodeFs)

      expect(collisions.size).toBe(0)
    })

    it('returns a genuinely empty index for a directory that exists but holds no photos', async () => {
      // `dir` was just created by beforeEach and nothing has been written into
      // it. This must NOT throw — only a missing directory is an error; an
      // empty one is a legitimate (if unusual) state.
      const { byId, unmatched, collisions } = await buildPhotoIndex(dir, nodeFs)
      expect(byId.size).toBe(0)
      expect(unmatched).toHaveLength(0)
      expect(collisions.size).toBe(0)
    })
  })

  it('throws PhotoDirectoryNotFoundError, naming the path, for a directory that does not exist', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'photos-test-')), 'does-not-exist')
    await expect(buildPhotoIndex(missing, nodeFs)).rejects.toBeInstanceOf(PhotoDirectoryNotFoundError)
    await expect(buildPhotoIndex(missing, nodeFs)).rejects.toThrow(missing)
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

  it('returns 0, not Infinity, for a zero-sized box', () => {
    const dpi = effectiveDpi({ path: 'x', id: 'a', width: 1000, height: 1000 }, { x: 0, y: 0, w: 0, h: 0 })
    expect(dpi).toBe(0)
    expect(dpi).not.toBe(Infinity)
  })
})
