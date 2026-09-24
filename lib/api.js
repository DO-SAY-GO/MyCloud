// JSON API behind the web app. Session-cookie auth; mutating calls need the X-MyCloud header (CSRF guard).
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HttpError, safeJoin, splitPath, decodeSegments, statOrNull, readBody, sendJson, readJson, updateJson, mimeOf, isImage, isVideo, uid } from './util.js';
import { sendFile, applyClientMtime } from './dav.js';
import { SESSION_COOKIE } from './auth.js';
import { parseEvents, buildEvent, parseContact, buildContact, splitCalendar, splitVcards, itemName } from './pim.js';
import { fetchPublicText } from './fetch-public.js';
import { FAMILY_FOLDER } from './store.js';
import { buildProfile, signProfile } from './profile.js';
import { treeSize } from './limits.js';

const PHOTO_LIMIT = 20000;
const MAX_SHARES_PER_USER = 500;
const SHARE_TTL_DAYS = [1, 7, 30, 365];

export class Api {
  constructor({ auth, store, thumbs, dataDir, signing, icon, limits, activity }) {
    this.signing = signing;
    this.icon = icon;
    this.limits = limits;
    this.activity = activity;
    this.auth = auth;
    this.store = store;
    this.thumbs = thumbs;
    this.sharesFile = path.join(dataDir, 'shares.json');
    this.dataDir = dataDir;
    this.profiles = new Map(); // one-time download token -> { user, xml, expires }
    this.shareHits = new Map(); // token -> last logged access
    // Account recovery or removal also voids setup profiles that haven't been downloaded yet.
    auth.onRevoke((u) => { for (const [k, p] of this.profiles) if (p.user === u) this.profiles.delete(k); });
  }

  async load() {
    this.shares = await readJson(this.sharesFile, {});
  }

