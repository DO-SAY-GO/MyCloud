// Storage admission: the one gate every operation that grows persistent storage must pass.
//
// Budgets: each user has one (MYCLOUD_QUOTA_GB), the shared Family space has its own (MYCLOUD_FAMILY_QUOTA_GB,
// defaulting to the user quota, so parking data in Family is not a way around your quota), and "system" covers
// server-managed data such as thumbnails, which is billed to nobody but still bound by the disk reserve.
//
// The disk reserve (MYCLOUD_DISK_RESERVE_GB) is kept as a byte ledger, not an occasional observation:
// available = free space at the last measurement − bytes written since − bytes other operations have claimed.
// Every reservation and every streamed chunk is checked against it, so even a small upload can't cross the floor.
// Real measurements refresh the ledger (defense in depth against other programs using the disk).
//
// Disk space is reserved at the *peak* an operation needs: a replacement is written in full beside the old copy
// before the swap, so it needs its whole size free even though, for the quota, it only adds the difference.
// New filesystem entries (files, folders, collections, locks) are counted too: per budget (MYCLOUD_MAX_FILES,
// default 1,000,000) and against a free-inode reserve (MYCLOUD_INODE_RESERVE, default 10,000), so empty files and
// metadata can't exhaust the filesystem where bytes alone would look harmless.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { HttpError } from './util.js';

const GB = 1024 ** 3;
const MEASURE_EVERY_MS = 2000;
const REMEASURE_BYTES = 64 * 1024 * 1024;
export const FAMILY = '#family';
export const SYSTEM = '#system';
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const gb = (bytes) => `${Math.round((bytes / GB) * 10) / 10} GB`;
const full = () => new HttpError(507, 'the server is out of space');

// Every filesystem entry (file, folder, collection, link) costs at least a block on disk, so it is charged one on
// top of its content. Otherwise empty files would be free, and a flood of them could exhaust the filesystem.
export const ENTRY_COST = 4096;

// Bytes and entries a directory tree accounts for: user content only. `skip` is a directory whose contents are not
// counted (the thumbnail cache is system data); the directory itself still is. Server bookkeeping (collection
// .props.json / .sync.json and trash records) is excluded: it belongs to no quota, its size is capped, and every
// write of it is still reserved against the disk and inode floors (the system budget).
// Exactly these locations, never a name alone: a user's own Drive file called ".sync.json" is content like any other.
const BOOKKEEPING = /^(calendars|addressbooks)\/[^/]+\/\.(sync|props)\.json$/;

// `base` is the subtree's path inside its owner's root, so a subtree (a deleted calendar) is judged by the same
// location rules as the quota uses.
export async function accounted(root, skip = null, base = '') {
  let bytes = 0;
  let entries = 0;
  const count = async (p, e) => {
    entries++;
    bytes += ENTRY_COST;
    if (e.isDirectory()) { if (p !== skip) await walk(p); } // Family links are symlinks: billed to Family only
    else if (e.isFile()) bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  };
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isFile() && BOOKKEEPING.test(path.join(base, path.relative(root, p)).split(path.sep).join('/'))) continue;
      if (e.isDirectory() && e.name === 'trash' && dir === root && !base) {
        // trash/<id>/{meta.json,item}: only the deleted item itself is content.
        for (const id of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
          const item = path.join(p, id.name, 'item');
          const st = await fs.lstat(item).catch(() => null);
          if (st) await count(item, { isDirectory: () => st.isDirectory(), isFile: () => st.isFile() });
        }
        continue;
      }
      await count(p, e);
    }
  };
  await walk(root);
  return { bytes, entries };
}

