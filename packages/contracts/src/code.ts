import { customAlphabet } from 'nanoid'

/**
 * Short codes are the primary key of a payment link, so the database enforces
 * uniqueness for us. That makes deep-link resolution a single indexed lookup —
 * no query, no composite index, no pagination.
 *
 * The alphabet drops the characters people mistranscribe when reading a link
 * off a screen or a printed QR: 0/O, 1/l/I. 54 symbols, 8 characters, so
 * ~46 bits of entropy. Collisions are handled by the create-only write failing
 * and the caller retrying, not by hoping.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export const CODE_LENGTH = 8

const generate = customAlphabet(ALPHABET, CODE_LENGTH)

export function newLinkCode(): string {
  return generate()
}

export function isValidLinkCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false
  for (const ch of code) if (!ALPHABET.includes(ch)) return false
  return true
}

/** Payment references are user-visible, so they carry a readable prefix. */
export function newPaymentReference(): string {
  return `kbl_${customAlphabet(ALPHABET, 10)()}`
}
