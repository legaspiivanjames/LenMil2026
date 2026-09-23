const state = { rows: [], authenticated: false, loading: false, busy: false, loadId: 0 };
const icon = (name) => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
const icons = () => window.lucide?.createIcons({ attrs: { 'stroke-width': 1.7 } });

document.body.innerHTML = `
  <header class="topbar"><div class="topbar-inner">
    <a class="brand" href="/index.html"><img src="/assets/bouquet-white.png" alt=""><div><strong>Reymil &amp; Aira</strong><span>Wedding guest management</span></div></a>
    <div class="account">
      <a class="button" href="/index.html" aria-label="View invitation" title="View invitation">${icon('external-link')}<span class="invitation-label">Invitation</span></a>
      <button id="logout" class="icon-button" aria-label="Sign out" data-tooltip="Sign out" hidden>${icon('log-out')}</button>
    </div>
  </div></header>
  <main>
    <section id="login" class="login" hidden aria-labelledby="login-title">
      ${icon('lock-keyhole')}
      <h1 id="login-title">Organizer access</h1>
      <p>Reymil &amp; Aira</p>
      <form id="login-form">
        <label for="password">Organizer password</label>
        <div class="password-wrap"><input id="password" type="password" autocomplete="current-password" required>
          <button id="toggle-password" class="icon-button" type="button" aria-label="Show password" title="Show password">${icon('eye')}</button>
        </div>
        <p id="login-error" class="notice" role="alert" hidden></p>
        <button class="primary" type="submit">${icon('log-in')}<span>Sign in</span></button>
      </form>
    </section>
    <section id="workspace" hidden>
      <nav class="tabs" aria-label="Guest management">
        <a href="/Guests.html">${icon('users')}Guest list</a>
        <a href="/Responses.html">${icon('mail-check')}Responses</a>
        <a href="/Attendance.html" aria-current="page">${icon('list-checks')}Attendance</a>
      </nav>
      <div class="page-title"><h1>Attendance</h1></div>
      <dl id="summary" class="summary"></dl>
      <div id="notice" class="notice" role="status" hidden></div>
      <div class="toolbar">
        <div class="search">${icon('search')}<label class="sr-only" for="search">Search guests</label>
          <input id="search" type="search" placeholder="Search by name" autocomplete="off">
        </div>
        <div class="toolbar-actions">
          <button id="export" class="button">${icon('download')}<span>Export CSV</span></button>
          <button id="print" class="button">${icon('printer')}<span>Print</span></button>
          <button id="refresh" class="icon-button" aria-label="Refresh" data-tooltip="Refresh">${icon('refresh-cw')}</button>
        </div>
      </div>
      <div class="table-shell" tabindex="0" role="region" aria-label="Attendance table">
        <table class="attendance-table">
          <thead><tr>${['Guest name', 'Allowed extras', 'Party size'].map((label) => '<th scope="col">' + label + '</th>').join('')}</tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <p id="table-footer" class="table-footer" role="status"></p>
    </section>
    <p id="initial-loading" class="boot" role="status">Checking access...</p>
  </main>`;

const $ = (id) => document.getElementById(id);

function message(id, text = '', success = false) {
  const element = $(id);
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('success', success);
}

function showLogin(text = '') {
  state.authenticated = false;
  state.rows = [];
  state.loadId += 1;
  $('rows').replaceChildren();
  $('summary').replaceChildren();
  $('workspace').hidden = true;
  $('logout').hidden = true;
  $('login').hidden = false;
  message('login-error', text);
}

async function api(path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, cache: 'no-store', credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !path.endsWith('/login')) showLogin(state.authenticated ? 'Your session has ended. Please sign in again.' : '');
      throw new Error(data.error || 'This request could not be completed.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Connection interrupted. Please refresh and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function summary(items) {
  $('summary').replaceChildren(...items.map(([label, count]) => {
    const group = document.createElement('div');
    const title = document.createElement('dt');
    const value = document.createElement('dd');
    title.textContent = label;
    value.textContent = count;
    group.append(title, value);
    return group;
  }));
}

function cell(row, text, className = '') {
  const element = document.createElement('td');
  element.className = className;
  const heading = document.querySelectorAll('thead th')[row.children.length];
  if (heading) element.dataset.label = heading.textContent;
  if (text instanceof Node) element.append(text);
  else element.textContent = text;
  row.append(element);
  return element;
}

function attendingGroups() {
  return state.rows.filter((row) => row.attending === true);
}

function visibleGroups(query) {
  const q = query.trim().toLowerCase();
  return attendingGroups().filter((row) =>
    !q || row.name.toLowerCase().includes(q) || row.additionalGuests.some((name) => name.toLowerCase().includes(q))
  );
}

function flatten(groups) {
  const display = [];
  for (const guest of groups) {
    display.push({ kind: 'guest', key: guest.id, name: guest.name, extra: guest.extra, partySize: guest.partySize });
    guest.additionalGuests.forEach((name, i) => display.push({ kind: 'companion', key: guest.id + '-c' + i, name }));
  }
  return display;
}

