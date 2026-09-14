import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { JsonStore, atomicWrite } from '../lib/store.js';

const password = 'test-organizer-password';
const secret = 'test-session-secret-at-least-32-characters-long';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'reymil-rsvp-test-'));
  await cp(new URL('../data/guests.json', import.meta.url), path.join(dataDir, 'guests.json'));
  await writeFile(path.join(dataDir, 'responses.json'), '[]\n');
  let server;
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(dataDir), os.tmpdir());
    assert.ok(path.basename(dataDir).startsWith('reymil-rsvp-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const store = new JsonStore(dataDir, options.writer);
  const app = await createApp({ store, adminPassword: password, sessionSecret: secret, ...options });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const request = async (route, method = 'GET', body, extraHeaders = {}) => {
    const headers = { Origin: base, ...extraHeaders };
    if (cookie && !('Cookie' in headers)) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data };
  };
  const login = async () => {
    const response = await request('/api/admin/login', 'POST', { password });
    assert.equal(response.status, 200);
    cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
    return response;
  };
  return { dataDir, request, login, store, getCookie: () => cookie };
}

test('seed list and public data expose availability but no RSVP details', async (t) => {
  const f = await fixture(t);
  const result = await f.request('/api/guests');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.guests.length, 35);
  assert.equal(result.data.guests.find((g) => g.name === 'Reynaldo L. Mape Jr.').extra, 5);
  assert.equal(result.data.guests.find((g) => g.name === 'Cion Zu\u00f1iga').extra, 1);
  assert.deepEqual(Object.keys(result.data.guests[0]).sort(), ['extra', 'id', 'name', 'responded']);
  assert.ok(result.data.guests.every((g) => !g.responded));
});

test('management access, same-origin checks, cookie flags, logout and public file whitelist', async (t) => {
  const f = await fixture(t);
  for (const [route, method, body] of [
    ['/api/admin/guests', 'GET'], ['/api/admin/responses', 'GET'],
    ['/api/admin/guests', 'POST', { name: 'Test', extra: 0 }],
    ['/api/admin/guests/guest-001', 'PUT', { name: 'Test', extra: 0 }],
    ['/api/admin/guests/guest-001', 'DELETE'], ['/api/admin/responses/test', 'DELETE']
  ]) assert.equal((await f.request(route, method, body)).status, 401);
  const login = await f.login();
  const cookies = login.headers.getSetCookie().join(';');
  assert.match(cookies, /httponly/i);
  assert.match(cookies, /samesite=strict/i);
  assert.match(cookies, /path=\/api\/admin/i);
  assert.equal((await f.request('/api/admin/session')).status, 200);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 9 * 60 * 60 * 1000;
    assert.equal((await f.request('/api/admin/session')).status, 401);
  } finally { Date.now = realNow; }
  assert.equal((await f.request('/api/admin/session', 'GET', undefined, { Cookie: f.getCookie().replace(/rsvp-organizer=[^;]+/, 'rsvp-organizer=forged') })).status, 401);
  assert.equal((await f.request('/api/admin/guests', 'POST', { name: 'Test', extra: 0 }, { Origin: 'https://different.example' })).status, 403);
  assert.equal((await f.request('/api/admin/logout', 'POST', {}, { Origin: '' })).status, 403);
  for (const route of ['/data/guests.json', '/data/responses.json', '/.env', '/server.js', '/lib/store.js', '/package.json', '/node_modules/cookie-session/index.js', '/assets/../.env', '/uploads/%2e%2e%2fdata%2fresponses.json']) {
    assert.equal((await f.request(route)).status, 404, route);
  }
  for (const route of ['/RSVP.html', '/Guests.html', '/Responses.html', '/assets/paper.png', '/vendor/lucide.js', '/vendor/react.js', '/vendor/react-dom.js']) {
    assert.equal((await f.request(route)).status, 200, route);
  }
  const logout = await f.request('/api/admin/logout', 'POST', {});
  assert.match(logout.headers.getSetCookie().join(';'), /expires=Thu, 01 Jan 1970/i);
});

