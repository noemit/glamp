#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';
import { basename, extname } from 'node:path';
import { debuglog, parseArgs } from 'node:util';

const statuses = ['open', 'review', 'done'];
const imageTypes = new Map(Object.entries({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
}));
const help = `Usage: glamp [--json] <command> [arguments]

  help                       Show this help (offline)
  schema                     Describe the card model as JSON Schema (offline)
  list                       List cards
  search <keywords...>       Find cards matching a query
  read <id>                  Read a full card, including its Markdown body
  put <file.md> [options]    Create a card from a Markdown file
  update <id> [file.md] [options]
                             Patch only the body and/or options supplied
  status <id> open|review|done
                             Change only the status
  attach <id> <image>        Attach a PNG, JPEG or WebP file
  images [list] <id>         List images on a card

Card options (put/update):
  --title TEXT               Default on create: first # heading or file stem
  --status open|review|done  Default on create: open
  --task | --no-task         Mark as a task or a note (default: note)
  --start YYYY-MM-DD         Starting date; use none to clear
  --end YYYY-MM-DD           Ending date; use none to clear

Set GLAMP_TOKEN in your environment, not in command arguments. GLAMP_URL
(default http://localhost:3000) must use HTTPS except on loopback.
--json may appear before or after the command. Success writes one JSON
value to stdout; errors write {"error":"..."} to stderr and exit nonzero.`;

const dateField = { type: ['string', 'null'], format: 'date' };
const timestamp = { type: 'string', format: 'date-time', readOnly: true };
const properties = {
  id: { type: 'string', format: 'uuid', readOnly: true },
  title: { type: 'string', minLength: 1, maxLength: 200 },
  body: { type: 'string', description: 'Markdown source', maxLength: 20_000 },
  status: { type: 'string', enum: statuses, default: 'open' },
  isTask: { type: 'boolean', default: false },
  startingDate: dateField, endingDate: dateField,
  createdAt: timestamp, updatedAt: timestamp,
};
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Glamp card', type: 'object', properties, required: Object.keys(properties),
};

// Only these messages may be printed: native errors can contain URLs, paths,
// argument values and headers. Likewise, never print an HTTP error body.
class CliError extends Error {}
function fail(message) { throw new CliError(message); }
function requireArgs(ok) {
  if (!ok) fail('Invalid arguments. See glamp help for usage.');
}

const cardOptions = {
  title: { type: 'string' }, status: { type: 'string' }, task: { type: 'boolean' },
  'no-task': { type: 'boolean' }, start: { type: 'string' }, end: { type: 'string' },
};
function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...cardOptions,
    } });
  } catch { fail('Invalid option or missing option value. See glamp help.'); }
  const { help: showHelp, json, ...options } = parsed.values;
  const [name = 'help', ...args] = parsed.positionals;
  const command = showHelp ? 'help' : name;
  requireArgs(showHelp || command === 'put' || command === 'update' || !Object.keys(options).length);
  return { command, args: showHelp ? [] : args, options, json };
}

function connection() {
  const token = process.env.GLAMP_TOKEN;
  if (!token || /[^\x21-\x7e]/.test(token)) fail('Set GLAMP_TOKEN to a valid bearer token.');
  if (['http', 'https', 'net', 'tls'].some(key => debuglog(key).enabled)) {
    fail('Disable Node transport debugging before using credentials.');
  }
  let base;
  try { base = new URL(process.env.GLAMP_URL ?? 'http://localhost:3000'); }
  catch { fail('GLAMP_URL must be an absolute HTTP(S) URL.'); }
  if (base.username || base.password || base.search || base.hash) {
    fail('GLAMP_URL must not contain credentials, a query or a fragment.');
  }
  const host = base.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || (isIPv4(host) && host.startsWith('127.'));
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    fail('GLAMP_URL must use HTTPS (HTTP is permitted only on loopback).');
  }
  return { token, base };
}

// Never let a DNS resolver redirect plaintext localhost traffic off-machine.
function localLookup(_host, { all }, cb) {
  if (all) cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  else cb(null, '127.0.0.1', 4);
}

async function request({ base, token }, route, { method = 'GET', query, body, headers = {} } = {}) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + route;
  if (query !== undefined) url.searchParams.set('q', query);
  try {
    // Native http(s) does not follow redirects. A one-shot agent makes a
    // direct connection rather than inheriting an environment proxy agent.
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method, agent: false, rejectUnauthorized: true, signal: AbortSignal.timeout(30_000),
      lookup: client === http && url.hostname === 'localhost' ? localLookup : undefined,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...headers },
    });
    const response = new Promise((resolve, reject) => {
      req.once('response', resolve);
      req.on('error', reject); // An abort can also emit after headers arrive.
    });
    req.end(body);
    const res = await response;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.destroy();
      fail(`Glamp API returned HTTP ${res.statusCode}.`);
    }
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('Glamp API did not return valid JSON.'); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail('Could not contact the Glamp API or read its response. Check GLAMP_URL and the server.');
  }
}

