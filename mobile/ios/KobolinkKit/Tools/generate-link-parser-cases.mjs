#!/usr/bin/env node
// Writes the table the Swift tests read: packages/contracts' `parseLinkCode` (the ORACLE) run over a
// large, deterministic corpus. See link-parser-corpus.mjs for the row format.
//
//   npm run build -w packages/contracts          # this CLI imports the oracle from dist/
//   node mobile/ios/KobolinkKit/Tools/generate-link-parser-cases.mjs                      # the committed table
//   node mobile/ios/KobolinkKit/Tools/generate-link-parser-cases.mjs --big 400000 /tmp/oracle.json
//
// `npm run test -w packages/contracts` fails if the committed table differs from what this
// produces (tests/ios-oracle-table.test.ts, which imports the source, not dist).
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTable, renderTable } from './link-parser-corpus.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const oracle = await import(resolve(here, '../../../../packages/contracts/dist/index.js'))

const args = process.argv.slice(2)
const bigIndex = args.indexOf('--big')
const big = bigIndex >= 0
const file = big ? resolve(args[bigIndex + 2]) : resolve(here, '../Tests/KobolinkKitTests/Resources/link-parser-oracle.json')

const table = buildTable(oracle, big ? Number(args[bigIndex + 1]) : undefined)
const body = renderTable(table)
writeFileSync(file, body)

const accepted = table.filter((r) => r[1] !== null).length
const byReason = Object.fromEntries(['scheme', 'host', 'port', 'host-alias'].map((k) => [k, table.filter((r) => r[3] === k).length]))
console.log(`${table.length} rows -> ${file} (${(body.length / 1024).toFixed(0)} KiB)`)
console.log(`oracle accepts ${accepted}, rejects ${table.length - accepted}; app stricter on ${table.filter((r) => r[3]).length}`, byReason)
