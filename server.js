import express from 'express';
import cookieSession from 'cookie-session';
import { rateLimit } from 'express-rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JsonStore, HttpError } from './lib/store.js';
import { SheetsStore } from './lib/sheetsStore.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const sessionDuration = 8 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest();

export async function createApp(options = {}) {
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const appOrigin = options.appOrigin ?? process.env.APP_ORIGIN;
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY;
  if (!adminPassword || adminPassword.length < 12 || adminPassword.startsWith('replace-') ||
      !sessionSecret || sessionSecret.length < 32 || sessionSecret.startsWith('replace-')) {
    throw new Error('Configure ADMIN_PASSWORD (12+ characters) and SESSION_SECRET (32+ characters). Run npm run setup for local settings.');
  }
  if (production && (!appOrigin || new URL(appOrigin).protocol !== 'https:')) {
    throw new Error('Production requires APP_ORIGIN=https://your-domain.example.');
  }
  if (appOrigin && new URL(appOrigin).origin !== appOrigin) throw new Error('APP_ORIGIN must be an origin without a trailing slash or path.');
  const store = options.store ?? (process.env.GOOGLE_SHEET_ID
    ? new SheetsStore({})
    : new JsonStore(options.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data')));
  await store.read();
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const expected = appOrigin || `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') !== expected || req.get('sec-fetch-site') === 'cross-site') {
        return next(new HttpError(403, 'ORIGIN_REJECTED', 'Please submit from this website.'));
      }
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        return next(new HttpError(415, 'JSON_REQUIRED', 'Send an application/json request.'));
      }
    }
    next();
  });
  app.use('/api', express.json({ limit: '32kb' }));
  app.use('/api/admin', cookieSession({
    name: 'rsvp-organizer', keys: [sessionSecret], maxAge: sessionDuration,
    httpOnly: true, sameSite: 'strict', secure: production, path: '/api/admin'
  }));
  const isLoggedIn = (req) => req.session?.organizer === true && Number.isFinite(req.session.expiresAt) && req.session.expiresAt > Date.now();
  app.post('/api/admin/login', rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { ok: false, code: 'RATE_LIMITED', error: 'Too many login attempts. Please try again in 15 minutes.' }
  }), (req, res) => {
    if (typeof req.body?.password !== 'string' || !timingSafeEqual(hash(req.body.password), hash(adminPassword))) {
      throw new HttpError(401, 'INVALID_PASSWORD', 'That password is incorrect.');
    }
    req.session = { organizer: true, expiresAt: Date.now() + sessionDuration };
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });
  app.use('/api/admin', (req, res, next) => {
    if (!isLoggedIn(req)) return next(new HttpError(401, 'LOGIN_REQUIRED', 'Please sign in to continue.'));
    next();
  });
  app.get('/api/admin/session', (req, res) => res.json({ ok: true }));
  app.get('/api/guests', async (req, res) => {
    const { guests, responses } = await store.read();
    const responded = new Set(responses.map((response) => response.guestId));
    res.json({ ok: true, guests: guests.map((guest) => ({ ...guest, responded: responded.has(guest.id) })) });
  });
  app.post('/api/responses', rateLimit({
    windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { ok: false, code: 'RATE_LIMITED', error: 'Please wait a minute before trying again.' }
  }), async (req, res) => {
    const response = await store.submit(req.body);
    res.status(201).json({ ok: true, response });
  });
  app.get('/api/admin/guests', async (req, res) => {
    const { guests, responses } = await store.read();
    const responded = new Set(responses.map((response) => response.guestId));
    res.json({ ok: true, guests: guests.map((guest) => ({ ...guest, responded: responded.has(guest.id) })) });
  });
  app.post('/api/admin/guests', async (req, res) => res.status(201).json({ ok: true, guest: await store.editGuest(null, req.body) }));
  app.put('/api/admin/guests/:id', async (req, res) => res.json({ ok: true, guest: await store.editGuest(req.params.id, req.body) }));
  app.delete('/api/admin/guests/:id', async (req, res) => {
    await store.deleteGuest(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/admin/responses', async (req, res) => {
    const { guests, responses } = await store.read();
    res.json({ ok: true, guestCount: guests.length, responses: responses.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)) });
  });
  app.delete('/api/admin/responses/:id', async (req, res) => {
    await store.deleteResponse(req.params.id);
    res.json({ ok: true });
  });

  const publicRoot = path.join(root, 'public');
  const files = [
    'index.html', 'RSVP.html', 'Guests.html', 'Responses.html', 'Attendance.html',
    'support.js', 'admin.js', 'admin.css', 'attendance.js',
    'vendor/lucide.js', 'vendor/react.js', 'vendor/react-dom.js'
  ];
  for (const directory of ['assets', 'uploads']) {
    for (const entry of await readdir(path.join(publicRoot, directory), { withFileTypes: true })) {
      if (entry.isFile() && /\.(png|jpe?g|webp|svg|pdf)$/i.test(entry.name)) files.push(`${directory}/${entry.name}`);
    }
  }
  app.get('/', (req, res) => res.redirect('/index.html'));
  // Never expose the project root as a static directory: it contains private storage and secrets.
  const publicFiles = new Set(files);
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    let requested;
    try { requested = decodeURIComponent(req.path).slice(1); } catch { return next(); }
    if (!publicFiles.has(requested)) return next();
    if (requested.endsWith('.html')) res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicRoot, requested));
  });
  app.use((req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof HttpError ? error.status : error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : 500;
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({
      ok: false, code: error instanceof HttpError ? error.code : 'REQUEST_FAILED',
      error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid JSON request.' : status === 413 ? 'This request is too large.' : 'We could not complete this request. Please try again.'
    });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const app = await createApp();
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    const server = app.listen(port, host, () => console.log(`RSVP server: http://${host}:${server.address().port}`));
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) {
    console.error('Server could not start:', error.message);
    process.exitCode = 1;
  }
}
