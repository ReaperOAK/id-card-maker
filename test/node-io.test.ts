import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFs } from '../src/node-io.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'idcard-io-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('nodeFs', () => {
  it('round-trips bytes and lists a directory', async () => {
    await nodeFs.mkdir(join(dir, 'sub'))
    await nodeFs.writeFile(join(dir, 'sub', 'a.bin'), new Uint8Array([1, 2, 3]))
    expect(await nodeFs.exists(join(dir, 'sub', 'a.bin'))).toBe(true)
    expect(await nodeFs.exists(join(dir, 'nope'))).toBe(false)
    expect([...(await nodeFs.readFile(join(dir, 'sub', 'a.bin')))]).toEqual([1, 2, 3])
    expect(await nodeFs.readDir(join(dir, 'sub'))).toEqual(['a.bin'])
  })
  it('returns a Uint8Array, not a Buffer, so the webview implementation is interchangeable', async () => {
    await nodeFs.writeFile(join(dir, 'x'), new Uint8Array([9]))
    const b = await nodeFs.readFile(join(dir, 'x'))
    expect(Object.getPrototypeOf(b)).toBe(Uint8Array.prototype)
  })
})
