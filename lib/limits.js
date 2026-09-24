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

export class Limits {
  // statfs is injectable so the ledger can be tested against an exact, unchanging disk.
  constructor(store, env = process.env, { statfs = (p) => fs.statfs(p) } = {}) {
    this.store = store;
    this.statfs = statfs;
    this.maxUpload = num(env.MYCLOUD_MAX_UPLOAD_GB, 50) * GB;
    this.reserveBytes = num(env.MYCLOUD_DISK_RESERVE_GB, 2) * GB;
    this.quota = env.MYCLOUD_QUOTA_GB ? Number(env.MYCLOUD_QUOTA_GB) * GB : Infinity;
    this.familyQuota = env.MYCLOUD_FAMILY_QUOTA_GB ? Number(env.MYCLOUD_FAMILY_QUOTA_GB) * GB : this.quota;
    this.usage = new Map(); // budget -> { bytes, at }
    this.active = new Set(); // live reservations: { budget, declared, bytes, replacing }
    this.measured = { free: 0, at: 0 };
    this.growth = 0; // bytes written since the last measurement
    this.sinceRemeasure = 0;
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
    const skip = budget === FAMILY ? null : this.store.cacheRoot(budget);
    let bytes = 0;
    const walk = async (dir) => {
      if (dir === skip) return;
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p); // Family links are symlinks, so shared space is billed to Family only
        else if (e.isFile()) bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(root);
    this.usage.set(budget, { bytes, at: Date.now() });
    return bytes;
  }

  static net(r) { return Math.max(r.declared, r.bytes) - r.replacing; }

  overQuota(budget) {
    const quota = this.quotaFor(budget);
    if (quota === Infinity) return null;
    let total = this.usage.get(budget)?.bytes ?? 0;
    for (const r of this.active) if (r.budget === budget) total += Limits.net(r);
    if (total <= quota) return null;
    return new HttpError(507, budget === FAMILY ? `the Family space is full (${gb(quota)})` : `this would put you over your ${gb(quota)} quota`);
  }

  // ---- disk ledger ----------------------------------------------------------------------------------------------
  async measure(force = false) {
    if (!force && Date.now() - this.measured.at < MEASURE_EVERY_MS) return;
    const s = await this.statfs(this.store.dataDir);
    this.measured = { free: s.bavail * s.bsize, at: Date.now() };
    this.growth = 0;
  }

  // Declared-but-not-yet-written bytes: space other operations have already claimed.
  pending() {
    let n = 0;
    for (const r of this.active) n += Math.max(0, r.declared - r.bytes);
    return n;
  }

  available() { return this.measured.free - this.growth - this.pending(); }

  // ---- reservations ---------------------------------------------------------------------------------------------
  // Claim `declared` bytes for `budget` before writing. `replacing`: bytes the write frees (an overwritten file).
  async reserve(budget, declared, replacing = 0) {
    const r = { budget, declared: Number.isFinite(declared) && declared > 0 ? declared : 0, bytes: 0, replacing: Math.max(0, replacing) };
    if (r.declared > this.maxUpload) throw new HttpError(413, `files are limited to ${gb(this.maxUpload)}`);
    if (this.quotaFor(budget) !== Infinity) await this.used(budget);
    await this.measure();
    // Synchronous from here: the checks and the claim can't interleave with another operation.
    if (this.available() - Math.max(0, r.declared - r.replacing) < this.reserveBytes) throw full();
    this.active.add(r);
    const err = this.overQuota(budget);
    if (err) {
      this.active.delete(r);
      throw err;
    }
    return r;
  }

  // Record bytes as they are written; throws the moment a limit would be crossed.
  consume(r, n) {
    const beyondClaim = Math.max(0, r.bytes + n - Math.max(r.declared, r.bytes));
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
    if (ok) this.growth -= r.replacing; // the overwritten file's bytes are free again
    else this.growth -= r.bytes; // the caller deletes the partial write
    const c = this.usage.get(r.budget);
    if (ok && c) c.bytes += r.bytes - r.replacing;
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
  async guard(budget, req, replacing, write) {
    const r = await this.reserve(budget, Number(req.headers['content-length']), replacing);
    let ok = false;
    try {
      await write(this.meter(r));
      ok = true;
    } finally {
      this.release(r, ok);
    }
  }

  // A write whose size is known up front (a calendar object, an import, a copy, a thumbnail).
  async withBytes(budget, bytes, replacing, fn) {
    const r = await this.reserve(budget, bytes, replacing);
    let ok = false;
    try {
      const result = await fn();
      r.bytes = r.declared; // written as claimed
      this.growth += r.declared;
      ok = true;
      return result;
    } finally {
      this.release(r, ok);
    }
  }
}

// Total bytes under a path (files only, links not followed), for sizing copies before they happen.
export async function treeSize(p) {
  const st = await fs.lstat(p).catch(() => null);
  if (!st || st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let n = 4096;
  for (const name of await fs.readdir(p)) n += await treeSize(path.join(p, name));
  return n;
}
