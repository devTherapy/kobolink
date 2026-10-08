#!/usr/bin/env node
// Writes the table KoboTests reads: packages/contracts' `formatNaira`, `parseNaira` and
// `isValidAmountKobo` (the ORACLE) run over a deterministic corpus, including the inputs where
// JavaScript's idea of whitespace and digits differs from Swift's.
//
//   npm run build -w packages/contracts    # this CLI imports the oracle from dist/
//   node mobile/ios/KobolinkKit/Tools/generate-money-cases.mjs
//
// Row shapes (JSON arrays, so a Swift test needs no parser of its own):
//   format: [kobo, formatNaira(kobo), formatNaira(kobo, {kobo: true})]
//   parse:  [input, kobo | null]
//   valid:  [kobo, isValidAmountKobo(kobo)]
// Kobo values here are integers; a float is refused by `formatNaira` (a TypeError) and by the
// generated Swift decoder (`Int`), which is tested separately.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { formatNaira, parseNaira, isValidAmountKobo, MIN_AMOUNT_KOBO, MAX_AMOUNT_KOBO } = await import(
  resolve(here, '../../../../packages/contracts/dist/index.js')
)

const koboValues = new Set([
  0, 1, 5, 9, 10, 11, 50, 99, 100, 101, 105, 109, 110, 150, 199, 999, 1000, 1001, 9999, 10000, 12345,
  99999, 100000, 100001, 123456, 999999, 1000000, 1850000, 1850005, 1850050, 1850099, 1850100,
  12345678, 99999999, 100000000, 123456789, 999999999, 1000000000, 1234567890,
  MIN_AMOUNT_KOBO - 1, MIN_AMOUNT_KOBO, MIN_AMOUNT_KOBO + 1,
  MAX_AMOUNT_KOBO - 1, MAX_AMOUNT_KOBO, MAX_AMOUNT_KOBO + 1,
  12345678901, 9007199254740, 9007199254740991,
])
for (let n = 1; n <= 12; n += 1) {
  koboValues.add(10 ** n)
  koboValues.add(10 ** n - 1)
  koboValues.add(10 ** n + 1)
}
for (const v of [...koboValues]) koboValues.add(-v)

const format = [...koboValues].sort((a, b) => a - b).map((k) => [k, formatNaira(k), formatNaira(k, { kobo: true })])
const valid = [...koboValues].sort((a, b) => a - b).map((k) => [k, isValidAmountKobo(k)])

const parseInputs = [
  // contracts' money.test.ts
  '18500', '18,500', '₦18,500', ' ₦18,500 ', '18500.5', '18500.05', '0',
  '', 'abc', '18,50 0.123', '1.2.3', '₦', '18500.123', '--5',
  // shapes
  '18500.50', '18500.00', '18500.0', '18500.', '.5', '5', '-5', '-0', '-0.00', '+5', '00018500', '0.5', '0.05', '0.005',
  '1e5', '0x10', '1_000', '18500,50', '1,8,5,0,0', '1,,8', '₦₦18,500', '₦18,500₦', '18,500₦', '₦-5', '-₦5', '- 5', '-  18,500.5',
  '10000000', '10000000.00', '10000000.01', '10000001', '100', '99.99', '100.00', '99', '9999999999',
  // JavaScript whitespace is removed anywhere
  '1 8 5 0 0', '18 500', '18 500', ' 18500 ', '\t18500\r\n', '18500\n', '\n18500', '1\n8',
  '  18,500  ', '  18500', '18500  ', '　 18500', '﻿18500', ' 18500', ' 18500', '  18500',
  ' 18500 ', '\u000b18500\u000c',
  // ... and what JavaScript does NOT call whitespace stays and fails the digit test
  '​18500', '18500​', '\u00851850', '᠎18500', '‌18500', '18‍500',
  // \d is ASCII
  '１８５００', '١٢٣', '१२३', '１８５００.５', '18500.٥', '18٥00', '²', '½', '⑤',
  // size limits (isSafeInteger on kobo, not on naira)
  '9007199254740991', '90071992547409', '90071992547410', '90071992547409.91', '90071992547409.92',
  '9007199254740992', '123456789012345678901234567890', '1'.repeat(40), '0'.repeat(40) + '5',
  '1'.repeat(16), '1'.repeat(15), '1'.repeat(14), '1'.repeat(14) + '.99', '1'.repeat(15) + '.99',
  // junk
  'one hundred', '₦ one', '18,500 naira', 'NGN 18500', '#5', '5%', '5-', '5.-', '5..5', '..5', '5.5.5', ',', '.', '-', '--', '-.5', '₦.5', '₦-.5',
  '😀', '18500😀', '5́', 'ｅ5',
]
// every ASCII character on its own, after a "5", and as the sole input
for (let c = 0x20; c < 0x7f; c += 1) {
  const ch = String.fromCharCode(c)
  parseInputs.push(ch, `5${ch}`, `${ch}5`, `5${ch}5`, `5.${ch}`, `5.5${ch}`)
}
for (const kobo of [0, 100, 1850000, 1850050, 99999999]) parseInputs.push(formatNaira(kobo, { kobo: true }), formatNaira(kobo))

const seen = new Set()
const parse = []
for (const input of parseInputs) {
  if (seen.has(input)) continue
  seen.add(input)
  const result = parseNaira(input)
  parse.push([input, result === null ? null : Object.is(result, -0) ? 0 : result])
}

const body = `${JSON.stringify({ min: MIN_AMOUNT_KOBO, max: MAX_AMOUNT_KOBO, format, parse, valid })}\n`
const file = resolve(here, '../Tests/KobolinkKitTests/Resources/money-oracle.json')
writeFileSync(file, body)
console.log(`${format.length} format rows, ${parse.length} parse rows (${parse.filter((r) => r[1] !== null).length} accepted), ${valid.length} valid rows -> ${file} (${(body.length / 1024).toFixed(0)} KiB)`)
