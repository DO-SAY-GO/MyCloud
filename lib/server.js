import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth } from './auth.js';
import { Store } from './store.js';
import { Dav } from './dav.js';
import { Api } from './api.js';
import { Thumbnailer } from './thumbs.js';
import { Limits, SYSTEM } from './limits.js';
import { Drive } from './drive.js';
import { Activity } from './activity.js';
import { HttpError, sendJson, statOrNull, mimeOf } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const APP_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// trustProxy: MyCloud sits behind exactly one reverse proxy (Caddy, Tailscale serve…). The client address is
// then the last X-Forwarded-For entry (the one that proxy appended); earlier entries are client-controlled.
// publicUrl: the address people use (https://cloud.example.com). Profiles, links and cookie security derive
// from it instead of from request headers.
export async function createServer({ dataDir, cert, key, trustProxy = false, publicUrl, log = console, env = process.env, statfs }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const auth = new Auth(dataDir, { davAccountPassword: env.MYCLOUD_DAV_ACCOUNT_PASSWORD === '1' });
  await auth.load();
  const store = new Store(dataDir);
  // Finish or roll back any calendar/contact transaction a crash interrupted, before anything else touches data.
  const recovered = await store.journal.recover();
  if (recovered) log.error(`[mycloud] recovered ${recovered} interrupted transaction(s)`);
  for (const j of store.journal.stuck) log.error(`[mycloud] could not finish recovering ${j.journal}; kept for the next start:`, j.failures);
  for (const u of Object.keys(auth.users)) await store.ensureUser(u);
  const activity = new Activity(dataDir);
  const limits = new Limits(store, env, statfs ? { statfs } : undefined);
  // Server bookkeeping reserves against the disk/inode floors (system budget); removals credit their budget.
  store.gate = (bytes, replacing, entries, fn, { peakEntries = entries } = {}) =>
    limits.withBytes(SYSTEM, bytes, replacing, fn, { entries, peakEntries });
  // Awaited by the store, so a removal's credit has landed before the request that caused it answers.
  store.freed = async (p, stats) => { const b = await limits.ownerOf(p).catch(() => null); if (b) limits.freed(b, stats); };
  const drive = new Drive(store, limits);
  const dav = new Dav(store, { limits, activity, drive });
  // Profiles are signed with the TLS certificate when MyCloud terminates TLS itself, or with an explicit pair
  // (MYCLOUD_SIGN_CERT/KEY[/CHAIN]) when a proxy like Caddy holds the certificate.
  const signCert = env.MYCLOUD_SIGN_CERT || cert;
  const signKey = env.MYCLOUD_SIGN_KEY || key;
  const signing = signCert && signKey ? { cert: signCert, key: signKey, chain: env.MYCLOUD_SIGN_CHAIN } : null;
  const icon = await fs.readFile(path.join(PUBLIC_DIR, 'icon-180.png')).catch(() => null);
  const thumbs = new Thumbnailer({ dataDir, log, hidePaths: [cert, key, signCert, signKey, env.MYCLOUD_SIGN_CHAIN],
    admit: (bytes, fn) => limits.withBytes(SYSTEM, bytes, 0, fn, { entries: 1 }) }); // cache is nobody's quota, but respects the disk reserve
  const api = new Api({ auth, store, thumbs, dataDir, signing, icon, limits, activity, drive });
  await api.load();

  // Trusting forwarded headers only makes sense with a known public address; without one, a directly exposed
  // server would take attacker-supplied X-Forwarded-* at face value.
  if (trustProxy && !publicUrl) throw new Error('--trust-proxy needs --public-url (the address people use, e.g. https://cloud.example.com)');
  const canonical = publicUrl ? new URL(publicUrl) : null;
  if (canonical && canonical.protocol !== 'https:' && canonical.protocol !== 'http:') throw new Error('--public-url must be http(s)');

  function context(req) {
    const forwarded = trustProxy ? req.headers['x-forwarded-for']?.split(',').map((s) => s.trim()).filter(Boolean).at(-1) : null;
    const ip = forwarded || req.socket.remoteAddress;
    const secure = canonical ? canonical.protocol === 'https:' : !!cert || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const host = req.headers.host && /^[A-Za-z0-9.[\]:-]+$/.test(req.headers.host) ? req.headers.host : 'localhost';
    const origin = canonical ? canonical.origin : `${secure ? 'https' : 'http'}://${host}`;
    return { ip, secure, origin };
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const p = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!p.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not found');
    const st = await statOrNull(p);
    if (!st?.isFile()) throw new HttpError(404, 'not found');
    res.writeHead(200, { 'Content-Type': mimeOf(p), 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP });
    if (req.method === 'HEAD') return res.end();
    res.end(await fs.readFile(p));
  }

  async function route(req, res) {
    const ctx = (req.mycloud = context(req));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (ctx.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, ctx.origin);
    const p = url.pathname;

    if (p === '/.well-known/caldav' || p === '/.well-known/carddav') {
      res.writeHead(301, { Location: '/dav/' });
      return res.end();
    }
    if (p === '/dav' || p.startsWith('/dav/')) {
      if (req.method === 'OPTIONS') return dav.handle(req, res, null, url);
      // App passwords only; browser cookies are deliberately not accepted here.
      const user = await auth.basicUser(req, ctx.ip);
      if (!user) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MyCloud", charset="UTF-8"', 'Content-Length': 0 });
        return res.end();
      }
      return dav.handle(req, res, user, url);
    }
    if (p.startsWith('/api/')) return api.handle(req, res, url, ctx.ip);
    if (p.startsWith('/s/')) return api.share(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (p.startsWith('/join/')) return serveStatic(req, res, '/'); // the web app renders the invite
    return serveStatic(req, res, p);
  }

  const handler = (req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' || err.code === 'ENOTEMPTY' ? 409 : err.code === 'ENOSPC' ? 507 : 500;
      if (status === 500) log.error(`[mycloud] ${req.method} ${req.url}:`, err);
      if (res.headersSent) return res.destroy();
      const message = status === 500 ? 'internal error' : status === 507 && !(err instanceof HttpError) ? 'the server is out of space' : err instanceof HttpError ? err.message : 'not found';
      if (req.url.startsWith('/api/')) return sendJson(res, status, { error: message });
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
  };

  const server = cert ? https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, handler) : http.createServer(handler);
  server.requestTimeout = 0; // a big upload over a slow link may take hours…
  server.timeout = 120_000; // …but a connection that goes silent for two minutes is dropped
  server.headersTimeout = 30_000;

  // Pick up `mycloud adduser/passwd` run against a live server without a restart.
  const reloadUsers = () => auth.reloadUsers().then(async (changed) => {
    if (changed) for (const u of Object.keys(auth.users)) await store.ensureUser(u);
  }).catch((e) => log.error('[mycloud] reloading users failed:', e));
  watchFile(auth.usersFile, { interval: 2000 }, reloadUsers);
  // Daily housekeeping: expire 30-day-old trash and partial uploads left by a crash.
  const sweep = () => store.sweep(Object.keys(auth.users)).catch((e) => log.error('[mycloud] sweep failed:', e));
  sweep();
  const sweeper = setInterval(sweep, 24 * 3600 * 1000);
  sweeper.unref();
  server.on('close', () => {
    unwatchFile(auth.usersFile, reloadUsers);
    clearInterval(sweeper);
  });
  return { server, auth, store, activity, limits, dav, drive };
}
