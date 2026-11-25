// Shared by every server-side store. Prefer an explicit deployment override,
// then Vercel's Neon connection strings, then assembled PG*/POSTGRES_* parts.
const urlKeys = Object.freeze([
  'DATABASE_URL',
  'POSTGRES_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
]);
const partKeys = Object.freeze([
  'PGHOST', 'POSTGRES_HOST', 'PGHOST_UNPOOLED',
  'PGUSER', 'POSTGRES_USER',
  'PGPASSWORD', 'POSTGRES_PASSWORD',
  'PGDATABASE', 'POSTGRES_DATABASE',
  'PGPORT', 'POSTGRES_PORT',
]);
export const databaseUrlKeys = Object.freeze([...urlKeys, ...partKeys]);

function cleanValue(raw) {
  let value = raw?.trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function normalizeUrl(raw, key) {
  const value = cleanValue(raw);
  if (!value) return '';
  if (key === 'POSTGRES_PRISMA_URL') {
    try {
      const parsed = new URL(value);
      if (parsed.searchParams.has('pgbouncer')) {
        parsed.searchParams.delete('pgbouncer');
        return parsed.href;
      }
    } catch {
      return value;
    }
  }
  return value;
}

function assembledUrl(env) {
  const host = cleanValue(env.PGHOST) || cleanValue(env.POSTGRES_HOST) || cleanValue(env.PGHOST_UNPOOLED);
  const user = cleanValue(env.PGUSER) || cleanValue(env.POSTGRES_USER);
  const password = cleanValue(env.PGPASSWORD) || cleanValue(env.POSTGRES_PASSWORD);
  const database = cleanValue(env.PGDATABASE) || cleanValue(env.POSTGRES_DATABASE);
  const port = cleanValue(env.PGPORT) || cleanValue(env.POSTGRES_PORT);
  if (!host || !user || !password || !database) return undefined;
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  const authority = port ? `${host}:${port}` : host;
  return `postgresql://${auth}@${authority}/${encodeURIComponent(database)}?sslmode=require`;
}

export function databaseUrl(env = process.env) {
  for (const key of urlKeys) {
    const url = normalizeUrl(env[key], key);
    if (url) return url;
  }
  return assembledUrl(env);
}
