// Photo/video thumbnails via ImageMagick (incl. HEIC) and ffmpeg, or sips on an unsandboxed Mac.
//
// Media parsers are the riskiest code that ever touches user uploads, and anything a compromised parser can read
// could be rendered into the thumbnail it hands back. So converters never run next to user data:
//   - on a host, inside an OS sandbox (sandbox-exec on macOS, bubblewrap on Linux) that shows them only the one
//     input file, a private scratch directory and the system's programs and libraries, with no network;
//   - in Docker, in a separate thumbnailer container (`mycloud thumbnailer`, MYCLOUD_THUMBNAILER_URL) that has no
//     data volume and no internet, and handles exactly one file at a time.
// With neither available, thumbnails are off unless MYCLOUD_THUMBNAILS=unsafe (MYCLOUD_THUMBNAILS=off disables them).
import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statOrNull, isVideo } from './util.js';

const run = promisify(execFile);
const SIZE = 480;
const MAX_JOBS = 2;
const TIMEOUT = 30_000;
const MB = 1024 * 1024;
const MAX_THUMB_BYTES = 2 * MB; // a 480px JPEG is ~50 KB; anything far bigger is not a thumbnail
const maxInputBytes = () => Number(process.env.MYCLOUD_THUMBNAIL_MAX_MB || 384) * MB;

