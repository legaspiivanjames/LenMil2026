// Stores guests and responses in a Google Sheet instead of local JSON files.
// Trade-off vs JsonStore/a real database: Google Sheets has no transactions or unique
// constraints, so "one response per guest" is enforced with a re-check-and-self-heal
// step after writing rather than a hard guarantee. See README's "Google Sheets storage"
// section before relying on this for anything higher-stakes than a small guest list.
import { JWT } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { HttpError } from './store.js';

const nameKey = (name) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isName = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const isId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const bad = (message) => new HttpError(400, 'INVALID_INPUT', message);

export const GUESTS_TAB = 'Guests';
export const RESPONSES_TAB = 'Responses';
export const GUESTS_HEADER = ['id', 'name', 'extra'];
export const RESPONSES_HEADER = [
  'id', 'guestId', 'name', 'additionalAllowed', 'attending',
  'additionalGuests', 'additionalGuestCount', 'partySize', 'submittedAt'
];

// How long a submit() waits before re-checking for a duplicate before declaring itself
// the winner. Larger = safer against races, slower for every guest submitting an RSVP.
const SETTLE_MS = 600;

function columnLetter(count) {
  return String.fromCharCode('A'.charCodeAt(0) + count - 1);
}

export class SheetsStore {
  constructor({ sheetId, credentialsJsonBase64 } = {}) {
    this.sheetId = sheetId ?? process.env.GOOGLE_SHEET_ID;
    const encoded = credentialsJsonBase64 ?? process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    if (!this.sheetId || !encoded) {
      throw new Error('Configure GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.');
    }
    const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    this.auth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    this._sheetNumericIds = null;
  }

