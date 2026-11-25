-- Apply to the deployment's private Neon database before serving traffic.
-- Each database holds one workspace; auth is enforced by the API, not by UUIDs.
BEGIN;
CREATE SCHEMA IF NOT EXISTS glamp;
CREATE TABLE IF NOT EXISTS glamp.cards (
  id uuid PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND btrim(title) <> ''),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 20000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'review', 'done')),
  is_task boolean NOT NULL DEFAULT false,
  starting_date date CHECK (starting_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  ending_date date CHECK (ending_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK (starting_date <= ending_date)
);
CREATE INDEX IF NOT EXISTS cards_updated_id_idx ON glamp.cards (updated_at DESC, id);
REVOKE ALL ON glamp.cards FROM PUBLIC;
COMMIT;