  // Secure whenever the browser is on HTTPS, including behind a TLS-terminating proxy.
  cookie(req, value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.mycloud?.secure ? '; Secure' : ''}`;
  }

  log(event, req, detail = {}) {
    this.activity?.log(event, { ip: req.mycloud?.ip, ...detail });
  }

  // Every write that grows storage passes the storage gate, billed to whoever's space it lands in.
  async admit(user, fsPath, bytes, replacing, fn) {
    return this.limits.withBytes(await this.limits.budgetFor(user, fsPath), bytes, replacing, fn);
  }

  async saveShares(fn) {
    const { data, result } = await updateJson(this.sharesFile, {}, fn);
    this.shares = data;
    return result;
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
      const { username = '', password = '' } = await this.json(req);
      const u = String(username).toLowerCase().trim().slice(0, 64);
      if (!(await this.auth.attempt(ip, u, () => this.auth.checkPassword(u, password)))) {
        this.log('login.fail', req, { user: u });
        throw new HttpError(401, 'wrong username or password');
      }
      this.log('login', req, { user: u });
      await this.store.ensureUser(u);
      const token = await this.auth.createSession(u);
      res.setHeader('Set-Cookie', this.cookie(req, token, 30 * 24 * 3600));
      return sendJson(res, 200, { user: u });
    }

    // Family invite links: look one up, then redeem it (creates the account and signs in).
    if (route === 'GET /join') {
      const inv = this.auth.invite(url.searchParams.get('token'));
      if (!inv) throw new HttpError(404, 'this invite link has expired or was already used');
      return sendJson(res, 200, { kind: inv.kind, username: inv.username, by: inv.by });
    }
    if (route === 'POST /join') {
      if (this.auth.throttled(ip)) throw new HttpError(429, 'too many attempts, try again shortly');
      const { token, username, password } = await this.json(req);
      let name;
      try {
        ({ name } = await this.auth.gate.run(ip, () => this.auth.redeemInvite(token, username, password)));
      } catch (e) {
        this.auth.noteFailure(ip);
        throw e instanceof HttpError ? e : new HttpError(400, e.message);
      }
      this.log('invite.redeem', req, { user: name });
      await this.store.ensureUser(name);
      res.setHeader('Set-Cookie', this.cookie(req, await this.auth.createSession(name), 30 * 24 * 3600));
      return sendJson(res, 200, { user: name });
    }

    const user = this.auth.sessionUser(req);
    if (!user) throw new HttpError(401, 'not signed in');
    const q = url.searchParams;
    const admin = this.auth.isAdmin(user);
    const requireAdmin = () => { if (!admin) throw new HttpError(403, 'only the family admin can do that'); };

    // Profile download: GET so Safari on iOS hands it to Settings.
    if (req.method === 'GET' && url.pathname.startsWith('/api/profile/')) {
      const token = url.pathname.slice('/api/profile/'.length);
      const p = this.profiles.get(token);
      this.profiles.delete(token);
      if (!p || p.user !== user || p.expires < Date.now()) throw new HttpError(404, 'this setup link has expired — create a new one in Settings');
      res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="MyCloud.mobileconfig"', 'Cache-Control': 'no-store' });
      return res.end(p.xml);
    }

    switch (route) {
      case 'POST /logout':
        await this.auth.destroySession(req);
        res.setHeader('Set-Cookie', this.cookie(req, '', 0));
        return sendJson(res, 200, {});

      case 'GET /me': {
        const s = await fs.statfs(this.store.filesRoot(user)).catch(() => null);
        return sendJson(res, 200, { user, admin, origin: req.mycloud.origin, secure: req.mycloud.secure, disk: s && { free: s.bavail * s.bsize, total: s.blocks * s.bsize } });
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
          if (st) items.push({ name: e.name, dir: st.isDirectory(), shared: e.isSymbolicLink() || undefined, size: st.size, mtime: st.mtimeMs, mime: st.isDirectory() ? null : mimeOf(e.name) });
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
          await this.limits.guard(await this.limits.budgetFor(user, p), req, (await statOrNull(p))?.size ?? 0, (meter) => pipeline(req, meter, createWriteStream(tmp)));
          await fs.rename(tmp, p);
        } catch (e) {
          await fs.rm(tmp, { force: true });
          throw e;
        }
        await applyClientMtime(req, p);
        return sendJson(res, 200, {});
      }
      case 'POST /files/mkdir': {
        const { path: rel } = await this.json(req);
        if (!splitPath(rel).length) throw new HttpError(400, 'path required');
        const dirPath = this.filePath(user, rel);
        await this.admit(user, dirPath, 4096 * splitPath(rel).length, 0, () => fs.mkdir(dirPath, { recursive: true }));
        return sendJson(res, 200, {});
      }
      case 'POST /files/move': {
        const { from, to } = await this.json(req);
        const src = this.filePath(user, from);
        const dst = this.filePath(user, to);
        if (!splitPath(from).length || !splitPath(to).length) throw new HttpError(400, 'paths required');
        if (dst.startsWith(src + path.sep)) throw new HttpError(400, 'cannot move a folder into itself');
        if (await this.store.isSharedLink(src)) throw new HttpError(403, 'the shared Family folder cannot be moved');
        if (await statOrNull(dst)) throw new HttpError(409, 'something with that name already exists');
        // Moving into another budget (e.g. out of Family) bills the destination.
        if ((await this.limits.budgetFor(user, src)) === (await this.limits.budgetFor(user, path.dirname(dst)))) await fs.rename(src, dst);
        else await this.admit(user, path.dirname(dst), await treeSize(src), 0, () => fs.rename(src, dst));
        return sendJson(res, 200, {});
      }
      case 'DELETE /files': {
        if (!splitPath(q.get('path')).length) throw new HttpError(400, 'refusing to delete the root');
        if (await this.store.isSharedLink(this.filePath(user, q.get('path')))) throw new HttpError(403, 'the shared Family folder cannot be deleted');
        const rel = splitPath(q.get('path')).join('/');
        await this.store.trash(user, this.filePath(user, rel), rel);
        this.log('file.delete', req, { user, path: rel });
        return sendJson(res, 200, {});
      }

      // ---- Recently Deleted ----
      case 'GET /trash':
        return sendJson(res, 200, { items: await this.store.listTrash(user) });
      case 'POST /trash/restore': {
        const { id, shared } = await this.json(req);
        const restored = await this.store.restore(user, id, !!shared);
        this.log('file.restore', req, { user, path: restored });
        return sendJson(res, 200, { path: restored });
      }
      case 'DELETE /trash': {
        const shared = q.get('shared') === '1';
        if (shared) requireAdmin(); // permanently erasing family things is the admin's call
        await this.store.purgeTrash(user, q.get('id'), shared);
        this.log('file.purge', req, { user, id: q.get('id') });
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
        await walk(this.filePath(user, `${FAMILY_FOLDER}/Photos`), `${FAMILY_FOLDER}/Photos`);
        photos.sort((a, b) => b.mtime - a.mtime);
        return sendJson(res, 200, { photos });
      }
      case 'GET /thumb': {
        const p = this.filePath(user, q.get('path'));
        const st = await statOrNull(p);
        if (!st?.isFile()) throw new HttpError(404, 'not found');
        const thumb = await this.thumbs.get(this.store.cacheRoot(user), p, st);
        if (!thumb) {
          // No thumbnailer: small web-friendly images can stand in; big originals, HEIC and video get a placeholder.
          if (!/\.(jpe?g|png|gif|webp|avif)$/i.test(p) || st.size > 4 * 1024 * 1024) throw new HttpError(404, 'no thumbnail');
          return sendFile(req, res, p, st, { 'Cache-Control': 'private, max-age=86400' });
        }
        return sendFile(req, res, thumb, await fs.stat(thumb), { 'Cache-Control': 'private, max-age=86400' });
      }

      // ---- Share links ----
      case 'GET /shares':
        return sendJson(res, 200, { shares: Object.entries(this.shares).filter(([, x]) => x.user === user).map(([token, x]) => ({ token, ...x })) });
      case 'POST /shares': {
        const { path: rel, days } = await this.json(req);
        const segs = splitPath(rel);
        // Publishing your whole Drive by accident is never what anyone meant.
        if (!segs.length) throw new HttpError(400, 'choose a file or folder to share, not your whole Drive');
        const st = await statOrNull(this.filePath(user, rel));
        if (!st) throw new HttpError(404, 'not found');
        // Decided by where the content really lives, so a renamed or copied alias of Family gets the same answer.
        const scope = await this.store.scopeOf(user, this.filePath(user, rel));
        if (!scope) throw new HttpError(403, 'that cannot be shared');
        if (scope === 'family' && !admin) throw new HttpError(403, 'only the family admin can publish things from the Family folder');
        const ttl = days === null || days === 0 ? null : SHARE_TTL_DAYS.includes(Number(days)) ? Number(days) : 7;
        const token = crypto.randomBytes(18).toString('base64url');
        const entry = { user, path: segs.join('/'), dir: st.isDirectory(), created: new Date().toISOString(), expires: ttl ? Date.now() + ttl * 86400 * 1000 : null };
        await this.saveShares((all) => {
          if (Object.values(all).filter((x) => x.user === user).length >= MAX_SHARES_PER_USER) throw new HttpError(429, 'too many share links; revoke some first');
          all[token] = entry;
        });
        this.log('share.create', req, { user, path: entry.path, dir: entry.dir, expires: entry.expires });
        return sendJson(res, 200, { token, url: `/s/${token}`, ...entry });
      }
      case 'DELETE /shares': {
        const token = q.get('token');
        if (this.shares[token]?.user === user) {
          await this.saveShares((all) => { delete all[token]; });
          this.log('share.revoke', req, { user });
        }
        return sendJson(res, 200, {});
      }

      // ---- Calendar ----
      case 'GET /calendars': {
        const cals = await this.store.listCollections(user, 'calendars');
        return sendJson(res, 200, { calendars: cals.map((c) => ({ id: c.id, name: c.props['{DAV:}displayname'] || c.id, color: c.props['{http://apple.com/ns/ical/}calendar-color']?.slice(0, 7) || '#0a84ff', shared: c.shared })) });
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
        const ics = buildEvent({ ...body, uid: id });
        await this.admit(user, dir, Buffer.byteLength(ics), 0, () => this.store.writeItem(dir, `${id}.ics`, ics));
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
        const vcf = buildContact({ ...body, uid: id });
        await this.admit(user, dir, Buffer.byteLength(vcf), 0, () => this.store.writeItem(dir, `${id}.vcf`, vcf));
        return sendJson(res, 200, { file: `${id}.vcf` });
      }
      case 'DELETE /contacts': {
        await this.store.deleteItem(this.store.collectionDir(user, 'addressbooks', q.get('book')), q.get('file'));
        return sendJson(res, 200, {});
      }

      // ---- Import (.ics / .vcf files, or a calendar link) ----
      case 'POST /import': {
        const type = q.get('type');
        if (type !== 'calendar' && type !== 'contacts') throw new HttpError(400, 'type must be calendar or contacts');
        const text = q.get('url') ? await fetchPublicText(q.get('url')) : (await readBody(req, 50 * 1024 * 1024)).toString('utf8');
        const area = type === 'calendar' ? 'calendars' : 'addressbooks';
        let target = q.get('target') || (type === 'contacts' ? 'contacts' : '');
        if (!target) target = await this.newCollection(user, area, q.get('name') || 'Imported');
        const dir = this.store.collectionDir(user, area, target);
        if (!(await statOrNull(dir))) throw new HttpError(404, 'that calendar or address book does not exist');
        const items = type === 'calendar'
          ? splitCalendar(text).map((i) => [itemName(i.uid, 'ics'), i.ics])
          : splitVcards(text).map((i) => [itemName(i.uid, 'vcf'), i.vcf]);
        if (!items.length) throw new HttpError(400, type === 'calendar' ? 'no events found in that file' : 'no contacts found in that file');
        // The whole import is sized and admitted at once (net of objects it replaces), then written.
        let bytes = 0;
        let replacing = 0;
        for (const [name, data] of items) {
          bytes += Buffer.byteLength(data);
          replacing += (await statOrNull(path.join(dir, name)))?.size ?? 0;
        }
        await this.admit(user, dir, bytes, replacing, async () => {
          for (const [name, data] of items) await this.store.writeItem(dir, name, data);
        });
        return sendJson(res, 200, { imported: items.length, target });
      }

      // ---- One-tap device setup (iPhone, iPad, Mac configuration profile) ----
      case 'POST /profile': {
        const { label } = await this.json(req);
        const ap = await this.auth.createAppPassword(user, label || 'iPhone');
        const token = crypto.randomBytes(18).toString('base64url');
        const xml = buildProfile({ url: new URL(req.mycloud.origin), user, password: ap.password, icon: this.icon });
        this.log('device.profile', req, { user, label: ap.label });
        const body = this.signing ? await signProfile(xml, this.signing) : Buffer.from(xml);
        this.profiles.set(token, { user, xml: body, expires: Date.now() + 10 * 60 * 1000 });
        return sendJson(res, 200, { url: `/api/profile/${token}` });
      }

      // ---- Family ----
      case 'GET /family': {
        const members = Object.entries(this.auth.users).map(([name, u]) => ({ name, admin: !!u.admin, created: u.created }));
        return sendJson(res, 200, { members, admin, invites: admin ? this.auth.listInvites() : [] });
      }
      case 'POST /family/invites': {
        requireAdmin();
        const { kind = 'join', username } = await this.json(req);
        if (kind !== 'join' && kind !== 'reset') throw new HttpError(400, 'bad invite kind');
        const token = await this.auth.createInvite(user, kind, username);
        this.log(kind === 'reset' ? 'invite.reset' : 'invite.create', req, { user, target: username });
        return sendJson(res, 200, { url: `/join/${token}` });
      }
      case 'DELETE /family/invites':
        requireAdmin();
        await this.auth.revokeInvite(q.get('id'));
        return sendJson(res, 200, {});
      case 'DELETE /family/members': {
        requireAdmin();
        const name = q.get('name');
        if (name === user) throw new HttpError(400, 'you cannot remove yourself');
        if (!this.auth.users[name]) throw new HttpError(404, 'no such member');
        await this.auth.deleteUser(name);
        await this.saveShares((all) => { for (const [k, x] of Object.entries(all)) if (x.user === name) delete all[k]; });
        this.log('member.remove', req, { user, target: name });
        // Nothing is destroyed: the member's files are set aside for the admin to keep or delete by hand.
        const removed = path.join(this.dataDir, 'removed');
        await fs.mkdir(removed, { recursive: true });
        await fs.rename(this.store.userRoot(name), path.join(removed, `${name}-${Date.now()}`)).catch(() => {});
        return sendJson(res, 200, {});
      }

      // ---- Account ----
      case 'GET /app-passwords':
        return sendJson(res, 200, { appPasswords: this.auth.listAppPasswords(user) });
      case 'POST /app-passwords': {
        const { label } = await this.json(req);
        const created = await this.auth.createAppPassword(user, label);
        this.log('device.add', req, { user, label: created.label });
        return sendJson(res, 200, created);
      }
      case 'DELETE /app-passwords':
        await this.auth.revokeAppPassword(user, q.get('id'));
        this.log('device.revoke', req, { user });
        return sendJson(res, 200, {});
      case 'POST /password': {
        const { current, next, keepDevices = false } = await this.json(req);
        if (!(await this.auth.attempt(ip, user, () => this.auth.checkPassword(user, current)))) throw new HttpError(403, 'current password is wrong');
        // Signs out every other browser; also disconnects devices unless the owner explicitly keeps them.
        await this.auth.setPassword(user, next, { revokeDevices: !keepDevices, keepSession: this.auth.sessionKey(req) });
        this.log('password.change', req, { user, keptDevices: !!keepDevices });
        return sendJson(res, 200, {});
      }
      case 'GET /activity':
        return sendJson(res, 200, { events: await this.activity.recent({ user: admin ? undefined : user, limit: 100 }) });
    }
    throw new HttpError(404, 'no such endpoint');
  }

  async newCollection(user, area, name) {
    const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'imported';
    let id = base;
    for (let n = 2; await statOrNull(this.store.collectionDir(user, area, id)); n++) id = `${base}-${n}`;
    await this.admit(user, this.store.collectionsRoot(user, area), 4096, 0, () => this.store.createCollection(user, area, id, { '{DAV:}displayname': name.slice(0, 100) }));
    return id;
  }

  // Public, unauthenticated share links: /s/<token>[/sub/path]
  async share(req, res, url) {
    const [, , token, ...rest] = url.pathname.split('/');
    const share = this.shares[token];
    if (!share || (share.expires && share.expires < Date.now()) || !this.auth.users[share.user]) throw new HttpError(404, 'this link has expired or never existed');
    // Log access at most once per 10 minutes per link, so a busy link can't flood the log.
    if ((this.shareHits.get(token) ?? 0) < Date.now() - 10 * 60 * 1000) {
      this.shareHits.set(token, Date.now());
      this.activity?.log('share.access', { ip: req.mycloud?.ip, user: share.user, path: share.path });
    }
    const segs = [...splitPath(share.path), ...decodeSegments(rest.join('/'))];
    const p = safeJoin(this.store.filesRoot(share.user), segs);
    const st = await statOrNull(p);
    if (!st) throw new HttpError(404, 'not found');
    // Re-authorize on every access: the target must still resolve inside the sharer's files, or inside Family
    // for a sharer who is (still) the admin.
    const scope = await this.store.scopeOf(share.user, p);
    if (!scope || (scope === 'family' && !this.auth.isAdmin(share.user))) throw new HttpError(404, 'not found');
    if (st.isFile()) return sendFile(req, res, p, st, { 'Cache-Control': 'no-cache' });
    const base = `/s/${token}/${rest.filter(Boolean).join('/')}${rest.filter(Boolean).length ? '/' : ''}`;
    const entries = (await fs.readdir(p, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
    const e = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(path.basename(p))} · MyCloud</title>
<style>body{font:16px/1.5 system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#1d1d1f}a{color:#0a84ff;text-decoration:none}li{padding:6px 0;border-bottom:1px solid #eee;list-style:none}ul{padding:0}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}li{border-color:#333}}</style>
<h1>☁️ ${e(path.basename(p))}</h1><ul>${entries.map((x) => `<li><a href="${e(base + encodeURIComponent(x.name))}${x.isDirectory() ? '/' : ''}">${x.isDirectory() ? '📁' : '📄'} ${e(x.name)}</a></li>`).join('')}</ul>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-store' });
    res.end(html);
  }
}