  async _request(pathAndQuery, init = {}) {
    const { token } = await this.auth.getAccessToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${pathAndQuery}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Google Sheets API ${init.method || 'GET'} ${pathAndQuery} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async _sheetIds() {
    if (this._sheetNumericIds) return this._sheetNumericIds;
    const meta = await this._request('?fields=sheets.properties');
    const ids = {};
    for (const sheet of meta.sheets) ids[sheet.properties.title] = sheet.properties.sheetId;
    if (!(GUESTS_TAB in ids) || !(RESPONSES_TAB in ids)) {
      throw new Error(`The spreadsheet needs tabs named "${GUESTS_TAB}" and "${RESPONSES_TAB}". Run "npm run seed-sheet" first.`);
    }
    this._sheetNumericIds = ids;
    return ids;
  }

  async _readRows(tab, header) {
    const range = `${tab}!A1:${columnLetter(header.length)}`;
    const data = await this._request(`/values/${encodeURIComponent(range)}`);
    const rows = data.values || [];
    const gotHeader = rows[0] || [];
    if (header.some((name, i) => gotHeader[i] !== name)) {
      throw new Error(`"${tab}" tab header must be exactly: ${header.join(', ')}. Run "npm run seed-sheet" to set this up, or fix row 1 by hand.`);
    }
    // Sheet row 1 is the header; data rows start at sheet row 2.
    return rows.slice(1).map((cells, i) => ({ row: i + 2, cells }));
  }

  // _row is defined non-enumerable so it never leaks through {...spread} or
  // JSON.stringify (e.g. into API responses) while still being readable by
  // this file's own row-lookup code (editGuest/deleteGuest/deleteResponse/submit).
  _withRow(object, row) {
    return Object.defineProperty(object, '_row', { value: row, enumerable: false });
  }

  _parseGuest({ row, cells }) {
    const [id, name, extraRaw] = cells;
    if (!id) return null; // blank row = deleted
    return this._withRow({ id, name, extra: Number(extraRaw) }, row);
  }

  _parseResponse({ row, cells }) {
    const [id, guestId, name, additionalAllowedRaw, attendingRaw, additionalGuestsRaw, additionalGuestCountRaw, partySizeRaw, submittedAt] = cells;
    if (!id) return null;
    return this._withRow({
      id, guestId, name,
      additionalAllowed: Number(additionalAllowedRaw),
      attending: attendingRaw === 'true',
      additionalGuests: additionalGuestsRaw ? JSON.parse(additionalGuestsRaw) : [],
      additionalGuestCount: Number(additionalGuestCountRaw),
      partySize: Number(partySizeRaw),
      submittedAt
    }, row);
  }

  _guestRowValues(guest) {
    return [guest.id, guest.name, guest.extra];
  }

  _responseRowValues(response) {
    return [
      response.id, response.guestId, response.name, response.additionalAllowed,
      response.attending ? 'true' : 'false', JSON.stringify(response.additionalGuests),
      response.additionalGuestCount, response.partySize, response.submittedAt
    ];
  }

  async read() {
    const [guestRows, responseRows] = await Promise.all([
      this._readRows(GUESTS_TAB, GUESTS_HEADER),
      this._readRows(RESPONSES_TAB, RESPONSES_HEADER)
    ]);
    return {
      guests: guestRows.map((r) => this._parseGuest(r)).filter(Boolean),
      responses: responseRows.map((r) => this._parseResponse(r)).filter(Boolean)
    };
  }

  async _deleteRow(tab, row) {
    const sheetId = (await this._sheetIds())[tab];
    await this._request('/:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }]
      })
    });
  }

  async _appendRow(tab, header, values) {
    const range = `${tab}!A1:${columnLetter(header.length)}1`;
    await this._request(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: [values] })
    });
  }

  async _updateRow(tab, header, row, values) {
    const range = `${tab}!A${row}:${columnLetter(header.length)}${row}`;
    await this._request(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [values] })
    });
  }

  async editGuest(id, payload) {
    if (!payload || !isName(payload.name) || !isCount(payload.extra)) {
      throw bad('Enter a name (up to 200 characters) and a whole number of additional guests, zero or more.');
    }
    const name = payload.name.normalize('NFC').trim().replace(/\s+/g, ' ');
    const { guests } = await this.read();
    if (guests.some((guest) => guest.id !== id && nameKey(guest.name) === nameKey(name))) {
      throw new HttpError(409, 'DUPLICATE_NAME', 'A guest with that name already exists.');
    }
    const existing = id ? guests.find((entry) => entry.id === id) : null;
    if (id && !existing) throw new HttpError(404, 'GUEST_NOT_FOUND', 'That guest no longer exists.');
    if (existing) {
      const guest = { id, name, extra: payload.extra };
      await this._updateRow(GUESTS_TAB, GUESTS_HEADER, existing._row, this._guestRowValues(guest));
      return guest;
    }
    const guest = { id: randomUUID(), name, extra: payload.extra };
    await this._appendRow(GUESTS_TAB, GUESTS_HEADER, this._guestRowValues(guest));
    return guest;
  }

  async deleteGuest(id) {
    const { guests, responses } = await this.read();
    const guest = guests.find((entry) => entry.id === id);
    if (!guest) throw new HttpError(404, 'GUEST_NOT_FOUND', 'That guest no longer exists.');
    if (responses.some((response) => response.guestId === id)) {
      throw new HttpError(409, 'HAS_RESPONSE', 'Delete this guest\'s RSVP response before removing the guest.');
    }
    await this._deleteRow(GUESTS_TAB, guest._row);
  }

  async submit(payload) {
    if (!payload || !isId(payload.guestId) || typeof payload.attending !== 'boolean' ||
        !Array.isArray(payload.additionalGuests) || !payload.additionalGuests.every(isName)) {
      throw bad('Choose your name and enter valid additional guest names.');
    }
    const { guests, responses } = await this.read();
    const guest = guests.find((entry) => entry.id === payload.guestId);
    if (!guest) throw new HttpError(404, 'GUEST_NOT_FOUND', 'This invitation is no longer available. Please contact us.');
    if (responses.some((response) => response.guestId === guest.id)) {
      throw new HttpError(409, 'ALREADY_RESPONDED', 'We already have a response for this guest. Please contact us to make a change.');
    }
    if (payload.additionalGuests.length > guest.extra) {
      throw new HttpError(409, 'ALLOWANCE_CHANGED', `This invitation now allows ${guest.extra} additional guest(s). Please update your party.`);
    }
    if (!payload.attending && payload.additionalGuests.length) throw bad('A declined invitation cannot include additional guests.');
    const additionalGuests = payload.additionalGuests.map((name) => name.normalize('NFC').trim());
    const response = {
      id: randomUUID(), guestId: guest.id, name: guest.name,
      additionalAllowed: guest.extra, attending: payload.attending,
      additionalGuests, additionalGuestCount: additionalGuests.length,
      partySize: payload.attending ? 1 + additionalGuests.length : 0,
      submittedAt: new Date().toISOString()
    };
    await this._appendRow(RESPONSES_TAB, RESPONSES_HEADER, this._responseRowValues(response));

    // Best-effort race mitigation: Sheets has no unique constraint, so if another
    // request submitted for the same guest at nearly the same instant, both appends
    // succeed as separate rows. Wait briefly for any concurrent append to land, then
    // keep only the earliest row for this guest and remove the rest. This narrows the
    // window for a duplicate surviving; it does not eliminate it under heavy contention.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const after = await this._readRows(RESPONSES_TAB, RESPONSES_HEADER);
    const dupes = after
      .map((r) => this._parseResponse(r))
      .filter((r) => r && r.guestId === guest.id)
      .sort((a, b) => a._row - b._row);
    if (dupes.length > 1 && dupes[0].id !== response.id) {
      // Another request's row is earlier than ours: we lost the race.
      const ours = dupes.find((r) => r.id === response.id);
      if (ours) await this._deleteRow(RESPONSES_TAB, ours._row);
      throw new HttpError(409, 'ALREADY_RESPONDED', 'We already have a response for this guest. Please contact us to make a change.');
    }
    for (const loser of dupes.slice(1)) {
      if (loser.id !== response.id) await this._deleteRow(RESPONSES_TAB, loser._row);
    }
    return response;
  }

  async deleteResponse(id) {
    const { responses } = await this.read();
    const response = responses.find((entry) => entry.id === id);
    if (!response) throw new HttpError(404, 'RESPONSE_NOT_FOUND', 'That response has already been deleted.');
    await this._deleteRow(RESPONSES_TAB, response._row);
  }
}
