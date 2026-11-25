-- Apply as the private backend's database role; the app never creates tables.
BEGIN;
CREATE SCHEMA IF NOT EXISTS glamp;
CREATE TABLE IF NOT EXISTS glamp.push_subscriptions (
  -- Hash the endpoint for a bounded, non-secret index key.
  id text PRIMARY KEY,
  subscription jsonb NOT NULL
);
-- Capability URLs and auth secrets must not be readable via public/Data API roles.
ALTER TABLE glamp.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON glamp.push_subscriptions FROM PUBLIC;
COMMIT;

-- A distinct, non-owner app role also needs a role-specific policy. Example
-- (replace glamp_backend with the trusted SERVER role, never a Data API role):
-- GRANT USAGE ON SCHEMA glamp TO glamp_backend;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON glamp.push_subscriptions TO glamp_backend;
-- CREATE POLICY server_only ON glamp.push_subscriptions TO glamp_backend
--   USING (true) WITH CHECK (true);
