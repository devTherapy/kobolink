/**
 * The shape `drizzle/0005_postings_notify_dashboard.sql`'s trigger passes
 * to `pg_notify('dashboard_events', ...)` — deliberately minimal (never the
 * posting's amount or metadata; see that migration's own doc comment for
 * why). `table` is `TG_TABLE_NAME`; only `'postings'` is ever produced
 * today, but the field exists so a future trigger on another table (e.g.
 * `links`, for `link.created`/`link.updated`) can share the same channel
 * without a new one to LISTEN on.
 */
export interface DashboardNotification {
  table: string
  id: string
}

/**
 * Parses one `pg` `notification` event's `payload` — untrusted in the sense
 * that it round-trips through Postgres as plain text, not in the sense that
 * anything but this repo's own trigger ever writes it. Never throws: a
 * malformed payload (a hand-run `NOTIFY` during a `psql` session, a future
 * trigger that gets this wrong) is dropped by the caller, not a crashed
 * listener connection.
 */
export function parseDashboardNotification(payload: string | undefined): DashboardNotification | undefined {
  if (payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.table !== 'string' || typeof candidate.id !== 'string') return undefined
  return { table: candidate.table, id: candidate.id }
}
