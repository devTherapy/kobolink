-- Hand-written custom migration (drizzle-kit --custom), same reasoning as
-- 0001/0002/0003: no declarative pgTable() equivalent for a trigger.
--
-- PLAN.md's B6 row: `GET /api/stream/dashboard` is fed by Postgres
-- `LISTEN`/`NOTIFY`, not polling. This trigger is the "notify" half — it
-- fires `AFTER INSERT` on `postings` itself, not from inside any one
-- service method, so it fires no matter which code path inserts a posting:
-- today that is only `PaymentsService.decideVerify` (`kind: 'link_payment'`),
-- but B8's wallet transfers/top-ups will insert `postings` rows too, and
-- this trigger picks those up automatically with no change here. An
-- application-level `pg_notify(...)` call inside `decideVerify` would have
-- to be copied into every future posting-writing method (and would be
-- silently skipped by any that forgot it); a trigger on the table can't be
-- forgotten.
--
-- The payload is deliberately minimal — just enough to look the row back
-- up (`{"table":"postings","id":"..."}`), never the posting's own metadata
-- or amount. `pg_notify`'s payload is capped at 8000 bytes and, more
-- importantly, is broadcast to *every* listener on the channel process-wide
-- before any merchant-scoping has happened — the listening side
-- (`apps/api/src/dashboard/dashboard-listener.service.ts`) re-reads the full
-- row from the pooled connection, decides which merchant it belongs to, and
-- only then builds and delivers the `DashboardEvent`. That re-read also
-- means this trigger never has to duplicate `resolveLink()`/stats logic in
-- PL/pgSQL just to shape a `DashboardEvent` — that stays TypeScript, single
-- source of truth in `packages/contracts`, same as everywhere else in this
-- codebase.
--
-- Postgres only delivers a channel's queued `NOTIFY`s to listeners once the
-- issuing transaction commits (and never if it rolls back) — exactly the
-- semantics this needs: `decideVerify` runs the posting insert (and, for a
-- success, its balancing `ledger_entries`) inside one transaction via
-- `IdempotencyService.run`, so a rolled-back attempt (e.g. a losing
-- idempotency race) never notifies anyone.

CREATE OR REPLACE FUNCTION notify_dashboard_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('dashboard_events', json_build_object('table', TG_TABLE_NAME, 'id', NEW.id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER postings_notify_dashboard
  AFTER INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION notify_dashboard_event();
