/**
 * Shared display formatting for merchant-facing screens. Money already has
 * one place it's allowed to be formatted (`formatNaira` in
 * `@kobolink/contracts`) — this is the calendar-date sibling: a plain
 * "2 Jun 2026", no time of day, for a table's "Created" column and anywhere
 * else in the dashboard that only needs a date. `formatCheckoutDate` in
 * `./checkout` covers the payer-facing case that does need a time and
 * timezone label (the checkout is a specific event, not a running log) — kept
 * separate rather than reused here so a table row doesn't grow a time
 * component nobody asked for.
 */
export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-NG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(new Date(iso))
}