function renderRows() {
  const groups = visibleGroups($('search').value);
  const display = flatten(groups);
  const body = $('rows');
  body.replaceChildren();
  if (state.loading || !display.length) {
    const row = document.createElement('tr');
    const content = cell(row, state.loading ? 'Loading...' : attendingGroups().length ? 'No matching results.' : 'No attending guests yet.', 'table-message');
    content.colSpan = 3;
    body.append(row);
  } else {
    for (const item of display) {
      const row = document.createElement('tr');
      row.dataset.id = item.key;
      if (item.kind === 'guest') {
        cell(row, item.name, 'name-cell');
        cell(row, item.extra, 'number');
        cell(row, item.partySize, 'number');
      } else {
        cell(row, '↳ ' + item.name, 'name-cell companion-name');
        cell(row, '', 'number');
        cell(row, '', 'number');
      }
      body.append(row);
    }
  }
  const guestCount = groups.length;
  const headcount = groups.reduce((sum, guest) => sum + guest.partySize, 0);
  $('table-footer').textContent = state.loading ? 'Loading...' : guestCount + ' attending guest' + (guestCount === 1 ? '' : 's') + ' · ' + headcount + ' total attendee' + (headcount === 1 ? '' : 's');
  icons();
}

function renderSummary() {
  const attending = state.rows.filter((row) => row.attending === true);
  const declined = state.rows.filter((row) => row.attending === false).length;
  const waiting = state.rows.filter((row) => row.attending === null).length;
  summary([
    ['Invited guests', state.rows.length],
    ['Attending headcount', attending.reduce((sum, row) => sum + row.partySize, 0)],
    ['Awaiting response', waiting],
    ['Declined', declined]
  ]);
}

async function load() {
  if (!state.authenticated || state.busy) return;
  const loadId = ++state.loadId;
  state.loading = true;
  $('refresh').disabled = true;
  renderRows();
  try {
    const [guestsData, responsesData] = await Promise.all([
      api('/api/admin/guests'),
      api('/api/admin/responses')
    ]);
    if (loadId !== state.loadId) return;
    const responseByGuestId = new Map(responsesData.responses.map((response) => [response.guestId, response]));
    state.rows = guestsData.guests.map((guest) => {
      const response = responseByGuestId.get(guest.id);
      return {
        id: guest.id,
        name: guest.name,
        extra: guest.extra,
        attending: response ? response.attending : null,
        partySize: response ? response.partySize : null,
        additionalGuests: response ? response.additionalGuests : []
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    renderSummary();
  } catch (error) {
    if (loadId === state.loadId) message('notice', error.message);
  } finally {
    if (loadId === state.loadId) {
      state.loading = false;
      $('refresh').disabled = false;
      renderRows();
    }
  }
}

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function buildCsv(groups) {
  const header = ['Guest name', 'Allowed extras', 'Party size'];
  const lines = [header];
  for (const guest of groups) {
    lines.push([guest.name, guest.extra, guest.partySize]);
    for (const companion of guest.additionalGuests) lines.push(['↳ ' + companion, '', '']);
  }
  return lines.map((line) => line.map(csvCell).join(',')).join('\r\n');
}

function downloadCsv(filename, content) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function busy(form, value) {
  state.busy = value;
  for (const input of form.querySelectorAll('input, button')) input.disabled = value;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('password').value;
  busy(event.currentTarget, true);
  message('login-error');
  try {
    await api('/api/admin/login', 'POST', { password });
    $('password').value = '';
    state.authenticated = true;
    $('login').hidden = true;
    $('workspace').hidden = false;
    $('logout').hidden = false;
    message('notice');
  } catch (error) {
    message('login-error', error.message);
  } finally {
    busy($('login-form'), false);
  }
  if (state.authenticated) await load();
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', 'POST', {}); showLogin(); }
  catch (error) { message('notice', error.message); }
});
$('toggle-password').addEventListener('click', () => {
  const visible = $('password').type === 'password';
  $('password').type = visible ? 'text' : 'password';
  $('toggle-password').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  $('toggle-password').title = visible ? 'Hide password' : 'Show password';
  $('toggle-password').innerHTML = icon(visible ? 'eye-off' : 'eye');
  icons();
});
$('search').addEventListener('input', renderRows);
$('refresh').addEventListener('click', () => { message('notice'); load(); });
$('export').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  downloadCsv('attendance-roster-' + today + '.csv', buildCsv(attendingGroups()));
});
$('print').addEventListener('click', () => {
  const savedQuery = $('search').value;
  $('search').value = '';
  renderRows();
  window.print();
  window.addEventListener('afterprint', function restore() {
    $('search').value = savedQuery;
    renderRows();
    window.removeEventListener('afterprint', restore);
  }, { once: true });
});
window.addEventListener('focus', () => {
  if (!state.loading) load();
});
window.addEventListener('load', icons);
icons();
try {
  await api('/api/admin/session');
  state.authenticated = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  await load();
} catch (error) {
  if ($('login').hidden) showLogin(error.message);
} finally {
  $('initial-loading').hidden = true;
}
