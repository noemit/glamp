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
  author text CHECK (author IS NULL OR (char_length(author) BETWEEN 1 AND 60 AND btrim(author) <> '')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK (starting_date <= ending_date)
);
ALTER TABLE glamp.cards ADD COLUMN IF NOT EXISTS author text CHECK (author IS NULL OR (char_length(author) BETWEEN 1 AND 60 AND btrim(author) <> ''));
CREATE INDEX IF NOT EXISTS cards_updated_id_idx ON glamp.cards (updated_at DESC, id);
CREATE INDEX IF NOT EXISTS cards_author_idx ON glamp.cards (lower(author)) WHERE author IS NOT NULL;
REVOKE ALL ON glamp.cards FROM PUBLIC;

CREATE TABLE IF NOT EXISTS glamp.agent_profiles (
  name text PRIMARY KEY CHECK (char_length(name) BETWEEN 1 AND 60 AND btrim(name) <> ''),
  role text NOT NULL DEFAULT '' CHECK (char_length(role) <= 120),
  color text NOT NULL DEFAULT 'slate' CHECK (color IN ('slate', 'sky', 'green', 'amber', 'rose', 'teal')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON glamp.agent_profiles FROM PUBLIC;

CREATE TABLE IF NOT EXISTS glamp.card_comments (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES glamp.cards (id) ON DELETE CASCADE,
  author text NOT NULL CHECK (char_length(author) BETWEEN 1 AND 60 AND btrim(author) <> ''),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000 AND btrim(body) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_comments_card_created_idx ON glamp.card_comments (card_id, created_at, id);
CREATE INDEX IF NOT EXISTS card_comments_author_idx ON glamp.card_comments (lower(author));
REVOKE ALL ON glamp.card_comments FROM PUBLIC;
COMMIT;
