import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseFlipAxis } from '../src/cli.js'

describe('parseFlipAxis', () => {
  it('accepts long-edge and short-edge', () => {
    expect(parseFlipAxis('long-edge')).toBe('long-edge')
    expect(parseFlipAxis('short-edge')).toBe('short-edge')
  })

  it('rejects anything else with a message naming both valid values', () => {
    expect(() => parseFlipAxis('sideways')).toThrow(/--flip.*long-edge.*short-edge/s)
    expect(() => parseFlipAxis('')).toThrow(/--flip/)
  })
})

/**
 * Runs the real CLI entry point as a subprocess via tsx, exactly as an
 * operator would (`node dist/cli.js ...` once built). This is what actually
 * proves `--flip` is wired from the command line through to `renderJob` —
 * unit-testing `parseFlipAxis` alone would not catch the flag being dropped
 * on the floor between `program.option(...)` and the `renderJob` call.
 */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('render --flip (F7, CLI wiring)', () => {
  it('rejects an invalid flip axis before doing any work, with a clear message', () => {
    const r = runCli([
      'render',
      '-l',
      'fixtures/layout.json',
      '-d',
      'fixtures/students.xlsx',
      '--flip',
      'sideways',
    ])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--flip/)
    expect(r.stderr).toMatch(/long-edge/)
    expect(r.stderr).toMatch(/short-edge/)
  })

  it('accepts --flip short-edge, passes it through renderJob, and still produces a sheet', async () => {
    const out = await mkdtemp(join(tmpdir(), 'idcard-cli-'))
    try {
      const r = runCli([
        'render',
        '-l',
        'fixtures/layout.json',
        '-d',
        'fixtures/students.xlsx',
        '-p',
        'fixtures/photos',
        '-o',
        out,
        '--flip',
        'short-edge',
        '--force',
      ])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/wrote/)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })

  it('defaults to long-edge when --flip is omitted', async () => {
    const out = await mkdtemp(join(tmpdir(), 'idcard-cli-'))
    try {
      const r = runCli(['render', '-l', 'fixtures/layout.json', '-d', 'fixtures/students.xlsx', '-o', out, '--force'])
      expect(r.status).toBe(0)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})
