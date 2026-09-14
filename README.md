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

This section describes the default local-file storage. If `GOOGLE_SHEET_ID` is set, guests and responses live in a Google Sheet instead — same fields, see "Google Sheets storage" below.

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

## Google Sheets storage

By default the app stores guests and responses in `data/*.json` on local disk. Set `GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` in `.env` to store them in a Google Sheet instead — the app checks for `GOOGLE_SHEET_ID` at startup and uses `lib/sheetsStore.js` automatically when it's present, ignoring `data/*.json` entirely. This is required on Vercel, where the local filesystem does not persist between requests.

**Trade-off:** Google Sheets has no transactions or unique constraints. The one-response-per-guest rule is enforced by re-checking the sheet shortly after each submission and removing a duplicate if one landed at nearly the same instant — this narrows the risk of two near-simultaneous submissions for the same guest both being saved, but does not eliminate it the way a real database would. Fine for a small guest list; know that this is a soft guarantee, not a hard one.

Setup:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project, then **APIs & Services → Library** and enable **Google Sheets API**.
2. **APIs & Services → Credentials → Create Credentials → Service Account**. Any name is fine; no project roles are needed.
3. Open the new service account → **Keys → Add Key → Create new key → JSON**. This downloads a `.json` key file — keep it private, it's a credential.
4. Create a new Google Sheet. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS-PART`**`/edit`.
5. Share that sheet with the service account's email (the `client_email` field in the downloaded JSON) as **Editor**. Uncheck "notify people".
6. Base64-encode the whole downloaded JSON file and put the values in `.env`:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\your-key.json")) | Set-Clipboard
   ```
   Paste the clipboard contents as `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, and the sheet ID from step 4 as `GOOGLE_SHEET_ID`.
7. Run `npm run seed-sheet`. This creates the `Guests` and `Responses` tabs with the right header row, and imports your current `data/guests.json` / `data/responses.json` if those tabs are still empty. Safe to re-run.
8. `npm start` — the server logs nothing different, but is now reading/writing the sheet.

For Vercel, add the same two variables in the project's **Settings → Environment Variables** (see below).

## Online hosting

Use a Node.js host with **persistent writable disk storage**, one running application process, and HTTPS. This project cannot collect shared responses on a static-only host or an ephemeral serverless filesystem — unless Google Sheets storage (above) is configured, since then there's no local disk to lose.

1. Install dependencies with `npm ci --omit=dev`.
2. Configure the environment settings above, including a persistent absolute `DATA_DIR` (skip this if using Google Sheets storage).
3. Before the first start, place **both** JSON files in that directory. Use the original initial files for a fresh event, or your current backed-up pair when migrating existing records. (Skip if using Google Sheets storage.)
4. Run `npm start` from the project directory. Configure the HTTPS proxy and `TRUST_PROXY` to match the host.
5. Test RSVP and organizer login through the actual HTTPS domain.
6. Verify the same records remain after a restart and a redeploy.

### Vercel

Vercel's filesystem doesn't persist, so this only works with **Google Sheets storage configured** (above) — `data/*.json` will not survive a redeploy or even a quiet container restart there.

1. Push this repo to GitHub and import it into Vercel ([vercel.com/new](https://vercel.com/new)), or run `vercel` from the project directory with the [Vercel CLI](https://vercel.com/docs/cli).
2. In the project's **Settings → Environment Variables**, add: `ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`, `APP_ORIGIN` (your `https://your-project.vercel.app` URL, or custom domain), `TRUST_PROXY=1`, `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.
3. Deploy. Vercel serves everything in `public/` as static files directly and routes `/api/*` to the function in `api/index.js` (see `vercel.json`).
4. Visit the deployed URL's `/index.html`, `/RSVP.html`, `/Guests.html`, `/Responses.html`, submit a test RSVP, and confirm it appears in the Google Sheet.

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
