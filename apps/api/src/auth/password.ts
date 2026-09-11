import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id, via `@node-rs/argon2` — the same library and the same
 * (library-default, which *is* Argon2id) options `src/db/seed.ts` already
 * hashes the seeded merchant's password with, so a password hashed by one
 * path always verifies through the other.
 */
export async function hashPassword(password: string): Promise<string> {
  return hash(password)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password)
}

/**
 * This PR's own decision for login: always run an argon2 verify against a
 * dummy hash when the user is unknown — PLAN.md's B2 row asks for the
 * observable behaviour ("wrong password, unknown user" both indistinguishable
 * 401s) but not this specific mechanism. Review round 1, finding 9: an
 * earlier version of this comment cited PLAN.md for the mechanism itself,
 * which it does not actually specify. The point of doing it this way is so
 * that rejecting an unknown email takes roughly the same wall-clock time as
 * rejecting a wrong password for a
 * real one, instead of an unknown-user response returning near-instantly
 * (no argon2 call at all) and a wrong-password response taking tens of
 * milliseconds — a gap an attacker can use to enumerate which emails have
 * accounts even though both cases return the identical `unauthenticated`
 * body. "Constant-time-ish", not a real constant-time guarantee: argon2's
 * own cost is what dominates, and this only equalises *that* cost between
 * the two branches, not, say, network jitter.
 *
 * The dummy hash is computed once, lazily, and cached — hashing itself is
 * exactly as expensive as verifying, so doing it on every unknown-user
 * login would double that branch's cost for no benefit; the value hashed
 * is fixed and never reused as a real credential anywhere.
 */
let dummyHashPromise: Promise<string> | undefined

async function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hash('kobolink-dummy-password-never-a-real-credential')
  return dummyHashPromise
}

/** Always resolves to `false` — the point is the argon2 call, not the (meaningless) result. */
export async function verifyDummyPassword(password: string): Promise<boolean> {
  const dummyHash = await getDummyHash()
  await verify(dummyHash, password)
  return false
}
