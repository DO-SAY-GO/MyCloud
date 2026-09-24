// WebDAV (Finder / Files), CalDAV (Calendar, Reminders) and CardDAV (Contacts) under /dav/.
//
//   /dav/principals/<u>/                 principal: tells clients where the homes are
//   /dav/files/<u>/...                   filesystem-backed WebDAV (class 1 + fake class 2 locks for Finder)
//   /dav/calendars/<u>/<cal>/<item>.ics  CalDAV
//   /dav/addressbooks/<u>/<book>/<x>.vcf CardDAV
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { NS, parseXml, child, childrenOf, clark, textOf, multistatus, response, esc } from './xml.js';
import { HttpError, safeJoin, decodeSegments, encodePath, statOrNull, readBody, etagOf, mimeOf } from './util.js';
import { treeStats, ENTRY_COST } from './limits.js';

const D = (n) => `{DAV:}${n}`;
const C = (n) => `{${NS.c}}${n}`;
const CARD = (n) => `{${NS.card}}${n}`;
const CS = (n) => `{${NS.cs}}${n}`;
const ICAL = (n) => `{${NS.ical}}${n}`;

const SYNC_PREFIX = 'http://mycloud.local/sync/';
const DAV_HEADER = '1, 2, 3, calendar-access, addressbook, extended-mkcol';
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, COPY, MOVE, LOCK, UNLOCK, REPORT';
const ITEM_LIMIT = 10 * 1024 * 1024;

const httpDate = (d) => new Date(d).toUTCString();
const COLL_KIND = { calendars: 'calendar', addressbooks: 'addressbook' };
const ITEM_KIND = { calendars: 'event', addressbooks: 'card' };

export class Dav {
  constructor(store, { limits, activity } = {}) {
    this.store = store;
    this.limits = limits;
    this.activity = activity;
  }

  // Every write that grows storage passes the storage gate, billed to whoever's space it lands in.
  async admit(user, fsPath, bytes, replacing, fn, opts) {
    if (!this.limits) return fn();
    return this.limits.withBytes(await this.limits.budgetFor(user, fsPath), bytes, replacing, fn, opts);
  }

  // Map a URL under /dav/ to a resource descriptor.
  async resolve(user, pathname) {
    const segs = decodeSegments(pathname).slice(1); // drop "dav"
    const [area, owner, ...rest] = segs;
    const base = { segs, user };
    if (!area) return { ...base, kind: 'root', collection: true };
    if (owner !== undefined && owner !== user) throw new HttpError(403, 'forbidden');

    if (area === 'principals') {
      if (!owner) return { ...base, kind: 'principals', collection: true };
      if (rest.length) throw new HttpError(404, 'not found');
      return { ...base, kind: 'principal', collection: true };
    }
    if (area === 'files') {
      if (!owner) return { ...base, kind: 'files-root', collection: true };
      const fsPath = safeJoin(this.store.filesRoot(user), rest);
      const stat = await statOrNull(fsPath);
      return { ...base, area, rest, fsPath, stat, kind: !stat ? 'missing' : stat.isDirectory() ? 'dir' : 'file', collection: !!stat?.isDirectory() };
    }
    if (area === 'calendars' || area === 'addressbooks') {
      if (!owner) return { ...base, kind: 'files-root', collection: true };
      const home = this.store.collectionsRoot(user, area);
      if (rest.length === 0) return { ...base, area, rest, kind: 'home', fsPath: home, collection: true };
      if (rest.some((s) => s.startsWith('.'))) throw new HttpError(403, 'forbidden');
      const fsPath = safeJoin(home, rest);
      const stat = await statOrNull(fsPath);
      if (rest.length === 1) {
        return { ...base, area, rest, fsPath, stat, kind: stat?.isDirectory() ? COLL_KIND[area] : 'missing', collection: !!stat?.isDirectory(), depthInHome: 1 };
      }
      if (rest.length === 2) {
        return { ...base, area, rest, fsPath, stat, collDir: path.dirname(fsPath), kind: stat?.isFile() ? ITEM_KIND[area] : 'missing', collection: false, depthInHome: 2 };
      }
      throw new HttpError(404, 'not found');
    }
    throw new HttpError(404, 'not found');
  }

