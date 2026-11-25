import { enablePush } from './push.js';

const $ = (id) => document.getElementById(id);
const dialog = $('dialog');
const statuses = { open: 'Ongoing', review: 'Review', done: 'Done' };
const views = {
  docs: { title: 'Notes', icon: 'book', addLabel: 'Add Notes' },
  todos: { title: 'To-dos', icon: 'task', addLabel: 'Add To-do' },
  board: { title: 'Board', icon: 'board', addLabel: 'Add Card' },
  calendar: { title: 'Calendar', icon: 'calendar', addLabel: 'Add Card' },
  archive: { title: 'Archive', icon: 'archive', addLabel: 'Add Notes' },
};
const state = {
  owner: false,
  epoch: 0,
  view: 'docs',
  cards: [],
  agents: new Map(),
  projects: [],
  project: 'all',
  loaded: false,
  loadError: '',
  month: new Date(),
  selectedDay: '',
  todoDay: '',
  filters: {
    type: 'all',
    time: 'all',
    status: 'all',
    agent: 'all',
  },
};
const agentColors = ['slate', 'sky', 'green', 'amber', 'rose', 'teal'];
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let listVersion = 0,
  sheetVersion = 0,
  authVersion = 0;
let searchTimer, toastTimer;
const sessionChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('glamp-session') : null;
const stale = Symbol('obsolete request');
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const uri = (id) => `/?card=${encodeURIComponent(id)}`;
const cardAPI = (id) => `/api/cards/${encodeURIComponent(id)}`;
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayKey = (d) =>
  `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localDate = (key) => new Date(`${key}T12:00:00`);
const offsetDay = (base, delta) => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta);
  return dayKey(d);
};

function displayDate(date) {
  return Number.isFinite(date.valueOf()) ? dateFormat.format(date) : '—';
}
function scheduleText(card) {
  const start = card.startingDate,
    end = card.endingDate;
  if (start && end && start !== end)
    return `${displayDate(localDate(start))} – ${displayDate(localDate(end))}`;
  return start || end ? `${start ? 'Scheduled' : 'Due'} ${displayDate(localDate(start || end))}` : '';
}
function cardTimeBucket(card, now = new Date()) {
  const start = card.startingDate || card.endingDate;
  const end = card.endingDate || card.startingDate;
  if (!start) return 'unscheduled';
  const today = dayKey(now);
  if (start <= today && today <= end) return 'today';
  if (start > today) return 'upcoming';
  return 'past';
}
function timePillInfo(card, now = new Date()) {
  const start = card.startingDate || card.endingDate;
  const end = card.endingDate || card.startingDate;
  if (!start) return null;
  const today = dayKey(now);
  const tomorrow = offsetDay(now, 1);
  const yesterday = offsetDay(now, -1);
  if (start <= today && today <= end) return { label: 'Today', cls: 'time-today' };
  if (start === tomorrow) return { label: 'Tomorrow', cls: 'time-tomorrow' };
  if (end === yesterday) return { label: 'Yesterday', cls: 'time-past' };
  if (start > today) return { label: 'Upcoming', cls: 'time-upcoming' };
  return { label: 'Past', cls: 'time-past' };
}

// Data is always inserted as text. No card, filename, status, or server error is HTML.
function node(tag, cls = '', text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'),
    use = document.createElementNS(ns, 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function button(label, onClick, cls = 'btn', glyph) {
  const b = node('button', cls);
  b.type = 'button';
  if (glyph) b.append(icon(glyph));
  if (label) b.append(label);
  b.addEventListener('click', onClick);
  return b;
}
function iconButton(label, glyph, click) {
  const b = button('', click, 'btn icon-only', glyph);
  b.setAttribute('aria-label', label);
  return b;
}
function cardLink(card, cls = 'card-title', label = card.title) {
  const a = node('a', cls, label);
  a.href = uri(card.id);
  a.dataset.card = card.id;
  return a;
}
function badge(status) {
  return node(
    'span',
    `status ${Object.hasOwn(statuses, status) ? status : 'open'}`,
    statuses[status] || 'Ongoing',
  );
}
function timePill(card) {
  const info = timePillInfo(card);
  return info ? node('span', `pill ${info.cls}`, info.label) : null;
}
function agentColor(name) {
  const profile = state.agents.get(name.toLowerCase());
  if (profile && agentColors.includes(profile.color)) return profile.color;
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return agentColors[hash % agentColors.length];
}
function initials(name) {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}
function avatarBadge(name, large = false) {
  const el = node('span', `avatar color-${agentColor(name)}${large ? ' lg' : ''}`, initials(name));
  const profile = state.agents.get(name.toLowerCase());
  el.title = profile?.role ? `${name} · ${profile.role}` : name;
  el.setAttribute('aria-hidden', 'true');
  return el;
}
function avatarStack(names) {
  const stack = node('span', 'avatar-stack');
  for (const name of names.slice(0, 4)) stack.append(avatarBadge(name));
  return stack;
}
function message(error) {
  return error instanceof TypeError
    ? 'Could not reach the workspace. Check your connection and try again.'
    : error?.message || 'Something went wrong. Please try again.';
}
function notify(text) {
  clearTimeout(toastTimer);
  $('notice').textContent = text;
  toastTimer = setTimeout(() => {
    $('notice').textContent = '';
  }, 5500);
}
function sheetMessage(text) {
  if (!$('doc-view').hidden && !dialog.open) $('doc-message').textContent = text;
  else $('dialog-message').textContent = text;
}
async function request(path, options = {}, privateData = true) {
  const epoch = state.epoch;
  if (privateData && !state.owner) throw stale;
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (epoch !== state.epoch) throw stale;
  if (privateData && (res.status === 401 || res.status === 403)) {
    lock('Your session has ended. Sign in to open the workspace again.');
    throw stale;
  }
  if (!res.ok)
    throw new Error(
      typeof data?.error === 'string' ? data.error : `Request failed (${res.status}). Please try again.`,
    );
  return data;
}
const json = (method, value) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});

function resetFilters() {
  state.filters = { type: 'all', time: 'all', status: 'all', agent: 'all' };
  $('filter-type').value = 'all';
  $('filter-time').value = 'all';
  $('filter-status').value = 'all';
  $('filter-agent').value = 'all';
  syncFilterChips();
}

function syncProjectOptions() {
  const select = $('project-select');
  const names = new Map();
  for (const p of state.projects) names.set(p.name.toLowerCase(), p.name);
  let hasUnassigned = false;
  for (const card of state.cards) {
    if (card.project) {
      if (!names.has(card.project.toLowerCase())) names.set(card.project.toLowerCase(), card.project);
    } else {
      hasUnassigned = true;
    }
  }
  const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
  const current = state.project;
  select.replaceChildren();
  const allOpt = node('option', '', 'All projects');
  allOpt.value = 'all';
  select.append(allOpt);
  for (const name of sorted) {
    const opt = node('option', '', name);
    opt.value = name;
    select.append(opt);
  }
  if (hasUnassigned && sorted.length) {
    const noneOpt = node('option', '', 'Unassigned');
    noneOpt.value = '__unassigned__';
    select.append(noneOpt);
  }
  if (current !== 'all' && current !== '__unassigned__' && !names.has(current.toLowerCase())) {
    state.project = 'all';
  } else if (current === '__unassigned__' && (!hasUnassigned || !sorted.length)) {
    state.project = 'all';
  }
  select.value = state.project;
}

function syncAgentOptions() {
  const select = $('filter-agent');
  const names = new Map();
  for (const profile of state.agents.values()) names.set(profile.name.toLowerCase(), profile.name);
  for (const card of state.cards) {
    for (const name of card.contributors || (card.author ? [card.author] : [])) {
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
    if (card.assignee && !names.has(card.assignee.toLowerCase())) {
      names.set(card.assignee.toLowerCase(), card.assignee);
    }
  }
  const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
  const current = state.filters.agent;
  select.replaceChildren(node('option', '', 'All'));
  select.firstElementChild.value = 'all';
  for (const name of sorted) {
    const opt = node('option', '', name);
    opt.value = name.toLowerCase();
    select.append(opt);
  }
  if (current !== 'all' && !names.has(current)) {
    state.filters.agent = 'all';
  }
  select.value = state.filters.agent;
  $('chip-agent-wrap').hidden = sorted.length === 0 && state.filters.agent === 'all';
  syncFilterChips();
}

function syncFilterChips() {
  const isTodos = state.view === 'todos';
  const isBoard = state.view === 'board';
  $('chip-type-wrap').hidden = isTodos;
  $('chip-status-wrap').hidden = isBoard;
  $('chip-type-wrap').classList.toggle('active', !isTodos && state.filters.type !== 'all');
  $('chip-time-wrap').classList.toggle('active', state.filters.time !== 'all');
  $('chip-status-wrap').classList.toggle('active', !isBoard && state.filters.status !== 'all');
  $('chip-agent-wrap').classList.toggle('active', state.filters.agent !== 'all');
  const active =
    (!isTodos && state.filters.type !== 'all') ||
    state.filters.time !== 'all' ||
    (!isBoard && state.filters.status !== 'all') ||
    state.filters.agent !== 'all';
  $('filter-clear').hidden = !active;
}

function lock(reason = '') {
  ++state.epoch;
  ++authVersion;
  ++listVersion;
  ++sheetVersion;
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  state.owner = false;
  state.loaded = false;
  state.cards = [];
  state.agents = new Map();
  state.projects = [];
  state.project = 'all';
  state.loadError = '';
  state.view = 'docs';
  state.month = new Date();
  state.selectedDay = '';
  state.todoDay = '';
  resetFilters();
  $('workspace').hidden = true;
  $('doc-view').hidden = true;
  $('doc-detail').replaceChildren();
  $('doc-message').textContent = '';
  $('views').hidden = true;
  $('project-switcher').hidden = true;
  $('account').hidden = true;
  $('open-archive').hidden = true;
  if (dialog.open) dialog.close();
  $('detail').replaceChildren();
  $('results').replaceChildren();
  $('notice').textContent = '';
  sheetMessage('');
  $('search').value = '';
  $('token').value = '';
  $('card-count').textContent = '';
  $('login-error').textContent = reason;
  $('push').lastElementChild.textContent = 'Enable push';
  $('push').disabled = false;
  $('boot').hidden = true;
  $('private-label').hidden = false;
  $('gate').hidden = false;
  $('login').disabled = false;
}

async function checkSession(restore = false) {
  const check = ++authVersion;
  try {
    const session = await request('/api/session', {}, false);
    if (check !== authVersion) return;
    if (session?.authenticated !== true || session?.owner !== true) {
      lock(state.owner ? 'Your session has ended. Sign in again.' : '');
      return;
    }
    if (state.owner || !restore) return;
    ++state.epoch;
    state.owner = true;
    $('token').value = '';
    $('gate').hidden = true;
    $('private-label').hidden = true;
    $('boot').hidden = true;
    $('workspace').hidden = false;
    $('views').hidden = false;
    $('project-switcher').hidden = false;
    $('account').hidden = false;
    $('open-archive').hidden = false;
    syncFilterChips();
    refresh();
    syncLocation();
    $('login').disabled = false;
  } catch (error) {
    if (error !== stale && check === authVersion) lock(message(error));
  }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('login').disabled) return;
  $('login').disabled = true;
  $('login-error').textContent = '';
  const check = ++authVersion;
  try {
    await request('/api/session', json('POST', { token: $('token').value }), false);
    if (check !== authVersion) return;
    $('token').value = '';
    await checkSession(true);
    if (state.owner && !dialog.open) $('workspace-title').focus();
    else if (!state.owner && !$('login-error').textContent)
      $('login-error').textContent = 'An owner token is required.';
  } catch (error) {
    if (error !== stale && check === authVersion) {
      $('login-error').textContent = message(error);
      $('token').select();
    }
  } finally {
    $('login').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  lock();
  replaceCardURL(null);
  $('login').disabled = true;
  try {
    await request('/api/session', { method: 'DELETE' }, false);
    sessionChannel?.postMessage('signed-out');
  } catch (error) {
    if (error !== stale)
      $('login-error').textContent =
        'Workspace hidden, but sign-out could not be confirmed. Reconnect and sign out again.';
  } finally {
    $('login').disabled = false;
    $('token').focus();
  }
});

sessionChannel?.addEventListener('message', (e) => {
  if (e.data === 'signed-out') lock('Signed out in another tab.');
});
function recheck() {
  if (state.owner && !document.hidden) checkSession();
}
window.addEventListener('focus', recheck);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    lock();
    checkSession(true);
  }
});
document.addEventListener('visibilitychange', recheck);
setInterval(recheck, 60000);

$('push').addEventListener('click', async () => {
  const epoch = state.epoch;
  $('push').disabled = true;
  try {
    await enablePush();
    if (epoch === state.epoch) {
      $('push').lastElementChild.textContent = 'Push enabled';
      notify('Notifications enabled on this device.');
    }
  } catch (error) {
    if (epoch !== state.epoch) return;
    await checkSession();
    if (epoch === state.epoch) {
      $('push').disabled = false;
      notify(message(error));
    }
  }
});

$('project-select').addEventListener('change', (e) => {
  state.project = e.target.value;
  render();
});
$('new-project').addEventListener('click', () => showNewProject());
$('manage-agents').addEventListener('click', () => showAgentsManager());

// Filter chips
$('filter-type').addEventListener('change', (e) => {
  state.filters.type = e.target.value;
  syncFilterChips();
  render();
});
$('filter-time').addEventListener('change', (e) => {
  state.filters.time = e.target.value;
  syncFilterChips();
  render();
});
$('filter-status').addEventListener('change', (e) => {
  state.filters.status = e.target.value;
  syncFilterChips();
  render();
});
$('filter-agent').addEventListener('change', (e) => {
  state.filters.agent = e.target.value;
  syncFilterChips();
  render();
});
$('filter-clear').addEventListener('click', () => {
  resetFilters();
  render();
});

// A single server query feeds every view, including calendar and board.
async function refresh() {
  const version = ++listVersion;
  const query = $('search').value.trim();
  state.loaded = false;
  state.loadError = '';
  render();
  try {
    const archivedParam = state.view === 'archive' ? '&archived=true' : '';
    const [cardsRes, agentsRes, projectsRes] = await Promise.all([
      request(`/api/cards?q=${encodeURIComponent(query)}${archivedParam}`),
      request('/api/agents').catch(() => ({ agents: [] })),
      request('/api/projects').catch(() => ({ projects: [] })),
    ]);
    if (version !== listVersion) return;
    state.cards = cardsRes.cards;
    state.agents = new Map((agentsRes?.agents || []).map((a) => [a.name.toLowerCase(), a]));
    state.projects = projectsRes?.projects || [];
    state.loaded = true;
    syncProjectOptions();
    syncAgentOptions();
    render();
  } catch (error) {
    if (error !== stale && version === listVersion && state.owner) {
      state.cards = [];
      state.loadError = message(error);
      render();
    }
  }
}
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  ++listVersion;
  state.loaded = false;
  state.loadError = '';
  render();
  searchTimer = setTimeout(refresh, 170);
});
$('views').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (!tab) return;
  const wasArchive = state.view === 'archive';
  state.view = tab.dataset.view;
  if (!$('doc-view').hidden) closeDoc(true);
  syncFilterChips();
  if (wasArchive) refresh();
  else render();
});
$('open-archive').addEventListener('click', () => {
  if (!state.owner) return;
  const wasArchive = state.view === 'archive';
  state.view = wasArchive ? 'docs' : 'archive';
  if (!$('doc-view').hidden) closeDoc(true);
  syncFilterChips();
  refresh();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('doc-back').addEventListener('click', () => closeDoc(true));
$('add').addEventListener('click', () => showEditor(null));

function empty(title, description, glyph, action) {
  const wrap = node('div', 'empty'),
    stamp = node('span', 'empty-mark');
  stamp.append(icon(glyph));
  wrap.append(stamp, node('h3', '', title), node('p', '', description));
  if (action) wrap.append(action);
  return wrap;
}

function hasActiveFilters() {
  const isTodos = state.view === 'todos';
  const isBoard = state.view === 'board';
  return (
    Boolean($('search').value.trim()) ||
    (!isTodos && state.filters.type !== 'all') ||
    state.filters.time !== 'all' ||
    (!isBoard && state.filters.status !== 'all') ||
    state.filters.agent !== 'all'
  );
}

function applyFilters(cards) {
  const now = new Date();
  return cards.filter((card) => {
    if (state.project === '__unassigned__') {
      if (card.project) return false;
    } else if (state.project !== 'all') {
      if ((card.project || '').toLowerCase() !== state.project.toLowerCase()) return false;
    }
    if (state.view === 'todos' && !card.isTask) return false;
    if (state.view !== 'todos') {
      if (state.filters.type === 'note' && card.isTask) return false;
      if (state.filters.type === 'task' && !card.isTask) return false;
    }
    if (state.view !== 'board' && state.filters.status !== 'all' && card.status !== state.filters.status)
      return false;
    if (state.filters.time !== 'all' && cardTimeBucket(card, now) !== state.filters.time) return false;
    if (state.filters.agent !== 'all') {
      const members = card.contributors || (card.author ? [card.author] : []);
      const assignedMatch = (card.assignee || '').toLowerCase() === state.filters.agent;
      if (!assignedMatch && !members.some((name) => name.toLowerCase() === state.filters.agent)) return false;
    }
    return true;
  });
}

function blankState() {
  if (hasActiveFilters())
    return empty(
      'No matching notes',
      'Try adjusting your search or filter selections.',
      'search',
      button('Clear filters', () => {
        $('search').value = '';
        resetFilters();
        refresh();
        $('search').focus();
      }),
    );
  if (state.view === 'archive') {
    return empty(
      'Archive is empty',
      'Archived cards are hidden from Notes, To-dos, Board, and Calendar and live here until restored.',
      'archive',
      button('Back to Notes', () => {
        state.view = 'docs';
        syncFilterChips();
        refresh();
      }),
    );
  }
  const tasks = state.view === 'todos';
  const inProject = state.project !== 'all' && state.project !== '__unassigned__';
  return empty(
    inProject
      ? `No ${tasks ? 'to-dos' : 'notes'} in ${state.project}`
      : tasks ? 'No to-dos yet' : 'No notes yet',
    tasks
      ? 'Add your first to-do card to start tracking tasks.'
      : 'Add your first note, plan, or to-do card.',
    tasks ? 'task' : 'book',
    button(tasks ? 'Add To-do' : 'Add Notes', () => showEditor(null), 'btn primary', 'plus'),
  );
}

function render() {
  if (!state.owner) return;
  for (const tab of $('views').querySelectorAll('button')) {
    if (tab.dataset.view === state.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (state.view === 'archive') $('open-archive').setAttribute('aria-current', 'page');
  else $('open-archive').removeAttribute('aria-current');
  const meta = views[state.view] || views.docs;
  $('workspace-title').textContent = meta.title;
  $('view-title').textContent = meta.title;
  $('add').hidden = state.view === 'archive';
  $('add-label').textContent = meta.addLabel;
  $('view-icon').firstElementChild.setAttribute('href', `#i-${meta.icon}`);

  const results = $('results');
  results.replaceChildren();
  results.setAttribute('aria-busy', String(!state.loaded && !state.loadError));
  const cards = applyFilters(state.cards);
  $('card-count').textContent = state.loaded ? String(cards.length) : '';
  if (state.loadError) {
    results.append(empty('Could not load cards', state.loadError, 'book', button('Try again', refresh)));
    return;
  }
  if (!state.loaded) {
    results.append(node('p', 'quiet', 'Loading notes…'));
    return;
  }
  if (state.view === 'board') results.append(boardView(cards));
  else if (state.view === 'calendar') results.append(calendarView(cards));
  else if (state.view === 'todos') results.append(todoView(cards));
  else if (!cards.length) results.append(blankState());
  else results.append(docsView(cards));
}

