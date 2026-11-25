#!/bin/sh
# Run as a non-root user with initdb, pg_ctl and psql on PATH.
# No URL, .env or existing database is used. The cluster listens only on a
# Unix socket inside the mode-0700 temporary directory.
set -eu
scripts=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d /var/tmp/glamp-schema.XXXXXXXX)
pg() { env -i PATH="$PATH" LC_ALL=C "$@"; }
cleanup() {
  if [ -f "$scratch/data/postmaster.pid" ]; then
    pg pg_ctl -w -D "$scratch/data" -m immediate stop >/dev/null || return 1
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
pg initdb -D "$scratch/data" -U postgres --encoding=UTF8 --no-locale --auth-local=trust --auth-host=reject >/dev/null
pg pg_ctl -w -D "$scratch/data" -l "$scratch/postgres.log" \
  -o "-c listen_addresses='' -c unix_socket_directories=$scratch -c cluster_name=glamp_schema_smoke -p 5432" start >/dev/null
pg psql -X -w -h "$scratch" -p 5432 -U postgres -d postgres -f "$scripts/check-schema.sql"
