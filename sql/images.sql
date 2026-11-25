-- Apply AFTER sql/schema.sql to the same Neon branch as the private storage bucket.
BEGIN;
CREATE TABLE IF NOT EXISTS glamp.card_images (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES glamp.cards (id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE CHECK (object_key = 'card-images/' || id::text),
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 3145728),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_images_card_created_idx ON glamp.card_images (card_id, created_at, id);
REVOKE ALL ON glamp.card_images FROM PUBLIC;
COMMIT;