async function has(cmd) {
  try {
    await run('/bin/sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

const sbString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

export class Thumbnailer {
  // hidePaths: extra host paths to hide from the sandbox (e.g. the TLS certificate and key directories).
  constructor({ dataDir, mode = process.env.MYCLOUD_THUMBNAILS || 'auto', remote = process.env.MYCLOUD_THUMBNAILER_URL, hidePaths = [], admit = (_n, fn) => fn(), log = console } = {}) {
    this.admit = admit; // storage gate for cache writes
    this.remote = remote && mode !== 'off' ? new URL(remote) : null;
    this.dataDir = dataDir;
    this.mode = mode;
    this.hidePaths = hidePaths.filter(Boolean);
    this.log = log;
    this.tools = null;
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
  }

  async detect() {
    if (this.tools) return this.tools;
    if (this.remote) return (this.tools = { enabled: true, remote: true });
    const [sips, magick, convert, ffmpeg] = await Promise.all(['sips', 'magick', 'convert', 'ffmpeg'].map(has));
    let sandbox = null;
    if (this.mode !== 'unsafe') {
      if (process.platform === 'darwin' && (await statOrNull('/usr/bin/sandbox-exec'))) sandbox = 'darwin';
      else if (process.platform === 'linux' && (await has('bwrap'))) {
        sandbox = await run('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', 'true']).then(() => 'bwrap', () => null);
      }
    }
    const enabled = this.mode !== 'off' && (!!sandbox || this.mode === 'unsafe');
    if (!enabled && this.mode !== 'off') this.log.error('[mycloud] thumbnails disabled: no sandbox available (install bubblewrap, or set MYCLOUD_THUMBNAILS=unsafe to accept the risk)');
    this.tools = { sips, magick: magick ? 'magick' : convert ? 'convert' : null, ffmpeg, sandbox, enabled };
    this.realData = await fs.realpath(this.dataDir).catch(() => this.dataDir);
    this.realHome = await fs.realpath(os.homedir()).catch(() => os.homedir());
    this.realHide = await Promise.all(this.hidePaths.map((p) => fs.realpath(path.dirname(p)).catch(() => null))).then((a) => a.filter(Boolean));
    return this.tools;
  }

  // Returns the cached JPEG path, or null when thumbnails are off or no tool can handle this file.
  async get(cacheDir, src, stat) {
    if (stat.size > maxInputBytes()) return null;
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

  // Send one file to the thumbnailer container; accept only a small, genuine JPEG back.
  async makeRemote(src, out) {
    const ext = path.extname(src).slice(1).toLowerCase();
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(new URL(`/thumb?ext=${encodeURIComponent(ext)}`, this.remote), { method: 'POST', timeout: 60_000 }, resolve);
        req.on('timeout', () => req.destroy(new Error('thumbnailer timed out')));
        req.on('error', reject);
        pipeline(createReadStream(src), req).catch(reject);
      });
      if (res.statusCode !== 200 || !/^image\/jpeg\b/.test(res.headers['content-type'] ?? '') || Number(res.headers['content-length'] ?? 0) > MAX_THUMB_BYTES) {
        res.destroy();
        return null;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of res) {
        size += chunk.length;
        if (size > MAX_THUMB_BYTES) {
          res.destroy();
          return null;
        }
        chunks.push(chunk);
      }
      const jpg = Buffer.concat(chunks);
      if (!isJpeg(jpg)) return null;
      await this.admit(jpg.length, async () => {
        await fs.mkdir(path.dirname(out), { recursive: true });
        const tmp = `${out}.${crypto.randomBytes(4).toString('hex')}.part`;
        await fs.writeFile(tmp, jpg);
        await fs.rename(tmp, out);
      });
      return out;
    } catch (e) {
      if (process.env.MYCLOUD_DEBUG) this.log.error(`[mycloud] remote thumbnail failed for ${src}: ${e.message}`);
      return null;
    }
  }

  // [command, args] for the converter, reading `input` and writing `output`.
  command(t, input, output, ext) {
    if (isVideo(input)) return t.ffmpeg && ['ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-protocol_whitelist', 'file', '-ss', '0.5', '-i', input, '-frames:v', '1', '-vf', `scale=${SIZE}:-2`, output]];
    // sips stages files in the per-user temp dir and cannot run under a tight profile, so it is only used unsandboxed.
    if (t.sips && !t.sandbox && !t.magick) return ['sips', ['-s', 'format', 'jpeg', '-Z', String(SIZE), input, '--out', output]];
    // The explicit coder prefix stops ImageMagick from sniffing a different (riskier) format from the bytes.
    if (t.magick) return [t.magick, ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '1GiB', '-limit', 'time', '20', `${ext}:${input}[0]`, '-auto-orient', '-thumbnail', `${SIZE}x${SIZE}`, output]];
    return null;
  }

  // Wrap [bin, args] in the host sandbox so that it sees only `realSrc` (at `input`), the `job` directory and the
  // system's programs and libraries. Exposed separately so tests can run escape probes through the same wrapper.
  wrap(t, bin, args, { job, realSrc, input }) {
    if (t.sandbox === 'darwin') {
      // Last matching rule wins: deny every place user data lives, then allow back only the input file.
      const hide = [this.realData, this.realHome, ...this.realHide, '/Users', '/Volumes', '/private/var/folders', '/private/tmp', '/private/var/tmp']
        .map((p) => `(subpath ${sbString(p)})`).join(' ');
      const profile = `(version 1)(allow default)(deny network*)(deny file-write*)
        (allow file-write* (subpath ${sbString(job)}) (literal "/dev/null") (literal "/dev/dtracehelper"))
        (deny file-read* ${hide})
        (allow file-read-metadata)
        (allow file-read* (literal ${sbString(realSrc)}) (subpath ${sbString(job)}))`;
      return ['/usr/bin/sandbox-exec', ['-p', profile, bin, ...args]];
    }
    if (t.sandbox === 'bwrap') {
      // Start from a read-only view of the system, then blank out everywhere data can live. The job directory
      // (and the single input bound into it) is mounted back last.
      const masks = ['/tmp', '/var', '/home', '/root', '/run', '/mnt', '/media', '/srv', '/sys', this.realData, ...this.realHide]
        .flatMap((p) => ['--tmpfs', p]);
      return ['bwrap', ['--ro-bind', '/', '/', ...masks, '--bind', job, job, '--ro-bind', realSrc, input,
        '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--new-session', '--', bin, ...args]];
    }
    return [bin, args];
  }

  async make(src, out) {
    const t = await this.detect();
    if (!t.enabled) return null;
    if (t.remote) return this.makeRemote(src, out);
    const ext = path.extname(src).slice(1).toLowerCase().replace('jpeg', 'jpg');
    // On macOS the job lives under /private/tmp: sips stages output next to it rather than honouring TMPDIR,
    // and the per-user temp dir stays unwritable from inside the sandbox.
    const base = t.sandbox === 'darwin' ? '/private/tmp' : os.tmpdir();
    const job = await fs.realpath(await fs.mkdtemp(path.join(base, 'mycloud-thumb-')));
    const realSrc = await fs.realpath(src);
    try {
      const input = t.sandbox === 'bwrap' ? path.join(job, `input.${ext}`) : realSrc;
      if (t.sandbox === 'bwrap') await fs.writeFile(input, ''); // mount point for the read-only input
      const output = path.join(job, 'thumb.jpg');
      const cmd = this.command(t, input, output, ext);
      if (!cmd) return null;
      const [bin, args] = this.wrap(t, cmd[0], cmd[1], { job, realSrc, input });
      await run(bin, args, { timeout: TIMEOUT, env: { PATH: process.env.PATH, TMPDIR: job, MAGICK_TEMPORARY_PATH: job, HOME: job }, maxBuffer: MB });
      const jpg = await fs.readFile(output);
      if (jpg.length > MAX_THUMB_BYTES || !isJpeg(jpg)) return null;
      await this.admit(jpg.length, async () => {
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, jpg);
      });
      return out;
    } catch (e) {
      if (process.env.MYCLOUD_DEBUG) this.log.error(`[mycloud] thumbnail failed for ${src}: ${String(e.stderr || e.message).trim()}`);
      return null;
    } finally {
      await fs.rm(job, { recursive: true, force: true });
    }
  }
}