  href(segs, collection) {
    const p = '/dav/' + encodePath(segs);
    return collection && segs.length ? p + '/' : p;
  }

  async handle(req, res, user, url) {
    const method = req.method;
    if (method === 'OPTIONS') {
      res.writeHead(200, { DAV: DAV_HEADER, Allow: ALLOW, 'MS-Author-Via': 'DAV', 'Content-Length': 0 });
      return res.end();
    }
    const r = await this.resolve(user, url.pathname);
    switch (method) {
      case 'PROPFIND': return this.propfind(req, res, r);
      case 'PROPPATCH': return this.proppatch(req, res, r);
      case 'REPORT': return this.report(req, res, r);
      case 'GET': case 'HEAD': return this.get(req, res, r);
      case 'PUT': return this.put(req, res, r);
      case 'DELETE': return this.delete(req, res, r);
      case 'MKCOL': case 'MKCALENDAR': return this.mkcol(req, res, r);
      case 'MOVE': case 'COPY': return this.moveCopy(req, res, r, url);
      case 'LOCK': return this.lock(req, res, r);
      case 'UNLOCK': res.writeHead(204); return res.end();
      default: throw new HttpError(405, 'method not allowed');
    }
  }

  // ---- properties -------------------------------------------------------

  async props(r) {
    const p = new Map();
    const u = r.user;
    const principal = `/dav/principals/${encodeURIComponent(u)}/`;
    p.set(D('current-user-principal'), `<d:href>${esc(principal)}</d:href>`);
    p.set(D('principal-collection-set'), '<d:href>/dav/principals/</d:href>');
    p.set(D('owner'), `<d:href>${esc(principal)}</d:href>`);
    p.set(D('current-user-privilege-set'), '<d:privilege><d:all/></d:privilege><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-properties/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege>');
    p.set(D('resourcetype'), r.collection ? '<d:collection/>' : '');
    if (r.stat) {
      p.set(D('getlastmodified'), httpDate(r.stat.mtime));
      p.set(D('creationdate'), new Date(r.stat.birthtime).toISOString());
    }

    switch (r.kind) {
      case 'principal':
        p.set(D('resourcetype'), '<d:collection/><d:principal/>');
        p.set(D('displayname'), esc(u));
        p.set(D('principal-URL'), `<d:href>${esc(principal)}</d:href>`);
        p.set(C('calendar-home-set'), `<d:href>/dav/calendars/${esc(encodeURIComponent(u))}/</d:href>`);
        p.set(CARD('addressbook-home-set'), `<d:href>/dav/addressbooks/${esc(encodeURIComponent(u))}/</d:href>`);
        p.set(C('calendar-user-address-set'), `<d:href>${esc(principal)}</d:href>`);
        p.set(C('schedule-inbox-URL'), `<d:href>/dav/calendars/${esc(encodeURIComponent(u))}/inbox/</d:href>`);
        p.set(C('schedule-outbox-URL'), `<d:href>/dav/calendars/${esc(encodeURIComponent(u))}/outbox/</d:href>`);
        break;
      case 'dir':
      case 'file': {
        p.set(D('displayname'), esc(r.rest.at(-1) ?? u));
        p.set(D('supportedlock'), '<d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry>');
        p.set(D('lockdiscovery'), '');
        if (r.kind === 'file') {
          p.set(D('getcontentlength'), String(r.stat.size));
          p.set(D('getcontenttype'), esc(mimeOf(r.fsPath)));
          p.set(D('getetag'), esc(etagOf(r.stat)));
        } else if (r.rest.length === 0) {
          const q = await fs.statfs(r.fsPath).catch(() => null);
          if (q) {
            p.set(D('quota-available-bytes'), String(q.bavail * q.bsize));
            p.set(D('quota-used-bytes'), String((q.blocks - q.bfree) * q.bsize));
          }
        }
        break;
      }
      case 'calendar':
      case 'addressbook': {
        const stored = await this.store.readProps(r.fsPath);
        const { seq } = await this.store.syncState(r.fsPath);
        const isCal = r.kind === 'calendar';
        p.set(D('resourcetype'), isCal ? '<d:collection/><c:calendar/>' : '<d:collection/><card:addressbook/>');
        p.set(D('displayname'), esc(r.rest[0]));
        p.set(CS('getctag'), String(seq));
        p.set(D('sync-token'), SYNC_PREFIX + seq);
        const reports = isCal ? ['c:calendar-multiget', 'c:calendar-query'] : ['card:addressbook-multiget', 'card:addressbook-query'];
        p.set(D('supported-report-set'), [...reports, 'd:sync-collection'].map((x) => `<d:supported-report><d:report><${x}/></d:report></d:supported-report>`).join(''));
        if (isCal) {
          const comps = stored[C('supported-calendar-component-set')] ?? 'VEVENT,VTODO';
          p.set(C('supported-calendar-component-set'), comps.split(',').map((n) => `<c:comp name="${esc(n)}"/>`).join(''));
          p.set(C('supported-calendar-data'), '<c:calendar-data content-type="text/calendar" version="2.0"/>');
        } else {
          p.set(CARD('supported-address-data'), '<card:address-data-type content-type="text/vcard" version="3.0"/><card:address-data-type content-type="text/vcard" version="4.0"/>');
        }
        for (const [k, v] of Object.entries(stored)) {
          if (k !== C('supported-calendar-component-set')) p.set(k, esc(v));
        }
        break;
      }
      case 'event':
      case 'card':
        p.set(D('getetag'), esc(etagOf(r.stat)));
        p.set(D('getcontentlength'), String(r.stat.size));
        p.set(D('getcontenttype'), r.kind === 'event' ? 'text/calendar; charset=utf-8; component=vevent' : 'text/vcard; charset=utf-8');
        break;
      case 'home':
        p.set(D('displayname'), esc(r.area));
        break;
    }
    return p;
  }

