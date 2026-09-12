import type { DashboardEvent } from '@kobolink/contracts'

/**
 * One SSE wire frame for a `DashboardEvent` — `id:`/`event:`/`data:` lines
 * terminated by the blank line the spec requires to mark the frame
 * complete. `id:` is what lets a reconnecting `EventSource` send back
 * `Last-Event-ID` (`packages/contracts/src/dashboard.ts`'s own doc
 * comment); this repo does not yet replay anything for that header (see
 * `dashboard-stream.controller.ts`'s doc comment), but the id is still
 * sent on every frame, heartbeats included, so that piece of the wire
 * protocol is already correct for whenever replay is built.
 *
 * `data:` is a single `JSON.stringify` — `DashboardEvent` never contains a
 * newline (every field is a number, an ISO string, or another parsed JSON
 * shape), so splitting a multi-line payload across several `data:` lines
 * (the other spec-legal form) is never needed here.
 */
export function formatSseFrame(id: number, event: DashboardEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
