// Vercel serverless entrypoint. Vercel routes every request that doesn't match a static
// file in public/ to this function; the Express app itself decides what's an API route,
// a known static file, or a 404 — same logic as running server.js directly.
import { createApp } from '../server.js';

let appPromise;
function getApp() {
  appPromise ??= createApp();
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    app(req, res);
  } catch (error) {
    appPromise = undefined; // let the next request retry instead of caching a failed startup
    console.error('App failed to start:', error.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, code: 'STARTUP_FAILED', error: 'The server is not configured correctly.' }));
  }
}
