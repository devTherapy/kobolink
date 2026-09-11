/**
 * Money is ALWAYS an integer number of kobo. Never a float, never naira.
 *
 * These two functions are the only place in the codebase where a division or
 * multiplication by 100 is allowed to appear. Everything else passes kobo
 * around untouched. That is deliberate: it makes a float rounding bug a
 * change to this file rather than something that can appear anywhere.
 */

export const KOBO_PER_NAIRA = 100

/** Largest amount a single payment link may carry: ₦10,000,000. */
export const MAX_AMOUNT_KOBO = 10_000_000 * KOBO_PER_NAIRA
/** Smallest chargeable amount: ₦100. */
export const MIN_AMOUNT_KOBO = 100 * KOBO_PER_NAIRA

const NAIRA = '₦'

/** Render kobo as naira for display: 1850000 -> "₦18,500". */
export function formatNaira(kobo: number, opts: { kobo?: boolean } = {}): string {
  if (!Number.isInteger(kobo)) {
    throw new TypeError(`formatNaira expects an integer number of kobo, got ${kobo}`)
  }
  const negative = kobo < 0
  const abs = Math.abs(kobo)
  const whole = Math.trunc(abs / KOBO_PER_NAIRA)
  const remainder = abs % KOBO_PER_NAIRA

  // Show the kobo part when it is non-zero, or when the caller insists.
  const showKobo = opts.kobo === true || remainder !== 0
  const body = showKobo
    ? `${whole.toLocaleString('en-NG')}.${String(remainder).padStart(2, '0')}`
    : whole.toLocaleString('en-NG')

  return `${negative ? '-' : ''}${NAIRA}${body}`
}

/**
 * Parse user input into kobo. Accepts "18500", "18,500", "₦18,500", "18500.50".
 * Returns null for anything it cannot read exactly — never a guess.
 */
export function parseNaira(input: string): number | null {
  const cleaned = input.trim().replace(/[₦,\s]/g, '')
  if (cleaned === '' || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const kobo = Number(whole) * KOBO_PER_NAIRA + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(kobo)) return null
  return negative ? -kobo : kobo
}

/** Is this a chargeable amount for a payment link? */
export function isValidAmountKobo(kobo: number): boolean {
  return (
    Number.isInteger(kobo) && kobo >= MIN_AMOUNT_KOBO && kobo <= MAX_AMOUNT_KOBO
  )
}