// `mycloud thumbnailer`: the isolated side of MYCLOUD_THUMBNAILER_URL, meant for a container with no volumes and no
// internet. Exactly one job exists at a time: the slot is taken *before* an upload is accepted, so no two users'
// files are ever on this worker together. Inputs are capped below the container's memory (its tmpfs counts too).
const EXT_OK = /^(jpe?g|png|gif|webp|heic|heif|avif|tiff?|mp4|mov|m4v|webm)$/;
const MAX_WAITING = 16;

export function thumbnailService({ log = console, workRoot = os.tmpdir(), convert } = {}) {
  const t = new Thumbnailer({ dataDir: workRoot, mode: 'unsafe', remote: null, log }); // the container is the sandbox
  const maxInput = maxInputBytes();
  let busy = false;
  const waiting = [];
  const stats = { maxActive: 0, active: 0 };
  const acquire = () => (busy ? new Promise((r) => waiting.push(r)) : ((busy = true), Promise.resolve()));
  const releaseSlot = () => { const next = waiting.shift(); if (next) next(); else busy = false; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://thumbnailer');
    const ext = (url.searchParams.get('ext') || '').toLowerCase().replace('jpeg', 'jpg');
    if (req.method !== 'POST' || url.pathname !== '/thumb' || !EXT_OK.test(ext)) return res.writeHead(400).end();
    if (Number(req.headers['content-length'] ?? 0) > maxInput) return res.writeHead(413, { Connection: 'close' }).end();
    if (waiting.length >= MAX_WAITING) return res.writeHead(503, { 'Retry-After': '5', Connection: 'close' }).end();
    await acquire();
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    let job;
    const cleanup = async () => {
      if (job) await fs.rm(job, { recursive: true, force: true });
      job = null;
    };
    try {
      job = await fs.mkdtemp(path.join(workRoot, 'job-'));
      const input = path.join(job, `input.${ext}`);
      let seen = 0;
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          seen += chunk.length;
          if (seen > maxInput) throw Object.assign(new Error('too large'), { status: 413 });
          yield chunk;
        }
      }, createWriteStream(input));
      const output = path.join(job, 'thumb.jpg');
      if (convert) await convert({ input, output, ext, workRoot });
      else {
        const cmd = t.command(await t.detect(), input, output, ext);
        if (!cmd) throw new Error('no converter for this type');
        await run(cmd[0], cmd[1], { timeout: TIMEOUT, env: { PATH: process.env.PATH, TMPDIR: job, MAGICK_TEMPORARY_PATH: job, HOME: job }, maxBuffer: MB });
      }
      const jpg = await fs.readFile(output);
      if (jpg.length > MAX_THUMB_BYTES || !isJpeg(jpg)) throw new Error('converter produced no usable JPEG');
      await cleanup(); // the input is gone before anyone hears back
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpg.length }).end(jpg);
    } catch (e) {
      if (process.env.MYCLOUD_DEBUG) log.error(`[thumbnailer] ${e.message}`);
      await cleanup();
      if (!res.headersSent) res.writeHead(e.status ?? 422, { Connection: 'close' }).end();
      req.resume();
    } finally {
      await cleanup();
      stats.active--;
      releaseSlot();
    }
  });
  server.stats = stats;
  return server;
}