export class Limits {
  // statfs is injectable so the ledger can be tested against an exact, unchanging disk.
  constructor(store, env = process.env, { statfs = (p) => fs.statfs(p) } = {}) {
    this.store = store;
    this.statfs = statfs;
    this.maxUpload = num(env.MYCLOUD_MAX_UPLOAD_GB, 50) * GB;
    this.reserveBytes = num(env.MYCLOUD_DISK_RESERVE_GB, 2) * GB;
    this.quota = env.MYCLOUD_QUOTA_GB ? Number(env.MYCLOUD_QUOTA_GB) * GB : Infinity;
    this.familyQuota = env.MYCLOUD_FAMILY_QUOTA_GB ? Number(env.MYCLOUD_FAMILY_QUOTA_GB) * GB : this.quota;
    this.maxEntries = num(env.MYCLOUD_MAX_FILES, 1_000_000);
    this.inodeReserve = num(env.MYCLOUD_INODE_RESERVE, 10_000);
    this.usage = new Map(); // budget -> { bytes, entries, at }
    this.active = new Set(); // live reservations: { budget, declared, bytes, replacing, entries }
    this.measured = { free: 0, inodes: Infinity, at: 0 };
    this.growth = 0; // bytes written since the last measurement
    this.entryGrowth = 0; // filesystem entries created since the last measurement
    this.sinceRemeasure = 0;
  }

  // Content was removed: credit its budget at once, so the cached usage never lags reality until the recount.
  freed(budget, { bytes, entries }) {
    const c = this.usage.get(budget);
    if (c) {
      c.bytes = Math.max(0, c.bytes - bytes);
      c.entries = Math.max(0, c.entries - entries);
    }
    this.growth -= bytes;
  }

  // Which budget owns an existing path (for crediting removals).
  async ownerOf(fsPath) {
    const users = path.join(this.store.dataDir, 'users');
    const rel = path.relative(users, fsPath).split(path.sep);
    if (rel[0] && rel[0] !== '..') return this.budgetFor(rel[0], path.dirname(fsPath));
    return this.budgetFor(null, path.dirname(fsPath));
  }

  // ---- budgets --------------------------------------------------------------------------------------------------
  // Which budget pays for writing at fsPath, decided by where it really lives (links followed).
  async budgetFor(user, fsPath) {
    let p = fsPath;
    let real = null;
    while (!real) {
      real = await fs.realpath(p).catch(() => null);
      if (!real) {
        const up = path.dirname(p);
        if (up === p) break;
        p = up;
      }
    }
    const within = async (root) => {
      const r = await fs.realpath(root).catch(() => root);
      return real === r || real?.startsWith(r + path.sep);
    };
    if (real && (await within(this.store.familyRoot()))) return FAMILY;
    return user;
  }

  quotaFor(budget) {
    if (budget === SYSTEM) return Infinity;
    return budget === FAMILY ? this.familyQuota : this.quota;
  }

  // Bytes a budget has on disk (refreshed every 10 minutes). The thumbnail cache is system data, not the user's.
  async used(budget) {
    const c = this.usage.get(budget);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.bytes;
    const root = budget === FAMILY ? this.store.familyRoot() : this.store.userRoot(budget);
    const { bytes, entries } = await accounted(root, budget === FAMILY ? null : this.store.cacheRoot(budget));
    this.usage.set(budget, { bytes, entries, at: Date.now() });
    return bytes;
  }

  static net(r) { return Math.max(r.declared, r.bytes) - r.replacing + r.entries * ENTRY_COST; }

  overQuota(budget) {
    if (budget === SYSTEM) return null;
    const quota = this.quotaFor(budget);
    const u = this.usage.get(budget) ?? { bytes: 0, entries: 0 };
    let total = u.bytes;
    let entries = u.entries;
    for (const r of this.active) {
      if (r.budget !== budget) continue;
      total += Limits.net(r);
      entries += r.entries;
    }
    if (entries > this.maxEntries) return new HttpError(507, `too many files and folders (limit ${this.maxEntries.toLocaleString('en')})`);
    if (total <= quota) return null;
    return new HttpError(507, budget === FAMILY ? `the Family space is full (${gb(quota)})` : `this would put you over your ${gb(quota)} quota`);
  }