test('guest create/edit validation and stable identity', async (t) => {
  const f = await fixture(t);
  await f.login();
  const created = await f.request('/api/admin/guests', 'POST', { name: '  Sample   Guest  ', extra: 2 });
  assert.equal(created.status, 201);
  const id = created.data.guest.id;
  assert.equal(created.data.guest.name, 'Sample Guest');
  assert.equal((await f.request('/api/admin/guests', 'POST', { name: 'sample guest', extra: 0 })).status, 409);
  for (const extra of [-1, 1.5, '2', null]) {
    assert.equal((await f.request('/api/admin/guests', 'POST', { name: 'Invalid', extra })).status, 400);
  }
  assert.equal((await f.request('/api/admin/guests', 'POST', { name: '   ', extra: 0 })).status, 400);
  const updated = await f.request('/api/admin/guests/' + id, 'PUT', { name: 'Renamed Guest', extra: 0 });
  assert.equal(updated.data.guest.id, id);
  assert.equal((await f.request('/api/admin/guests/' + id, 'DELETE')).status, 200);
  assert.equal((await f.request('/api/admin/guests/' + id, 'PUT', { name: 'Missing', extra: 0 })).status, 404);
});

test('zero and five extras, declines, authoritative counts and timestamp', async (t) => {
  const f = await fixture(t);
  const zero = await f.request('/api/responses', 'POST', {
    guestId: 'guest-007', attending: true, additionalGuests: [], partySize: 99, additionalAllowed: 99, name: 'Forged name', submittedAt: '2000-01-01'
  });
  assert.equal(zero.status, 201);
  assert.equal(zero.data.response.partySize, 1);
  assert.equal(zero.data.response.additionalAllowed, 0);
  assert.equal(zero.data.response.name, 'Jay-Ar Lonceras');
  assert.ok(Date.now() - Date.parse(zero.data.response.submittedAt) < 10000);
  const names = ['One', 'Two', 'Three', 'Four', 'Five'];
  const five = await f.request('/api/responses', 'POST', { guestId: 'guest-001', attending: true, additionalGuests: names });
  assert.equal(five.status, 201);
  assert.equal(five.data.response.partySize, 6);
  assert.equal(five.data.response.additionalGuestCount, 5);
  const decline = await f.request('/api/responses', 'POST', { guestId: 'guest-002', attending: false, additionalGuests: [] });
  assert.equal(decline.status, 201);
  assert.equal(decline.data.response.partySize, 0);
  assert.equal((await f.request('/api/responses', 'POST', { guestId: 'guest-002', attending: true, additionalGuests: [] })).status, 409);
  assert.equal((await f.request('/api/guests')).data.guests.find((g) => g.id === 'guest-002').responded, true);
});

test('invalid and stale submissions do not save', async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { guestId: 'guest-003', attending: 'true', additionalGuests: [] },
    { guestId: 'guest-003', attending: true, additionalGuests: [' '] },
    { guestId: 'guest-003', attending: false, additionalGuests: ['One'] },
    { guestId: 'guest-003', attending: true, additionalGuests: [3] }
  ]) assert.equal((await f.request('/api/responses', 'POST', payload)).status, 400);
  assert.equal((await f.request('/api/responses', 'POST', { guestId: 'missing', attending: true, additionalGuests: [] })).status, 404);
  await f.login();
  await f.request('/api/admin/guests/guest-001', 'PUT', { name: 'Reynaldo L. Mape Jr.', extra: 0 });
  const stale = await f.request('/api/responses', 'POST', { guestId: 'guest-001', attending: true, additionalGuests: ['One'] });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'ALLOWANCE_CHANGED');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, 'responses.json'), 'utf8')), []);
});

