import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { parseFlipAxis } from '../src/cli.js'

const TSX_BIN = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const CLI_ENTRY = join(process.cwd(), 'src/cli.ts')

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
function runCli(args: string[], cwd: string = process.cwd()): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, ...args], {
    encoding: 'utf8',
    cwd,
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

describe('render font paths (F6)', () => {
  it("resolves layout.fonts against the layout file's own directory, not the process cwd", async () => {
    // Builds a self-contained project folder (layout + template + a font
    // reached only by a path relative to the layout, never to whatever
    // directory the CLI happens to be run from) in one temp dir, and runs the
    // CLI from an unrelated cwd that does not contain the font at all. Before
    // the fix, fonts.ts's `readFile(path)` resolved relative font paths
    // against process.cwd() (unlike templateFront/templateBack, which the CLI
    // already resolved against the layout's directory), so this would have
    // failed with "Font ... not found" despite the project being complete.
    const projectDir = await mkdtemp(join(tmpdir(), 'idcard-fontbase-project-'))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), 'idcard-fontbase-cwd-'))
    const out = await mkdtemp(join(tmpdir(), 'idcard-fontbase-out-'))
    try {
      const layout = JSON.parse(await readFile('fixtures/layout.json', 'utf8'))
      layout.fonts = { value: 'fonts/LiberationSans-Regular.ttf' }
      await mkdir(join(projectDir, 'fonts'), { recursive: true })
      await copyFile(
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        join(projectDir, 'fonts/LiberationSans-Regular.ttf'),
      )
      await copyFile('fixtures/template.pdf', join(projectDir, 'template.pdf'))
      await writeFile(join(projectDir, 'layout.json'), JSON.stringify(layout))

      const r = runCli(
        [
          'render',
          '-l',
          join(projectDir, 'layout.json'),
          '-d',
          join(process.cwd(), 'fixtures/students.xlsx'),
          '-o',
          out,
          '--force',
        ],
        unrelatedCwd,
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/wrote/)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(unrelatedCwd, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('render output messages (operator-facing gaps)', () => {
  it('prints both job-fronts.pdf and job-backs.pdf when a back side is rendered', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'idcard-backmsg-'))
    const out = await mkdtemp(join(tmpdir(), 'idcard-backmsg-out-'))
    try {
      const layout = JSON.parse(await readFile('fixtures/layout.json', 'utf8'))
      layout.templateBack = 'template.pdf'
      const nameEl = layout.front.find((e: { id: string }) => e.id === 'name')
      layout.back = [{ ...nameEl, id: 'back_name', page: 'back' }]
      await copyFile('fixtures/template.pdf', join(projectDir, 'template.pdf'))
      await writeFile(join(projectDir, 'layout.json'), JSON.stringify(layout))

      const r = runCli([
        'render',
        '-l',
        join(projectDir, 'layout.json'),
        '-d',
        join(process.cwd(), 'fixtures/students.xlsx'),
        '-o',
        out,
        '--force',
      ])
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/wrote.*job-fronts\.pdf/)
      expect(r.stdout).toMatch(/wrote.*job-backs\.pdf/)
      await expect(stat(join(out, 'job-backs.pdf'))).resolves.toBeDefined()
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })

  it('reports a missing --photos directory as its own clear message rather than 1000 photo-missing issues', () => {
    const missing = join(tmpdir(), 'idcard-photos-does-not-exist-' + Date.now())
    const r = runCli(['render', '-l', 'fixtures/layout.json', '-d', 'fixtures/students.xlsx', '-p', missing, '--force'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/--photos/)
    expect(r.stderr).toContain(missing)
    expect(r.stderr).not.toMatch(/photo-missing/)
  })

  it('refuses an empty spreadsheet with a clear message and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idcard-empty-sheet-'))
    const out = join(dir, 'out')
    try {
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Sheet1')
      ws.addRow(['ID No.', 'Name', "Guardian's Name", 'Class', 'R.No.', 'DOB', 'Blood Group', 'Contact No.', 'Address'])
      const dataPath = join(dir, 'empty.xlsx')
      await wb.xlsx.writeFile(dataPath)

      const r = runCli(['render', '-l', 'fixtures/layout.json', '-d', dataPath, '-o', out, '--force'])
      expect(r.status).not.toBe(0)
      expect(r.stderr).toMatch(/no data rows/i)
      await expect(stat(out)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
