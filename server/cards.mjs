import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const defaults = { body: '', status: 'open', isTask: false, startingDate: null, endingDate: null };
const editable = new Set(['title', ...Object.keys(defaults)]);
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const validId = id => typeof id === 'string' && id.length === 36 && uuid.test(id);
class CardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function invalid(message) { throw new CardError(400, message); }

function checkText(value, name, max) {
  // PostgreSQL text cannot represent U+0000 or unpaired surrogates.
  if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed() || [...value].length > max) {
    invalid(`${name} must be text of at most ${max} characters.`);
  }
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
  for (const name of ['startingDate', 'endingDate']) if (Object.hasOwn(result, name)) checkDate(result[name], name);
  return result;
}
function checkRange({ startingDate, endingDate }) {
  if (startingDate && endingDate && startingDate > endingDate) invalid('endingDate cannot precede startingDate.');
}

// Neon uses its HTTP driver (no long-lived client); migrations are explicit.
// SQLite is strictly for dev/test. Never switch stores on a connection failure.
async function openStore() {
  if (process.env.DATABASE_URL) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    return {
      query: (statement, params) => sql.query(statement, params),
      dates: "to_char(starting_date, 'YYYY-MM-DD') AS starting_date, to_char(ending_date, 'YYYY-MM-DD') AS ending_date",
      table: 'glamp.cards', contains: 'strpos', now: 'statement_timestamp()', boolean: value => value,
    };
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new CardError(503, 'DATABASE_URL is required for a deployed workspace.');
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
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        body TEXT NOT NULL CHECK (length(body) <= 20000), status TEXT NOT NULL CHECK (status IN ('open','review','done')),
        is_task INTEGER NOT NULL CHECK (is_task IN (0,1)), starting_date TEXT, ending_date TEXT,
        created_at TEXT NOT NULL DEFAULT (${now}), updated_at TEXT NOT NULL DEFAULT (${now}),
        revision INTEGER NOT NULL DEFAULT 0, CHECK (starting_date <= ending_date)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cards_updated_id_idx ON cards(updated_at DESC, id);`);
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
    dates: 'starting_date, ending_date', table: 'cards', contains: 'instr', now, boolean: Number,
  };
}
let store;
export function initStore() {
  return store ??= openStore().catch(err => { store = undefined; throw err; });
}
const columns = db => `id, title, body, status, is_task, ${db.dates}, created_at, updated_at, revision`;
function toCard(row) {
  return {
    id: row.id, title: row.title, body: row.body, status: row.status, isTask: Boolean(row.is_task),
    startingDate: row.starting_date, endingDate: row.ending_date,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}
const values = (db, c) => [c.title, c.body, c.status, db.boolean(c.isTask), c.startingDate, c.endingDate];
async function getRow(db, id) {
  if (!validId(id)) invalid('Invalid card UUID.');
  const [row] = await db.query(`SELECT ${columns(db)} FROM ${db.table} WHERE id = $1`, [id.toLowerCase()]);
  if (!row) throw new CardError(404, 'Card not found.');
  return row;
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

export const cardsRouter = express.Router();
cardsRouter.get('/', async (req, res) => {
  const q = req.query.q ?? '';
  checkText(q, 'q', 200);
  const db = await initStore();
  const term = q.trim();
  // No LIKE patterns, regexes or full-text syntax: all punctuation is literal.
  const where = term ? `WHERE ${db.contains}(lower(title), lower($1)) > 0 OR ${db.contains}(lower(body), lower($1)) > 0` : '';
  const rows = await db.query(`SELECT ${columns(db)} FROM ${db.table} ${where} ORDER BY updated_at DESC, id`, term ? [term] : []);
  res.json({ cards: rows.map(toCard) });
});
cardsRouter.get('/:id', async (req, res) => res.json({ card: toCard(await getRow(await initStore(), req.params.id)) }));
const parseJson = express.json({ limit: '128kb' });
cardsRouter.post('/', parseJson, async (req, res) => {
  const card = { ...defaults, ...changes(req.body) };
  if (!card.title) invalid('A nonblank title is required.');
  checkRange(card);
  const db = await initStore();
  const [row] = await db.query(`INSERT INTO ${db.table} (id, title, body, status, is_task, starting_date, ending_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns(db)}`, [randomUUID(), ...values(db, card)]);
  const saved = toCard(row);
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
      starting_date = $5, ending_date = $6, updated_at = ${db.now}, revision = revision + 1
      WHERE id = $7 AND revision = $8 RETURNING ${columns(db)}`, [...values(db, card), old.id, old.revision]);
    if (!row) continue;
    const saved = toCard(row);
    if (old.status !== 'review' && saved.status === 'review') await notifyReview(req, saved);
    return res.json({ card: saved });
  }
  throw new CardError(409, 'Card changed concurrently. Please retry the edit.');
});
cardsRouter.use((err, _req, res, next) => {
  if (err instanceof CardError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  next(err);
});
