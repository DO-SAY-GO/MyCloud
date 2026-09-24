// Upload guards: per-file size cap, a free-disk reserve, and optional per-user quotas.
// Enforced while streaming, so a chunked upload without Content-Length can't slip past.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { HttpError } from './util.js';

const GB = 1024 ** 3;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export class Limits {
  constructor(store, env = process.env) {
    this.store = store;
    this.maxUpload = num(env.MYCLOUD_MAX_UPLOAD_GB, 50) * GB;
    this.reserve = num(env.MYCLOUD_DISK_RESERVE_GB, 2) * GB;
    this.quota = env.MYCLOUD_QUOTA_GB ? Number(env.MYCLOUD_QUOTA_GB) * GB : Infinity;
    this.usage = new Map(); // user -> { bytes, at }
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

  // Throws before any byte is written when the declared size can't fit.
  async admit(user, declared) {
    const size = Number.isFinite(declared) ? declared : 0;
    if (size > this.maxUpload) throw new HttpError(413, `files are limited to ${Math.round(this.maxUpload / GB)} GB`);
    if ((await this.freeBytes()) - size < this.reserve) throw new HttpError(507, 'the server is out of space');
    if (this.quota !== Infinity && (await this.used(user)) + size > this.quota) throw new HttpError(507, 'you are over your storage quota');
  }

  // Counts bytes as they stream; aborts on the size cap or when the disk reserve is reached.
  meter(user) {
    let seen = 0;
    let nextCheck = 64 * 1024 * 1024;
    const self = this;
    return new Transform({
      async transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > self.maxUpload) return cb(new HttpError(413, `files are limited to ${Math.round(self.maxUpload / GB)} GB`));
        if (seen >= nextCheck) {
          nextCheck += 64 * 1024 * 1024;
          try {
            if ((await self.freeBytes()) < self.reserve) return cb(new HttpError(507, 'the server ran out of space'));
          } catch { /* statfs unavailable: rely on the write failing */ }
        }
        cb(null, chunk);
      },
      flush(cb) {
        const c = self.usage.get(user);
        if (c) c.bytes += seen;
        cb();
      },
    });
  }
}