function cardPath(id) {
  if (id.length !== 36 || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) fail('Card id must be a UUID.');
  return `/api/cards/${id}`;
}
function date(value) {
  if (value === 'none') return null;
  if (value.length === 10 && !value.startsWith('0000') && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value) return value;
  }
  fail('Dates must be valid YYYY-MM-DD values (or none).');
}
function validateText(key, value) {
  const { maxLength } = properties[key];
  if (value.includes('\0') || !value.isWellFormed()) fail(`Invalid text in ${key}.`);
  if (value.length > 2 * maxLength || [...value].length > maxLength) {
    fail(`Card ${key} cannot exceed ${maxLength} characters.`);
  }
}
function cardFields(options) {
  const fields = {};
  if (options.title !== undefined) {
    fields.title = options.title.trim();
    if (!fields.title) fail('Title cannot be blank.');
  }
  if (options.status !== undefined) {
    if (!statuses.includes(options.status)) fail('Status must be open, review or done.');
    fields.status = options.status;
  }
  if (options.task && options['no-task']) fail('Choose either --task or --no-task.');
  if (options.task || options['no-task']) fields.isTask = Boolean(options.task);
  if (options.start !== undefined) fields.startingDate = date(options.start);
  if (options.end !== undefined) fields.endingDate = date(options.end);
  if (fields.startingDate && fields.endingDate && fields.startingDate > fields.endingDate) {
    fail('Starting date cannot be later than ending date.');
  }
  return fields;
}
async function contents(file, encoding) {
  try { return await readFile(file, encoding); }
  catch { fail('Cannot read input file. Check its path and permissions.'); }
}
function sendJson(method, value) {
  return { method, body: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

async function run(command, args, options) {
  const [id, file] = args;
  switch (command) {
    case 'help':
    case 'schema':
      requireArgs(!args.length);
      return command === 'schema' ? schema : { help };
    case 'list':
    case 'search': {
      const query = args.join(' ').trim();
      requireArgs(command === 'list' ? !args.length : query.length > 0);
      return request(connection(), '/api/cards', { query: query || undefined });
    }
    case 'read':
      requireArgs(args.length === 1);
      return request(connection(), cardPath(id));
    case 'put':
    case 'update': {
      const create = command === 'put';
      requireArgs(create ? args.length === 1 : args.length >= 1 && args.length <= 2);
      const route = create ? '/api/cards' : cardPath(id);
      const input = create ? args[0] : file;
      const fields = cardFields(options);
      if (input !== undefined) {
        if (extname(input).toLowerCase() !== '.md') fail('Expected a Markdown (.md) input file.');
        fields.body = await contents(input, 'utf8');
        if (create && !fields.title) {
          fields.title = /^#[ \t]+([^\r\n]+)/m.exec(fields.body)?.[1].trim() || basename(input, extname(input));
        }
      }
      requireArgs(Object.keys(fields).length > 0);
      for (const key of ['title', 'body']) if (key in fields) validateText(key, fields[key]);
      return request(connection(), route, sendJson(create ? 'POST' : 'PATCH', fields));
    }
    case 'status':
      requireArgs(args.length === 2);
      return request(connection(), cardPath(id), sendJson('PATCH', cardFields({ status: args[1] })));
    case 'attach': {
      requireArgs(args.length === 2);
      const route = `${cardPath(id)}/images`;
      const mime = imageTypes.get(extname(file).toLowerCase());
      if (!mime) fail('Expected a PNG, JPEG or WebP file.');
      return request(connection(), route, { method: 'POST', body: await contents(file), headers: {
        'content-type': mime, 'x-filename': encodeURIComponent(basename(file)),
      } });
    }
    case 'images':
      requireArgs(args.length === 1 || (id === 'list' && args.length === 2));
      return request(connection(), `${cardPath(args.at(-1))}/images`);
    default: fail('Unknown command. See glamp help.');
  }
}

function format(command, result, json) {
  // Validate the envelope even in --json mode: a proxy's JSON error delivered
  // with HTTP 200 must not look like a successful card read or write.
  if (['list', 'search', 'images'].includes(command)) {
    if (!Array.isArray(result?.[command === 'images' ? 'images' : 'cards'])) fail('Invalid list response from Glamp API.');
  } else if (['read', 'put', 'update', 'status', 'attach'].includes(command)) {
    const item = result?.[command === 'attach' ? 'image' : 'card'];
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Invalid object response from Glamp API.');
  }
  if (json || ['schema', 'images', 'attach'].includes(command)) return JSON.stringify(result, null, json ? 0 : 2);
  if (command === 'help') return result.help;
  if (result.cards) return result.cards.map(c => `${c.id}\t${c.status}\t${c.title}`).join('\n') || 'No cards.';
  const c = result.card;
  const meta = [c.id, c.status, c.isTask && 'task', c.startingDate && `start ${c.startingDate}`, c.endingDate && `end ${c.endingDate}`];
  return `${c.title}\n${meta.filter(Boolean).join(' · ')}\n\n${c.body}`;
}

const argv = process.argv.slice(2);
let machine = argv.includes('--json'); // also format option-parsing failures
try {
  const { command, args, options, json } = parse(argv);
  machine = json;
  const result = await run(command, args, options);
  const formatted = format(command, result, json);
  const output = json ? formatted : formatted.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  // Don't print an accidental token reflection, even in a successful response.
  // Fail closed rather than applying a text replacement that could corrupt JSON.
  const token = process.env.GLAMP_TOKEN;
  if (token && (output.includes(token) || output.includes(JSON.stringify(token).slice(1, -1)))) {
    fail('Output withheld: it contains the configured credential.');
  }
  process.stdout.write(output + '\n');
} catch (error) {
  const message = error instanceof CliError ? error.message : 'Unexpected CLI error.';
  process.stderr.write((machine ? JSON.stringify({ error: message }) : `glamp: ${message}`) + '\n');
  process.exitCode = 1;
}