  // ---- disk ledger ----------------------------------------------------------------------------------------------
  async measure(force = false) {
    if (!force && Date.now() - this.measured.at < MEASURE_EVERY_MS) return;
    const s = await this.statfs(this.store.dataDir);
    this.measured = { free: s.bavail * s.bsize, inodes: Number.isFinite(s.ffree) ? s.ffree : Infinity, at: Date.now() };
    this.growth = 0;
    this.entryGrowth = 0;
  }

  // Declared-but-not-yet-written bytes: space other operations have already claimed.
  pending() {
    let n = 0;
    for (const r of this.active) n += Math.max(0, r.declared - r.bytes) + r.entries * ENTRY_COST;
    return n;
  }

  available() { return this.measured.free - this.growth - this.pending(); }

  availableInodes() {
    let pendingEntries = 0;
    for (const r of this.active) pendingEntries += r.entries;
    return this.measured.inodes - this.entryGrowth - pendingEntries;
  }

  // ---- reservations ---------------------------------------------------------------------------------------------
  // Claim `declared` bytes and `entries` new filesystem entries for `budget` before writing.
  // `replacing`: bytes the write frees once it completes (an overwritten file). It lowers the quota charge but
  // not the disk claim: the new copy exists in full beside the old one until the swap.
  async reserve(budget, declared, replacing = 0, entries = 0) {
    const r = { budget, declared: Number.isFinite(declared) && declared > 0 ? declared : 0, bytes: 0, replacing: Math.max(0, replacing), entries: Math.max(0, entries) };
    if (r.declared > this.maxUpload) throw new HttpError(413, `files are limited to ${gb(this.maxUpload)}`);
    if (budget !== SYSTEM) await this.used(budget);
    await this.measure();
    // Synchronous from here: the checks and the claim can't interleave with another operation.
    if (this.available() - r.declared - r.entries * ENTRY_COST < this.reserveBytes) throw full();
    if (this.availableInodes() - r.entries < this.inodeReserve) throw full();
    this.active.add(r);
    const err = this.overQuota(budget);
    if (err) {
      this.active.delete(r);
      throw err;
    }
    return r;
  }

  // At commit time, under the target's lock, correct a reservation's guess about what it replaces: another request
  // may have created or replaced the same name since. Re-checks the quota if the net growth went up.
  // `bytes`, when given, is what the operation will really write (measured under the source's lock), replacing the
  // earlier estimate; a growing claim is re-checked against the size cap, the disk and inode floors, and the quota.
  settle(r, { replacing = r.replacing, entries = r.entries, bytes } = {}) {
    const before = { net: Limits.net(r), declared: r.declared, entries: r.entries };
    r.replacing = Math.max(0, replacing);
    r.entries = Math.max(0, entries);
    if (bytes !== undefined) r.declared = Math.max(0, bytes);
    if (r.declared > this.maxUpload) throw new HttpError(413, `files are limited to ${gb(this.maxUpload)}`);
    if (r.declared > before.declared || r.entries > before.entries) {
      if (this.available() < this.reserveBytes) throw full();
      if (this.availableInodes() < this.inodeReserve) throw full();
    }
    if (Limits.net(r) > before.net) {
      const err = this.overQuota(r.budget);
      if (err) throw err;
    }
  }

  // Claim one filesystem entry *before* creating it (a copy discovering more files than it was sized for). Past what
  // the reservation already holds, each extra entry is re-checked against the inode and disk floors and the quota.
  claimEntry(r) {
    r.usedEntries = (r.usedEntries ?? 0) + 1;
    if (r.usedEntries <= r.entries) return;
    r.entries = r.usedEntries;
    if (this.availableInodes() < this.inodeReserve) throw full();
    if (this.available() < this.reserveBytes) throw full();
    const err = this.overQuota(r.budget);
    if (err) throw err;
  }