  // Properties computed only on request (they need the item body).
  async lazyProp(r, name) {
    if ((name === C('calendar-data') && r.kind === 'event') || (name === CARD('address-data') && r.kind === 'card')) {
      return esc(await fs.readFile(r.fsPath, 'utf8'));
    }
    return undefined;
  }

  async renderResponse(r, request) {
    const href = this.href(r.segs, r.collection);
    const all = await this.props(r);
    if (request.type === 'propname') return response(href, new Map([...all.keys()].map((k) => [k, ''])));
    if (request.type === 'allprop') return response(href, all);
    const found = new Map();
    const missing = [];
    for (const name of request.names) {
      const v = all.has(name) ? all.get(name) : await this.lazyProp(r, name);
      if (v === undefined) missing.push(name);
      else found.set(name, v);
    }
    return response(href, found, missing);
  }

  async children(r) {
    const childResource = (segs) => this.resolve(r.user, '/dav/' + encodePath(segs));
    let names = [];
    switch (r.kind) {
      case 'root': names = ['principals', 'files', 'calendars', 'addressbooks']; break;
      case 'principals': names = [r.user]; break;
      case 'files-root': names = [r.user]; break;
      case 'dir': case 'home': case 'calendar': case 'addressbook':
        names = (await fs.readdir(r.fsPath).catch(() => [])).filter((n) => !(r.kind !== 'dir' && n.startsWith('.')));
        break;
    }
    const out = [];
    for (const n of names) {
      try {
        const c = await childResource([...r.segs, n]);
        if (c.kind !== 'missing') out.push(c);
      } catch { /* skip unreadable entries */ }
    }
    return out;
  }

