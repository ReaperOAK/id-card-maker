#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { loadRows } from './data.js'
import type { FlipAxis } from './impose.js'
import { parseLayout } from './layout.js'
import { buildPhotoIndex } from './photos.js'
import { renderJob } from './render-job.js'
import { summarise } from './preflight.js'
import { detectTrim } from './trim.js'

/**
 * Validates the `--flip` value. Exported so it is unit-testable without
 * spawning the CLI as a subprocess. Rejects rather than defaulting silently:
 * `RenderJobArgs.flipAxis` is honoured correctly once it arrives, but a wrong
 * axis backs every card in a duplex job onto the wrong front, and that is
 * only discovered after cutting.
 */
export function parseFlipAxis(value: string): FlipAxis {
  if (value !== 'long-edge' && value !== 'short-edge') {
    throw new Error(`--flip must be "long-edge" or "short-edge", got "${value}"`)
  }
  return value
}

const program = new Command()
program.name('idcard').description('Batch ID card generator').version('0.1.0')

program
  .command('trim')
  .description('Report the detected trim box of a template PDF')
  .requiredOption('-t, --template <path>')
  .option('--dpi <n>', 'detection resolution', '300')
  .action(async (opts: { template: string; dpi: string }) => {
    const rect = await detectTrim(new Uint8Array(await readFile(opts.template)), { dpi: Number(opts.dpi) })
    console.log(JSON.stringify(rect, null, 2))
    console.log(`= ${(rect.w / 72).toFixed(4)} x ${(rect.h / 72).toFixed(4)} in`)
  })

program
  .command('render')
  .description('Generate imposed print sheets')
  .requiredOption('-l, --layout <path>')
  .requiredOption('-d, --data <path>')
  .option('-p, --photos <dir>')
  .option('-o, --out <dir>', 'output directory', 'out')
  .option('--name <text>', 'job name printed on the sheet slug')
  .option('--flip <axis>', 'duplex flip axis for the back sheet: long-edge or short-edge', 'long-edge')
  .option('--force', 'generate even when preflight reports blocking issues', false)
  .action(async (opts: { layout: string; data: string; photos?: string; out: string; name?: string; flip: string; force: boolean }) => {
    const flipAxis = parseFlipAxis(opts.flip)
    const layoutPath = resolve(opts.layout)
    const layout = parseLayout(JSON.parse(await readFile(layoutPath, 'utf8')))
    const base = dirname(layoutPath)

    const { rows } = await loadRows(opts.data)
    const photoIndex = opts.photos
      ? await buildPhotoIndex(opts.photos)
      : { byId: new Map(), unmatched: [], collisions: new Map() }

    // Two photo files normalising to the same id means a student could silently
    // receive someone else's face on their card. buildPhotoIndex already picks a
    // winner (first file, alphabetically) so generation is not blocked on this
    // alone, but the operator must be told before printing — this is exactly the
    // failure the id-normalisation/matching module exists to prevent.
    if (photoIndex.collisions.size > 0) {
      console.log(`PHOTO ID COLLISIONS: ${photoIndex.collisions.size} id(s) claimed by more than one file`)
      for (const [id, paths] of photoIndex.collisions) {
        console.log(`  id "${id}": ${paths.join(', ')} (first file wins)`)
      }
    }

    const result = await renderJob({
      layout,
      templateFront: new Uint8Array(await readFile(resolve(base, layout.templateFront))),
      templateBack: layout.templateBack ? new Uint8Array(await readFile(resolve(base, layout.templateBack))) : null,
      rows,
      photos: photoIndex.byId,
      jobName: opts.name ?? layout.name,
      allowOverrides: opts.force,
      flipAxis,
    })

    const counts = summarise(result.issues)
    console.log(`students ${rows.length}  sheets ${result.sheets}  blocking ${counts.blocking}  warnings ${counts.warnings}`)
    for (const [code, n] of counts.byCode) console.log(`  ${code}: ${n}`)

    await mkdir(opts.out, { recursive: true })
    await writeFile(join(opts.out, 'job-fronts.pdf'), result.frontPdf)
    if (result.backPdf) await writeFile(join(opts.out, 'job-backs.pdf'), result.backPdf)
    console.log(`wrote ${join(opts.out, 'job-fronts.pdf')}`)
  })

// Only run the CLI when this file is the process entry point, not merely
// imported (e.g. by tests that import `parseFlipAxis` above). Without this
// guard, importing this module for its exports would also run `commander`
// against whatever process spawned it (a test runner, say), which does not
// share this file's command surface.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await program.parseAsync(process.argv)
}
