-- Run scripts/check-schema.sh, NOT psql "$DATABASE_URL". No cloud credentials.
\set ON_ERROR_STOP on
DO $$ BEGIN
  IF inet_server_addr() IS NOT NULL OR current_setting('listen_addresses') <> ''
    OR current_setting('cluster_name') <> 'glamp_schema_smoke'
    OR current_setting('data_directory') !~ '^(/private)?/var/tmp/glamp-schema\.[[:alnum:]]+/data$' THEN
    RAISE EXCEPTION 'Refusing to run outside the throwaway scripts/check-schema.sh cluster';
  END IF;
END $$;
SELECT version();
CREATE ROLE glamp_owner;
CREATE ROLE glamp_app LOGIN;
CREATE ROLE unrelated LOGIN;
GRANT CREATE ON DATABASE postgres TO glamp_owner;

-- Any attempt to write the legacy table, even an UPDATE matching zero rows,
-- must fail the run. No fixture uses real application data.
CREATE TABLE public.cards (legacy_marker text);
INSERT INTO public.cards VALUES ('unchanged');
CREATE FUNCTION public.reject_card_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Unexpected write to public.cards'; END $$;
CREATE TRIGGER reject_card_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.cards
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_card_write();
GRANT ALL ON public.cards TO glamp_owner, glamp_app;

SET ROLE glamp_owner;
\ir ../sql/schema.sql
\ir ../sql/images.sql
\ir ../sql/push.sql

-- Exercise the same-role (table owner) deployment before re-applying DDL.
INSERT INTO glamp.cards (id,title) VALUES ('00000000-0000-4000-8000-000000000001','before replay');
INSERT INTO glamp.card_images (id,card_id,object_key,name,content_type,size) VALUES
  ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001',
   'card-images/00000000-0000-4000-8000-000000000004','before.png','image/png',10);
INSERT INTO glamp.push_subscriptions VALUES ('fixture','{"auth":"test-only"}');
\ir ../sql/schema.sql
\ir ../sql/images.sql
\ir ../sql/push.sql

-- Example split deployment: only the migration role owns objects. The runtime
-- needs a role-specific RLS policy in addition to schema/table permissions.
GRANT USAGE ON SCHEMA glamp TO glamp_app;
GRANT SELECT, INSERT, UPDATE ON glamp.cards TO glamp_app;
GRANT SELECT, INSERT ON glamp.card_images TO glamp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON glamp.push_subscriptions TO glamp_app;
SET ROLE glamp_app;
DO $$ BEGIN
  INSERT INTO glamp.push_subscriptions VALUES ('no-policy','{}');
  RAISE EXCEPTION 'Grants alone unexpectedly allowed insert without a backend policy';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: grants alone are insufficient for non-owner';
END $$;
SET ROLE glamp_owner;
CREATE POLICY backend_subscriptions ON glamp.push_subscriptions FOR ALL TO glamp_app
  USING (true) WITH CHECK (true);

SET ROLE glamp_app;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM glamp.cards WHERE title = 'before replay') OR NOT EXISTS (
    SELECT FROM glamp.card_images WHERE name = 'before.png'
  ) OR NOT EXISTS (SELECT FROM glamp.push_subscriptions WHERE subscription->>'auth' = 'test-only') THEN RAISE EXCEPTION 'Lost data or app cannot read after replay'; END IF;
END $$;
INSERT INTO glamp.cards (id,title) VALUES ('00000000-0000-4000-8000-000000000002','app write');
INSERT INTO glamp.card_images (id,card_id,object_key,name,content_type,size) VALUES
  ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',
   'card-images/00000000-0000-4000-8000-000000000003','fixture.png','image/png',10);
UPDATE glamp.cards SET status = 'done' WHERE title = 'app write';
SET ROLE glamp_owner;
DELETE FROM glamp.cards WHERE status = 'done';
SET ROLE glamp_app;
DO $$ BEGIN
  IF EXISTS (SELECT FROM glamp.card_images WHERE name = 'fixture.png') THEN
    RAISE EXCEPTION 'Image FK cascade failed';
  END IF;
END $$;
INSERT INTO glamp.push_subscriptions VALUES ('second','{}');
DELETE FROM glamp.push_subscriptions WHERE id = 'second';
INSERT INTO glamp.push_subscriptions VALUES ('fixture','{"auth":"updated"}')
  ON CONFLICT (id) DO UPDATE SET subscription = EXCLUDED.subscription;
DO $$ BEGIN
  IF (SELECT count(*) FROM glamp.push_subscriptions) <> 1 OR NOT EXISTS (
    SELECT FROM glamp.push_subscriptions WHERE subscription->>'auth' = 'updated'
  ) THEN RAISE EXCEPTION 'App subscription lifecycle failed'; END IF;
END $$;

SET ROLE unrelated;
DO $$ BEGIN
  PERFORM subscription FROM glamp.push_subscriptions;
  RAISE EXCEPTION 'Unrelated role unexpectedly has access';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: unrelated role denied (42501)';
END $$;
-- Simulate a reader with explicit ACLs: RLS should still hide the seeded row.
SET ROLE glamp_owner;
GRANT USAGE ON SCHEMA glamp TO unrelated;
GRANT SELECT ON glamp.push_subscriptions TO unrelated;
SET ROLE unrelated;
DO $$ BEGIN
  IF EXISTS (SELECT subscription FROM glamp.push_subscriptions) THEN
    RAISE EXCEPTION 'Unrelated reader can see subscription secrets';
  END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT array_agg(legacy_marker) FROM public.cards) IS DISTINCT FROM ARRAY['unchanged'] OR EXISTS (
    SELECT FROM pg_tables WHERE schemaname='public' AND tablename <> 'cards'
  ) THEN RAISE EXCEPTION 'public schema was modified'; END IF;
END $$;
\echo PASS: migration replay, isolated public.cards, backend writes, FK cascade and subscription isolation
