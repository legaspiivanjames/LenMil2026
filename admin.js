const view = document.body.dataset.view;
const guestsView = view === 'guests';
const state = { rows: [], guestCount: 0, authenticated: false, loading: false, busy: false, loadId: 0 };
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
        <a href="/Guests.html" ${guestsView ? 'aria-current="page"' : ''}>${icon('users')}Guest list</a>
        <a href="/Responses.html" ${!guestsView ? 'aria-current="page"' : ''}>${icon('mail-check')}Responses</a>
      </nav>
      <div class="page-title"><h1>${guestsView ? 'Guest list' : 'RSVP responses'}</h1>
        ${guestsView ? '<button id="add-guest" class="primary">' + icon('plus') + 'Add guest</button>' : ''}
      </div>
      <dl id="summary" class="summary"></dl>
      <div id="notice" class="notice" role="status" hidden></div>
      <div class="toolbar">
        <div class="search">${icon('search')}<label class="sr-only" for="search">Search ${guestsView ? 'guests' : 'responses'}</label>
          <input id="search" type="search" placeholder="Search by name" autocomplete="off">
        </div>
        ${!guestsView ? '<div class="filter"><label for="attendance">Attendance</label><select id="attendance"><option value="all">All responses</option><option value="yes">Attending</option><option value="no">Not attending</option></select></div>' : ''}
        <button id="refresh" class="icon-button" aria-label="Refresh" data-tooltip="Refresh">${icon('refresh-cw')}</button>
      </div>
      <div class="table-shell" tabindex="0" role="region" aria-label="${guestsView ? 'Guest list' : 'RSVP responses'} table">
        <table class="${guestsView ? 'guest-table' : 'response-table'}">
          <thead><tr>${(guestsView
            ? ['Guest name', 'Allowed extras', 'RSVP status', 'Actions']
            : ['Guest name', 'Attendance', 'Allowed extras', 'Extra count', 'Additional guests', 'Party size', 'Submitted', 'Actions']
          ).map((label) => '<th scope="col">' + label + '</th>').join('')}</tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <p id="table-footer" class="table-footer" role="status"></p>
    </section>
    <p id="initial-loading" class="boot" role="status">Checking access...</p>
  </main>
  <dialog id="guest-dialog" aria-labelledby="guest-title">
    <form id="guest-form">
      <div class="dialog-top"><h2 id="guest-title">Add guest</h2><button class="icon-button" type="button" data-close="guest-dialog" aria-label="Close">${icon('x')}</button></div>
      <label class="field" for="guest-name">Guest name<input id="guest-name" maxlength="200" required autocomplete="off"></label>
      <label class="field" for="guest-extra">Allowed additional guests<input id="guest-extra" type="number" min="0" step="1" value="0" required></label>
      <p id="guest-error" class="notice" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" data-close="guest-dialog">Cancel</button><button id="save-guest" class="primary" type="submit">${icon('check')}Save guest</button></div>
    </form>
  </dialog>
  <dialog id="delete-dialog" aria-labelledby="delete-title">
    <form id="delete-form">
      <h2 id="delete-title">Delete response?</h2><p id="delete-copy"></p>
      <p id="delete-error" class="notice" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" data-close="delete-dialog">Cancel</button><button class="danger" type="submit">${icon('trash-2')}Delete</button></div>
    </form>
  </dialog>`;

const $ = (id) => document.getElementById(id);
const guestDialog = $('guest-dialog');
const deleteDialog = $('delete-dialog');
let editingId = null;
let deleting = null;

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
  guestDialog.close();
  deleteDialog.close();
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

function badge(label, variant) {
  const element = document.createElement('span');
  element.className = 'status ' + variant;
  element.textContent = label;
  return element;
}

function actionButton(label, symbol, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button' + (danger ? ' delete' : '');
  button.setAttribute('aria-label', label);
  button.dataset.tooltip = label;
  button.title = label;
  button.innerHTML = icon(symbol);
  button.addEventListener('click', action);
  return button;
}

function renderRows() {
  const query = $('search').value.trim().toLowerCase();
  const attendance = $('attendance')?.value || 'all';
  const filtered = state.rows.filter((row) => {
    const names = guestsView ? row.name : [row.name, ...row.additionalGuests].join(' ');
    return names.toLowerCase().includes(query) &&
      (guestsView || attendance === 'all' || row.attending === (attendance === 'yes'));
  });
  const body = $('rows');
  body.replaceChildren();
  if (state.loading || !filtered.length) {
    const row = document.createElement('tr');
    const content = cell(row, state.loading ? 'Loading...' : state.rows.length ? 'No matching results.' : guestsView ? 'No guests yet.' : 'No RSVP responses yet.', 'table-message');
    content.colSpan = guestsView ? 4 : 8;
    body.append(row);
  } else {
    for (const item of filtered) {
      const row = document.createElement('tr');
      row.dataset.id = item.id;
      const nameCell = cell(row, item.name, 'name-cell');
      if (guestsView) {
        const mobileStatus = badge(item.responded ? 'Responded' : 'Awaiting response', item.responded ? 'responded' : 'waiting');
        mobileStatus.classList.add('mobile-status');
        nameCell.append(mobileStatus);
        cell(row, item.extra, 'number');
        cell(row, badge(item.responded ? 'Responded' : 'Awaiting response', item.responded ? 'responded' : 'waiting'));
      } else {
        cell(row, badge(item.attending ? 'Attending' : 'Not attending', item.attending ? 'yes' : 'no'));
        cell(row, item.additionalAllowed, 'number');
        cell(row, item.additionalGuestCount, 'number');
        const names = document.createElement('ul');
        names.className = 'companions';
        for (const name of item.additionalGuests) {
          const entry = document.createElement('li');
          entry.textContent = name;
          names.append(entry);
        }
        cell(row, item.additionalGuests.length ? names : 'None');
        cell(row, item.partySize, 'number');
        const time = document.createElement('time');
        time.dateTime = item.submittedAt;
        time.textContent = new Date(item.submittedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        cell(row, time);
      }
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      if (guestsView) actions.append(actionButton('Edit ' + item.name, 'pencil', () => openGuest(item)));
      actions.append(actionButton('Delete ' + item.name, 'trash-2', () => openDelete(item), true));
      cell(row, actions);
      body.append(row);
    }
  }
  $('table-footer').textContent = state.loading ? 'Loading...' : filtered.length + ' of ' + state.rows.length + (guestsView ? ' guests' : ' responses');
  icons();
}

function renderSummary() {
  if (guestsView) {
    const responded = state.rows.filter((guest) => guest.responded).length;
    summary([['Invited guests', state.rows.length], ['Responded', responded], ['Awaiting response', state.rows.length - responded], ['Allowed extras', state.rows.reduce((sum, guest) => sum + guest.extra, 0)]]);
  } else {
    const attending = state.rows.filter((row) => row.attending).length;
    summary([['Responses', state.rows.length], ['Attending headcount', state.rows.reduce((sum, row) => sum + row.partySize, 0)], ['Awaiting response', state.guestCount - state.rows.length], ['Declined invitations', state.rows.length - attending]]);
  }
}

async function load() {
  if (!state.authenticated || state.busy) return;
  const loadId = ++state.loadId;
  state.loading = true;
  $('refresh').disabled = true;
  renderRows();
  try {
    const data = await api('/api/admin/' + view);
    if (loadId !== state.loadId) return;
    state.rows = guestsView ? data.guests.slice().sort((a, b) => a.name.localeCompare(b.name)) : data.responses;
    state.guestCount = data.guestCount || 0;
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

function openGuest(guest) {
  editingId = guest?.id || null;
  $('guest-title').textContent = guest ? 'Edit guest' : 'Add guest';
  $('guest-name').value = guest?.name || '';
  $('guest-extra').value = guest?.extra ?? 0;
  message('guest-error');
  guestDialog.showModal();
  $('guest-name').focus();
}

function openDelete(item) {
  if (guestsView && item.responded) {
    message('notice', 'Delete this guest\'s response on the Responses page before removing the guest.');
    return;
  }
  deleting = item;
  $('delete-title').textContent = guestsView ? 'Delete guest?' : 'Delete response?';
  $('delete-copy').textContent = guestsView
    ? 'Remove ' + item.name + ' from the invitation list?'
    : 'Delete the response from ' + item.name + '? This guest will be able to submit a new RSVP.';
  message('delete-error');
  deleteDialog.showModal();
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
$('add-guest')?.addEventListener('click', () => openGuest());
$('search').addEventListener('input', renderRows);
$('attendance')?.addEventListener('change', renderRows);
$('refresh').addEventListener('click', () => { message('notice'); load(); });
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => { if (!state.busy) $(button.dataset.close).close(); });
}
for (const dialog of [guestDialog, deleteDialog]) {
  dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
}
$('guest-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('guest-name').value.trim();
  const extra = $('guest-extra').valueAsNumber;
  if (!name || !Number.isSafeInteger(extra) || extra < 0) {
    message('guest-error', 'Enter a name and a whole number of additional guests, zero or more.');
    return;
  }
  busy($('guest-form'), true);
  message('guest-error');
  let saved = false;
  try {
    await api('/api/admin/guests' + (editingId ? '/' + encodeURIComponent(editingId) : ''), editingId ? 'PUT' : 'POST', { name, extra });
    guestDialog.close();
    message('notice', 'Guest saved.', true);
    saved = true;
  } catch (error) { message('guest-error', error.message); }
  finally { busy($('guest-form'), false); }
  if (saved) await load();
});
$('delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!deleting) return;
  busy($('delete-form'), true);
  message('delete-error');
  let deleted = false;
  try {
    await api('/api/admin/' + view + '/' + encodeURIComponent(deleting.id), 'DELETE');
    deleteDialog.close();
    message('notice', guestsView ? 'Guest deleted.' : 'Response deleted. This guest can respond again.', true);
    deleted = true;
  } catch (error) { message('delete-error', error.message); }
  finally { busy($('delete-form'), false); }
  if (deleted) await load();
});
window.addEventListener('focus', () => {
  if (!guestDialog.open && !deleteDialog.open && !state.loading) load();
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
