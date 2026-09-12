import { customAlphabet } from 'nanoid'

/**
 * `postings.reference` for a `transfer`/`topup` posting — B8 mints its own
 * shape, per that column's own doc comment ("`kbl_...` for a `link_payment`;
 * B8 mints its own shape for `transfer` and `topup`"). `postings.reference`
 * carries no format CHECK of its own (only `PaymentReferenceSchema`, in
 * `packages/contracts`, constrains the `kbl_...` shape, and only for
 * `link_payment`), so this is free to pick a distinct, equally-readable
 * prefix without touching `packages/contracts` — `postings.kind` already
 * tells `transfer` and `topup` apart, so one shape covers both.
 *
 * Same alphabet as `packages/contracts/src/code.ts` (0/O/1/l/I dropped —
 * people mistranscribe them off a screen), duplicated deliberately rather
 * than imported: this file's whole reason to exist is that `packages/contracts`
 * is not B8's to edit, and the alphabet is a cosmetic choice, not a shape
 * contracts needs to agree with apps/web or the mobile apps on the way a
 * `LinkCode`/`PaymentReference` regex does.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const generate = customAlphabet(ALPHABET, 10)

/**
 * A reference generator as a pure function type, injected via
 * `WALLET_REFERENCE_GENERATOR` rather than `WalletService` importing
 * `newWalletReference` directly — the same DI seam `PaymentsModule` gives
 * `PAYMENT_REFERENCE_GENERATOR` (see that file's own doc comment), so a
 * test can force a genuine `postings_reference_unique` collision without
 * narrowing the real alphabet or hoping for one by chance.
 */
export type WalletReferenceGenerator = () => string

export const WALLET_REFERENCE_GENERATOR = Symbol('WALLET_REFERENCE_GENERATOR')

export function newWalletReference(): string {
  return `wal_${generate()}`
}

export const defaultWalletReferenceGenerator: WalletReferenceGenerator = newWalletReference
