-- Optional, run ONCE as the migration owner after all three migrations.
-- First create a separate ordinary LOGIN role named glamp_app (no admin role,
-- BYPASSRLS or ownership), and grant it CONNECT to the target database.
-- Use its private connection string only on the server. Never use a
-- browser-facing role, and never include this schema in a public Data API.
BEGIN;
GRANT USAGE ON SCHEMA glamp TO glamp_app;
GRANT SELECT, INSERT, UPDATE ON glamp.cards TO glamp_app;
GRANT SELECT, INSERT ON glamp.card_images TO glamp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON glamp.push_subscriptions TO glamp_app;
CREATE POLICY backend_subscriptions ON glamp.push_subscriptions
  FOR ALL TO glamp_app USING (true) WITH CHECK (true);
COMMIT;
