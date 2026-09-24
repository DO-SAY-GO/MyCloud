// Upload guards: per-file size cap, a free-disk reserve, and optional per-user quotas.
//
// Every upload holds a reservation for as long as it streams. Checks count what is *in flight* across all
// concurrent uploads, not just what is already on disk, so parallel uploads can't jointly overrun a quota or the
// reserve, and chunked uploads (no Content-Length) are held to the same limits byte by byte.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { HttpError } from './util.js';

const GB = 1024 ** 3;
const DISK_CHECK_EVERY = 16 * 1024 * 1024; // re-measure free space after this much new data, across all uploads
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const gb = (bytes) => `${Math.round((bytes / GB) * 10) / 10} GB`;

export class Limits {
  constructor(store, env = process.env) {
    this.store = store;
    this.maxUpload = num(env.MYCLOUD_MAX_UPLOAD_GB, 50) * GB;
    this.reserveBytes = num(env.MYCLOUD_DISK_RESERVE_GB, 2) * GB;
    this.quota = env.MYCLOUD_QUOTA_GB ? Number(env.MYCLOUD_QUOTA_GB) * GB : Infinity;
    this.usage = new Map(); // user -> { bytes, at } (bytes on disk, refreshed every 10 minutes)
    this.active = new Set(); // live reservations: { user, declared, bytes, replacing }
    this.sinceDiskCheck = 0;
  }

  async freeBytes() {
    const s = await fs.statfs(this.store.dataDir);
    return s.bavail * s.bsize;
  }

  async used(user) {
    const c = this.usage.get(user);
    if (c && Date.now() - c.at < 10 * 60 * 1000) return c.bytes;
    let bytes = 0;
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p); // the Family link is a symlink: shared space isn't billed to anyone
        else if (e.isFile()) bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(this.store.userRoot(user));
    this.usage.set(user, { bytes, at: Date.now() });
    return bytes;
  }

  // What an upload stands to add: the larger of what it declared and what has arrived, minus what it replaces.
  static net(r) { return Math.max(r.declared, r.bytes) - r.replacing; }

  // Declared-but-not-yet-written bytes: disk space other uploads have already claimed.
  pendingOnDisk() {
    let n = 0;
    for (const r of this.active) n += Math.max(0, r.declared - r.bytes);
    return n;
  }

  overQuota(user) {
    if (this.quota === Infinity) return null;
    let total = this.usage.get(user)?.bytes ?? 0;
    for (const r of this.active) if (r.user === user) total += Limits.net(r);
    return total > this.quota ? new HttpError(507, `this would put you over your ${gb(this.quota)} quota`) : null;
  }

  // Before any byte is written. `replacing` is the size of the file being overwritten (it frees that much).
  async reserve(user, declared, replacing = 0) {
    const r = { user, declared: Number.isFinite(declared) && declared > 0 ? declared : 0, bytes: 0, replacing };
    if (r.declared > this.maxUpload) throw new HttpError(413, `files are limited to ${gb(this.maxUpload)}`);
    if (this.quota !== Infinity) await this.used(user);
    const free = await this.freeBytes();
    if (free - this.pendingOnDisk() - r.declared < this.reserveBytes) throw new HttpError(507, 'the server is out of space');
    // From here on everything is synchronous, so the check and the claim can't interleave with another upload.
    this.active.add(r);
    const err = this.overQuota(user);
    if (err) {
      this.active.delete(r);
      throw err;
    }
    return r;
  }

  release(r, ok) {
    if (!this.active.delete(r)) return;
    const c = this.usage.get(r.user);
    if (ok && c) c.bytes += r.bytes - r.replacing;
  }

  // Counts bytes as they stream and stops the upload the moment any limit is crossed.
  meter(r) {
    const self = this;
    return new Transform({
      async transform(chunk, _enc, cb) {
        r.bytes += chunk.length;
        self.sinceDiskCheck += chunk.length;
        if (r.bytes > self.maxUpload) return cb(new HttpError(413, `files are limited to ${gb(self.maxUpload)}`));
        if (r.bytes > r.declared) {
          const err = self.overQuota(r.user);
          if (err) return cb(err);
        }
        if (self.sinceDiskCheck >= DISK_CHECK_EVERY) {
          self.sinceDiskCheck = 0;
          try {
            if ((await self.freeBytes()) - self.pendingOnDisk() < self.reserveBytes) return cb(new HttpError(507, 'the server ran out of space'));
          } catch { /* statfs unavailable: the write itself fails with ENOSPC */ }
        }
        cb(null, chunk);
      },
    });
  }

  // One call for the common case: reserve, stream `source` through the meter into `sink`, release.
  async guard(user, req, replacing, write) {
    const r = await this.reserve(user, Number(req.headers['content-length']), replacing);
    let ok = false;
    try {
      await write(this.meter(r));
      ok = true;
    } finally {
      this.release(r, ok);
    }
  }
}