const tableSepRe = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const hrRe = /^\s*(?:---+|\*\*\*+|___+)\s*$/;
const fenceRe = /^\s*(```|~~~)/;

function parseBodyPreview(card) {
  const raw = card.body || '';
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const checks = [];
  const blocks = [];
  let rawBudget = 0;
  let inFence = false;
  let fenceMarker = '';
  let inTable = false;
  let codeBuf = [];
  let paraBuf = [];
  const titleNorm = (card.title || '').trim().toLowerCase();

  const flushPara = () => {
    if (!paraBuf.length) return;
    if (rawBudget < 900) {
      const text = paraBuf.join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({ kind: 'para', text });
        rawBudget += text.length;
      }
    }
    paraBuf = [];
  };
  const flushCode = () => {
    if (!codeBuf.length) return;
    if (rawBudget < 900) {
      const text = codeBuf.join(' ').replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({ kind: 'code', text });
        rawBudget += text.length;
      }
    }
    codeBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inFence) {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
        flushCode();
      } else if (trimmed && rawBudget < 900 && codeBuf.length < 4) {
        codeBuf.push(trimmed);
      }
      continue;
    }

    const fMatch = fenceRe.exec(line);
    if (fMatch) {
      inTable = false;
      flushPara();
      inFence = true;
      fenceMarker = fMatch[1];
      continue;
    }

    if (!trimmed) {
      inTable = false;
      flushPara();
      continue;
    }

    if (inTable) {
      if (line.includes('|')) {
        if (!tableSepRe.test(line) && rawBudget < 900) {
          const cells = splitTableRow(line).filter(Boolean);
          if (cells.length) {
            const text = cells.length === 2 ? `${cells[0]} — ${cells[1]}` : cells.join(', ');
            blocks.push({ kind: 'item', text });
            rawBudget += text.length;
          }
        }
        continue;
      }
      inTable = false;
    }

    if (hrRe.test(line) || tableSepRe.test(line)) {
      flushPara();
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && tableSepRe.test(lines[i + 1])) {
      flushPara();
      inTable = true;
      if (rawBudget < 900) {
        const cells = splitTableRow(line).filter(Boolean);
        if (cells.length) {
          const text = cells.length === 2 ? `${cells[0]} — ${cells[1]}` : cells.join(', ');
          blocks.push({ kind: 'item', text });
          rawBudget += text.length;
        }
      }
      i++;
      continue;
    }

    const unquoted = trimmed.replace(/^(?:>\s*)+/, '').trim();
    if (!unquoted) {
      flushPara();
      continue;
    }

    const checkMatch = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(unquoted);
    if (checkMatch) {
      flushPara();
      if (checks.length < 2) {
        checks.push({ checked: checkMatch[1].toLowerCase() === 'x', text: checkMatch[2].trim() });
      }
      continue;
    }

    if (rawBudget >= 900) {
      if (checks.length >= 2) break;
      continue;
    }

    const hMatch = /^#{1,6}\s+(.+?)\s*#*$/.exec(unquoted);
    if (hMatch) {
      flushPara();
      const text = hMatch[1].trim();
      if (text && !(blocks.length === 0 && titleNorm && text.toLowerCase() === titleNorm)) {
        blocks.push({ kind: 'heading', text });
        rawBudget += text.length;
      }
      continue;
    }

    const listMatch = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(unquoted);
    if (listMatch) {
      flushPara();
      const text = listMatch[1].trim();
      if (text) {
        blocks.push({ kind: 'item', text });
        rawBudget += text.length;
      }
      continue;
    }

    paraBuf.push(unquoted);
  }
  flushPara();
  flushCode();

  return { blocks, checks };
}

function trimPreviewNodes(el, maxChars = 240) {
  let remaining = maxChars;
  const walk = (parent) => {
    for (let child = parent.firstChild; child; ) {
      const next = child.nextSibling;
      if (remaining <= 0) {
        child.remove();
        child = next;
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue || '';
        if (text.length > remaining) {
          const cut = text.slice(0, remaining).replace(/\s+\S*$/, '') || text.slice(0, remaining);
          child.nodeValue = `${cut.trimEnd()}…`;
          remaining = 0;
        } else {
          remaining -= text.length;
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
        if (!child.textContent) child.remove();
      }
      child = next;
    }
  };
  walk(el);
  while (el.lastElementChild?.classList.contains('preview-sep') && el.lastChild === el.lastElementChild) {
    el.lastElementChild.remove();
  }
}

function renderBodyPreview(preview, target, fallback, { includeChecks = false, maxChars = 240 } = {}) {
  let hasContent = false;
  const appendSep = () => {
    if (hasContent) target.append(node('span', 'preview-sep', ' · '));
  };

  for (const block of preview.blocks) {
    const frag = document.createDocumentFragment();
    if (block.kind === 'heading') {
      const h = node('strong', 'preview-heading');
      appendInline(block.text, h, { links: false });
      frag.append(h);
    } else if (block.kind === 'code') {
      frag.append(node('code', '', block.text));
    } else {
      appendInline(block.text, frag, { links: false });
    }
    if (!frag.textContent.trim()) continue;
    appendSep();
    target.append(frag);
    hasContent = true;
  }

  if (!hasContent && includeChecks && preview.checks.length) {
    for (const c of preview.checks) {
      const frag = document.createDocumentFragment();
      frag.append(c.checked ? '✓ ' : '☐ ');
      appendInline(c.text, frag, { links: false });
      if (!frag.textContent.trim()) continue;
      appendSep();
      target.append(frag);
      hasContent = true;
    }
  }

  if (hasContent) trimPreviewNodes(target, maxChars);
  if (!target.textContent.trim() && fallback) target.textContent = fallback;
}

function toggleTaskCheckbox(card, check) {
  check.addEventListener('change', async () => {
    check.disabled = true;
    const next = check.checked ? 'done' : 'open';
    try {
      await request(cardAPI(card.id), json('PATCH', { status: next }));
      await refresh();
      $('results')
        .querySelector(`[data-todo="${CSS.escape(card.id)}"]`)
        ?.focus();
    } catch (error) {
      if (error !== stale && state.owner) {
        check.checked = !check.checked;
        check.disabled = false;
        notify(message(error));
      }
    }
  });
}

function docsView(cards) {
  const feed = node('div', 'card-feed');
  for (const card of cards) {
    const item = node('article', `card-item${card.isTask && card.status === 'done' ? ' done-task' : ''}`);
    const top = node('div', 'card-top');
    const left = node('div', 'card-top-left');

    const pills = node('span', 'card-pills');
    if (card.project && state.project === 'all') {
      pills.append(node('span', 'pill project-tag', card.project));
    }
    if (card.assignee) {
      pills.append(node('span', 'pill assignee-tag', `@${card.assignee}`));
    }
    const tp = timePill(card);
    if (tp) pills.append(tp);
    pills.append(badge(card.status));

    left.append(cardLink(card), pills);

    const arrow = icon('next');
    arrow.classList.add('chev');
    top.append(left, arrow);
    item.append(top);

    const preview = parseBodyPreview(card);
    if (preview.blocks.length || !preview.checks.length) {
      const snipEl = node('p', 'card-snippet');
      renderBodyPreview(preview, snipEl, card.isTask ? 'To-do item' : 'Note');
      item.append(snipEl);
    }

    if (preview.checks.length) {
      const checkWrap = node('div', 'card-check-preview');
      for (const c of preview.checks) {
        const row = node('div', `card-check-row${c.checked ? ' checked' : ''}`);
        const label = node('span', 'card-check-text');
        appendInline(c.text, label, { links: false });
        row.append(node('span', `mini-box${c.checked ? ' checked' : ''}`), label);
        checkWrap.append(row);
      }
      item.append(checkWrap);
    }

    const footer = node('div', 'card-footer');
    if (card.isTask) {
      const check = node('input');
      check.type = 'checkbox';
      check.checked = card.status === 'done';
      check.dataset.todo = card.id;
      check.setAttribute('aria-label', `Mark ${card.title} ${check.checked ? 'open' : 'done'}`);
      toggleTaskCheckbox(card, check);
      footer.append(check);
    }
    const members = card.contributors || (card.author ? [card.author] : []);
    if (members.length) {
      footer.append(
        avatarStack(members),
        node('span', '', members.length > 1 ? 'With' : 'By'),
        node('span', 'card-footer-strong', members.join(', ')),
      );
      if (card.commentCount > 0) {
        footer.append(
          node('span', 'card-footer-dot', '·'),
          node('span', '', `${card.commentCount} ${card.commentCount === 1 ? 'comment' : 'comments'}`),
        );
      }
    } else {
      const kindText = card.isTask ? 'Task' : 'Note';
      const dateLabel = scheduleText(card) || `Created ${displayDate(new Date(card.createdAt))}`;
      footer.append(
        node('span', '', kindText),
        node('span', 'card-footer-dot', '·'),
        node('span', 'card-footer-strong', dateLabel),
      );
    }
    item.append(footer);

    feed.append(item);
  }
  return feed;
}

function boardView(cards) {
  const lanes = node('div', 'board');
  for (const [status, label] of Object.entries(statuses)) {
    const group = cards.filter((c) => c.status === status),
      lane = node('section', `lane ${status}`);
    lane.setAttribute('aria-label', label);
    const head = node('div', 'lane-head');
    const heading = node('h3', 'sr-only', label);
    head.append(heading, badge(status), node('span', 'count', String(group.length)));
    lane.append(head);
    if (!group.length) lane.append(node('p', 'lane-empty', 'No cards here yet.'));
    for (const card of group) {
      const item = node('article', 'lane-card');
      const top = node('div', 'lane-card-top');
      top.append(node('span', `pill ${card.isTask ? 'kind-task' : 'kind-note'}`, card.isTask ? 'Task' : 'Note'));
      if (card.assignee) top.append(node('span', 'pill assignee-tag', `@${card.assignee}`));
      const tp = timePill(card);
      if (tp) top.append(tp);
      else if (!card.assignee) top.append(node('span', 'card-date', displayDate(new Date(card.createdAt))));

      const preview = parseBodyPreview(card);
      const snipEl = node('p', 'snippet');
      renderBodyPreview(preview, snipEl, 'No notes yet.', { includeChecks: true, maxChars: 160 });
      item.append(top, cardLink(card), snipEl);
      lane.append(item);
    }
    lanes.append(lane);
  }
  return lanes;
}

function weekDaysStartingMonday(now = new Date()) {
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return labels.map((dowLabel, idx) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + idx);
    return { dowLabel, date, key: dayKey(date), num: date.getDate() };
  });
}

function todoView(cards) {
  const shell = node('div', 'todo-shell');
  const now = new Date();
  const today = dayKey(now);
  const week = weekDaysStartingMonday(now);

  const stripWrap = node('section', 'week-strip-wrap');
  stripWrap.setAttribute('aria-label', 'This week');
  const stripHead = node('div', 'week-strip-head');
  stripHead.append(node('span', 'week-month', monthFormat.format(now)));
  if (state.todoDay) {
    stripHead.append(
      button(
        'Show all to-dos',
        () => {
          state.todoDay = '';
          render();
        },
        'chip-reset',
      ),
    );
  }
  stripWrap.append(stripHead);

  const strip = node('div', 'week-strip');
  for (const d of week) {
    const dayCards = entriesOn(cards, d.key).map((e) => e.card);
    const doneCount = dayCards.filter((c) => c.status === 'done').length;
    const openCount = dayCards.length - doneCount;
    let tone = '';
    if (dayCards.length) tone = openCount === 0 ? ' all-done' : ' has-open';
    const isSelected = state.todoDay === d.key;
    const cls = `week-day${tone}${d.key === today ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`;
    const btn = node('button', cls);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(isSelected));
    btn.setAttribute('aria-label', `${displayDate(d.date)}, ${openCount} open, ${doneCount} done`);
    btn.addEventListener('click', () => {
      state.todoDay = state.todoDay === d.key ? '' : d.key;
      render();
    });
    btn.append(node('span', 'week-day-dow', d.dowLabel), node('span', 'week-day-cap', String(d.num)));
    const stats = node('div', 'week-day-stats');
    if (dayCards.length) {
      stats.append(
        node('span', openCount ? 'stat-open' : '', `× ${openCount}`),
        node('span', doneCount ? 'stat-done' : '', `✓ ${doneCount}`),
      );
    } else {
      stats.append(node('span', '', '—'));
    }
    btn.append(stats);
    strip.append(btn);
  }
  stripWrap.append(strip);
  shell.append(stripWrap);

  const visible = state.todoDay ? entriesOn(cards, state.todoDay).map((e) => e.card) : cards;
  const sheetCard = node('section', 'todo-card-sheet');
  const head = node('div', 'todo-sheet-head');
  const titleWrap = node('div', 'todo-sheet-title');
  const headingText = state.todoDay
    ? state.todoDay === today
      ? 'To-Do Today'
      : displayDate(localDate(state.todoDay))
    : 'To-Do Today';
  const doneTotal = visible.filter((c) => c.status === 'done').length;
  titleWrap.append(
    node('h3', '', headingText),
    node('span', 'todo-progress', `${doneTotal} / ${visible.length}`),
  );
  head.append(titleWrap, button('New to-do', () => showEditor(null), 'btn outline', 'plus'));
  sheetCard.append(head);

  if (!visible.length) {
    const emptyBox = state.todoDay
      ? empty(
          'Nothing scheduled for this day',
          'Pick another day on the strip or show all to-dos.',
          'task',
          button('Show all to-dos', () => {
            state.todoDay = '';
            render();
          }),
        )
      : blankState();
    shell.append(emptyBox);
    return shell;
  }

  const list = node('div', 'todo-list');
  for (const card of visible) {
    const row = node('article', `todo-row${card.status === 'done' ? ' done-task' : ''}`);
    const check = node('input');
    check.type = 'checkbox';
    check.checked = card.status === 'done';
    check.dataset.todo = card.id;
    check.setAttribute('aria-label', `Mark ${card.title} ${check.checked ? 'open' : 'done'}`);
    toggleTaskCheckbox(card, check);

    const body = node('div', 'todo-row-body');
    const subCls =
      card.status === 'done' ? 'todo-sub is-done' : card.status === 'review' ? 'todo-sub is-review' : 'todo-sub';
    const subEl = node('p', subCls);
    if (card.status === 'done') {
      subEl.textContent = '✓ Completed';
    } else if (card.status === 'review') {
      subEl.textContent = 'Ready for review';
    } else {
      const sched = scheduleText(card);
      if (sched) subEl.textContent = sched;
      else renderBodyPreview(parseBodyPreview(card), subEl, 'To-do item', { includeChecks: true, maxChars: 140 });
    }
    body.append(cardLink(card), subEl);

    const badges = node('div', 'todo-row-badges');
    if (card.assignee) badges.append(node('span', 'pill assignee-tag', `@${card.assignee}`));
    const tp = timePill(card);
    if (tp) badges.append(tp);
    badges.append(badge(card.status));

    row.append(check, body, badges);
    list.append(row);
  }
  sheetCard.append(list);
  shell.append(sheetCard);
  return shell;
}

// Bound work to the displayed month rather than expanding a potentially years-long range.
function entriesOn(cards, day) {
  const entries = [];
  for (const card of cards) {
    const start = card.startingDate || card.endingDate,
      end = card.endingDate || card.startingDate;
    const created = dayKey(new Date(card.createdAt)) === day,
      scheduled = Boolean(start && start <= day && day <= end);
    if (created || scheduled)
      entries.push({
        card,
        scheduled,
        reason: created && scheduled ? 'Created & scheduled' : scheduled ? 'Scheduled' : 'Created',
      });
  }
  return entries;
}

function calendarView(cards) {
  const frag = document.createDocumentFragment(),
    cal = node('div', 'calendar'),
    tools = node('div', 'calendar-tools'),
    controls = node('div', 'calendar-buttons');
  const year = state.month.getFullYear(),
    month = state.month.getMonth(),
    now = new Date(),
    today = dayKey(now);
  const first = new Date(year, month, 1),
    numDays = new Date(year, month + 1, 0).getDate();
  const move = (offset) => {
    state.month = new Date(year, month + offset, 1);
    state.selectedDay = '';
    render();
    $('results')
      .querySelector(`button[aria-label="${offset < 0 ? 'Previous' : 'Next'} month"]`)
      ?.focus();
  };
  controls.append(
    iconButton('Previous month', 'prev', () => move(-1)),
    button('Today', () => {
      state.month = new Date();
      state.selectedDay = today;
      render();
      focusDay(today);
    }),
    iconButton('Next month', 'next', () => move(1)),
  );
  tools.append(node('h3', '', monthFormat.format(first)), controls);
  cal.append(tools);
  const grid = node('div', 'month-grid');
  for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
    grid.append(node('span', 'weekday', day));
  const selected =
    state.selectedDay || (now.getMonth() === month && now.getFullYear() === year ? today : dayKey(first));
  const slots = Math.ceil((first.getDay() + numDays) / 7) * 7;
  for (let i = 0; i < slots; i++) {
    const num = i - first.getDay() + 1;
    if (num < 1 || num > numDays) {
      grid.append(node('div', 'day off'));
      continue;
    }
    const date = new Date(year, month, num),
      day = dayKey(date),
      entries = entriesOn(cards, day);
    const cell = node('div', 'day');
    cell.dataset.date = day;
    const pick = button(
      String(num),
      () => {
        state.selectedDay = day;
        render();
        focusDay(day);
      },
      `day-head${day === today ? ' today' : ''}`,
    );
    pick.setAttribute(
      'aria-label',
      `${displayDate(date)}, ${entries.length} ${entries.length === 1 ? 'card' : 'cards'}`,
    );
    pick.setAttribute('aria-pressed', String(day === selected));
    if (day === today) pick.setAttribute('aria-current', 'date');
    cell.append(pick);
    if (entries.length)
      cell.append(node('span', `day-dot${entries.some((e) => e.scheduled) ? ' scheduled' : ''}`));
    for (const { card, scheduled, reason } of entries) {
      const evCls = `day-event${card.status === 'done' ? ' done' : scheduled ? ' scheduled' : ''}`;
      const link = cardLink(card, evCls);
      link.title = `${card.title} · ${reason}`;
      cell.append(link);
    }
    grid.append(cell);
  }
  const agenda = node('section', 'agenda');
  agenda.setAttribute('aria-label', 'Selected day');
  agenda.append(node('h4', '', displayDate(localDate(selected))));
  const ul = node('ul');
  for (const entry of entriesOn(cards, selected)) {
    const li = node('li');
    const meta = node('span', 'card-pills');
    meta.append(node('span', 'help', entry.reason), badge(entry.card.status));
    li.append(cardLink(entry.card), meta);
    ul.append(li);
  }
  agenda.append(ul.childElementCount ? ul : node('p', 'help', 'No cards on this day.'));
  const legend = node('div', 'legend');
  legend.append(node('span', '', 'Created'), node('span', '', 'Scheduled'));
  cal.append(grid, agenda);
  frag.append(cal, legend);
  return frag;
}
function focusDay(day) {
  $('results').querySelector(`[data-date="${day}"] button`)?.focus();
}

// Real anchors keep copying, opening a new tab and browser history working normally.
function replaceCardURL(id, push = false) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('card', id);
  else url.searchParams.delete('card');
  if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url);
}
function closeDialog() {
  ++sheetVersion;
  if (dialog.open) dialog.close();
  $('detail').replaceChildren();
  $('dialog-message').textContent = '';
}
function closeDoc(updateURL = true) {
  ++sheetVersion;
  $('doc-view').hidden = true;
  $('doc-detail').replaceChildren();
  $('doc-message').textContent = '';
  if (state.owner) $('workspace').hidden = false;
  if (updateURL) replaceCardURL(null);
  if (state.owner && document.activeElement === document.body) $('add').focus();
}
function closeSheet(updateURL = true) {
  if (dialog.open) closeDialog();
  if (!$('doc-view').hidden) closeDoc(updateURL);
}
function syncLocation() {
  if (!state.owner) return;
  const id = new URL(location.href).searchParams.get('card');
  if (id) openCard(id);
  else if (!$('doc-view').hidden) closeDoc(false);
}
window.addEventListener('popstate', syncLocation);
$('close').addEventListener('click', () => closeDialog());
dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeDialog();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-card]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  if (!state.owner) return;
  if (dialog.open) closeDialog();
  replaceCardURL(a.dataset.card, true);
  openCard(a.dataset.card);
});
function sheet(title) {
  const heading = node('h2', '', title);
  heading.id = 'dialog-title';
  heading.tabIndex = -1;
  $('detail').replaceChildren(heading);
  $('dialog-message').textContent = '';
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  heading.focus();
  return heading;
}
function docSheet(title) {
  if (dialog.open) closeDialog();
  const heading = node('h1', '', title);
  heading.id = 'doc-title';
  heading.tabIndex = -1;
  $('doc-back-label').textContent = `Back to ${views[state.view]?.title || 'Notes'}`;
  $('doc-detail').replaceChildren(heading);
  $('doc-message').textContent = '';
  $('workspace').hidden = true;
  $('doc-view').hidden = false;
  window.scrollTo({ top: 0, behavior: 'instant' });
  heading.focus();
  return heading;
}
async function openCard(id) {
  const version = ++sheetVersion;
  docSheet('Opening card…');
  try {
    if (!idPattern.test(id)) throw new Error('This card link is not valid.');
    const { card } = await request(cardAPI(id));
    if (version === sheetVersion) showCard(card);
  } catch (error) {
    if (error === stale || version !== sheetVersion || !state.owner) return;
    docSheet('Card unavailable');
    $('doc-detail').append(
      node('p', 'intro', message(error)),
      button('Return to workspace', () => closeDoc(true)),
    );
  }
}
function linkTarget(value) {
  try {
    const url = new URL(value, location.origin),
      id = url.searchParams.get('card');
    return /^(?:https?:\/\/|\/\?)/i.test(value) &&
      url.origin === location.origin &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      id &&
      idPattern.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}
function safeExternalURL(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
function appendInline(text, parent, opts = {}) {
  // Zero-innerHTML inline Markdown: `code`, ***bold italic***, **bold**, __bold__, ~~strike~~, *italic*, _italic_, ![alt](url), [label](url), [[card]], <url>, and bare URLs.
  const links = opts.links !== false;
  const depth = opts.depth || 0;
  if (depth > 6) {
    parent.append(text);
    return;
  }
  const childOpts = { links, depth: depth + 1 };
  const noLinkOpts = { links: false, depth: depth + 1 };
  const tokenRe =
    /\\([\\`*_{}[\]()#+\-.!~|])|`([^`\n]+)`|!\[([^\[\]\n]{0,200})\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\[([^\[\]\n]{1,200})\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\[\[(?:card:)?([a-zA-Z0-9_-]{1,128})(?:\|([^\[\]\n]{1,200}))?\]\]|<(https?:\/\/[^\s<>"']+)>|(https?:\/\/[^\s<>"'()[\]]+|(?<![\w/])\/\?card=[a-zA-Z0-9_-]+)|\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*|(?<!\w)___(?!\s)([^_\n]+?)(?<!\s)___(?!\w)|\*\*(?!\s)((?:\*(?!\*)|[^*\n])+?)(?<!\s)\*\*|(?<!\w)__(?!\s)((?:_(?!_)|[^_\n])+?)(?<!\s)__(?!\w)|~~(?!\s)((?:~(?!~)|[^~\n])+?)(?<!\s)~~|\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g;
  let last = 0;
  for (const m of text.matchAll(tokenRe)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const raw = m[0];
    if (m[1] !== undefined) {
      parent.append(m[1]);
    } else if (m[2] !== undefined) {
      parent.append(node('code', '', m[2]));
    } else if (m[3] !== undefined && m[4] !== undefined) {
      if (m[3].trim()) parent.append(m[3].trim());
    } else if (m[5] !== undefined && m[6] !== undefined) {
      if (!links) {
        const span = node('span', 'preview-link');
        appendInline(m[5], span, noLinkOpts);
        parent.append(span);
      } else {
        const cid = linkTarget(m[6]);
        if (cid) {
          const a = cardLink({ id: cid }, '', '');
          appendInline(m[5], a, noLinkOpts);
          parent.append(a);
        } else {
          const ext = safeExternalURL(m[6]);
          if (ext) {
            const a = node('a');
            a.href = ext;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            appendInline(m[5], a, noLinkOpts);
            parent.append(a);
          } else {
            appendInline(m[5], parent, noLinkOpts);
          }
        }
      }
    } else if (m[7] !== undefined) {
      const cid = m[7];
      const label = m[8] || state.cards.find((c) => c.id === cid)?.title || cid;
      parent.append(links ? cardLink({ id: cid }, '', label) : node('span', 'preview-link', label));
    } else if (m[9] !== undefined) {
      const ext = safeExternalURL(m[9]);
      if (links && ext) {
        const a = node('a', '', m[9]);
        a.href = ext;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.append(a);
      } else {
        parent.append(links ? raw : node('span', 'preview-link', m[9]));
      }
    } else if (m[10] !== undefined) {
      if (!links) {
        parent.append(raw);
      } else {
        const trimmed = raw.replace(/[.,;!]+$/, '');
        const trail = raw.slice(trimmed.length);
        const cid = linkTarget(trimmed);
        if (cid) {
          parent.append(cardLink({ id: cid }, '', trimmed));
          if (trail) parent.append(trail);
        } else {
          const ext = safeExternalURL(trimmed);
          if (ext) {
            const a = node('a', '', trimmed);
            a.href = ext;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            parent.append(a);
            if (trail) parent.append(trail);
          } else {
            parent.append(raw);
          }
        }
      }
    } else if (m[11] !== undefined || m[12] !== undefined) {
      const strong = node('strong');
      const em = node('em');
      appendInline(m[11] ?? m[12], em, childOpts);
      strong.append(em);
      parent.append(strong);
    } else if (m[13] !== undefined || m[14] !== undefined) {
      const strong = node('strong');
      appendInline(m[13] ?? m[14], strong, childOpts);
      parent.append(strong);
    } else if (m[15] !== undefined) {
      const del = node('del');
      appendInline(m[15], del, childOpts);
      parent.append(del);
    } else if (m[16] !== undefined || m[17] !== undefined) {
      const em = node('em');
      appendInline(m[16] ?? m[17], em, childOpts);
      parent.append(em);
    } else {
      parent.append(raw);
    }
    last = m.index + raw.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}
function renderBody(text) {
  const container = node('div', 'md-body');
  if (!text || !text.trim()) {
    container.append(node('p', 'help', 'No notes on this card yet.'));
    return container;
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const isSpecial = (line, idx) =>
    fenceRe.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    hrRe.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    (line.includes('|') && idx + 1 < lines.length && tableSepRe.test(lines[idx + 1]));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code block
    const fMatch = fenceRe.exec(line);
    if (fMatch) {
      const marker = fMatch[1];
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = node('pre'),
        code = node('code', '', codeLines.join('\n'));
      pre.append(code);
      container.append(pre);
      continue;
    }
    // Horizontal rule
    if (hrRe.test(line)) {
      container.append(node('hr'));
      i++;
      continue;
    }
    // Heading (# -> h2 .. ###### -> h5)
    const hMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (hMatch) {
      const h = node(`h${Math.min(5, hMatch[1].length + 1)}`);
      appendInline(hMatch[2].trim(), h);
      container.append(h);
      i++;
      continue;
    }
    // Table (header | sep | rows)
    if (line.includes('|') && i + 1 < lines.length && tableSepRe.test(lines[i + 1])) {
      const wrap = node('div', 'md-table-wrap'),
        table = node('table'),
        thead = node('thead'),
        tbody = node('tbody');
      const headTr = node('tr');
      for (const cell of splitTableRow(line)) {
        const th = node('th');
        appendInline(cell, th);
        headTr.append(th);
      }
      thead.append(headTr);
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const tr = node('tr');
        for (const cell of splitTableRow(lines[i])) {
          const td = node('td');
          appendInline(cell, td);
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(thead, tbody);
      wrap.append(table);
      container.append(wrap);
      continue;
    }
    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote = node('blockquote');
      const qLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const p = node('p');
      qLines.forEach((ql, idx) => {
        if (idx > 0) p.append(document.createElement('br'));
        appendInline(ql, p);
      });
      quote.append(p);
      container.append(quote);
      continue;
    }
    // Checklist or unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const isChecklist = /^\s*[-*+]\s+\[([ xX])\]\s+/.test(line);
      const ul = node('ul', isChecklist ? 'md-checklist' : '');
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const checkMatch = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i]);
        const li = node('li');
        if (isChecklist && checkMatch) {
          const checked = checkMatch[1].toLowerCase() === 'x';
          if (checked) li.className = 'checked';
          const textSpan = node('span');
          appendInline(checkMatch[2], textSpan);
          li.append(node('span', `mini-box${checked ? ' checked' : ''}`), textSpan);
        } else {
          appendInline(lines[i].replace(/^\s*[-*+]\s+/, ''), li);
        }
        ul.append(li);
        i++;
      }
      container.append(ul);
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = node('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = node('li');
        appendInline(lines[i].replace(/^\s*\d+\.\s+/, ''), li);
        ol.append(li);
        i++;
      }
      container.append(ol);
      continue;
    }
    // Paragraph
    const p = node('p');
    let firstLine = true;
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i], i)) {
      if (!firstLine) p.append(document.createElement('br'));
      appendInline(lines[i], p);
      firstLine = false;
      i++;
    }
    container.append(p);
  }
  return container;
}
function showCard(card) {
  const version = ++sheetVersion;
  const heading = docSheet(card.title),
    detail = $('doc-detail');
  const top = node('div', 'detail-top');
  if (card.archived) top.append(node('span', 'pill archived-tag', 'Archived'));
  if (card.project) top.append(node('span', 'pill project-tag', card.project));
  if (card.assignee) top.append(node('span', 'pill assignee-tag', `@${card.assignee}`));
  top.append(
    badge(card.status),
    node('span', `pill ${card.isTask ? 'kind-task' : 'kind-note'}`, card.isTask ? 'Task' : 'Note'),
  );
  const tp = timePill(card);
  if (tp) top.append(tp);
  heading.before(top);
  const meta = node('div', 'detail-meta');
  if (card.author) {
    const a = node('span');
    a.append(avatarBadge(card.author), card.author);
    meta.append(a);
  }
  meta.append(node('span', '', `Created ${displayDate(new Date(card.createdAt))}`));
  if (card.startingDate || card.endingDate) {
    const s = node('span');
    s.append(icon('calendar'), scheduleText(card));
    meta.append(s);
  }
  const actions = node('div', 'button-row doc-actions');
  const statusAction = async (next) => {
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      const { card: saved } = await request(cardAPI(card.id), json('PATCH', { status: next }));
      if (version === sheetVersion) {
        showCard(saved);
        sheetMessage(`Card marked ${statuses[next].toLowerCase()}.`);
      }
      refresh();
    } catch (error) {
      if (error !== stale && version === sheetVersion) {
        sheetMessage(message(error));
        for (const b of actions.querySelectorAll('button')) b.disabled = false;
      }
    }
  };
  const archiveAction = async (archived) => {
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try {
      const { card: saved } = await request(cardAPI(card.id), json('PATCH', { archived }));
      if (version === sheetVersion) {
        if (archived) {
          closeDoc(true);
          notify('Card archived.');
        } else {
          showCard(saved);
          sheetMessage('Card restored from archive.');
        }
      }
      refresh();
    } catch (error) {
      if (error !== stale && version === sheetVersion) {
        sheetMessage(message(error));
        for (const b of actions.querySelectorAll('button')) b.disabled = false;
      }
    }
  };
  const images = topImageSection(card, version);
  actions.append(button('Edit', () => showEditor(card), 'btn', 'edit'));
  if (card.status !== 'done') actions.append(button('Mark done', () => statusAction('done'), 'btn', 'check'));
  if (card.status !== 'review')
    actions.append(button('Send to review', () => statusAction('review'), 'btn', 'review'));
  if (card.status === 'done') actions.append(button('Reopen', () => statusAction('open')));
  actions.append(
    button('Add image', () => images.toggleUpload(), 'btn', 'image'),
    button(
      card.archived ? 'Restore' : 'Archive',
      () => archiveAction(!card.archived),
      'btn',
      'archive',
    ),
    button(
      'Copy link',
      async () => {
        const url = new URL(uri(card.id), location.origin).href;
        try {
          await navigator.clipboard.writeText(url);
          if (version === sheetVersion) sheetMessage('Card link copied.');
        } catch {
          if (version !== sheetVersion) return;
          let input = detail.querySelector('.copy-input');
          if (!input) {
            input = node('input', 'copy-input');
            input.readOnly = true;
            input.setAttribute('aria-label', 'Card link');
            actions.after(input);
          }
          input.value = url;
          input.focus();
          input.select();
          sheetMessage('Select and copy this card link.');
        }
      },
      'btn',
      'link',
    ),
  );
  // Images sit right at the top of the document, above the rendered Markdown body.
  detail.append(meta, actions, images.uploadPanel, images.section, renderBody(card.body || ''), commentSection(card, version));
}
function commentSection(card, version) {
  const section = node('section', 'comments-section'),
    head = node('div', 'comments-head'),
    count = node('span', 'count', card.commentCount ? String(card.commentCount) : ''),
    list = node('div', 'comment-list');
  head.append(node('h3', '', 'Comments'), count);
  const form = node('form', 'comment-form'),
    input = node('textarea');
  input.maxLength = 10000;
  input.rows = 2;
  input.placeholder = 'Leave a comment or reply to your agents…';
  input.setAttribute('aria-label', 'Add a comment');
  const submit = node('button', 'btn primary', 'Post comment');
  submit.type = 'submit';
  const formActions = node('div', 'comment-form-actions');
  formActions.append(submit);
  form.append(input, formActions);
  section.append(head, list, form);

  let revision = 0;
  const fetchComments = async () => {
    const ticket = ++revision;
    list.replaceChildren(node('p', 'help', 'Loading comments…'));
    try {
      const { comments } = await request(`${cardAPI(card.id)}/comments`);
      if (version !== sheetVersion || ticket !== revision) return;
      count.textContent = comments.length ? String(comments.length) : '';
      list.replaceChildren();
      if (!comments.length) {
        list.append(node('p', 'help', 'No comments yet.'));
        return;
      }
      for (const c of comments) {
        const item = node('article', 'comment-item');
        const top = node('div', 'comment-top');
        const profile = state.agents.get(c.author.toLowerCase());
        top.append(avatarBadge(c.author, true), node('span', 'comment-author', c.author));
        if (profile?.role) top.append(node('span', 'comment-role', profile.role));
        const stamp = new Date(c.createdAt);
        top.append(node('span', 'comment-time', Number.isFinite(stamp.valueOf()) ? dateTimeFormat.format(stamp) : ''));
        const bodyEl = renderBody(c.body);
        bodyEl.classList.add('comment-body');
        item.append(top, bodyEl);
        list.append(item);
      }
    } catch (error) {
      if (error !== stale && version === sheetVersion && ticket === revision)
        list.replaceChildren(node('p', 'error-text', message(error)), button('Retry comments', fetchComments));
    }
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || submit.disabled) return;
    submit.disabled = true;
    try {
      await request(`${cardAPI(card.id)}/comments`, json('POST', { body: text }));
      if (version === sheetVersion) {
        input.value = '';
        await fetchComments();
      }
      refresh();
    } catch (error) {
      if (error !== stale && version === sheetVersion) sheetMessage(message(error));
    } finally {
      if (version === sheetVersion) submit.disabled = false;
    }
  });
  fetchComments();
  return section;
}
function safeImageURL(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value, location.origin);
    return /^https?:$/.test(u.protocol) &&
      u.origin === location.origin &&
      !u.pathname.startsWith('//') &&
      !u.username &&
      !u.password
      ? u.pathname + u.search
      : null;
  } catch {
    return null;
  }
}
function topImageSection(card, version) {
  const section = node('section', 'doc-images');
  section.hidden = true;
  const gallery = node('div', 'doc-gallery');
  section.append(gallery);

  const uploadPanel = node('div', 'upload-panel');
  uploadPanel.hidden = true;
  const captionInput = node('input');
  captionInput.type = 'text';
  captionInput.maxLength = 500;
  captionInput.placeholder = 'Optional caption for this image…';
  captionInput.setAttribute('aria-label', 'Image caption');
  const fileInput = node('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp';
  fileInput.hidden = true;
  fileInput.multiple = true;
  const pickBtn = button('Choose image…', () => fileInput.click(), 'btn primary', 'image');
  const cancelBtn = button('Close', () => { uploadPanel.hidden = true; }, 'btn');
  const row = node('div', 'upload-row');
  row.append(captionInput, pickBtn, cancelBtn);
  uploadPanel.append(row, node('p', 'help', 'JPEG, PNG, or WebP · up to 3 MiB each'), fileInput);

  let revision = 0;
  const fetchImages = async () => {
    const ticket = ++revision;
    try {
      const { images } = await request(`${cardAPI(card.id)}/images`);
      if (version !== sheetVersion || ticket !== revision) return;
      gallery.replaceChildren();
      gallery.classList.toggle('single', images.length === 1);
      for (const item of images) {
        const url = safeImageURL(item.url);
        if (!url) continue;
        const figure = node('figure', 'doc-figure'),
          img = node('img');
        img.loading = 'lazy';
        img.alt = item.caption || item.name || 'Card attachment';
        img.addEventListener('error', () => {
          if (version === sheetVersion) {
            img.alt = `Image unavailable: ${item.name || 'attachment'}`;
            recheck();
          }
        });
        img.src = url;
        const zoom = button(
          '',
          () => {
            const large = figure.classList.toggle('large-image');
            zoom.setAttribute('aria-pressed', String(large));
          },
          'image-zoom',
        );
        zoom.setAttribute('aria-label', `Enlarge ${item.caption || item.name || 'image'}`);
        zoom.setAttribute('aria-pressed', 'false');
        zoom.append(img);

        const capBar = node('figcaption', 'doc-caption-bar');
        const capText = node(
          'span',
          `doc-caption-text${item.caption ? '' : ' fallback'}`,
          item.caption || item.name || '',
        );
        const editCapBtn = button(
          item.caption ? 'Edit caption' : 'Add caption',
          () => {
            const existing = figure.querySelector('.doc-caption-form');
            if (existing) { existing.remove(); return; }
            const form = node('form', 'doc-caption-form');
            const inp = node('input');
            inp.type = 'text';
            inp.maxLength = 500;
            inp.value = item.caption || '';
            inp.placeholder = 'Write a caption…';
            inp.setAttribute('aria-label', 'Edit image caption');
            const saveBtn = node('button', 'btn sm primary', 'Save');
            saveBtn.type = 'submit';
            form.append(inp, saveBtn, button('Cancel', () => form.remove(), 'btn sm'));
            figure.append(form);
            inp.focus();
            form.addEventListener('submit', async (e) => {
              e.preventDefault();
              if (saveBtn.disabled) return;
              saveBtn.disabled = true;
              try {
                const { image: updated } = await request(
                  `${cardAPI(card.id)}/images/${encodeURIComponent(item.id)}`,
                  json('PATCH', { caption: inp.value.trim() || null }),
                );
                if (version === sheetVersion) {
                  item.caption = updated.caption;
                  capText.textContent = updated.caption || item.name || '';
                  capText.className = `doc-caption-text${updated.caption ? '' : ' fallback'}`;
                  editCapBtn.textContent = updated.caption ? 'Edit caption' : 'Add caption';
                  img.alt = updated.caption || item.name || 'Card attachment';
                  form.remove();
                  sheetMessage('Caption saved.');
                }
              } catch (error) {
                if (error !== stale && version === sheetVersion) {
                  saveBtn.disabled = false;
                  sheetMessage(message(error));
                }
              }
            });
          },
          'btn sm ghost',
        );
        capBar.append(capText, editCapBtn);
        figure.append(zoom, capBar);
        gallery.append(figure);
      }
      section.hidden = !gallery.hasChildNodes();
    } catch (error) {
      if (error !== stale && version === sheetVersion && ticket === revision) {
        const msg = message(error);
        if (/not configured/i.test(msg)) {
          pickBtn.disabled = true;
          section.hidden = true;
        } else {
          section.hidden = false;
          gallery.replaceChildren(node('p', 'error-text', msg), button('Retry images', fetchImages));
        }
      }
    }
  };
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    if (!files.length) return;
    pickBtn.disabled = true;
    const caption = captionInput.value.trim();
    let sent = 0;
    try {
      for (const file of files) {
        if (version !== sheetVersion) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
          throw new Error('Choose a JPEG, PNG, or WebP image.');
        if (file.size > 3 * 1024 * 1024) throw new Error(`${file.name} is larger than 3 MiB.`);
        sheetMessage(`Uploading ${sent + 1} of ${files.length}…`);
        const headers = {
          'Content-Type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
        };
        if (caption) headers['x-caption'] = encodeURIComponent(caption);
        await request(`${cardAPI(card.id)}/images`, { method: 'POST', headers, body: file });
        ++sent;
      }
      if (version === sheetVersion) {
        captionInput.value = '';
        uploadPanel.hidden = true;
        sheetMessage(`${sent === 1 ? 'Image' : `${sent} images`} attached.`);
      }
    } catch (error) {
      if (error !== stale && version === sheetVersion) sheetMessage(message(error));
    } finally {
      if (version === sheetVersion) {
        pickBtn.disabled = false;
        fileInput.value = '';
        if (sent) fetchImages();
      }
    }
  });
  fetchImages();
  return {
    section,
    uploadPanel,
    toggleUpload() {
      uploadPanel.hidden = !uploadPanel.hidden;
      if (!uploadPanel.hidden) captionInput.focus();
    },
  };
}
function field(label, input) {
  const wrap = node('div', 'field'),
    name = node('label', 'field-label', label);
  name.htmlFor = input.id;
  wrap.append(name, input);
  return wrap;
}
function editorInput(tag, name, value) {
  const input = node(tag);
  input.id = `edit-${name}`;
  input.name = name;
  input.value = value ?? '';
  return input;
}
function showAgentsManager(newTokenBanner = null) {
  const version = ++sheetVersion;
  sheet('Agents');
  const detail = $('detail');
  detail.append(
    node(
      'p',
      'help',
      'Create a dedicated token for each bot. Cards and comments created with a bot’s token are automatically attributed to that bot, and you can revoke any bot instantly.',
    ),
  );

  const bannerWrap = node('div');
  const renderBanner = (info) => {
    bannerWrap.replaceChildren();
    if (!info) return;
    const box = node('div', 'token-banner');
    box.append(
      node('p', 'token-banner-title', `Token created for ${info.agent.name} — copy it now (shown once):`),
    );
    const codeInput = node('input', 'token-code');
    codeInput.readOnly = true;
    codeInput.value = info.token;
    codeInput.setAttribute('aria-label', `${info.agent.name} bearer token`);
    const promptText = `Read ${location.origin}/agent.txt and use GLAMP_TOKEN=${info.token} to check GET ${location.origin}/api/cards?assignee=${encodeURIComponent(info.agent.name)}`;
    const row = node('div', 'button-row');
    row.append(
      button('Copy token', async () => {
        try {
          await navigator.clipboard.writeText(info.token);
          sheetMessage(`Copied token for ${info.agent.name}.`);
        } catch {
          codeInput.focus();
          codeInput.select();
          sheetMessage('Select and copy the token above.');
        }
      }, 'btn sm primary'),
      button('Copy agent instructions', async () => {
        try {
          await navigator.clipboard.writeText(promptText);
          sheetMessage(`Copied setup prompt for ${info.agent.name}.`);
        } catch {
          sheetMessage('Could not access clipboard.');
        }
      }, 'btn sm'),
    );
    box.append(codeInput, row);
    bannerWrap.append(box);
  };
  renderBanner(newTokenBanner);
  detail.append(bannerWrap);

  const form = node('form', 'agent-create-form'),
    fields = node('div', 'fields');
  const nameInput = editorInput('input', 'agent-name', '');
  nameInput.required = true;
  nameInput.maxLength = 60;
  nameInput.placeholder = 'e.g. growth, scout, planner';
  const roleInput = editorInput('input', 'agent-role', '');
  roleInput.maxLength = 120;
  roleInput.placeholder = 'Optional role (e.g. Growth & SEO)';
  const colorSelect = editorInput('select', 'agent-color');
  for (const c of agentColors) {
    const opt = node('option', '', c[0].toUpperCase() + c.slice(1));
    opt.value = c;
    colorSelect.append(opt);
  }
  colorSelect.value = 'teal';
  const topRow = node('div', 'two-col');
  topRow.append(field('Agent name', nameInput), field('Color', colorSelect));
  fields.append(topRow, field('Role (optional)', roleInput));
  const createBtn = node('button', 'btn primary', 'Add agent & create token');
  createBtn.type = 'submit';
  form.append(fields, createBtn);
  detail.append(form);

  const listWrap = node('div', 'agents-list');
  detail.append(listWrap);

  const loadAgents = async () => {
    listWrap.replaceChildren(node('p', 'help', 'Loading agents…'));
    try {
      const { agents } = await request('/api/agents');
      if (version !== sheetVersion) return;
      state.agents = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
      syncAgentOptions();
      listWrap.replaceChildren();
      if (!agents.length) {
        listWrap.append(node('p', 'help', 'No agents yet. Create one above to generate its token.'));
        return;
      }
      for (const ag of agents) {
        const card = node('article', 'agent-row');
        const top = node('div', 'agent-row-top');
        const ident = node('div', 'agent-identity');
        const meta = node('div', 'agent-meta');
        const stats = [
          ag.role,
          `${ag.cardCount} cards`,
          `${ag.assignedCount || 0} assigned`,
          `${ag.commentCount} comments`,
        ].filter(Boolean).join(' · ');
        meta.append(node('span', 'agent-name', ag.name), node('span', 'agent-sub', stats));
        ident.append(avatarBadge(ag.name, true), meta);
        const actions = node('div', 'button-row');
        if (ag.name.toLowerCase() !== 'owner') {
          actions.append(
            button('New token', async () => {
              try {
                const res = await request('/api/agents/tokens', json('POST', { name: ag.name }));
                if (version === sheetVersion) {
                  renderBanner(res);
                  sheetMessage(`Generated a new token for ${ag.name}.`);
                  await loadAgents();
                }
              } catch (error) {
                if (error !== stale && version === sheetVersion) sheetMessage(message(error));
              }
            }, 'btn sm'),
          );
        }
        top.append(ident, actions);
        card.append(top);

        if (ag.tokens?.length) {
          const tokWrap = node('div', 'agent-tokens');
          for (const tok of ag.tokens) {
            const row = node('div', 'token-row');
            const left = node('span', 'row-inline');
            const used = tok.lastUsedAt
              ? `Last used ${dateTimeFormat.format(new Date(tok.lastUsedAt))}`
              : 'Never used yet';
            left.append(node('span', 'token-prefix', `${tok.prefix}…`), node('span', 'help', ` ${used}`));
            row.append(
              left,
              button('Revoke', async () => {
                try {
                  await request(`/api/agents/tokens/${encodeURIComponent(tok.id)}`, { method: 'DELETE' });
                  if (version === sheetVersion) {
                    sheetMessage(`Revoked token for ${ag.name}.`);
                    await loadAgents();
                  }
                } catch (error) {
                  if (error !== stale && version === sheetVersion) sheetMessage(message(error));
                }
              }, 'btn sm danger'),
            );
            tokWrap.append(row);
          }
          card.append(tokWrap);
        }
        listWrap.append(card);
      }
    } catch (error) {
      if (error !== stale && version === sheetVersion) {
        listWrap.replaceChildren(node('p', 'error-text', message(error)));
      }
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || createBtn.disabled) return;
    createBtn.disabled = true;
    sheetMessage('Creating agent token…');
    try {
      const payload = { name, color: colorSelect.value };
      if (roleInput.value.trim()) payload.role = roleInput.value.trim();
      const res = await request('/api/agents/tokens', json('POST', payload));
      if (version === sheetVersion) {
        nameInput.value = '';
        roleInput.value = '';
        renderBanner(res);
        sheetMessage(`Agent ${res.agent.name} is ready.`);
        await loadAgents();
      }
    } catch (error) {
      if (error !== stale && version === sheetVersion) sheetMessage(message(error));
    } finally {
      if (version === sheetVersion) createBtn.disabled = false;
    }
  });
  loadAgents();
}
function showNewProject() {
  const version = ++sheetVersion;
  sheet('New project');
  const form = node('form'),
    fields = node('div', 'fields');
  const nameInput = editorInput('input', 'project-name', '');
  nameInput.required = true;
  nameInput.maxLength = 60;
  nameInput.placeholder = 'e.g. Launch Plan, Personal, Mobile App';
  fields.append(field('Project name', nameInput));
  const buttons = node('div', 'form-bottom'),
    save = node('button', 'btn primary', 'Create project');
  save.type = 'submit';
  buttons.append(button('Cancel', () => closeDialog()), save);
  form.append(fields, buttons);
  $('detail').append(form);
  nameInput.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name || save.disabled) return;
    save.disabled = true;
    sheetMessage('Creating project…');
    try {
      const { project } = await request('/api/projects', json('POST', { name }));
      if (version === sheetVersion) {
        state.project = project.name;
        closeDialog();
        notify(`Switched to ${project.name}.`);
      }
      refresh();
    } catch (error) {
      if (error !== stale && version === sheetVersion) {
        save.disabled = false;
        sheetMessage(message(error));
      }
    }
  });
}
function editorImagesSection(card, version) {
  const wrap = node('div', 'field editor-images');
  wrap.hidden = true;
  const label = node('span', 'field-label', 'Images');
  const grid = node('div', 'editor-images-grid');
  wrap.append(label, grid);

  const load = async () => {
    try {
      const { images } = await request(`${cardAPI(card.id)}/images`);
      if (version !== sheetVersion) return;
      grid.replaceChildren();
      if (!images.length) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      for (const item of images) {
        const url = safeImageURL(item.url);
        if (!url) continue;
        const tile = node('div', 'editor-image-item');
        const img = node('img');
        img.loading = 'lazy';
        img.src = url;
        img.alt = item.caption || item.name || 'Card image';
        const caption = node('span', 'editor-image-meta', item.caption || item.name || 'Image');
        caption.title = item.caption || item.name || '';
        const delBtn = button('Delete', async () => {
          delBtn.disabled = true;
          delBtn.textContent = 'Deleting…';
          try {
            await request(`${cardAPI(card.id)}/images/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            if (version === sheetVersion) {
              tile.remove();
              if (!grid.hasChildNodes()) wrap.hidden = true;
              sheetMessage('Image deleted.');
            }
          } catch (error) {
            if (error !== stale && version === sheetVersion) {
              delBtn.disabled = false;
              delBtn.textContent = 'Delete';
              sheetMessage(message(error));
            }
          }
        }, 'btn sm danger');
        delBtn.setAttribute('aria-label', `Delete ${item.caption || item.name || 'image'}`);
        const row = node('div', 'editor-image-bar');
        row.append(caption, delBtn);
        tile.append(img, row);
        grid.append(tile);
      }
    } catch {
      // Leave section hidden if image storage is not configured.
    }
  };
  load();
  return wrap;
}
function showEditor(card) {
  const version = ++sheetVersion;
  docSheet(card ? 'Edit card' : 'New card');
  const form = node('form'),
    fields = node('div', 'fields');
  const title = editorInput('input', 'title', card?.title);
  title.required = true;
  title.maxLength = 200;
  title.placeholder = 'Give this card a title';
  const body = editorInput('textarea', 'body', card?.body);
  body.maxLength = 20000;
  body.rows = 10;
  body.placeholder = 'Write Markdown notes, headings, tables, code blocks, or checklists (- [ ] item)…';
  const bodyField = field('Body', body),
    hint = node('p', 'help', 'Paste a card link into your notes, or use [label](/?card=id).');
  hint.id = 'link-hint';
  body.setAttribute('aria-describedby', hint.id);
  bodyField.append(hint);
  const status = editorInput('select', 'status');
  for (const [value, label] of Object.entries(statuses)) {
    const opt = node('option', '', label);
    opt.value = value;
    status.append(opt);
  }
  status.value = card?.status || 'open';
  const type = node('label', 'check-label'),
    isTask = editorInput('input', 'isTask');
  isTask.type = 'checkbox';
  isTask.checked = card?.isTask ?? state.view === 'todos';
  type.append(isTask, 'This is a to-do');
  const starting = editorInput('input', 'startingDate', card?.startingDate);
  starting.type = 'date';
  const ending = editorInput('input', 'endingDate', card?.endingDate);
  ending.type = 'date';
  const defaultProject =
    card?.project ?? (state.project !== 'all' && state.project !== '__unassigned__' ? state.project : '');
  const project = editorInput('input', 'project', defaultProject);
  project.maxLength = 60;
  project.placeholder = 'Optional (pick or type a new project)';
  project.setAttribute('list', 'project-suggestions');
  const datalist = node('datalist');
  datalist.id = 'project-suggestions';
  const projNames = new Set(state.projects.map((p) => p.name));
  for (const c of state.cards) if (c.project) projNames.add(c.project);
  for (const name of [...projNames].sort((a, b) => a.localeCompare(b))) {
    const opt = node('option');
    opt.value = name;
    datalist.append(opt);
  }
  const assignee = editorInput('input', 'assignee', card?.assignee);
  assignee.maxLength = 60;
  assignee.placeholder = 'Optional (e.g. growth, scout, Owner)';
  assignee.setAttribute('list', 'agent-suggestions');
  const agentList = node('datalist');
  agentList.id = 'agent-suggestions';
  const agentNames = new Set(['Owner', ...[...state.agents.values()].map((a) => a.name)]);
  for (const name of [...agentNames].sort((a, b) => a.localeCompare(b))) {
    const opt = node('option');
    opt.value = name;
    agentList.append(opt);
  }
  const author = editorInput('input', 'author', card?.author);
  author.maxLength = 60;
  author.placeholder = 'Optional (e.g. Owner or agent name)';
  const limits = () => {
    ending.min = starting.value;
    starting.max = ending.value;
  };
  limits();
  starting.addEventListener('input', limits);
  ending.addEventListener('input', limits);
  const options = node('div', 'two-col');
  options.append(field('Status', status), type);
  const dates = node('div', 'two-col');
  dates.append(field('Start date (optional)', starting), field('End date (optional)', ending));
  const routing = node('div', 'two-col');
  routing.append(field('Project (optional)', project), field('Assigned to (optional)', assignee));
  fields.append(field('Title', title), bodyField);
  if (card) fields.append(editorImagesSection(card, version));
  fields.append(options, dates, routing, field('Author (optional)', author), datalist, agentList);
  const buttons = node('div', 'form-bottom'),
    save = node('button', 'btn primary', 'Save card');
  save.type = 'submit';
  buttons.append(
    button('Cancel', () => (card ? showCard(card) : closeDoc(true))),
    save,
  );
  form.append(fields, buttons);
  $('doc-detail').append(form);
  title.focus();
  title.addEventListener('input', () => title.setCustomValidity(''));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    if (!title.value.trim()) {
      title.setCustomValidity('Enter a title.');
      title.reportValidity();
      return;
    }
    const values = {
      title: title.value.trim(),
      body: body.value,
      status: status.value,
      isTask: isTask.checked,
      startingDate: starting.value || null,
      endingDate: ending.value || null,
      project: project.value.trim() || null,
      assignee: assignee.value.trim().replace(/^@+/, '') || null,
      author: author.value.trim() || null,
    };
    // Send only edited fields, so fixing a typo doesn't undo an agent's status change.
    const edit = card
      ? Object.fromEntries(Object.entries(values).filter(([key, v]) => (card[key] ?? null) !== v))
      : values;
    if (card && !Object.keys(edit).length) {
      showCard(card);
      return;
    }
    save.disabled = true;
    sheetMessage('Saving…');
    try {
      const { card: saved } = await request(
        card ? cardAPI(card.id) : '/api/cards',
        json(card ? 'PATCH' : 'POST', edit),
      );
      if (version === sheetVersion) {
        replaceCardURL(saved.id, !card);
        showCard(saved);
        sheetMessage('Card saved.');
      }
      refresh();
    } catch (error) {
      if (error !== stale && version === sheetVersion) {
        save.disabled = false;
        sheetMessage(message(error));
      }
    }
  });
}
$('search').maxLength = 200;
checkSession(true);
