// Shared by every server-side store. Prefer an explicit deployment override,
// then Vercel's Neon connection string, then the direct connection aliases.
export const databaseUrlKeys = Object.freeze([
  'DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING',
]);
export function databaseUrl(env = process.env) {
  for (const key of databaseUrlKeys) {
    const url = env[key]?.trim();
    if (url) return url;
  }
}
