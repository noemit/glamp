import { enablePush } from './push.js';

const $ = (id) => document.getElementById(id);
const dialog = $('dialog');
const statuses = { open: 'Ongoing', review: 'Review', done: 'Done' };
const views = {
  docs: { title: 'Notes', icon: 'book', addLabel: 'Add Notes' },
  todos: { title: 'To-dos', icon: 'task', addLabel: 'Add To-do' },
  board: { title: 'Board', icon: 'board', addLabel: 'Add Card' },
  calendar: { title: 'Calendar', icon: 'calendar', addLabel: 'Add Card' },
};
const state = {
  owner: false,
  epoch: 0,
  view: 'docs',
  cards: [],
  agents: new Map(),
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
  $('dialog-message').textContent = text;
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

function syncAgentOptions() {
  const select = $('filter-agent');
  const names = new Map();
  for (const profile of state.agents.values()) names.set(profile.name.toLowerCase(), profile.name);
  for (const card of state.cards) {
    for (const name of card.contributors || (card.author ? [card.author] : [])) {
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
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
  state.loadError = '';
  state.view = 'docs';
  state.month = new Date();
  state.selectedDay = '';
  state.todoDay = '';
  resetFilters();
  $('workspace').hidden = true;
  $('views').hidden = true;
  $('account').hidden = true;
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
    $('account').hidden = false;
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
    const [cardsRes, agentsRes] = await Promise.all([
      request(`/api/cards?q=${encodeURIComponent(query)}`),
      request('/api/agents').catch(() => ({ agents: [] })),
    ]);
    if (version !== listVersion) return;
    state.cards = cardsRes.cards;
    state.agents = new Map((agentsRes?.agents || []).map((a) => [a.name.toLowerCase(), a]));
    state.loaded = true;
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
  state.view = tab.dataset.view;
  syncFilterChips();
  render();
});
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
      if (!members.some((name) => name.toLowerCase() === state.filters.agent)) return false;
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
  const tasks = state.view === 'todos';
  return empty(
    tasks ? 'No to-dos yet' : 'No notes yet',
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
  const meta = views[state.view];
  $('workspace-title').textContent = meta.title;
  $('view-title').textContent = meta.title;
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

function parseBodyPreview(card) {
  const raw = card.body || '';
  const lines = raw.split(/\r?\n/);
  const checks = [];
  const prose = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(trimmed);
    if (match) {
      if (checks.length < 2) checks.push({ checked: match[1].toLowerCase() === 'x', text: match[2].trim() });
    } else {
      prose.push(trimmed.replace(/^#+\s*/, ''));
    }
  }
  const snippet = prose.join(' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  return {
    snippet: snippet || (!checks.length ? (card.isTask ? 'To-do item' : 'Note') : ''),
    checks,
  };
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
    const tp = timePill(card);
    if (tp) pills.append(tp);
    pills.append(badge(card.status));

    left.append(cardLink(card), pills);

    const arrow = icon('next');
    arrow.classList.add('chev');
    top.append(left, arrow);
    item.append(top);

    const { snippet, checks } = parseBodyPreview(card);
    if (snippet) item.append(node('p', 'card-snippet', snippet));

    if (checks.length) {
      const checkWrap = node('div', 'card-check-preview');
      for (const c of checks) {
        const row = node('div', `card-check-row${c.checked ? ' checked' : ''}`);
        row.append(node('span', `mini-box${c.checked ? ' checked' : ''}`), node('span', '', c.text));
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
      const tp = timePill(card);
      if (tp) top.append(tp);
      else top.append(node('span', 'card-date', displayDate(new Date(card.createdAt))));

      const { snippet } = parseBodyPreview(card);
      item.append(top, cardLink(card), node('p', 'snippet', snippet || 'No notes yet.'));
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
    const subText =
      card.status === 'done'
        ? '✓ Completed'
        : card.status === 'review'
          ? 'Ready for review'
          : scheduleText(card) || parseBodyPreview(card).snippet;
    body.append(cardLink(card), node('p', subCls, subText));

    const badges = node('div', 'todo-row-badges');
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
function closeSheet(updateURL = true) {
  ++sheetVersion;
  if (dialog.open) dialog.close();
  $('detail').replaceChildren();
  sheetMessage('');
  if (updateURL) replaceCardURL(null);
  if (state.owner && document.activeElement === document.body) $('add').focus();
}
function syncLocation() {
  if (!state.owner) return;
  const id = new URL(location.href).searchParams.get('card');
  if (id) openCard(id);
  else closeSheet(false);
}
window.addEventListener('popstate', syncLocation);
$('close').addEventListener('click', () => closeSheet());
dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSheet();
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-card]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  if (!state.owner) return;
  replaceCardURL(a.dataset.card, true);
  openCard(a.dataset.card);
});
function sheet(title) {
  const heading = node('h2', '', title);
  heading.id = 'dialog-title';
  heading.tabIndex = -1;
  $('detail').replaceChildren(heading);
  sheetMessage('');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  heading.focus();
  return heading;
}
async function openCard(id) {
  const version = ++sheetVersion;
  sheet('Opening card…');
  try {
    if (!idPattern.test(id)) throw new Error('This card link is not valid.');
    const { card } = await request(cardAPI(id));
    if (version === sheetVersion) showCard(card);
  } catch (error) {
    if (error === stale || version !== sheetVersion || !state.owner) return;
    sheet('Card unavailable');
    $('detail').append(
      node('p', 'intro', message(error)),
      button('Return to workspace', () => closeSheet()),
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
function renderBody(text) {
  const block = node('div', 'body-text');
  if (!text) {
    block.append(node('span', 'help', 'No notes on this card yet.'));
    return block;
  }
  // Only same-workspace card URLs (or [[id]]) become links. Other Markdown,
  // HTML and external URLs stay literal; never embed remote resources.
  const tokens =
    /\[([^\[\]\n]{1,200})\]\(([^\s()]+)\)|\[\[(?:card:)?([a-zA-Z0-9_-]{1,128})(?:\|([^\[\]\n]{1,200}))?\]\]|https?:\/\/[^\s<>"'()[\]]+|(?<![\w/])\/\?card=[a-zA-Z0-9_-]+/gi;
  let last = 0;
  for (const m of text.matchAll(tokens)) {
    block.append(text.slice(last, m.index));
    const raw = m[0],
      target = m[2] || raw.replace(/[.,;!]+$/, ''),
      id = m[3] || linkTarget(target);
    if (id) {
      const label =
        m[1] || m[4] || (m[3] && state.cards.find((c) => c.id === id)?.title) || (m[3] ? id : target);
      block.append(cardLink({ id }, '', label));
      if (!m[2] && !m[3]) block.append(raw.slice(target.length));
    } else block.append(raw);
    last = m.index + raw.length;
  }
  block.append(text.slice(last));
  return block;
}
function showCard(card) {
  const version = ++sheetVersion;
  const heading = sheet(card.title),
    detail = $('detail');
  const top = node('div', 'detail-top');
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
  const actions = node('div', 'button-row');
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
  actions.append(button('Edit', () => showEditor(card), 'btn', 'edit'));
  if (card.status !== 'done') actions.append(button('Mark done', () => statusAction('done'), 'btn', 'check'));
  if (card.status !== 'review')
    actions.append(button('Send to review', () => statusAction('review'), 'btn', 'review'));
  if (card.status === 'done') actions.append(button('Reopen', () => statusAction('open')));
  actions.append(
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
  detail.append(meta, renderBody(card.body || ''), actions, commentSection(card, version), imageSection(card, version));
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
        item.append(top, node('p', 'comment-body', c.body));
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
function imageSection(card, version) {
  const section = node('section', 'images'),
    head = node('div', 'image-head'),
    gallery = node('div', 'gallery');
  const input = node('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.hidden = true;
  input.multiple = true;
  const upload = button('Add image', () => input.click(), 'btn', 'image');
  head.append(node('h3', '', 'Images'), upload);
  section.append(head, node('p', 'help', 'JPEG, PNG, or WebP · up to 3 MiB each'), input, gallery);
  let revision = 0;
  const fetchImages = async () => {
    const ticket = ++revision;
    gallery.replaceChildren(node('p', 'help', 'Loading images…'));
    try {
      const { images } = await request(`${cardAPI(card.id)}/images`);
      if (version !== sheetVersion || ticket !== revision) return;
      gallery.replaceChildren();
      for (const item of images) {
        const url = safeImageURL(item.url);
        if (!url) continue;
        const figure = node('figure'),
          img = node('img');
        img.loading = 'lazy';
        img.alt = item.name || 'Card attachment';
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
        zoom.setAttribute('aria-label', `Enlarge ${item.name || 'image'}`);
        zoom.setAttribute('aria-pressed', 'false');
        zoom.append(img);
        figure.append(zoom, node('figcaption', '', item.name));
        gallery.append(figure);
      }
      if (!gallery.hasChildNodes()) gallery.append(node('p', 'help', 'No images attached.'));
    } catch (error) {
      if (error !== stale && version === sheetVersion && ticket === revision) {
        const msg = message(error);
        if (/not configured/i.test(msg)) {
          upload.disabled = true;
          gallery.replaceChildren(node('p', 'help', 'Image attachments are not configured for this workspace.'));
        } else {
          gallery.replaceChildren(node('p', 'error-text', msg), button('Retry images', fetchImages));
        }
      }
    }
  };
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    if (!files.length) return;
    upload.disabled = true;
    let sent = 0;
    try {
      for (const file of files) {
        if (version !== sheetVersion) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
          throw new Error('Choose a JPEG, PNG, or WebP image.');
        if (file.size > 3 * 1024 * 1024) throw new Error(`${file.name} is larger than 3 MiB.`);
        sheetMessage(`Uploading ${sent + 1} of ${files.length}…`);
        await request(`${cardAPI(card.id)}/images`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name),
          },
          body: file,
        });
        ++sent;
      }
      if (version === sheetVersion) sheetMessage(`${sent === 1 ? 'Image' : `${sent} images`} attached.`);
    } catch (error) {
      if (error !== stale && version === sheetVersion) sheetMessage(message(error));
    } finally {
      if (version === sheetVersion) {
        upload.disabled = false;
        input.value = '';
        if (sent) fetchImages();
      }
    }
  });
  fetchImages();
  return section;
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
function showEditor(card) {
  const version = ++sheetVersion;
  sheet(card ? 'Edit card' : 'New card');
  const form = node('form'),
    fields = node('div', 'fields');
  const title = editorInput('input', 'title', card?.title);
  title.required = true;
  title.maxLength = 200;
  title.placeholder = 'Give this card a title';
  const body = editorInput('textarea', 'body', card?.body);
  body.maxLength = 20000;
  body.rows = 5;
  body.placeholder = 'Write your notes, plan, or checklist (- [ ] item)…';
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
  fields.append(field('Title', title), bodyField, options, dates, field('Author (optional)', author));
  const buttons = node('div', 'form-bottom'),
    save = node('button', 'btn primary', 'Save card');
  save.type = 'submit';
  buttons.append(
    button('Cancel', () => (card ? showCard(card) : closeSheet())),
    save,
  );
  form.append(fields, buttons);
  $('detail').append(form);
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