  // ---- methods -----------------------------------------------------------

  async readXml(req) {
    const body = (await readBody(req, 1024 * 1024)).toString('utf8').trim();
    if (!body) return null;
    try {
      return parseXml(body);
    } catch {
      throw new HttpError(400, 'malformed xml');
    }
  }

  parsePropRequest(root) {
    if (!root || child(root, NS.d, 'allprop')) return { type: 'allprop' };
    if (child(root, NS.d, 'propname')) return { type: 'propname' };
    const prop = child(root, NS.d, 'prop');
    return { type: 'prop', names: prop ? prop.children.map(clark) : [] };
  }

  sendMultistatus(res, xml) {
    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml), DAV: DAV_HEADER });
    res.end(xml);
  }

  async propfind(req, res, r) {
    if (r.kind === 'missing') throw new HttpError(404, 'not found');
    const request = this.parsePropRequest(await this.readXml(req));
    const depth = req.headers.depth ?? 'infinity';
    const list = [r];
    if (depth !== '0' && r.collection) list.push(...(await this.children(r)));
    const parts = [];
    for (const x of list) parts.push(await this.renderResponse(x, request));
    this.sendMultistatus(res, multistatus(parts));
  }

  async proppatch(req, res, r) {
    if (r.kind === 'missing') throw new HttpError(404, 'not found');
    const root = await this.readXml(req);
    const set = {};
    const remove = [];
    const names = [];
    for (const op of root?.children ?? []) {
      for (const prop of childrenOf(op, NS.d, 'prop')) {
        for (const p of prop.children) {
          names.push(clark(p));
          if (op.name === 'set') set[clark(p)] = textOf(p).trim();
          else remove.push(clark(p));
        }
      }
    }
    // Collection metadata (name, colour, order…) is persisted; other props are accepted and ignored.
    // It is server bookkeeping: the store reserves each rewrite against the disk floors, and it is capped at 64 KB.
    if (r.kind === 'calendar' || r.kind === 'addressbook') await this.store.patchProps(r.fsPath, set, remove);
    this.sendMultistatus(res, multistatus([response(this.href(r.segs, r.collection), new Map(names.map((n) => [n, ''])))]));
  }

  async get(req, res, r) {
    if (r.collection) {
      if (r.kind !== 'dir') throw new HttpError(405, 'collection');
      const entries = await fs.readdir(r.fsPath, { withFileTypes: true });
      const html = `<!doctype html><meta charset="utf-8"><title>${esc(r.rest.join('/') || '/')}</title><ul>${entries.map((e) => `<li><a href="${esc(encodeURIComponent(e.name))}${e.isDirectory() ? '/' : ''}">${esc(e.name)}</a></li>`).join('')}</ul>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    if (r.kind === 'missing') throw new HttpError(404, 'not found');
    const etag = etagOf(r.stat);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    return sendFile(req, res, r.fsPath, r.stat);
  }

  checkPreconditions(req, r) {
    const im = req.headers['if-match'];
    const inm = req.headers['if-none-match'];
    const exists = r.kind !== 'missing';
    if (im && (!exists || (im !== '*' && !im.split(',').map((s) => s.trim()).includes(etagOf(r.stat))))) throw new HttpError(412, 'precondition failed');
    if (inm === '*' && exists) throw new HttpError(412, 'precondition failed');
  }

  async put(req, res, r) {
    if (r.collection) throw new HttpError(405, 'cannot PUT to a collection');
    this.checkPreconditions(req, r);
    const existed = r.kind !== 'missing';
    let replacedNow = existed; // decided again at commit time, under the lock

    if (r.area === 'files') {
      if (r.rest.length === 0) throw new HttpError(405, 'cannot PUT to root');
      const parent = await statOrNull(path.dirname(r.fsPath));
      if (!parent?.isDirectory()) throw new HttpError(409, 'parent does not exist');
      const tmp = `${path.dirname(r.fsPath)}/.mycloud-upload-${crypto.randomBytes(6).toString('hex')}`;
      try {
        const write = (...meter) => pipeline(req, ...meter, createWriteStream(tmp));
        if (!this.limits) {
          await write();
          await fs.rename(tmp, r.fsPath);
        } else {
          await this.limits.guard(await this.limits.budgetFor(r.user, r.fsPath), req, r.stat?.size ?? 0, async (meter, res) => {
            await write(meter);
            // Settle against what is there *now* (a concurrent upload may have created or replaced it), then swap.
            await this.store.withLock(r.fsPath, async () => {
              const now = await statOrNull(r.fsPath);
              replacedNow = !!now;
              this.limits.settle(res, { replacing: now?.size ?? 0, entries: now ? 0 : 1 });
              await fs.rename(tmp, r.fsPath);
            });
          }, { entries: existed ? 0 : 1 });
        }
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    } else {
      if (r.depthInHome !== 2) throw new HttpError(405, 'items live inside a calendar or address book');
      const parent = await statOrNull(r.collDir);
      if (!parent?.isDirectory()) throw new HttpError(409, 'collection does not exist');
      const body = await readBody(req, ITEM_LIMIT);
      const marker = r.area === 'calendars' ? 'BEGIN:VCALENDAR' : 'BEGIN:VCARD';
      if (!body.toString('utf8', 0, 512).toUpperCase().includes(marker)) {
        throw new HttpError(415, `expected ${r.area === 'calendars' ? 'text/calendar' : 'text/vcard'}`);
      }
      await this.admit(r.user, r.collDir, body.length, r.stat?.size ?? 0,
        (res) => this.store.writeItem(r.collDir, r.rest[1], body, { settle: (x) => {
          replacedNow = x.entries === 0;
          if (res) this.limits.settle(res, x);
        } }), { entries: existed ? 0 : 1 });
    }
    const headers = {};
    if (r.area === 'files' && (await applyClientMtime(req, r.fsPath))) headers['X-OC-MTime'] = 'accepted';
    const stat = await fs.stat(r.fsPath);
    res.writeHead(replacedNow ? 204 : 201, { ...headers, ETag: etagOf(stat) });
    res.end();
  }

  async delete(req, res, r) {
    if (r.kind === 'missing') throw new HttpError(404, 'not found');
    this.checkPreconditions(req, r);
    if (await this.store.isSharedLink(r.fsPath)) throw new HttpError(403, 'the shared Family space cannot be deleted');
    if (r.area === 'files' && r.rest.length > 0) {
      // Deletes from Finder/Files land in Recently Deleted, like everywhere else.
      await this.store.trash(r.user, r.fsPath, r.rest.join('/'));
      this.activity?.log('file.delete', { user: r.user, ip: req.mycloud?.ip, path: r.rest.join('/'), via: 'dav' });
    } else if (r.kind === 'event' || r.kind === 'card') {
      await this.store.deleteItem(r.collDir, r.rest[1]);
    } else if (r.kind === 'calendar' || r.kind === 'addressbook') {
      await this.store.deleteCollection(r.fsPath);
    } else {
      throw new HttpError(403, 'cannot delete this resource');
    }
    res.writeHead(204);
    res.end();
  }

  async mkcol(req, res, r) {
    if (r.kind !== 'missing') throw new HttpError(405, 'already exists');
    const body = await this.readXml(req);
    if (r.area === 'files') {
      if (body) throw new HttpError(415, 'unsupported mkcol body');
      const parent = await statOrNull(path.dirname(r.fsPath));
      if (!parent?.isDirectory()) throw new HttpError(409, 'parent does not exist');
      await this.admit(r.user, path.dirname(r.fsPath), 4096, 0, () => fs.mkdir(r.fsPath), { entries: 1 });
    } else if (r.depthInHome === 1) {
      const wantsCalendar = req.method === 'MKCALENDAR';
      const props = {};
      let rtype = null;
      for (const setEl of childrenOf(body, NS.d, 'set')) {
        for (const p of child(setEl, NS.d, 'prop')?.children ?? []) {
          if (p.ns === NS.d && p.name === 'resourcetype') rtype = p;
          else if (p.ns === NS.c && p.name === 'supported-calendar-component-set') {
            props[clark(p)] = childrenOf(p, NS.c, 'comp').map((c) => c.attrs.name).join(',');
          } else props[clark(p)] = textOf(p).trim();
        }
      }
      const isCal = wantsCalendar || !!child(rtype, NS.c, 'calendar');
      const isBook = !!child(rtype, NS.card, 'addressbook');
      if ((r.area === 'calendars' && !isCal) || (r.area === 'addressbooks' && !isBook)) throw new HttpError(403, 'wrong collection type for this home');
      // The collection folder is the user's (one entry); its bookkeeping files reserve through the store.
      await this.admit(r.user, path.dirname(r.fsPath), 0, 0, () => this.store.createCollection(r.user, r.area, r.rest[0], props), { entries: 1 });
    } else {
      throw new HttpError(403, 'cannot create a collection here');
    }
    res.writeHead(201, { 'Content-Length': 0 });
    res.end();
  }

  async moveCopy(req, res, r, url) {
    if (r.kind === 'missing') throw new HttpError(404, 'not found');
    const destHeader = req.headers.destination;
    if (!destHeader) throw new HttpError(400, 'missing Destination');
    let destUrl;
    try { destUrl = new URL(destHeader, url); } catch { throw new HttpError(400, 'bad Destination'); }
    if (!destUrl.pathname.startsWith('/dav/')) throw new HttpError(502, 'destination outside this server');
    const dest = await this.resolve(r.user, destUrl.pathname);
    const isItem = (x) => x.depthInHome === 2 && x.area === r.area;
    const sameArea = (r.area === 'files' && dest.area === 'files' && r.rest.length > 0 && dest.rest.length > 0) || (isItem(r) && isItem(dest));
    if (!sameArea) throw new HttpError(403, 'unsupported move/copy');
    // Copying the Family link would create a second name for shared content; refuse links outright.
    if (await this.store.isSharedLink(r.fsPath)) throw new HttpError(403, `the shared Family space cannot be ${req.method === 'MOVE' ? 'moved' : 'copied'}`);
    if (dest.fsPath === r.fsPath || dest.fsPath.startsWith(r.fsPath + path.sep)) throw new HttpError(403, 'cannot move into itself');
    const overwrite = (req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
    const existed = dest.kind !== 'missing';
    if (existed && !overwrite) throw new HttpError(412, 'destination exists');
    if (existed && (await this.store.isSharedLink(dest.fsPath))) throw new HttpError(403, 'the shared Family space cannot be replaced');
    const destParent = await statOrNull(path.dirname(dest.fsPath));
    if (!destParent?.isDirectory()) throw new HttpError(409, 'destination parent missing');
    const move = req.method === 'MOVE';
    const stats = await treeStats(r.fsPath);
    const from = this.limits ? await this.limits.budgetFor(r.user, r.fsPath) : null;
    const to = this.limits ? await this.limits.budgetFor(r.user, path.dirname(dest.fsPath)) : null;
    const crossBudget = from !== to;
    const admit = (bytes, replacing, fn, entries) => (this.limits ? this.limits.withBytes(to, bytes, replacing, fn, { entries }) : fn(null));
    let replacedNow = existed;

    if (isItem(r)) {
      // Calendar/contact objects: one journaled transaction with both collections' sync logs, under their locks.
      const transfer = (res) => this.store.transferItem({
        move, from: r.fsPath, fromDir: r.collDir, toDir: dest.collDir, toName: dest.rest[1], overwrite,
        settle: res && (!move || crossBudget) ? (x) => this.limits.settle(res, x) : undefined,
      });
      if (move && !crossBudget) {
        const replaced = await admit(0, 0, transfer, 0);
        replacedNow = replaced !== null;
        if (replacedNow && this.limits) this.limits.freed(to, { bytes: replaced + ENTRY_COST, entries: 1 });
      } else {
        replacedNow = (await admit(stats.bytes, 0, transfer, 1)) !== null;
      }
    } else {
      // Drive: stage outside any lock (a copy can be large), then under the destination lock (and the source's, for
      // a move; sorted, so opposite moves can't deadlock) re-check Overwrite against what is there now, move a
      // replaced destination to Recently Deleted, and swap in with one rename.
      const stage = path.join(path.dirname(dest.fsPath), `.mycloud-stage-${crypto.randomBytes(6).toString('hex')}`);
      const commit = async () => {
        const now = await fs.lstat(dest.fsPath).catch(() => null);
        if (now && !overwrite) throw new HttpError(412, 'destination exists');
        replacedNow = !!now;
        let trashed = null;
        try {
          if (now) trashed = await this.store.trash(r.user, dest.fsPath, dest.rest.join('/'));
          await fs.rename(stage, dest.fsPath);
        } catch (e) {
          if (trashed) await this.store.restore(r.user, trashed.id, trashed.shared).catch(() => {});
          throw e;
        }
      };
      const work = move
        ? () => this.store.withLocks([r.fsPath, dest.fsPath], async () => {
          if (!(await fs.lstat(r.fsPath).catch(() => null))) throw Object.assign(new Error('source vanished'), { code: 'ENOENT' });
          await fs.rename(r.fsPath, stage);
          try {
            await commit();
          } catch (e) {
            await fs.rename(stage, r.fsPath).catch(() => {});
            throw e;
          }
        })
        : async () => {
          try {
            await fs.cp(r.fsPath, stage, { recursive: true, filter: async (src) => !(await fs.lstat(src)).isSymbolicLink() });
            await this.store.withLocks([dest.fsPath], commit);
          } catch (e) {
            await fs.rm(stage, { recursive: true, force: true });
            throw e;
          }
        };
      // A replaced Drive item stays billed in Recently Deleted, so the new content is all new growth.
      if (move && !crossBudget) await admit(0, 0, work, 0);
      else await admit(stats.bytes, 0, work, stats.entries);
    }
    if (move && crossBudget && this.limits) this.limits.freed(from, { bytes: stats.bytes + stats.entries * ENTRY_COST, entries: stats.entries });
    res.writeHead(replacedNow ? 204 : 201);
    res.end();
  }

  // Finder refuses to write without class-2 locking, so hand out advisory locks that are never enforced.
  async lock(req, res, r) {
    await readBody(req, 64 * 1024);
    let status = 200;
    if (r.kind === 'missing' && r.area === 'files' && r.rest.length) {
      // A lock on a new name creates an empty file (Finder relies on it), so it passes the storage gate too.
      await this.admit(r.user, r.fsPath, 0, 0, () => fs.writeFile(r.fsPath, '', { flag: 'wx' }).catch(() => {}), { entries: 1 });
      status = 201;
    }
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const href = this.href(r.segs, r.collection);
    const timeout = req.headers.timeout?.split(',')[0]?.trim() || 'Second-3600';
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>${esc(req.headers.depth ?? 'infinity')}</d:depth><d:owner/><d:timeout>${esc(timeout)}</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken><d:lockroot><d:href>${esc(href)}</d:href></d:lockroot></d:activelock></d:lockdiscovery></d:prop>`;
    res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` });
    res.end(xml);
  }

  async report(req, res, r) {
    const root = await this.readXml(req);
    if (!root) throw new HttpError(400, 'missing report body');
    const request = this.parsePropRequest(root);
    const parts = [];
    const key = clark(root);

    if (key === C('calendar-multiget') || key === CARD('addressbook-multiget')) {
      for (const h of childrenOf(root, NS.d, 'href')) {
        const href = textOf(h).trim();
        let pathname;
        try { pathname = new URL(href, 'http://x').pathname; } catch { continue; }
        let item;
        try { item = await this.resolve(r.user, pathname); } catch { item = null; }
        if (!item || item.kind === 'missing' || item.collection) parts.push(response(href, null, [], '404 Not Found'));
        else parts.push(await this.renderResponse(item, request));
      }
      return this.sendMultistatus(res, multistatus(parts));
    }

    if (key === C('calendar-query') || key === CARD('addressbook-query')) {
      // Filters are advisory; returning the full collection is always a correct superset for sync clients.
      const items = r.collection ? await this.children(r) : r.kind === 'missing' ? [] : [r];
      for (const item of items) parts.push(await this.renderResponse(item, request));
      return this.sendMultistatus(res, multistatus(parts));
    }

    if (key === D('sync-collection')) {
      if (r.kind !== 'calendar' && r.kind !== 'addressbook') throw new HttpError(403, 'sync-collection needs a calendar or address book');
      const state = await this.store.syncState(r.fsPath);
      const tokenText = textOf(child(root, NS.d, 'sync-token')).trim();
      let since = 0;
      if (tokenText) {
        if (!tokenText.startsWith(SYNC_PREFIX)) return this.invalidSyncToken(res);
        since = Number(tokenText.slice(SYNC_PREFIX.length));
        const oldest = state.log[0]?.seq ?? state.seq;
        if (!Number.isInteger(since) || since > state.seq || (since < oldest - 1 && since !== state.seq)) return this.invalidSyncToken(res);
      }
      let names;
      if (!since) names = new Map((await this.store.listItems(r.fsPath)).map((n) => [n, false]));
      else {
        names = new Map();
        for (const e of state.log) if (e.seq > since) names.set(e.name, e.deleted);
      }
      for (const [name, deleted] of names) {
        const item = await this.resolve(r.user, '/dav/' + encodePath([...r.segs, name]));
        if (deleted || item.kind === 'missing') parts.push(response(this.href(item.segs, false), null, [], '404 Not Found'));
        else parts.push(await this.renderResponse(item, request));
      }
      return this.sendMultistatus(res, multistatus(parts, `<d:sync-token>${SYNC_PREFIX}${state.seq}</d:sync-token>`));
    }

    // principal-property-search, expand-property, etc: an empty result keeps clients happy.
    this.sendMultistatus(res, multistatus([]));
  }

  invalidSyncToken(res) {
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>';
    res.writeHead(403, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(xml);
  }
}

// Nextcloud's convention, spoken by rclone, PhotoSync and our importers: keep the original file date.
export async function applyClientMtime(req, fsPath) {
  const mtime = Number(req.headers['x-oc-mtime']);
  if (!(mtime > 0 && mtime < 1e11)) return false;
  await fs.utimes(fsPath, new Date(), new Date(mtime * 1000));
  return true;
}

// User content (an uploaded .html or .svg) must never run script on the app's origin.
const USER_CONTENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

// Stream a file with single-range support (video scrubbing, resumable downloads).
export async function sendFile(req, res, fsPath, stat, extraHeaders = {}) {
  const type = mimeOf(fsPath);
  const headers = {
    'Content-Type': type,
    // Chrome's PDF viewer refuses to render inside a sandboxed document; it runs in its own origin anyway.
    ...(type !== 'application/pdf' && { 'Content-Security-Policy': USER_CONTENT_CSP }),
    'Last-Modified': httpDate(stat.mtime),
    ETag: etagOf(stat),
    'Accept-Ranges': 'bytes',
    ...extraHeaders,
  };
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && stat.size > 0 && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  await pipeline(createReadStream(fsPath, { start, end }), res);
}
