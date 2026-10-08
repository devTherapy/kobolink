#!/usr/bin/env node
// Writes the table PayerValidationTests reads: packages/contracts' `EmailSchema` and
// `DisplayNameSchema` (the ORACLE: exactly what the API applies to a checkout request) run over a
// deterministic corpus.
//
//   npm run build -w packages/contracts    # this CLI imports the oracle from dist/
//   node mobile/ios/KobolinkKit/Tools/generate-payer-cases.mjs
//
// Row shapes:
//   email: [input, normalised | null]    the Zod result for the RAW input (the schema trims and lower-cases)
//   name:  [input, trimmed | null]       the Zod result for the input as PayForm sends it (trimmed first)
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { EmailSchema, DisplayNameSchema } = await import(resolve(here, '../../../../packages/contracts/dist/index.js'))

const emails = [
  'ngozi@example.com', ' ngozi@example.com ', 'NGOZI@EXAMPLE.COM', 'Ngozi.Okafor@Example.Com', 'a@b.co', 'a@b.c', 'a@b', 'a@.com', '@example.com', 'a@example.',
  'a.b.c@example.com', 'a..b@example.com', '.a@example.com', 'a.@example.com', "o'brien@example.com", "obrien'@example.com", "'@example.com", "a'.b@example.com",
  'a+tag@example.com', 'a-b@example.com', 'a_b@example.com', '-@example.com', '_@example.com', '+@example.com', 'a@exa mple.com', 'a b@example.com',
  'a@example.com.ng', 'a@sub.example.co.uk', 'a@-example.com', 'a@example-.com', 'a@exa--mple.com', 'a@1example.com', 'a@example.c0m', 'a@example.123', 'a@example.c',
  'a@@example.com', 'a@b@example.com', 'a@example..com', 'a@.example.com', 'a@example.com.', 'ａ@example.com', 'a@ｅxample.com', 'é@example.com', 'a@exämple.com', 'a@example.cöm',
  ' a@example.com ', '\ta@example.com\n', '​a@example.com', 'a@example.com​', 'fail@example.com', 'FAIL@Example.com',
  '', ' ', '@', 'plainaddress', 'a@b.cd', 'a@b.cde', 'x'.repeat(64) + '@example.com', 'x'.repeat(240) + '@example.com', 'x'.repeat(242) + '@example.com', 'x'.repeat(243) + '@example.com',
  'a@' + 'x'.repeat(63) + '.com', 'a@' + 'x'.repeat(300) + '.com', 'İ@example.com', 'a@İ.com', 'ǅ@example.com', 'ß@example.com', 'a@example.com\u0000',
  '😀@example.com', 'a@😀.com', 'a@example.com😀',
]
for (let c = 0x21; c < 0x7f; c += 1) {
  const ch = String.fromCharCode(c)
  emails.push(`a${ch}b@example.com`, `${ch}@example.com`, `a@${ch}.com`, `a@example.c${ch}`, `a@e${ch}e.com`)
}

const names = [
  'Ngozi Okafor', '  Ngozi  ', 'N', '', ' ', ' ', ' N ', '﻿N', ' N ', '​N', 'x'.repeat(80), 'x'.repeat(81), ' ' + 'x'.repeat(80) + ' ',
  '😀'.repeat(40), '😀'.repeat(41), '😀'.repeat(39) + 'x', 'é'.repeat(80), 'é'.repeat(81), 'é'.repeat(40), 'é'.repeat(41), '👨‍👩‍👧‍👦', '👨‍👩‍👧‍👦'.repeat(8),
  'Ada\nLovelace', 'Ada\tLovelace', '\n', 'O\'Brien', 'Nguyễn', '日本語', '𠮷'.repeat(40), '𠮷'.repeat(41),
]

const seenEmail = new Set()
const email = []
for (const input of emails) {
  if (seenEmail.has(input)) continue
  seenEmail.add(input)
  const r = EmailSchema.safeParse(input)
  email.push([input, r.success ? r.data : null])
}
const name = names.map((input) => {
  const r = DisplayNameSchema.safeParse(input.trim())
  return [input, r.success ? r.data : null]
})

const body = `${JSON.stringify({ email, name })}\n`
const file = resolve(here, '../Tests/KobolinkKitTests/Resources/payer-oracle.json')
writeFileSync(file, body)
console.log(`${email.length} email rows (${email.filter((r) => r[1] !== null).length} valid), ${name.length} name rows (${name.filter((r) => r[1] !== null).length} valid) -> ${file} (${(body.length / 1024).toFixed(0)} KiB)`)
