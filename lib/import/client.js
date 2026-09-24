// Talks to a MyCloud server the way any device does: WebDAV, CalDAV, CardDAV with an app password.
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sign in with the account password once, mint a device password just for this import, and hand back a
// client that uses it. DAV itself never sees the account password.
export async function connectWithAccountPassword({ server, user, accountPassword, label }) {
  const base = new URL(server.endsWith('/') ? server : `${server}/`);
  const call = async (method, p, body, cookie) => {
    let res;
    try {
      res = await fetch(new URL(p, base), { method, headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
    } catch (e) {
      throw new Error(`cannot reach ${base.origin}: ${e.cause?.code || e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${base.origin} answered ${res.status}`);
    return { data, res };
  };
  const { res } = await call('POST', 'api/login', { username: user, password: accountPassword });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const { data: ap } = await call('POST', 'api/app-passwords', { label }, cookie);
  return {
    client: new DavClient({ server, user, password: ap.password }),
    // Throw away the import's device password and sign its web session out.
    revoke: async () => {
      await call('DELETE', `api/app-passwords?id=${encodeURIComponent(ap.id)}`, undefined, cookie).catch(() => {});
      await call('POST', 'api/logout', undefined, cookie).catch(() => {});
    },
  };
}

export class DavClient {
  constructor({ server, user, password }) {
    this.base = new URL(server.endsWith('/') ? server : `${server}/`);
    this.user = user;
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.madeDirs = new Set();
  }

  async request(method, p, { body, headers = {} } = {}) {
    const streaming = body && typeof body.pipe === 'function';
    const init = { method, headers: { Authorization: this.auth, ...headers }, body: streaming ? Readable.toWeb(body) : body };
    if (streaming) init.duplex = 'half';
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(new URL(p, this.base), init);
      } catch (e) {
        if (streaming || attempt >= 3) throw new Error(`cannot reach ${this.base.origin}: ${e.cause?.code || e.message}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  async ok(res, what) {
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) throw new Error(`${what} failed (${res.status})`);
    return res;
  }

  async check() {
    const r = await this.request('PROPFIND', `dav/principals/${enc(this.user)}/`, { headers: { Depth: '0' } });
    await r.arrayBuffer().catch(() => {});
    if (r.status === 401) throw new Error('wrong username or app password');
    if (r.status !== 207) throw new Error(`${this.base.origin} answered ${r.status}; is that a MyCloud server?`);
  }

  filePath(rel) {
    return `dav/files/${enc(this.user)}/` + rel.split('/').filter(Boolean).map(enc).join('/');
  }

  async mkdirp(relDir) {
    const parts = relDir.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (this.madeDirs.has(d)) continue;
      const r = await this.request('MKCOL', this.filePath(d) + '/');
      await r.arrayBuffer().catch(() => {});
      if (r.status !== 201 && r.status !== 405) throw new Error(`could not create folder ${d} (${r.status})`);
      this.madeDirs.add(d);
    }
  }

  async remoteSize(rel) {
    const r = await this.request('HEAD', this.filePath(rel));
    return r.ok ? Number(r.headers.get('content-length')) : null;
  }

  async putFile(rel, localPath, mtimeMs) {
    await this.mkdirp(path.posix.dirname(rel));
    const headers = mtimeMs ? { 'X-OC-Mtime': String(Math.floor(mtimeMs / 1000)) } : {};
    await this.ok(await this.request('PUT', this.filePath(rel), { body: createReadStream(localPath), headers }), `upload of ${rel}`);
  }

  async putBytes(rel, data, mtimeMs) {
    await this.mkdirp(path.posix.dirname(rel));
    const headers = mtimeMs ? { 'X-OC-Mtime': String(Math.floor(mtimeMs / 1000)) } : {};
    await this.ok(await this.request('PUT', this.filePath(rel), { body: data, headers }), `upload of ${rel}`);
  }

  // Upload unless an identical-size file is already there; on a name clash with a different file, pick "name 2.ext".
  async uploadOnce(dir, name, localPath, size, mtimeMs) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 100; n++) {
      const rel = `${dir}/${n === 1 ? name : `${stem} ${n}${ext}`}`;
      const remote = await this.remoteSize(rel);
      if (remote === size) return 'skipped';
      if (remote === null) {
        await this.putFile(rel, localPath, mtimeMs);
        return 'uploaded';
      }
    }
    throw new Error(`too many files named ${name} in ${dir}`);
  }

  // Calendars and address books: create the collection if needed, then PUT items by UID.
  async ensureCollection(area, id, displayName, components) {
    const p = `dav/${area}/${enc(this.user)}/${enc(id)}/`;
    const probe = await this.request('PROPFIND', p, { headers: { Depth: '0' } });
    await probe.arrayBuffer().catch(() => {});
    if (probe.status === 207) return;
    const name = displayName.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' })[c]);
    const body = area === 'calendars'
      ? `<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${name}</d:displayname>${components ? `<c:supported-calendar-component-set><c:comp name="${components}"/></c:supported-calendar-component-set>` : ''}</d:prop></d:set></c:mkcalendar>`
      : `<d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>${name}</d:displayname></d:prop></d:set></d:mkcol>`;
    await this.ok(await this.request(area === 'calendars' ? 'MKCALENDAR' : 'MKCOL', p, { body, headers: { 'Content-Type': 'application/xml' } }), `creating ${displayName}`);
  }

  async putItem(area, id, name, text) {
    const type = area === 'calendars' ? 'text/calendar' : 'text/vcard';
    await this.ok(await this.request('PUT', `dav/${area}/${enc(this.user)}/${enc(id)}/${enc(name)}`, { body: text, headers: { 'Content-Type': `${type}; charset=utf-8` } }), `saving ${name}`);
  }
}
