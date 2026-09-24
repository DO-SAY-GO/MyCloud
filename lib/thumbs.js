// Photo/video thumbnails via whatever the host already has: sips (macOS), ImageMagick, or ffmpeg.
// With no tool available, callers fall back to the original file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statOrNull, isVideo } from './util.js';

const run = promisify(execFile);
const SIZE = 480;
const MAX_JOBS = 2;

async function has(cmd) {
  try {
    await run('/bin/sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

export class Thumbnailer {
  constructor() {
    this.tools = null;
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
  }

  async detect() {
    if (!this.tools) {
      const [sips, magick, convert, ffmpeg] = await Promise.all(['sips', 'magick', 'convert', 'ffmpeg'].map(has));
      this.tools = { sips, magick: magick ? 'magick' : convert ? 'convert' : null, ffmpeg };
    }
    return this.tools;
  }

  // Returns the cached JPEG path, or null when no tool can handle this file.
  async get(cacheDir, src, stat) {
    const key = crypto.createHash('sha1').update(`${src}\0${stat.size}\0${stat.mtimeMs}`).digest('hex');
    const out = path.join(cacheDir, 'thumbs', `${key}.jpg`);
    if (await statOrNull(out)) return out;
    if (!this.inflight.has(out)) {
      const job = this.slot(() => this.make(src, out)).finally(() => this.inflight.delete(out));
      this.inflight.set(out, job);
    }
    return this.inflight.get(out);
  }

  async slot(fn) {
    if (this.active >= MAX_JOBS) await new Promise((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async make(src, out) {
    const t = await this.detect();
    await fs.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp.jpg`;
    const opts = { timeout: 30_000 };
    try {
      if (isVideo(src)) {
        if (!t.ffmpeg) return null;
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', '0.5', '-i', src, '-frames:v', '1', '-vf', `scale=${SIZE}:-2`, tmp], opts);
      } else if (t.sips) {
        await run('sips', ['-s', 'format', 'jpeg', '-Z', String(SIZE), src, '--out', tmp], opts);
      } else if (t.magick) {
        await run(t.magick, [`${src}[0]`, '-auto-orient', '-thumbnail', `${SIZE}x${SIZE}`, tmp], opts);
      } else {
        return null;
      }
      await fs.rename(tmp, out);
      return out;
    } catch {
      await fs.rm(tmp, { force: true });
      return null;
    }
  }
}