test('simultaneous submissions save exactly one; admin deletion unlocks the guest', async (t) => {
  const f = await fixture(t);
  const body = { guestId: 'guest-003', attending: true, additionalGuests: ['Companion'] };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.request('/api/responses', 'POST', body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  const saved = results.find((r) => r.status === 201).data.response;
  await f.login();
  assert.equal((await f.request('/api/admin/guests/guest-003', 'DELETE')).status, 409);
  await f.request('/api/admin/guests/guest-003', 'PUT', { name: 'Aldrin Updated', extra: 0 });
  const response = (await f.request('/api/admin/responses')).data.responses[0];
  assert.equal(response.name, 'Aldrin John Bueno');
  assert.equal(response.additionalAllowed, 1);
  assert.equal((await f.request('/api/responses', 'POST', body)).status, 409);
  assert.equal((await f.request('/api/admin/responses/' + saved.id, 'DELETE')).status, 200);
  assert.equal((await f.request('/api/guests')).data.guests.find((g) => g.id === body.guestId).responded, false);
  const again = await f.request('/api/responses', 'POST', { ...body, additionalGuests: [] });
  assert.equal(again.status, 201);
  assert.equal(again.data.response.name, 'Aldrin Updated');
});

test('concurrent different guests do not lose responses and restart preserves storage', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(['guest-001', 'guest-002', 'guest-003'].map((guestId) =>
    f.request('/api/responses', 'POST', { guestId, attending: true, additionalGuests: [] })));
  assert.ok(results.every((result) => result.status === 201));
  const before = await readFile(path.join(f.dataDir, 'responses.json'), 'utf8');
  await createApp({ dataDir: f.dataDir, adminPassword: password, sessionSecret: secret });
  const reopened = await new JsonStore(f.dataDir).read();
  assert.equal(reopened.responses.length, 3);
  assert.equal(await readFile(path.join(f.dataDir, 'responses.json'), 'utf8'), before);
});

test('failed replacement preserves original file, cleans temporary files, and releases queue', async (t) => {
  const f = await fixture(t, {
    writer: (file, data) => atomicWrite(file, data, async () => { throw new Error('Simulated disk replacement failure'); })
  });
  const file = path.join(f.dataDir, 'responses.json');
  const before = await readFile(file, 'utf8');
  const body = { guestId: 'guest-007', attending: true, additionalGuests: [] };
  assert.equal((await f.request('/api/responses', 'POST', body)).status, 500);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.ok((await readdir(f.dataDir)).every((name) => !name.endsWith('.tmp')));
  assert.equal((await f.request('/api/guests')).data.guests.find((g) => g.id === 'guest-007').responded, false);
  f.store.writer = atomicWrite;
  assert.equal((await f.request('/api/responses', 'POST', body)).status, 201);
});

test('corrupt or missing storage fails startup without replacing records', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dataDir, 'responses.json');
  await writeFile(file, '{broken');
  await assert.rejects(createApp({ dataDir: f.dataDir, adminPassword: password, sessionSecret: secret }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await rm(file);
  await assert.rejects(createApp({ dataDir: f.dataDir, adminPassword: password, sessionSecret: secret }), /ENOENT/);
});

test('login throttling and production HTTPS session configuration', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/admin/login', 'POST', { password: 'incorrect' })).status, 401);
  assert.equal((await f.request('/api/admin/login', 'POST', { password })).status, 429);
  const prod = await fixture(t, { production: true, appOrigin: 'https://rsvp.example', trustProxy: 1 });
  const login = await prod.request('/api/admin/login', 'POST', { password }, { Origin: 'https://rsvp.example', 'X-Forwarded-Proto': 'https' });
  assert.equal(login.status, 200);
  assert.match(login.headers.getSetCookie().join(';'), /secure/i);
  assert.match(login.headers.get('strict-transport-security'), /max-age/);
  await assert.rejects(createApp({ adminPassword: password, sessionSecret: secret, production: true }), /APP_ORIGIN/);
});
