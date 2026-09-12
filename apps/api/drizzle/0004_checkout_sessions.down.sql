-- Hand-written reverse of 0004_checkout-sessions.sql, same convention as
-- every other migration's `.down.sql` sibling (see 0000's for the full
-- explanation of why this repo hand-writes these at all).
--
-- A plain `DROP TABLE` — no trigger, no function, no enum type to also
-- tear down, unlike 0001-0003. `checkout_sessions_link_code_idx` and both
-- foreign keys go with the table automatically.

DROP TABLE "checkout_sessions";
