import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOpenApiDocument } from './build-openapi-document.js'

/**
 * `npm run generate:openapi -w apps/api` — writes the checked-in
 * `apps/api/openapi.json` that M0's Swift/Kotlin model generators read
 * without booting the API. Run this after any change that could affect the
 * document (a contracts schema, `route-manifest.ts`); `openapi-drift.spec.ts`
 * fails the gate if you forget.
 *
 * Mirrors `db/seed.ts`'s shape: compiled by the same `tsc -p
 * tsconfig.build.json` as the app itself (not run through `tsx` — see
 * `main.ts`'s comment on why this repo avoids esbuild-based runners), then
 * executed directly with `node`.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const outputPath = path.resolve(here, '../../openapi.json')

async function main(): Promise<void> {
  const document = buildOpenApiDocument()
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  process.stdout.write(`wrote ${outputPath}\n`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
