import path from 'node:path';
import fs from 'node:fs/promises';
import { readJson, writeJson, writeFileAtomic, statOrNull, safeJoin } from './util.js';

const SYNC_LOG_LIMIT = 2000;
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