  // Record bytes as they are written; throws the moment a limit would be crossed.
  consume(r, n) {
    const beyondClaim = Math.max(0, r.bytes + n - Math.max(r.declared, r.bytes));
    r.metered = true; // its bytes are known exactly, as written
    r.bytes += n;
    this.growth += n;
    this.sinceRemeasure += n;
    if (r.bytes > this.maxUpload) throw new HttpError(413, `files are limited to ${gb(this.maxUpload)}`);
    if (beyondClaim > 0) {
      if (this.available() < this.reserveBytes) throw full();
      const err = this.overQuota(r.budget);
      if (err) throw err;
    }
  }

  release(r, ok) {
    if (!this.active.delete(r)) return;
    // Space claimed but never written (an aborted or smaller-than-declared write) goes back to the pool,
    // and a replaced file's bytes come back to the disk.
    if (ok) {
      this.growth -= r.replacing; // the overwritten file's bytes are free again
      this.growth += r.entries * ENTRY_COST;
      this.entryGrowth += r.entries;
    } else {
      this.growth -= r.bytes; // the caller deletes the partial write
    }
    const c = this.usage.get(r.budget);
    if (ok && c) {
      c.bytes += r.bytes - r.replacing + r.entries * ENTRY_COST;
      c.entries += r.entries;
    }
    if (this.sinceRemeasure > REMEASURE_BYTES) {
      this.sinceRemeasure = 0;
      this.measure(true).catch(() => {});
    }
  }

  // A stream stage for uploads of unknown or untrusted length.
  meter(r) {
    const self = this;
    return new Transform({
      transform(chunk, _enc, cb) {
        try {
          self.consume(r, chunk.length);
          cb(null, chunk);
        } catch (e) {
          cb(e);
        }
      },
    });
  }

  // Streamed upload: reserve what the client declared, meter every byte, release on every path.
  async guard(budget, req, replacing, write, { entries = 0 } = {}) {
    const r = await this.reserve(budget, Number(req.headers['content-length']), replacing, entries);
    let ok = false;
    try {
      await write(this.meter(r), r);
      ok = true;
    } finally {
      this.release(r, ok);
    }
  }

  // A write whose size is known up front (a calendar object, an import, a copy, a thumbnail).
  async withBytes(budget, bytes, replacing, fn, { entries = 0 } = {}) {
    const r = await this.reserve(budget, bytes, replacing, entries);
    let ok = false;
    try {
      const result = await fn(r);
      if (!r.metered) {
        r.bytes = r.declared; // written as claimed (metered writes already counted every byte)
        this.growth += r.declared;
      }
      ok = true;
      return result;
    } finally {
      this.release(r, ok);
    }
  }
}

// Copy a tree (links skipped), claiming each entry before creating it and passing every byte through `consume`, so
// the copy is charged for what it really copies, and limits hold during the copy, even if the source grew after it
// was first measured.
export async function meteredCopy(src, dst, consume, claimEntry = () => {}) {
  const st = await fs.lstat(src);
  if (st.isSymbolicLink()) return;
  claimEntry();
  if (st.isDirectory()) {
    await fs.mkdir(dst);
    for (const name of await fs.readdir(src)) await meteredCopy(path.join(src, name), path.join(dst, name), consume, claimEntry);
    return;
  }
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Transform } = await import('node:stream');
  await pipeline(createReadStream(src), new Transform({
    transform(chunk, _e, cb) {
      try {
        consume(chunk.length);
        cb(null, chunk);
      } catch (e) {
        cb(e);
      }
    },
  }), createWriteStream(dst, { mode: 0o600 }));
}

// Bytes and entries under a path (links not followed), for sizing copies before they happen.
export async function treeStats(p) {
  const st = await fs.lstat(p).catch(() => null);
  if (!st || st.isSymbolicLink()) return { bytes: 0, entries: 0 };
  if (!st.isDirectory()) return { bytes: st.size, entries: 1 };
  const total = { bytes: 4096, entries: 1 };
  for (const name of await fs.readdir(p)) {
    const t = await treeStats(path.join(p, name));
    total.bytes += t.bytes;
    total.entries += t.entries;
  }
  return total;
}
export const treeSize = async (p) => (await treeStats(p)).bytes;
