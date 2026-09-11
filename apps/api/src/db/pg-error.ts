/**
 * The subset of `pg`'s `DatabaseError` shape a caller needs to tell "this
 * insert lost a unique-constraint race" apart from every other failure —
 * `code`/`constraint` are set by Postgres itself, not invented by the
 * driver. Same shape `src/db/seed.ts` reads (that file predates this one
 * and keeps its own private copy rather than being refactored to import
 * this — see this PR's description); `src/auth/auth.service.ts` is the
 * other caller.
 */
export interface PossiblePgError {
  code?: string
  constraint?: string
  cause?: unknown
}

/**
 * `drizzle-orm`'s node-postgres driver never throws `pg`'s own
 * `DatabaseError` directly — it wraps it in a `DrizzleQueryError` whose
 * `.cause` is the real driver error carrying `code`/`constraint`. Unwrap
 * `.cause` recursively (a future drizzle version, or a differently-wrapped
 * error, could nest it one level deeper) until something has a `code`.
 */
export function asPgError(error: unknown): PossiblePgError | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as PossiblePgError
  if (typeof candidate.code === 'string') return candidate
  return asPgError(candidate.cause)
}

/** Postgres error code `23505` is `unique_violation`; `constraintName` narrows it to one specific index. */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const pgError = asPgError(error)
  return pgError?.code === '23505' && pgError.constraint === constraintName
}
