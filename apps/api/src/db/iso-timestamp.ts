/**
 * The one boundary between a `timestamp with time zone` column (every
 * `timestamp(..., { withTimezone: true, mode: 'date' })` column across
 * `schema/*.ts`) and `packages/contracts`' `IsoDateTimeSchema`
 * (`z.iso.datetime({ offset: true })`, RFC 3339 with an explicit offset).
 *
 * `mode: 'date'` — not `mode: 'string'` — is the point: node-postgres
 * parses `timestamptz` into a real `Date` before Drizzle ever sees it, and
 * a `Date` round-trips through `toIso`/`fromIso` losslessly (down to
 * millisecond precision — Postgres itself stores microseconds, `Date`
 * cannot, and no contract shape in this codebase needs sub-millisecond
 * precision). `mode: 'string'` looks like the more direct route to an ISO
 * string, but it returns whatever the driver's raw text format is —
 * `2026-09-11 12:48:29.861912+00`, space-separated with a two-digit
 * offset — which fails `IsoDateTimeSchema` outright (no `T`, no `Z`,
 * `+00` is not `+00:00`). B2/B3 (and everything after) should call
 * `toIso` at the row → contract-shape boundary rather than either
 * hand-rolling that formatting or reaching for `mode: 'string'` again.
 */
export function toIso(date: Date): string {
  return date.toISOString()
}

/** The inverse, for the rarer case of turning a contract `IsoDateTime` back into a column value (e.g. a query filter). */
export function fromIso(iso: string): Date {
  return new Date(iso)
}
