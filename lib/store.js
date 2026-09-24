import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { readJson, writeJson, writeFileAtomic, statOrNull, safeJoin, HttpError } from './util.js';
import { accounted, ENTRY_COST } from './limits.js';

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
    // Hooks the server wires to the storage gate (no-ops for plain library use):
    //   gate(bytes, replacing, entries, fn): server bookkeeping (sync logs, collection properties, trash records)
    //     is nobody's quota, but every write of it still reserves its peak against the disk and inode floors.
    //   freed(fsPath, { bytes, entries }): user content was removed, so its budget's cached usage drops at once.
    this.gate = (_bytes, _replacing, _entries, fn) => fn();
    this.freed = () => {};
  }

  // Write a bookkeeping JSON file through the gate, reserving the whole new copy (it's staged beside the old one).
  async writeMeta(p, obj) {
    const data = JSON.stringify(obj, null, 2);
    const old = (await statOrNull(p))?.size;
    await this.gate(Buffer.byteLength(data), old ?? 0, old === undefined ? 1 : 0, () => writeFileAtomic(p, data));
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
      await this.writeMeta(path.join(calendar, '.props.json'), { '{DAV:}displayname': 'Family', '{http://apple.com/ns/ical/}calendar-color': '#ff9500' });
      await this.writeMeta(path.join(calendar, '.sync.json'), { seq: 1, log: [] });
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
    const meta = JSON.stringify({ rel, by: u, deletedAt: new Date().toISOString() }, null, 2);
    // The trash record (a folder and meta.json) is bookkeeping; the item itself stays billed where it was.
    await this.gate(Buffer.byteLength(meta), 0, 2, async () => {
      await fs.mkdir(dir, { recursive: true });
      try {
        await writeFileAtomic(path.join(dir, 'meta.json'), meta);
        await fs.rename(fsPath, path.join(dir, 'item'));
      } catch (e) {
        await fs.rm(dir, { recursive: true, force: true });
        throw e;
      }
    });
    return { id, shared: root === path.join(await fs.realpath(this.familyRoot()).catch(() => this.familyRoot()), 'trash') };
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
    await this.removeCounted(path.join(this.trashItemDir(u, id, shared), 'item'));
    await fs.rm(this.trashItemDir(u, id, shared), { recursive: true, force: true });
  }

  // Remove user content and credit its budget right away (bytes and entries, counted like the quota counts them).
  async removeCounted(p) {
    const st = await fs.lstat(p).catch(() => null);
    if (!st) return;
    // Counted by the owner's location rules (a calendar's own bookkeeping was never billed, so isn't credited).
    const owner = path.relative(this.familyRoot(), p).startsWith('..') ? path.join(this.dataDir, 'users', path.relative(path.join(this.dataDir, 'users'), p).split(path.sep)[0]) : this.familyRoot();
    const inner = st.isDirectory() ? await accounted(p, null, path.relative(owner, p)) : { bytes: 0, entries: 0 };
    const freed = { bytes: inner.bytes + ENTRY_COST + (st.isFile() ? st.size : 0), entries: inner.entries + 1 };
    await fs.rm(p, { recursive: true, force: true });
    this.freed(p, freed);
  }

  // Housekeeping: expire old trash and stray partial uploads left by a crash.
  async sweep(users) {
    const cutoff = Date.now() - TRASH_DAYS * 86400 * 1000;
    for (const root of [...users.map((u) => path.join(this.userRoot(u), 'trash')), path.join(this.familyRoot(), 'trash')]) {
      for (const id of await fs.readdir(root).catch(() => [])) {
        if (Number(id.split('-')[0]) < cutoff) {
          await this.removeCounted(path.join(root, id, 'item'));
          await fs.rm(path.join(root, id), { recursive: true, force: true });
        }
      }
    }
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        // Leftovers of uploads and staged copies interrupted by a crash (files or whole folders).
        if (/^\.mycloud-(upload|stage)-/.test(e.name)) {
          if (Date.now() - ((await statOrNull(p))?.mtimeMs ?? 0) > 86400 * 1000) await fs.rm(p, { recursive: true, force: true });
        } else if (e.isDirectory()) await walk(p);
      }
    };
    for (const u of users) for (const area of ['files', 'calendars', 'addressbooks']) await walk(path.join(this.userRoot(u), area));
    for (const area of ['files', 'calendars']) await walk(path.join(this.familyRoot(), area));
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
    const files = [['.props.json', JSON.stringify(props, null, 2)], ['.sync.json', JSON.stringify({ seq: 1, log: [] }, null, 2)]];
    // Both bookkeeping files are reserved before the folder exists; a refusal leaves nothing behind.
    await this.gate(files.reduce((n, [, d]) => n + Buffer.byteLength(d), 0), 0, 2, async () => {
      await fs.mkdir(dir, { recursive: true });
      try {
        for (const [name, data] of files) await writeFileAtomic(path.join(dir, name), data);
      } catch (e) {
        await fs.rm(dir, { recursive: true, force: true });
        throw e;
      }
    });
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
      await this.writeMeta(path.join(dir, '.props.json'), props);
    });
  }

  async listItems(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
  }

  syncState(dir) { return readJson(path.join(dir, '.sync.json'), { seq: 1, log: [] }); }

  // Every mutation in a collection bumps its sequence; the sequence is both the CTag and the sync-token.
  //
  // Content and bookkeeping change as one unit: under the collections' locks, the new sync logs are computed and
  // their space reserved *before* anything is touched; the new logs are written to staging files; then `commit`
  // changes the content; only then are the logs swapped in. A refused reservation or a failed write leaves the
  // content and the logs exactly as they were.
  async withSyncChanges(changes, commit) {
    const reals = [...new Set(await Promise.all(changes.map((c) => fs.realpath(c.dir).catch(() => c.dir))))].sort();
    const lockAll = (i) => (i < reals.length ? this.withLock(reals[i], () => lockAll(i + 1)) : this.applySync(changes, commit));
    return lockAll(0);
  }

  async applySync(changes, commit) {
    const byDir = new Map();
    for (const c of changes) {
      const real = await fs.realpath(c.dir).catch(() => c.dir);
      if (!byDir.has(real)) byDir.set(real, { dir: c.dir, state: await this.syncState(c.dir) });
      const { state } = byDir.get(real);
      state.seq += 1;
      state.log.push({ seq: state.seq, name: c.name, deleted: !!c.deleted });
      if (state.log.length > SYNC_LOG_LIMIT) state.log.splice(0, state.log.length - SYNC_LOG_LIMIT);
    }
    const plans = [];
    let bytes = 0;
    let replacing = 0;
    for (const { dir, state } of byDir.values()) {
      const data = JSON.stringify(state, null, 2);
      const target = path.join(dir, '.sync.json');
      bytes += Buffer.byteLength(data);
      replacing += (await statOrNull(target))?.size ?? 0;
      plans.push({ target, data, tmp: path.join(dir, `.mycloud-stage-${crypto.randomBytes(6).toString('hex')}`) });
    }
    const cleanup = () => Promise.all(plans.map((p) => fs.rm(p.tmp, { force: true })));
    return this.gate(bytes, replacing, 0, async () => {
      let result;
      try {
        for (const p of plans) await fs.writeFile(p.tmp, p.data, { mode: 0o600 });
        result = await commit();
      } catch (e) {
        await cleanup();
        throw e;
      }
      for (const p of plans) await fs.rename(p.tmp, p.target);
      return result;
    });
  }

  // Write several objects into one collection all-or-nothing (an import is one of these). `settle` learns, under the
  // lock and before anything changes, what the write really replaces and how many entries it really adds.
  async writeItems(dir, items, { settle } = {}) {
    return this.withSyncChanges(items.map(([name]) => ({ dir, name })), async () => {
      if (settle) {
        let replacing = 0;
        let entries = 0;
        for (const [name] of new Map(items)) {
          const old = await statOrNull(safeJoin(dir, [String(name ?? '')]));
          replacing += old?.size ?? 0;
          if (!old) entries++;
        }
        settle({ replacing, entries });
      }
      const staged = [];
      try {
        for (const [name, data] of items) {
          const tmp = path.join(dir, `.mycloud-stage-${crypto.randomBytes(6).toString('hex')}`);
          staged.push([tmp, safeJoin(dir, [String(name ?? '')])]);
          await fs.writeFile(tmp, data, { mode: 0o600 });
        }
      } catch (e) {
        await Promise.all(staged.map(([tmp]) => fs.rm(tmp, { force: true })));
        throw e;
      }
      for (const [tmp, target] of staged) await fs.rename(tmp, target);
    });
  }

  writeItem(dir, name, data, opts) {
    return this.writeItems(dir, [[name, data]], opts);
  }

  async deleteItem(dir, name) {
    const p = safeJoin(dir, [String(name ?? '')]);
    if (!(await statOrNull(p))) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    await this.withSyncChanges([{ dir, name, deleted: true }], () => this.removeCounted(p));
  }

  // Delete a whole calendar or address book (its items are user content; its bookkeeping is not).
  async deleteCollection(dir) {
    await this.removeCounted(dir);
  }

  // Shared collections are reached through per-user links; lock on the real path.
  async withLock(dir, fn) {
    // Same key whether or not the target exists yet (resolve the parent), so concurrent creates share one lock.
    const key = await fs.realpath(dir).catch(async () => path.join(await fs.realpath(path.dirname(dir)).catch(() => path.dirname(dir)), path.basename(dir)));
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
