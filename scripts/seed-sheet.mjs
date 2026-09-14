// One-time setup: creates the "Guests" and "Responses" tabs (with the right header row)
// in your Google Sheet if they don't exist yet, and imports your current local
// data/guests.json and data/responses.json into them if those tabs are still empty.
// Safe to re-run: it never touches a tab that already has data rows.
import { readFile } from 'node:fs/promises';
import { JWT } from 'google-auth-library';
import { GUESTS_TAB, RESPONSES_TAB, GUESTS_HEADER, RESPONSES_HEADER } from '../lib/sheetsStore.js';

const sheetId = process.env.GOOGLE_SHEET_ID;
const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
if (!sheetId || !encoded) {
  console.error('Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 in .env first.');
  process.exitCode = 1;
  process.exit();
}
const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
const auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

async function api(pathAndQuery, init = {}) {
  const { token } = await auth.getAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${pathAndQuery} -> ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

const meta = await api('?fields=sheets.properties');
const existing = new Map(meta.sheets.map((s) => [s.properties.title, s.properties]));

for (const [title, header] of [[GUESTS_TAB, GUESTS_HEADER], [RESPONSES_TAB, RESPONSES_HEADER]]) {
  if (!existing.has(title)) {
    await api('/:batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) });
    console.log(`Created "${title}" tab.`);
  }
  const range = `${title}!A1:${String.fromCharCode(64 + header.length)}1`;
  await api(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [header] })
  });
}
console.log('Header rows are set.');

async function currentRowCount(title) {
  const data = await api(`/values/${encodeURIComponent(`${title}!A2:A`)}`);
  return (data.values || []).length;
}

async function readJsonIfPresent(relativePath) {
  try { return JSON.parse(await readFile(new URL(relativePath, import.meta.url))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

if ((await currentRowCount(GUESTS_TAB)) === 0) {
  const guests = await readJsonIfPresent('../data/guests.json');
  if (guests?.length) {
    await api(`/values/${encodeURIComponent(`${GUESTS_TAB}!A1:C1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: guests.map((g) => [g.id, g.name, g.extra]) })
    });
    console.log(`Imported ${guests.length} guests from data/guests.json.`);
  } else {
    console.log('No local data/guests.json to import; "Guests" tab is empty. Add guests via the Guests.html page once the server is running.');
  }
} else {
  console.log('"Guests" tab already has rows; left it alone.');
}

if ((await currentRowCount(RESPONSES_TAB)) === 0) {
  const responses = await readJsonIfPresent('../data/responses.json');
  if (responses?.length) {
    await api(`/values/${encodeURIComponent(`${RESPONSES_TAB}!A1:I1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({
        values: responses.map((r) => [
          r.id, r.guestId, r.name, r.additionalAllowed, r.attending ? 'true' : 'false',
          JSON.stringify(r.additionalGuests), r.additionalGuestCount, r.partySize, r.submittedAt
        ])
      })
    });
    console.log(`Imported ${responses.length} responses from data/responses.json.`);
  } else {
    console.log('No responses to import; "Responses" tab is empty.');
  }
} else {
  console.log('"Responses" tab already has rows; left it alone.');
}

console.log('Done. The sheet is ready for SheetsStore.');
