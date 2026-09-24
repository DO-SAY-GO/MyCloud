// Photo/video thumbnails via ImageMagick (incl. HEIC) and ffmpeg, or sips on an unsandboxed Mac.
//
// Media parsers are the riskiest code that ever touches user uploads, so converters run inside an OS sandbox:
// no network, no reads of the MyCloud data or home directories except the one input file, and writes only
// to a scratch directory. macOS uses sandbox-exec; Linux uses bubblewrap. With no sandbox available,
// thumbnails are off unless MYCLOUD_THUMBNAILS=unsafe (MYCLOUD_THUMBNAILS=off disables them everywhere).
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

async function has(cmd) {
  try {
    await run('/bin/sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

const sbString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class Thumbnailer {
  constructor({ dataDir, mode = process.env.MYCLOUD_THUMBNAILS || 'auto', log = console } = {}) {
    this.dataDir = dataDir;
    this.mode = mode;
    this.log = log;
    this.tools = null;
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
  }

  async detect() {
    if (this.tools) return this.tools;
    const [sips, magick, convert, ffmpeg] = await Promise.all(['sips', 'magick', 'convert', 'ffmpeg'].map(has));
    let sandbox = null;
    if (process.platform === 'darwin' && (await statOrNull('/usr/bin/sandbox-exec'))) sandbox = 'darwin';
    else if (process.platform === 'linux' && (await has('bwrap'))) {
      sandbox = await run('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', 'true']).then(() => 'bwrap', () => null);
    }
    const enabled = this.mode !== 'off' && (sandbox || this.mode === 'unsafe');
    if (!enabled && this.mode !== 'off') this.log.error('[mycloud] thumbnails disabled: no sandbox available (install bubblewrap, or set MYCLOUD_THUMBNAILS=unsafe to accept the risk)');
    this.tools = { sips, magick: magick ? 'magick' : convert ? 'convert' : null, ffmpeg, sandbox: this.mode === 'unsafe' ? null : sandbox, enabled };
    this.realData = await fs.realpath(this.dataDir);
    this.realHome = await fs.realpath(os.homedir()).catch(() => os.homedir());
    return this.tools;
  }

  // Returns the cached JPEG path, or null when thumbnails are off or no tool can handle this file.
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

  // [command, args] for the converter, reading `input` and writing `output`.
  command(t, input, output, ext) {
    if (isVideo(input)) return t.ffmpeg && ['ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-protocol_whitelist', 'file', '-ss', '0.5', '-i', input, '-frames:v', '1', '-vf', `scale=${SIZE}:-2`, output]];
    // sips stages files in the per-user temp dir and cannot run under a tight profile, so it is only used unsandboxed.
    if (t.sips && !t.sandbox && !t.magick) return ['sips', ['-s', 'format', 'jpeg', '-Z', String(SIZE), input, '--out', output]];
    // The explicit coder prefix stops ImageMagick from sniffing a different (riskier) format from the bytes.
    if (t.magick) return [t.magick, ['-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '1GiB', '-limit', 'time', '20', `${ext}:${input}[0]`, '-auto-orient', '-thumbnail', `${SIZE}x${SIZE}`, output]];
    return null;
  }

  async make(src, out) {
    const t = await this.detect();
    if (!t.enabled) return null;
    const ext = path.extname(src).slice(1).toLowerCase().replace('jpeg', 'jpg');
    // On macOS the job lives under /private/tmp: sips stages output next to it rather than honouring TMPDIR,
    // and the per-user temp dir stays unwritable from inside the sandbox.
    const base = t.sandbox === 'darwin' ? '/private/tmp' : os.tmpdir();
    const job = await fs.realpath(await fs.mkdtemp(path.join(base, 'mycloud-thumb-')));
    const realSrc = await fs.realpath(src);
    try {
      const input = t.sandbox === 'bwrap' ? path.join(job, `input.${ext}`) : realSrc;
      const output = path.join(job, 'thumb.jpg');
      const cmd = this.command(t, input, output, ext);
      if (!cmd) return null;
      const env = { PATH: process.env.PATH, TMPDIR: job, MAGICK_TEMPORARY_PATH: job, HOME: job };
      let [bin, args] = cmd;
      if (t.sandbox === 'darwin') {
        // Last matching rule wins: deny every place user data lives, then allow back only the input file.
        // Anything the converter can read could be rendered into the thumbnail it hands back, so reads stay minimal.
        const profile = `(version 1)(allow default)(deny network*)(deny file-write*)
          (allow file-write* (subpath ${sbString(job)}) (literal "/dev/null") (literal "/dev/dtracehelper"))
          (deny file-read* (subpath ${sbString(this.realData)}) (subpath ${sbString(this.realHome)})
            (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp"))
          (allow file-read-metadata)
          (allow file-read* (literal ${sbString(realSrc)}) (subpath ${sbString(job)}))`;
        args = ['-p', profile, bin, ...args];
        bin = '/usr/bin/sandbox-exec';
      } else if (t.sandbox === 'bwrap') {
        await fs.writeFile(input, '');
        args = ['--ro-bind', '/', '/', '--tmpfs', '/home', '--tmpfs', '/root', '--tmpfs', this.realData, '--bind', job, job, '--ro-bind', realSrc, input,
          '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--new-session', '--', bin, ...args];
        bin = 'bwrap';
      }
      await run(bin, args, { timeout: TIMEOUT, env, maxBuffer: 1024 * 1024 });
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.copyFile(output, out);
      return out;
    } catch (e) {
      if (process.env.MYCLOUD_DEBUG) this.log.error(`[mycloud] thumbnail failed for ${src}: ${String(e.stderr || e.message).trim()}`);
      return null;
    } finally {
      await fs.rm(job, { recursive: true, force: true });
    }
  }
}
