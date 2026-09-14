# Reymil & Aira RSVP

The invitation, RSVP form, and organizer pages run from one Node.js server. Guest records and responses are stored in JSON files on that server.

## Local setup

Requires Node.js 24 or newer.

```powershell
npm install
npm run setup
npm start
```

The setup command creates a local `.env` with a generated organizer password and session secret. It never replaces an existing `.env`. Find the password in its `ADMIN_PASSWORD` setting.

Open these addresses in your browser:

- Invitation: <http://127.0.0.1:3000/index.html>
- RSVP: <http://127.0.0.1:3000/RSVP.html>
- Guest editor: <http://127.0.0.1:3000/Guests.html>
- Responses: <http://127.0.0.1:3000/Responses.html>

Use the same hostname for every page; `localhost` and `127.0.0.1` have separate login cookies. Open the server addresses rather than double-clicking HTML files. Live Server and static file hosting cannot save these JSON records.

If port 3000 is occupied, change `PORT` in `.env` and use that port in the addresses above.

## Organizer pages

Both pages use the same password and an eight-hour session. The guest editor supports adding, renaming, adjusting allowances, and deleting guests. Names must be unique without regard to case or extra spaces; allowances must be whole numbers, zero or more.

The responses page lists attendance, allowed extras at submission, additional guest names/count, total party size, and submission time. Timestamps are stored in UTC and displayed in the browser's local timezone. Headcount includes attending guests and their companions; declined invitations contribute zero.

A guest can submit one response, including a decline. Responded names remain visible but disabled in RSVP search. To allow another submission, delete the response in the organizer page. Delete a guest's response before removing that guest. Renaming a guest preserves their ID and does not unlock their RSVP.

Availability refreshes when the RSVP page or picker regains focus. The server checks again at submission, including allowance changes made while a form was open.

## Data

- `data/guests.json`: initial 35 guests from the supplied list, each with `id`, `name`, and `extra`.
- `data/responses.json`: initially an empty array. Saved records contain `id`, `guestId`, `name`, `additionalAllowed`, `attending`, `additionalGuests`, `additionalGuestCount`, `partySize`, and `submittedAt`.

Response names and allowances are snapshots: later guest edits do not rewrite an existing response. The application uses the stable guest ID to determine whether a response exists.

The server never resets or repairs data automatically. Both JSON files must exist and contain valid, consistent records before startup. It fails startup on missing/corrupt data rather than silently creating empty records. If a write fails, the UI displays an error and the previously saved file remains intact.

Use the editor for normal changes. If manually editing JSON, stop the server first and preserve IDs and record relationships. Never run multiple server processes against the same directory: the write queue belongs to one process.

The previous external spreadsheet has not been modified or imported. The application no longer reads or saves through it.

## Configuration

| Setting | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Organizer password, at least 12 characters. |
| `SESSION_SECRET` | Random signing secret, at least 32 characters. |
| `PORT` | HTTP port; default 3000. |
| `HOST` | Listen address; default `127.0.0.1`. Use `0.0.0.0` on hosting. |
| `DATA_DIR` | Directory containing both JSON files; defaults to the project `data` folder. Relative paths use the process working directory. |
| `NODE_ENV` | Set to `production` for online use. |
| `APP_ORIGIN` | Required in production: exact HTTPS origin, such as `https://rsvp.example.com`, with no trailing slash. |
| `TRUST_PROXY` | Set only to match the host's trusted reverse proxy topology, e.g. `1` for one proxy. |

Keep `.env` private. It is ignored by Git and cannot be served by the application. To revoke existing organizer sessions, change both `ADMIN_PASSWORD` and `SESSION_SECRET`, then restart. Incorrect login attempts are limited to 10 per 15 minutes per IP address.

## Online hosting

Use a Node.js host with **persistent writable disk storage**, one running application process, and HTTPS. This project cannot collect shared responses on a static-only host or an ephemeral serverless filesystem.

1. Install dependencies with `npm ci --omit=dev`.
2. Configure the environment settings above, including a persistent absolute `DATA_DIR`.
3. Before the first start, place **both** JSON files in that directory. Use the original initial files for a fresh event, or your current backed-up pair when migrating existing records.
4. Run `npm start` from the project directory. Configure the HTTPS proxy and `TRUST_PROXY` to match the host.
5. Test RSVP and organizer login through the actual HTTPS domain.
6. Verify the same records remain after a restart and a redeploy.

Deployments must keep the existing persistent data directory; do not copy the initial JSON files over live records. The server serves only approved pages and media, and does not expose raw storage or server files.

## Backup and restore

Stop the server before copying both JSON files to a dated folder outside publicly served assets. Back up before bulk edits or deployments. Restart the server after copying. Hosting snapshots may also be used when they capture the directory consistently.

To restore, stop the server, keep a copy of the current pair, and replace both JSON files with the matching backup pair. Start again and verify the guest and response counts.

## Verification

```powershell
npm test
npm run test:browser
```

Tests use temporary data and never submit to the project's response file. Browser tests use installed Chrome on Windows; otherwise install Playwright Chromium with `npx playwright install chromium`. Set `PLAYWRIGHT_CHANNEL` to select an installed supported browser.

Browser screenshots are written to `test-results`. Tests cover guest editing, protected API access, validation, concurrent submissions, response deletion/unlocking, failed writes, restart persistence, and desktop/mobile RSVP layout.
