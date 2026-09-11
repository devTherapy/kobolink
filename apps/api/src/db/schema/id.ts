import { nanoid } from 'nanoid'

/**
 * Opaque identifiers for every table whose primary key is not a natural key
 * (`links.code` is the one exception — the short code itself is the key).
 *
 * `packages/contracts`' `IdSchema` bounds a public id to
 * `^[A-Za-z0-9_-]+$`, 1-64 characters. nanoid's default alphabet is exactly
 * that character set, so a generated id round-trips the contract with no
 * translation layer at the API boundary.
 */
export function newId(): string {
  return nanoid()
}
