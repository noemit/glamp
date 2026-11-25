import { enablePush } from './push.js';

const $ = (id) => document.getElementById(id);
const dialog = $('dialog');
const statuses = { open: 'Open', review: 'Needs review', done: 'Done' };
const views = { docs: 'All cards', board: 'Board', todos: 'To-dos', calendar: 'Calendar' };
const state = {
  owner: false,
  epoch: 0,
  view: 'docs',
  cards: [],
  loaded: false,
  loadError: '',
  month: new Date(),
  selectedDay: '',
};
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
  b.append(label);
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
    statuses[status] || 'Open',
  );
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
    lock('Your session has ended. Sign in to open the notebook again.');
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
  state.loadError = '';
  state.view = 'docs';
  state.month = new Date();
  state.selectedDay = '';
  $('workspace').hidden = true;
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
    $('account').hidden = false;
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
        'Notebook hidden, but sign-out could not be confirmed. Reconnect and sign out again.';
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

// A single server query feeds every view, including calendar and board.
async function refresh() {
  const version = ++listVersion;
  const query = $('search').value.trim();
  state.loaded = false;
  state.loadError = '';
  render();
  try {
    const { cards } = await request(`/api/cards?q=${encodeURIComponent(query)}`);
    if (version !== listVersion) return;
    state.cards = cards;
    state.loaded = true;
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
function blankState() {
  if ($('search').value.trim())
    return empty(
      'No matching cards',
      'Try another keyword, or clear your search to see everything.',
      'search',
      button('Clear search', () => {
        $('search').value = '';
        refresh();
        $('search').focus();
      }),
    );
  const tasks = state.view === 'todos';
  return empty(
    tasks ? 'No to-dos yet' : 'A fresh page',
    tasks
      ? 'Turn any card into a to-do, or add one here.'
      : 'Add your first card for a note, a plan, or something to do.',
    tasks ? 'task' : 'book',
    button(tasks ? 'Add a to-do' : 'Add the first card', () => showEditor(null), 'btn', 'plus'),
  );
}
function render() {
  if (!state.owner) return;
  for (const tab of $('views').querySelectorAll('button')) {
    if (tab.dataset.view === state.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  $('view-title').textContent = views[state.view];
  const results = $('results');
  results.replaceChildren();
  results.setAttribute('aria-busy', String(!state.loaded && !state.loadError));
  const cards = state.view === 'todos' ? state.cards.filter((c) => c.isTask) : state.cards;
  $('card-count').textContent = state.loaded ? String(cards.length) : '';
  if (state.loadError) {
    results.append(empty('Could not load cards', state.loadError, 'book', button('Try again', refresh)));
    return;
  }
  if (!state.loaded) {
    results.append(node('p', 'quiet', 'Loading cards…'));
    return;
  }
  if (state.view === 'board') results.append(boardView(cards));
  else if (state.view === 'calendar') results.append(calendarView(cards));
  else if (!cards.length) results.append(blankState());
  else results.append(state.view === 'todos' ? todoView(cards) : docsView(cards));
}
function preview(card) {
  return (
    (card.body || '').replace(/\s+/g, ' ').trim().slice(0, 180) ||
    (card.isTask ? 'To-do card' : 'Notebook card')
  );
}
function docsView(cards) {
  const list = node('div', 'list');
  const head = node('div', 'list-label');
  head.setAttribute('aria-hidden', 'true');
  for (const label of ['Card', 'Created', 'Status', '']) head.append(node('span', '', label));
  list.append(head);
  for (const card of cards) {
    const row = node('article', 'entry'),
      main = node('div', 'entry-main'),
      text = node('div', 'entry-text');
    const stamp = node('span', `stamp${card.isTask ? ' task' : ''}`);
    stamp.append(icon(card.isTask ? 'task' : 'doc'));
    text.append(cardLink(card), node('p', 'snippet', preview(card)));
    main.append(stamp, text);
    const arrow = icon('next');
    arrow.classList.add('chev');
    row.append(
      main,
      node('span', 'secondary-line created', displayDate(new Date(card.createdAt))),
      badge(card.status),
      arrow,
    );
    list.append(row);
  }
  return list;
}
function boardView(cards) {
  const lanes = node('div', 'board');
  for (const [status, label] of Object.entries(statuses)) {
    const group = cards.filter((c) => c.status === status),
      lane = node('section', `lane ${status}`);
    lane.setAttribute('aria-label', label);
    const head = node('div', 'lane-head');
    const heading = node('h3', 'sr-only', label);
    head.append(heading, badge(status), node('span', 'count', group.length));
    lane.append(head);
    if (!group.length) lane.append(node('p', 'lane-empty', 'No cards here.'));
    for (const card of group) {
      const item = node('article', 'lane-card');
      item.append(
        node('span', 'lane-caption', card.isTask ? 'To-do' : 'Note'),
        cardLink(card),
        node('p', 'snippet', preview(card)),
      );
      lane.append(item);
    }
    lanes.append(lane);
  }
  return lanes;
}
function todoView(cards) {
  const list = node('div', 'list todo-list');
  list.append(
    node(
      'div',
      'todo-head',
      `${cards.filter((c) => c.status === 'done').length} of ${cards.length} complete`,
    ),
  );
  for (const card of cards) {
    const row = node('article', `entry${card.status === 'done' ? ' done-task' : ''}`),
      text = node('div', 'entry-text');
    const check = node('input');
    check.type = 'checkbox';
    check.checked = card.status === 'done';
    check.dataset.todo = card.id;
    check.setAttribute('aria-label', `Mark ${card.title} ${check.checked ? 'open' : 'done'}`);
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
    text.append(cardLink(card), node('p', 'snippet', scheduleText(card) || preview(card)));
    row.append(check, text, badge(card.status));
    list.append(row);
  }
  return list;
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
      const link = cardLink(card, `day-event${scheduled ? ' scheduled' : ''}`);
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
    li.append(cardLink(entry.card), node('span', 'help', entry.reason));
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
      button('Return to notebook', () => closeSheet()),
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
  top.append(badge(card.status), node('span', '', card.isTask ? 'To-do card' : 'Notebook card'));
  heading.before(top);
  const meta = node('div', 'detail-meta');
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
  detail.append(meta, renderBody(card.body || ''), actions, imageSection(card, version));
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
      if (error !== stale && version === sheetVersion && ticket === revision)
        gallery.replaceChildren(node('p', 'error-text', message(error)), button('Retry images', fetchImages));
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
  body.placeholder = 'Write your notes or plan…';
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
  fields.append(field('Title', title), bodyField, options, dates);
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
