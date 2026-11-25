import { databaseUrl } from './database-url.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const defaults = { body: '', status: 'open', isTask: false, startingDate: null, endingDate: null, author: null };
const editable = new Set(['title', ...Object.keys(defaults)]);
const agentColors = ['slate', 'sky', 'green', 'amber', 'rose', 'teal'];
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const validId = id => typeof id === 'string' && id.length === 36 && uuid.test(id);
class CardError extends Error {
  constructor(status, message) { super(message); this.status = status; this.publicMessage = message; }
}
function invalid(message) { throw new CardError(400, message); }

function checkText(value, name, max) {
  // PostgreSQL text cannot represent U+0000 or unpaired surrogates.
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || [...value].length > max) {
    invalid(`${name} must be text of at most ${max} characters.`);
  }
}
function checkAuthor(value, name = 'author', required = false) {
  if (value === null || value === undefined) {
    if (required) invalid(`A nonblank ${name} is required.`);
    return null;
  }
  checkText(value, name, 60);
  if (/[\x00-\x1f\x7f]/u.test(value)) invalid(`${name} cannot contain control characters.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) invalid(`A nonblank ${name} is required.`);
    return null;
  }
  return trimmed;
}
function headerAuthor(req) {
  const raw = req.get('x-agent-name');
  if (raw === undefined || !raw.trim()) return null;
  return checkAuthor(raw, 'x-agent-name', false);
}
function defaultColorFor(name) {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return agentColors[hash % agentColors.length];
}
function checkDate(value, name) {
  if (value === null) return;
  if (typeof value === 'string' && value.length === 10 && /^\d{4}-\d\d-\d\d$/.test(value) && !value.startsWith('0000')) {
    const d = new Date(value + 'T00:00:00Z');
    if (Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value) return;
  }
  invalid(`${name} must be null or a calendar date (YYYY-MM-DD).`);
}
function changes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON object.');
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !editable.has(key))) invalid('Supply only editable card fields, at least one.');
  const result = { ...input };
  if (Object.hasOwn(result, 'title')) {
    checkText(result.title, 'title', 200);
    result.title = result.title.trim();
    if (!result.title) invalid('A nonblank title is required.');
  }
  if (Object.hasOwn(result, 'body')) checkText(result.body, 'body', 20000);
  if (Object.hasOwn(result, 'status') && !['open', 'review', 'done'].includes(result.status)) invalid('Invalid status.');
  if (Object.hasOwn(result, 'isTask') && typeof result.isTask !== 'boolean') invalid('isTask must be boolean.');
  if (Object.hasOwn(result, 'author')) result.author = checkAuthor(result.author, 'author', false);
  for (const name of ['startingDate', 'endingDate']) if (Object.hasOwn(result, name)) checkDate(result[name], name);
  return result;
}
function checkRange({ startingDate, endingDate }) {
  if (startingDate && endingDate && startingDate > endingDate) invalid('endingDate cannot precede startingDate.');
}

// Neon uses its HTTP driver (no long-lived client); migrations are explicit.
// SQLite is strictly for dev/test. Never switch stores on a connection failure.
async function openStore() {
  const url = databaseUrl();
  if (url) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(url);
    return {
      query: (statement, params) => sql.query(statement, params),
      dates: "to_char(starting_date, 'YYYY-MM-DD') AS starting_date, to_char(ending_date, 'YYYY-MM-DD') AS ending_date",
      table: 'glamp.cards', commentsTable: 'glamp.card_comments', profilesTable: 'glamp.agent_profiles',
      contains: 'strpos', now: 'statement_timestamp()', boolean: value => value,
    };
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new CardError(503, 'A Neon connection string (POSTGRES_URL or DATABASE_URL) is required for a deployed workspace.');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.resolve(process.env.GLAMP_DATA_DIR || '.glamp');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Also keep new database files private when the chosen directory already exists.
  const file = path.join(dir, 'cards.sqlite');
  await (await open(file, 'a', 0o600)).close();
  const db = new DatabaseSync(file);
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        body TEXT NOT NULL CHECK (length(body) <= 20000), status TEXT NOT NULL CHECK (status IN ('open','review','done')),
        is_task INTEGER NOT NULL CHECK (is_task IN (0,1)), starting_date TEXT, ending_date TEXT,
        author TEXT CHECK (author IS NULL OR length(author) BETWEEN 1 AND 60),
        created_at TEXT NOT NULL DEFAULT (${now}), updated_at TEXT NOT NULL DEFAULT (${now}),
        revision INTEGER NOT NULL DEFAULT 0, CHECK (starting_date <= ending_date)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cards_updated_id_idx ON cards(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS agent_profiles (
        name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 60),
        role TEXT NOT NULL DEFAULT '' CHECK (length(role) <= 120),
        color TEXT NOT NULL DEFAULT 'slate' CHECK (color IN ('slate','sky','green','amber','rose','teal')),
        updated_at TEXT NOT NULL DEFAULT (${now})
      ) STRICT;
      CREATE TABLE IF NOT EXISTS card_comments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 60),
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
        created_at TEXT NOT NULL DEFAULT (${now})
      ) STRICT;
      CREATE INDEX IF NOT EXISTS card_comments_card_created_idx ON card_comments(card_id, created_at, id);`);
    const cols = db.prepare('PRAGMA table_info(cards)').all();
    if (!cols.some(c => c.name === 'author')) {
      db.exec('ALTER TABLE cards ADD COLUMN author TEXT;');
    }
    // SQLite's built-in lower() only folds ASCII.
    db.function('lower', { deterministic: true }, s => s.toLowerCase());
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    query(statement, params = []) {
      const bindings = Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p]));
      return db.prepare(statement).all(bindings);
    },
    dates: 'starting_date, ending_date', table: 'cards', commentsTable: 'card_comments',
    profilesTable: 'agent_profiles', contains: 'instr', now, boolean: Number,
  };
}
let store;
export function initStore() {
  return store ??= openStore().catch(err => { store = undefined; throw err; });
}
const columns = db => `id, title, body, status, is_task, ${db.dates}, author, created_at, updated_at, revision`;
function uniqueContributors(cardAuthor, commentAuthors = []) {
  const seen = new Set();
  const list = [];
  for (const name of [cardAuthor, ...commentAuthors]) {
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
  return list;
}
function toCard(row, commentAuthors = []) {
  return {
    id: row.id, title: row.title, body: row.body, status: row.status, isTask: Boolean(row.is_task),
    startingDate: row.starting_date, endingDate: row.ending_date, author: row.author ?? null,
    contributors: uniqueContributors(row.author ?? null, commentAuthors),
    commentCount: commentAuthors.length,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}
function toComment(row) {
  return {
    id: row.id, cardId: row.card_id, author: row.author, body: row.body,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
const values = (db, c) => [c.title, c.body, c.status, db.boolean(c.isTask), c.startingDate, c.endingDate, c.author];
async function getRow(db, id) {
  if (!validId(id)) invalid('Invalid card UUID.');
  const [row] = await db.query(`SELECT ${columns(db)} FROM ${db.table} WHERE id = $1`, [id.toLowerCase()]);
  if (!row) throw new CardError(404, 'Card not found.');
  return row;
}
async function commentAuthorsFor(db, cardId) {
  const rows = await db.query(
    `SELECT author FROM ${db.commentsTable} WHERE card_id = $1 ORDER BY created_at, id`,
    [cardId.toLowerCase()],
  );
  return rows.map(r => r.author);
}
async function ensureProfile(db, name) {
  if (!name || name.toLowerCase() === 'owner') return;
  await db.query(
    `INSERT INTO ${db.profilesTable} (name, role, color) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
    [name, '', defaultColorFor(name)],
  );
}
export async function cardExists(id) {
  if (!validId(id)) return false;
  const db = await initStore();
  const rows = await db.query(`SELECT 1 FROM ${db.table} WHERE id = $1`, [id.toLowerCase()]);
  return rows.length !== 0;
}
async function notifyReview(req, card) {
  // Await the hook so serverless runtimes don't freeze it after the response.
  // The write already committed: a delivery failure must not invite a retry.
  try { await req.app.locals.notifyReview?.({ ...card }); }
  catch { console.warn('Card saved; review notification failed.'); }
}

const dbSetupErrors = new Map([
  ['42P01', 'Glamp cannot find its cards table. Run sql/schema.sql in the Neon database and branch connected to this deployment.'],
  ['3F000', 'Glamp cannot find its schema. Run sql/schema.sql in the Neon database and branch connected to this deployment.'],
  ['42501', 'The connected database role lacks the required permission for glamp.cards. Check the schema and table grants in sql/access.example.sql.'],
  ['42703', 'The cards table does not match this version of Glamp. Run the latest sql/schema.sql in Neon to add new columns.'],
  ['28P01', 'Neon rejected the database credentials. Check the Production database connection in Vercel.'],
  ['28000', 'Neon refused database access. Check the Production database connection in Vercel.'],
  ['3D000', 'Neon cannot find the database named in the connection string. Check the database selected for this deployment.'],
  ['08001', 'Glamp could not connect to the Neon database. Check POSTGRES_URL and that the Neon branch is active.'],
  ['08006', 'The connection to Neon closed unexpectedly. Retry or check the Neon branch status.'],
  ['53300', 'Neon has too many active connections. Use the pooled POSTGRES_URL connection string.'],
  ['57P01', 'The Neon compute restarted or suspended during the request. Please retry.'],
  ['57P03', 'The Neon database is still starting up. Please retry in a moment.'],
  ['XX000', 'Neon reported an endpoint or compute error. Check that the connected Neon project and branch are active.'],
]);
function neonErrorDiagnostic(err) {
  const mapped = dbSetupErrors.get(err.code);
  if (mapped) return { tag: err.code, message: mapped };
  if (err.sourceError) {
    return { tag: 'transport', message: 'Glamp could not reach Neon. Check the database connection for this deployment and retry.' };
  }
  const msg = typeof err.message === 'string' ? err.message : '';
  if (/not a valid URL|Wrong URL scheme|missing user, host or database/i.test(msg)) {
    return { tag: 'invalid-url', message: 'The database connection string is invalid. Check POSTGRES_URL or DATABASE_URL in Vercel.' };
  }
  const httpStatus = msg.match(/Server error \(HTTP status (\d{3})\)/i)?.[1];
  if (httpStatus) {
    return {
      tag: `http-${httpStatus}`,
      message: `Neon rejected the SQL request (HTTP ${httpStatus}). Check that POSTGRES_URL points to an active Neon branch and valid credentials.`,
    };
  }
  return {
    tag: err.code || 'neon',
    message: 'Glamp encountered a Neon database error. Check the Vercel database connection and that sql/schema.sql has been applied.',
  };
}
function handleDbError(err, _req, res, next) {
  if (err.name === 'NeonDbError') {
    const diag = neonErrorDiagnostic(err);
    console.error('Glamp cards database error:', diag.tag);
    return res.status(503).json({ error: diag.message });
  }
  if (err instanceof CardError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  next(err);
}

export const cardsRouter = express.Router();
cardsRouter.get('/', async (req, res) => {
  const q = req.query.q ?? '';
  checkText(q, 'q', 200);
  const authorFilter = req.query.author === undefined ? null : checkAuthor(String(req.query.author), 'author', false);
  const db = await initStore();
  const term = q.trim();
  // No LIKE patterns, regexes or full-text syntax: all punctuation is literal.
  const where = term ? `WHERE ${db.contains}(lower(title), lower($1)) > 0 OR ${db.contains}(lower(body), lower($1)) > 0` : '';
  const rows = await db.query(`SELECT ${columns(db)} FROM ${db.table} ${where} ORDER BY updated_at DESC, id`, term ? [term] : []);
  const byCard = new Map();
  if (rows.length) {
    const comments = await db.query(`SELECT card_id, author FROM ${db.commentsTable} ORDER BY created_at, id`, []);
    for (const c of comments) {
      let arr = byCard.get(c.card_id);
      if (!arr) { arr = []; byCard.set(c.card_id, arr); }
      arr.push(c.author);
    }
  }
  let cards = rows.map(row => toCard(row, byCard.get(row.id) ?? []));
  if (authorFilter) {
    const target = authorFilter.toLowerCase();
    cards = cards.filter(c => c.contributors.some(name => name.toLowerCase() === target));
  }
  res.json({ cards });
});
cardsRouter.get('/:id', async (req, res) => {
  const db = await initStore();
  const row = await getRow(db, req.params.id);
  const authors = await commentAuthorsFor(db, row.id);
  res.json({ card: toCard(row, authors) });
});
const parseJson = express.json({ limit: '128kb' });
cardsRouter.post('/', parseJson, async (req, res) => {
  const card = { ...defaults, ...changes(req.body) };
  if (!card.title) invalid('A nonblank title is required.');
  if (!card.author) card.author = headerAuthor(req);
  checkRange(card);
  const db = await initStore();
  const [row] = await db.query(`INSERT INTO ${db.table} (id, title, body, status, is_task, starting_date, ending_date, author)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${columns(db)}`, [randomUUID(), ...values(db, card)]);
  await ensureProfile(db, row.author);
  const saved = toCard(row, []);
  if (saved.status === 'review') await notifyReview(req, saved);
  res.status(201).json({ card: saved });
});
cardsRouter.patch('/:id', parseJson, async (req, res) => {
  const edit = changes(req.body);
  const db = await initStore();
  // Compare-and-swap protects merged date validation, unrelated edits and the
  // old status used for notification, including across serverless instances.
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await getRow(db, req.params.id);
    const card = { ...toCard(old), ...edit };
    checkRange(card);
    const [row] = await db.query(`UPDATE ${db.table} SET title = $1, body = $2, status = $3, is_task = $4,
      starting_date = $5, ending_date = $6, author = $7, updated_at = ${db.now}, revision = revision + 1
      WHERE id = $8 AND revision = $9 RETURNING ${columns(db)}`, [...values(db, card), old.id, old.revision]);
    if (!row) continue;
    await ensureProfile(db, row.author);
    const authors = await commentAuthorsFor(db, row.id);
    const saved = toCard(row, authors);
    if (old.status !== 'review' && saved.status === 'review') await notifyReview(req, saved);
    return res.json({ card: saved });
  }
  throw new CardError(409, 'Card changed concurrently. Please retry the edit.');
});
cardsRouter.get('/:id/comments', async (req, res) => {
  const db = await initStore();
  const row = await getRow(db, req.params.id);
  const comments = await db.query(
    `SELECT id, card_id, author, body, created_at FROM ${db.commentsTable} WHERE card_id = $1 ORDER BY created_at, id`,
    [row.id],
  );
  res.json({ comments: comments.map(toComment) });
});
cardsRouter.post('/:id/comments', parseJson, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) invalid('Expected a JSON object.');
  const allowed = new Set(['body', 'author']);
  const keys = Object.keys(req.body);
  if (!keys.length || keys.some(k => !allowed.has(k))) invalid('Supply body and optional author.');
  checkText(req.body.body, 'body', 10000);
  const body = req.body.body.trim();
  if (!body) invalid('A nonblank comment body is required.');
  const suppliedAuthor = Object.hasOwn(req.body, 'author') ? checkAuthor(req.body.author, 'author', false) : headerAuthor(req);
  const author = suppliedAuthor || (req.role === 'owner' ? 'Owner' : null);
  if (!author) invalid('Provide an author name in body.author or the X-Agent-Name header.');
  const db = await initStore();
  const card = await getRow(db, req.params.id);
  const [row] = await db.query(
    `INSERT INTO ${db.commentsTable} (id, card_id, author, body) VALUES ($1, $2, $3, $4)
     RETURNING id, card_id, author, body, created_at`,
    [randomUUID(), card.id, author, body],
  );
  await ensureProfile(db, author);
  res.status(201).json({ comment: toComment(row) });
});
cardsRouter.use(handleDbError);

export const agentsRouter = express.Router();
agentsRouter.get('/', async (_req, res) => {
  const db = await initStore();
  const [profiles, cards, comments] = await Promise.all([
    db.query(`SELECT name, role, color, updated_at FROM ${db.profilesTable}`, []),
    db.query(`SELECT author, updated_at FROM ${db.table} WHERE author IS NOT NULL`, []),
    db.query(`SELECT author, created_at FROM ${db.commentsTable}`, []),
  ]);
  const map = new Map();
  const touch = (name, stamp) => {
    const key = name.toLowerCase();
    let entry = map.get(key);
    if (!entry) {
      entry = { name, role: '', color: defaultColorFor(name), cardCount: 0, commentCount: 0, lastActiveAt: null };
      map.set(key, entry);
    }
    if (stamp) {
      const iso = new Date(stamp).toISOString();
      if (!entry.lastActiveAt || iso > entry.lastActiveAt) entry.lastActiveAt = iso;
    }
    return entry;
  };
  for (const p of profiles) {
    const entry = touch(p.name, p.updated_at);
    entry.role = p.role || '';
    entry.color = agentColors.includes(p.color) ? p.color : defaultColorFor(p.name);
  }
  for (const c of cards) {
    if (!c.author) continue;
    touch(c.author, c.updated_at).cardCount++;
  }
  for (const cm of comments) {
    if (!cm.author) continue;
    touch(cm.author, cm.created_at).commentCount++;
  }
  const agents = [...map.values()].sort((a, b) =>
    (b.cardCount + b.commentCount) - (a.cardCount + a.commentCount) || a.name.localeCompare(b.name),
  );
  res.json({ agents });
});
async function saveProfile(req, res, explicitName) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) invalid('Expected a JSON object.');
  const allowed = new Set(['name', 'role', 'color']);
  if (Object.keys(req.body).some(k => !allowed.has(k))) invalid('Supply only name, role, and color.');
  const name = checkAuthor(explicitName ?? req.body.name ?? req.get('x-agent-name'), 'name', true);
  let role;
  if (Object.hasOwn(req.body, 'role')) {
    checkText(req.body.role, 'role', 120);
    role = req.body.role.trim();
  }
  let color;
  if (Object.hasOwn(req.body, 'color')) {
    if (typeof req.body.color !== 'string' || !agentColors.includes(req.body.color)) {
      invalid(`color must be one of: ${agentColors.join(', ')}.`);
    }
    color = req.body.color;
  }
  const db = await initStore();
  const [existing] = await db.query(`SELECT name, role, color FROM ${db.profilesTable} WHERE lower(name) = lower($1)`, [name]);
  const finalName = existing ? existing.name : name;
  const finalRole = role ?? existing?.role ?? '';
  const finalColor = color ?? existing?.color ?? defaultColorFor(finalName);
  const [row] = await db.query(
    `INSERT INTO ${db.profilesTable} (name, role, color, updated_at) VALUES ($1, $2, $3, ${db.now})
     ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role, color = EXCLUDED.color, updated_at = ${db.now}
     RETURNING name, role, color, updated_at`,
    [finalName, finalRole, finalColor],
  );
  res.json({
    agent: {
      name: row.name, role: row.role, color: row.color,
      updatedAt: new Date(row.updated_at).toISOString(),
    },
  });
}
agentsRouter.post('/', parseJson, (req, res) => saveProfile(req, res));
agentsRouter.put('/:name', parseJson, (req, res) => saveProfile(req, res, req.params.name));
agentsRouter.use(handleDbError);
