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
import { HttpError, sendJson, statOrNull, mimeOf } from './util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const APP_CSP = "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

export async function createServer({ dataDir, cert, key, trustProxy = false, secureCookies, log = console }) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const auth = new Auth(dataDir);
  await auth.load();
  const store = new Store(dataDir);
  for (const u of Object.keys(auth.users)) await store.ensureUser(u);
  const dav = new Dav(store);
  const api = new Api({ auth, store, thumbs: new Thumbnailer(), dataDir, secureCookies: secureCookies ?? !!cert });
  await api.load();

  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

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
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const proto = cert || (trustProxy && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
    const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (p === '/.well-known/caldav' || p === '/.well-known/carddav') {
      res.writeHead(301, { Location: '/dav/' });
      return res.end();
    }
    if (p === '/dav' || p.startsWith('/dav/')) {
      if (req.method === 'OPTIONS') return dav.handle(req, res, null, url);
      const user = (await auth.basicUser(req)) || auth.sessionUser(req);
      if (!user) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MyCloud", charset="UTF-8"', 'Content-Length': 0 });
        return res.end();
      }
      return dav.handle(req, res, user, url);
    }
    if (p.startsWith('/api/')) return api.handle(req, res, url, clientIp(req));
    if (p.startsWith('/s/')) return api.share(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (p.startsWith('/join/')) return serveStatic(req, res, '/'); // the web app renders the invite
    return serveStatic(req, res, p);
  }

  const handler = (req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' || err.code === 'ENOTEMPTY' ? 409 : 500;
      if (status === 500) log.error(`[mycloud] ${req.method} ${req.url}:`, err);
      if (res.headersSent) return res.destroy();
      const message = status === 500 ? 'internal error' : err instanceof HttpError ? err.message : 'not found';
      if (req.url.startsWith('/api/')) return sendJson(res, status, { error: message });
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
  };

  const server = cert ? https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, handler) : http.createServer(handler);
  server.requestTimeout = 0; // large uploads over slow links

  // Pick up `mycloud adduser/passwd` run against a live server without a restart.
  const reloadUsers = () => auth.reloadUsers().then(async (changed) => {
    if (changed) for (const u of Object.keys(auth.users)) await store.ensureUser(u);
  }).catch((e) => log.error('[mycloud] reloading users failed:', e));
  watchFile(auth.usersFile, { interval: 2000 }, reloadUsers);
  server.on('close', () => unwatchFile(auth.usersFile, reloadUsers));
  return { server, auth, store };
}
