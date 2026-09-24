// JSON API behind the web app. Session-cookie auth; mutating calls need the X-MyCloud header (CSRF guard).
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HttpError, safeJoin, splitPath, decodeSegments, statOrNull, readBody, sendJson, readJson, writeJson, mimeOf, isImage, isVideo, uid } from './util.js';
import { sendFile } from './dav.js';
import { SESSION_COOKIE } from './auth.js';
import { parseEvents, buildEvent, parseContact, buildContact } from './pim.js';

const PHOTO_LIMIT = 20000;

export class Api {
  constructor({ auth, store, thumbs, dataDir, secureCookies }) {
    this.auth = auth;
    this.store = store;
    this.thumbs = thumbs;
    this.sharesFile = path.join(dataDir, 'shares.json');
    this.secureCookies = secureCookies;
  }

  async load() {
    this.shares = await readJson(this.sharesFile, {});
  }

  cookie(value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureCookies ? '; Secure' : ''}`;
  }

  async json(req) {
    const buf = await readBody(req, 1024 * 1024);
    try {
      return buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch {
      throw new HttpError(400, 'invalid json');
    }
  }

  filePath(user, rel) {
    return safeJoin(this.store.filesRoot(user), splitPath(rel));
  }

  async handle(req, res, url, ip) {
    const route = `${req.method} ${url.pathname.replace(/^\/api/, '')}`;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-mycloud'] !== '1') throw new HttpError(403, 'missing X-MyCloud header');

    if (route === 'POST /login') {
      if (this.auth.throttled(ip)) throw new HttpError(429, 'too many attempts, try again shortly');
      const { username = '', password = '' } = await this.json(req);
      const u = String(username).toLowerCase().trim();
      if (!(await this.auth.checkPassword(u, password))) {
        this.auth.noteFailure(ip);
        throw new HttpError(401, 'wrong username or password');
      }
      this.auth.noteSuccess(ip);
      await this.store.ensureUser(u);
      const token = await this.auth.createSession(u);
      res.setHeader('Set-Cookie', this.cookie(token, 30 * 24 * 3600));
      return sendJson(res, 200, { user: u });
    }

    const user = this.auth.sessionUser(req);
    if (!user) throw new HttpError(401, 'not signed in');
    const q = url.searchParams;

    switch (route) {
      case 'POST /logout':
        await this.auth.destroySession(req);
        res.setHeader('Set-Cookie', this.cookie('', 0));
        return sendJson(res, 200, {});

      case 'GET /me': {
        const s = await fs.statfs(this.store.filesRoot(user)).catch(() => null);
        return sendJson(res, 200, { user, origin: `${url.protocol}//${url.host}`, disk: s && { free: s.bavail * s.bsize, total: s.blocks * s.bsize } });
      }

      // ---- Drive ----
      case 'GET /files': {
        const dir = this.filePath(user, q.get('path'));
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
          throw e.code === 'ENOENT' || e.code === 'ENOTDIR' ? new HttpError(404, 'folder not found') : e;
        });
        const items = [];
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const st = await statOrNull(path.join(dir, e.name));
          if (st) items.push({ name: e.name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, mime: st.isDirectory() ? null : mimeOf(e.name) });
        }
        return sendJson(res, 200, { items });
      }
      case 'GET /files/raw': case 'HEAD /files/raw': {
        const p = this.filePath(user, q.get('path'));
        const st = await statOrNull(p);
        if (!st?.isFile()) throw new HttpError(404, 'file not found');
        const disposition = q.has('download') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` } : {};
        return sendFile(req, res, p, st, { 'Cache-Control': 'private, no-cache', ...disposition });
      }
      case 'PUT /files/raw': {
        const rel = splitPath(q.get('path'));
        if (!rel.length) throw new HttpError(400, 'path required');
        const p = this.filePath(user, rel.join('/'));
        await fs.mkdir(path.dirname(p), { recursive: true });
        const tmp = path.join(path.dirname(p), `.mycloud-upload-${crypto.randomBytes(6).toString('hex')}`);
        try {
          await pipeline(req, createWriteStream(tmp));
          await fs.rename(tmp, p);
        } catch (e) {
          await fs.rm(tmp, { force: true });
          throw e;
        }
        return sendJson(res, 200, {});
      }
      case 'POST /files/mkdir': {
        const { path: rel } = await this.json(req);
        if (!splitPath(rel).length) throw new HttpError(400, 'path required');
        await fs.mkdir(this.filePath(user, rel), { recursive: true });
        return sendJson(res, 200, {});
      }
      case 'POST /files/move': {
        const { from, to } = await this.json(req);
        const src = this.filePath(user, from);
        const dst = this.filePath(user, to);
        if (!splitPath(from).length || !splitPath(to).length) throw new HttpError(400, 'paths required');
        if (dst.startsWith(src + path.sep)) throw new HttpError(400, 'cannot move a folder into itself');
        if (await statOrNull(dst)) throw new HttpError(409, 'something with that name already exists');
        await fs.rename(src, dst);
        return sendJson(res, 200, {});
      }
      case 'DELETE /files': {
        if (!splitPath(q.get('path')).length) throw new HttpError(400, 'refusing to delete the root');
        await fs.rm(this.filePath(user, q.get('path')), { recursive: true });
        return sendJson(res, 200, {});
      }

      // ---- Photos ----
      case 'GET /photos': {
        const root = this.filePath(user, 'Photos');
        const photos = [];
        const walk = async (dir, rel) => {
          for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
            if (e.name.startsWith('.') || photos.length >= PHOTO_LIMIT) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full, `${rel}/${e.name}`);
            else if (isImage(e.name) || isVideo(e.name)) {
              const st = await statOrNull(full);
              if (st) photos.push({ path: `${rel}/${e.name}`, name: e.name, mtime: st.mtimeMs, size: st.size, video: isVideo(e.name) });
            }
          }
        };
        await walk(root, 'Photos');
        photos.sort((a, b) => b.mtime - a.mtime);
        return sendJson(res, 200, { photos });
      }
      case 'GET /thumb': {
        const p = this.filePath(user, q.get('path'));
        const st = await statOrNull(p);
        if (!st?.isFile()) throw new HttpError(404, 'not found');
        const thumb = await this.thumbs.get(this.store.cacheRoot(user), p, st);
        if (!thumb) {
          if (isVideo(p)) throw new HttpError(404, 'no thumbnail');
          return sendFile(req, res, p, st, { 'Cache-Control': 'private, max-age=86400' });
        }
        return sendFile(req, res, thumb, await fs.stat(thumb), { 'Cache-Control': 'private, max-age=86400' });
      }

      // ---- Share links ----
      case 'GET /shares':
        return sendJson(res, 200, { shares: Object.entries(this.shares).filter(([, s]) => s.user === user).map(([token, s]) => ({ token, ...s })) });
      case 'POST /shares': {
        const { path: rel } = await this.json(req);
        if (!(await statOrNull(this.filePath(user, rel)))) throw new HttpError(404, 'not found');
        const token = crypto.randomBytes(18).toString('base64url');
        this.shares[token] = { user, path: splitPath(rel).join('/'), created: new Date().toISOString() };
        await writeJson(this.sharesFile, this.shares);
        return sendJson(res, 200, { token, url: `/s/${token}` });
      }
      case 'DELETE /shares': {
        const token = q.get('token');
        if (this.shares[token]?.user === user) {
          delete this.shares[token];
          await writeJson(this.sharesFile, this.shares);
        }
        return sendJson(res, 200, {});
      }

      // ---- Calendar ----
      case 'GET /calendars': {
        const cals = await this.store.listCollections(user, 'calendars');
        return sendJson(res, 200, { calendars: cals.map((c) => ({ id: c.id, name: c.props['{DAV:}displayname'] || c.id, color: c.props['{http://apple.com/ns/ical/}calendar-color']?.slice(0, 7) || '#0a84ff' })) });
      }
      case 'GET /events': {
        const events = [];
        for (const cal of await this.store.listCollections(user, 'calendars')) {
          for (const name of await this.store.listItems(cal.dir)) {
            const text = await fs.readFile(path.join(cal.dir, name), 'utf8').catch(() => '');
            for (const ev of parseEvents(text)) events.push({ ...ev, calendar: cal.id, file: name });
          }
        }
        return sendJson(res, 200, { events });
      }
      case 'POST /events': {
        const body = await this.json(req);
        if (!body.title || !body.start) throw new HttpError(400, 'title and start are required');
        const dir = this.store.collectionDir(user, 'calendars', body.calendar || 'personal');
        if (!(await statOrNull(dir))) throw new HttpError(404, 'calendar not found');
        const id = uid();
        await this.store.writeItem(dir, `${id}.ics`, buildEvent({ ...body, uid: id }));
        return sendJson(res, 200, { file: `${id}.ics` });
      }
      case 'DELETE /events': {
        await this.store.deleteItem(this.store.collectionDir(user, 'calendars', q.get('calendar')), q.get('file'));
        return sendJson(res, 200, {});
      }

      // ---- Contacts ----
      case 'GET /contacts': {
        const contacts = [];
        for (const book of await this.store.listCollections(user, 'addressbooks')) {
          for (const name of await this.store.listItems(book.dir)) {
            const text = await fs.readFile(path.join(book.dir, name), 'utf8').catch(() => '');
            if (/BEGIN:VCARD/i.test(text) && !/X-ADDRESSBOOKSERVER-KIND:group/i.test(text)) contacts.push({ ...parseContact(text), book: book.id, file: name });
          }
        }
        contacts.sort((a, b) => a.name.localeCompare(b.name));
        return sendJson(res, 200, { contacts });
      }
      case 'POST /contacts': {
        const body = await this.json(req);
        if (!body.name) throw new HttpError(400, 'name is required');
        const dir = this.store.collectionDir(user, 'addressbooks', body.book || 'contacts');
        if (!(await statOrNull(dir))) throw new HttpError(404, 'address book not found');
        const id = uid();
        await this.store.writeItem(dir, `${id}.vcf`, buildContact({ ...body, uid: id }));
        return sendJson(res, 200, { file: `${id}.vcf` });
      }
      case 'DELETE /contacts': {
        await this.store.deleteItem(this.store.collectionDir(user, 'addressbooks', q.get('book')), q.get('file'));
        return sendJson(res, 200, {});
      }

      // ---- Account ----
      case 'GET /app-passwords':
        return sendJson(res, 200, { appPasswords: this.auth.listAppPasswords(user) });
      case 'POST /app-passwords': {
        const { label } = await this.json(req);
        return sendJson(res, 200, await this.auth.createAppPassword(user, label));
      }
      case 'DELETE /app-passwords':
        await this.auth.revokeAppPassword(user, q.get('id'));
        return sendJson(res, 200, {});
      case 'POST /password': {
        const { current, next } = await this.json(req);
        if (!(await this.auth.checkPassword(user, current))) throw new HttpError(403, 'current password is wrong');
        await this.auth.setPassword(user, next);
        const token = await this.auth.createSession(user);
        res.setHeader('Set-Cookie', this.cookie(token, 30 * 24 * 3600));
        return sendJson(res, 200, {});
      }
    }
    throw new HttpError(404, 'no such endpoint');
  }

  // Public, unauthenticated share links: /s/<token>[/sub/path]
  async share(req, res, url) {
    const [, , token, ...rest] = url.pathname.split('/');
    const share = this.shares[token];
    if (!share) throw new HttpError(404, 'this link has expired or never existed');
    const segs = [...splitPath(share.path), ...decodeSegments(rest.join('/'))];
    const p = safeJoin(this.store.filesRoot(share.user), segs);
    const st = await statOrNull(p);
    if (!st) throw new HttpError(404, 'not found');
    if (st.isFile()) return sendFile(req, res, p, st, { 'Cache-Control': 'no-cache' });
    const base = `/s/${token}/${rest.filter(Boolean).join('/')}${rest.filter(Boolean).length ? '/' : ''}`;
    const entries = (await fs.readdir(p, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
    const e = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(path.basename(p))} · MyCloud</title>
<style>body{font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#1d1d1f}a{color:#0a84ff;text-decoration:none}li{padding:6px 0;border-bottom:1px solid #eee;list-style:none}ul{padding:0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}li{border-color:#333}}</style>
<h1>☁️ ${e(path.basename(p))}</h1><ul>${entries.map((x) => `<li><a href="${e(base + encodeURIComponent(x.name))}${x.isDirectory() ? '/' : ''}">${x.isDirectory() ? '📁' : '📄'} ${e(x.name)}</a></li>`).join('')}</ul>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}
