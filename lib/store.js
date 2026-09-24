import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { readJson, writeJson, writeFileAtomic, statOrNull, safeJoin, HttpError } from './util.js';

const SYNC_LOG_LIMIT = 2000;
const TRASH_DAYS = 30;
export const COLLECTION_TYPES = ['calendars', 'addressbooks'];

// On-disk layout, per user:
//   users/<u>/files/...                         Drive (WebDAV), incl. Photos/ and Notes/
//   users/<u>/calendars/<id>/{.props.json,.sync.json,*.ics}
//   users/<u>/addressbooks/<id>/{.props.json,.sync.json,*.vcf}
// Shared by everyone on the server (the family), linked into each user's tree:
//   family/files/...             -> users/<u>/files/Family
//   family/calendars/family/     -> users/<u>/calendars/family
export const FAMILY_FOLDER = 'Family';
export const FAMILY_CALENDAR = 'family';
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.locks = new Map();
  }

  userRoot(u) { return path.join(this.dataDir, 'users', u); }
  filesRoot(u) { return path.join(this.userRoot(u), 'files'); }
  cacheRoot(u) { return path.join(this.userRoot(u), 'cache'); }
  collectionsRoot(u, type) { return path.join(this.userRoot(u), type); }
  familyRoot() { return path.join(this.dataDir, 'family'); }
  collectionDir(u, type, id) { return safeJoin(this.collectionsRoot(u, type), [String(id ?? '')]); }

  async ensureUser(u) {
    const files = this.filesRoot(u);
    for (const d of ['Documents', 'Photos', 'Notes']) await fs.mkdir(path.join(files, d), { recursive: true });
    await fs.mkdir(this.cacheRoot(u), { recursive: true });
    if (!(await statOrNull(this.collectionsRoot(u, 'calendars')))) {
      await this.createCollection(u, 'calendars', 'personal', { '{DAV:}displayname': 'Personal', '{http://apple.com/ns/ical/}calendar-color': '#0a84ff' });
    }
    if (!(await statOrNull(this.collectionsRoot(u, 'addressbooks')))) {
      await this.createCollection(u, 'addressbooks', 'contacts', { '{DAV:}displayname': 'Contacts' });
    }
    const shared = await this.ensureFamily();
    await linkOnce(shared.files, path.join(files, FAMILY_FOLDER));
    await linkOnce(shared.calendar, path.join(this.collectionsRoot(u, 'calendars'), FAMILY_CALENDAR));
  }

  async ensureFamily() {
    const root = this.familyRoot();
    const files = path.join(root, 'files');
    const calendar = path.join(root, 'calendars', FAMILY_CALENDAR);
    await fs.mkdir(path.join(files, 'Photos'), { recursive: true });
    if (!(await statOrNull(calendar))) {
      await fs.mkdir(calendar, { recursive: true });
      await writeJson(path.join(calendar, '.props.json'), { '{DAV:}displayname': 'Family', '{http://apple.com/ns/ical/}calendar-color': '#ff9500' });
      await writeJson(path.join(calendar, '.sync.json'), { seq: 1, log: [] });
    }
    return { files, calendar };
  }

  // ---- Trash: deletes are moves, kept for 30 days --------------------------------------------
  // Items under the shared Family space go to the family trash, so any member can restore them.
  async trashRootFor(u, fsPath) {
    const real = await fs.realpath(fsPath);
    const familyRoot = await fs.realpath(this.familyRoot()).catch(() => this.familyRoot());
    return real.startsWith(familyRoot + path.sep) ? path.join(familyRoot, 'trash') : path.join(this.userRoot(u), 'trash');
  }

  async trash(u, fsPath, rel) {
    if (/(^|\/)(\._[^/]*|\.DS_Store)$/.test(rel)) return fs.rm(fsPath, { recursive: true, force: true }); // Finder litter
    const root = await this.trashRootFor(u, fsPath);
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(root, id);
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, 'meta.json'), { rel, by: u, deletedAt: new Date().toISOString() });
    await fs.rename(fsPath, path.join(dir, 'item'));
    return id;
  }

  async listTrash(u) {
    const out = [];
    for (const [root, shared] of [[path.join(this.userRoot(u), 'trash'), false], [path.join(this.familyRoot(), 'trash'), true]]) {
      for (const id of await fs.readdir(root).catch(() => [])) {
        const meta = await readJson(path.join(root, id, 'meta.json'), null);
        const st = await statOrNull(path.join(root, id, 'item'));
        if (meta && st) out.push({ id, shared, ...meta, dir: st.isDirectory(), size: st.size });
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  trashItemDir(u, id, shared) {
    if (!/^\d+-[0-9a-f]{8}$/.test(String(id))) throw Object.assign(new Error('bad trash id'), { code: 'ENOENT' });
    return path.join(shared ? this.familyRoot() : this.userRoot(u), 'trash', id);
  }

  // Put it back where it was (or next to it, if that name is taken now). Returns the restored path.
  async restore(u, id, shared) {
    const dir = this.trashItemDir(u, id, shared);
    const meta = await readJson(path.join(dir, 'meta.json'), null);
    if (!meta) throw Object.assign(new Error('not in trash'), { code: 'ENOENT' });
    const segs = meta.rel.split('/').filter(Boolean);
    const parent = safeJoin(this.filesRoot(u), segs.slice(0, -1));
    await fs.mkdir(parent, { recursive: true });
    const base = segs.at(-1);
    const ext = path.extname(base);
    let target = path.join(parent, base);
    for (let n = 2; await statOrNull(target); n++) target = path.join(parent, `${base.slice(0, base.length - ext.length)} (restored${n > 2 ? ` ${n - 1}` : ''})${ext}`);
    await fs.rename(path.join(dir, 'item'), target);
    await fs.rm(dir, { recursive: true, force: true });
    return path.relative(this.filesRoot(u), target).split(path.sep).join('/');
  }

  async purgeTrash(u, id, shared) {
    await fs.rm(this.trashItemDir(u, id, shared), { recursive: true, force: true });
  }

  // Housekeeping: expire old trash and stray partial uploads left by a crash.
  async sweep(users) {
    const cutoff = Date.now() - TRASH_DAYS * 86400 * 1000;
    for (const root of [...users.map((u) => path.join(this.userRoot(u), 'trash')), path.join(this.familyRoot(), 'trash')]) {
      for (const id of await fs.readdir(root).catch(() => [])) {
        if (Number(id.split('-')[0]) < cutoff) await fs.rm(path.join(root, id), { recursive: true, force: true });
      }
    }
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.startsWith('.mycloud-upload-') && Date.now() - ((await statOrNull(p))?.mtimeMs ?? 0) > 86400 * 1000) await fs.rm(p, { force: true });
      }
    };
    for (const u of users) await walk(this.filesRoot(u));
    await walk(path.join(this.familyRoot(), 'files'));
  }

  // Where a path really lives, after following links: 'user' (u's own files), 'family', or null (anywhere else).
  // Authorization decisions use this, never the visible path, so an alias can't change the answer.
  async scopeOf(u, fsPath) {
    const real = await fs.realpath(fsPath).catch(() => null);
    if (!real) return null;
    const within = (root) => real === root || real.startsWith(root + path.sep);
    const userRoot = await fs.realpath(this.filesRoot(u)).catch(() => null);
    const familyRoot = await fs.realpath(path.join(this.familyRoot(), 'files')).catch(() => null);
    if (familyRoot && within(familyRoot)) return 'family';
    if (userRoot && within(userRoot)) return 'user';
    return null;
  }

  // The family links themselves must not be deleted or renamed by a member.
  async isSharedLink(p) {
    const st = await fs.lstat(p).catch(() => null);
    return !!st?.isSymbolicLink();
  }

  async createCollection(u, type, id, props = {}) {
    const dir = this.collectionDir(u, type, id);
    await fs.mkdir(dir, { recursive: true });
    await writeJson(path.join(dir, '.props.json'), props);
    await writeJson(path.join(dir, '.sync.json'), { seq: 1, log: [] });
    return dir;
  }

  async listCollections(u, type) {
    const root = this.collectionsRoot(u, type);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (!(await statOrNull(dir))?.isDirectory()) continue;
      out.push({ id: e.name, dir, props: await this.readProps(dir), shared: e.isSymbolicLink() });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  readProps(dir) { return readJson(path.join(dir, '.props.json'), {}); }

  async patchProps(dir, set, remove = []) {
    return this.withLock(dir, async () => {
      const props = await this.readProps(dir);
      Object.assign(props, set);
      for (const k of remove) delete props[k];
      if (JSON.stringify(props).length > 64 * 1024) throw new HttpError(413, 'too many or too large collection properties');
      await writeJson(path.join(dir, '.props.json'), props);
    });
  }

  async listItems(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
  }

  syncState(dir) { return readJson(path.join(dir, '.sync.json'), { seq: 1, log: [] }); }

  // Every mutation in a collection bumps its sequence; the sequence is both the CTag and the sync-token.
  async recordChange(dir, name, deleted = false) {
    return this.withLock(dir, async () => {
      const state = await this.syncState(dir);
      state.seq += 1;
      state.log.push({ seq: state.seq, name, deleted });
      if (state.log.length > SYNC_LOG_LIMIT) state.log.splice(0, state.log.length - SYNC_LOG_LIMIT);
      await writeJson(path.join(dir, '.sync.json'), state);
      return state.seq;
    });
  }

  async writeItem(dir, name, data) {
    await writeFileAtomic(safeJoin(dir, [String(name ?? '')]), data);
    await this.recordChange(dir, name);
  }

  async deleteItem(dir, name) {
    await fs.rm(safeJoin(dir, [String(name ?? '')]));
    await this.recordChange(dir, name, true);
  }

  // Shared collections are reached through per-user links; lock on the real path.
  async withLock(dir, fn) {
    const key = await fs.realpath(dir).catch(() => dir);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    this.locks.set(key, settled);
    settled.then(() => { if (this.locks.get(key) === settled) this.locks.delete(key); });
    return next;
  }
}

async function linkOnce(target, link) {
  if (await fs.lstat(link).catch(() => null)) return;
  await fs.symlink(path.relative(path.dirname(link), target), link);
}
