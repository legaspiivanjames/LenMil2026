import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const nameKey = (name) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isName = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
const isId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const bad = (message) => new HttpError(400, 'INVALID_INPUT', message);

function validateData(guests, responses) {
  if (!Array.isArray(guests) || !Array.isArray(responses)) throw new Error('Storage must contain JSON arrays.');
  const ids = new Set();
  const names = new Set();
  for (const guest of guests) {
    if (!guest || !isId(guest.id) || !isName(guest.name) || !isCount(guest.extra) ||
        ids.has(guest.id) || names.has(nameKey(guest.name))) throw new Error('Invalid or duplicate guest in storage.');
    ids.add(guest.id);
    names.add(nameKey(guest.name));
  }
  const responded = new Set();
  const responseIds = new Set();
  for (const response of responses) {
    if (!response || !isId(response.id) || responseIds.has(response.id) || !ids.has(response.guestId) ||
        responded.has(response.guestId) || !isName(response.name) || typeof response.attending !== 'boolean' ||
        !isCount(response.additionalAllowed) || !Array.isArray(response.additionalGuests) ||
        !response.additionalGuests.every(isName) || response.additionalGuests.length > response.additionalAllowed ||
        response.additionalGuestCount !== response.additionalGuests.length ||
        (!response.attending && response.additionalGuests.length !== 0) ||
        response.partySize !== (response.attending ? 1 + response.additionalGuests.length : 0) ||
        typeof response.submittedAt !== 'string' || !Number.isFinite(Date.parse(response.submittedAt))) {
      throw new Error('Invalid or duplicate response in storage.');
    }
    responded.add(response.guestId);
    responseIds.add(response.id);
  }
}

export async function atomicWrite(file, value, replace = rename) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    await replace(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class JsonStore {
  constructor(directory, writer = atomicWrite) {
    this.directory = path.resolve(directory);
    this.writer = writer;
    this.queue = Promise.resolve();
  }

  // Reads and mutations share a queue so validation and commit see one consistent state.
  run(operation) {
    const result = this.queue.then(async () => {
      const [guests, responses] = await Promise.all(['guests', 'responses'].map(async (key) =>
        JSON.parse(await readFile(path.join(this.directory, `${key}.json`), 'utf8'))
      ));
      validateData(guests, responses);
      return operation({ guests, responses });
    });
    this.queue = result.catch(() => {});
    return result;
  }

  read() { return this.run((data) => data); }

  async save(key, data) {
    validateData(data.guests, data.responses);
    await this.writer(path.join(this.directory, `${key}.json`), data[key]);
  }

  editGuest(id, payload) {
    return this.run(async (data) => {
      if (!payload || !isName(payload.name) || !isCount(payload.extra)) {
        throw bad('Enter a name (up to 200 characters) and a whole number of additional guests, zero or more.');
      }
      const name = payload.name.normalize('NFC').trim().replace(/\s+/g, ' ');
      if (data.guests.some((guest) => guest.id !== id && nameKey(guest.name) === nameKey(name))) {
        throw new HttpError(409, 'DUPLICATE_NAME', 'A guest with that name already exists.');
      }
      let guest = id ? data.guests.find((entry) => entry.id === id) : null;
      if (id && !guest) throw new HttpError(404, 'GUEST_NOT_FOUND', 'That guest no longer exists.');
      if (!guest) {
        guest = { id: randomUUID(), name, extra: payload.extra };
        data.guests.push(guest);
      } else {
        guest.name = name;
        guest.extra = payload.extra;
      }
      await this.save('guests', data);
      return guest;
    });
  }

  deleteGuest(id) {
    return this.run(async (data) => {
      if (!data.guests.some((guest) => guest.id === id)) throw new HttpError(404, 'GUEST_NOT_FOUND', 'That guest no longer exists.');
      if (data.responses.some((response) => response.guestId === id)) {
        throw new HttpError(409, 'HAS_RESPONSE', 'Delete this guest\'s RSVP response before removing the guest.');
      }
      data.guests = data.guests.filter((guest) => guest.id !== id);
      await this.save('guests', data);
    });
  }

  submit(payload) {
    return this.run(async (data) => {
      if (!payload || !isId(payload.guestId) || typeof payload.attending !== 'boolean' ||
          !Array.isArray(payload.additionalGuests) || !payload.additionalGuests.every(isName)) {
        throw bad('Choose your name and enter valid additional guest names.');
      }
      const guest = data.guests.find((entry) => entry.id === payload.guestId);
      if (!guest) throw new HttpError(404, 'GUEST_NOT_FOUND', 'This invitation is no longer available. Please contact us.');
      if (data.responses.some((response) => response.guestId === guest.id)) {
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
      data.responses.push(response);
      await this.save('responses', data);
      return response;
    });
  }

  deleteResponse(id) {
    return this.run(async (data) => {
      if (!data.responses.some((response) => response.id === id)) throw new HttpError(404, 'RESPONSE_NOT_FOUND', 'That response has already been deleted.');
      data.responses = data.responses.filter((response) => response.id !== id);
      await this.save('responses', data);
    });
  }
}
