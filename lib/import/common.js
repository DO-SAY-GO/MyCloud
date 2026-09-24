import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Build lib/import/<name>.swift once per source version (needs Apple's free command line tools).
// An embedded Info.plist carries the privacy strings macOS shows when a helper asks for Reminders or Photos access.
export async function swiftHelper(name) {
  const srcPath = path.join(HERE, `${name}.swift`);
  const src = await fs.readFile(srcPath);
  const bin = path.join(os.homedir(), '.mycloud', 'bin', `mycloud-${name}-${crypto.createHash('sha1').update(src).digest('hex').slice(0, 10)}`);
  if (await fs.stat(bin).catch(() => null)) return bin;
  await fs.mkdir(path.dirname(bin), { recursive: true });
  const plist = `${bin}.plist`;
  await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.dosaygo.mycloud.${name}</string>
  <key>CFBundleName</key><string>MyCloud importer</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>MyCloud copies your reminders to your own server.</string>
  <key>NSRemindersUsageDescription</key><string>MyCloud copies your reminders to your own server.</string>
  <key>NSPhotoLibraryUsageDescription</key><string>MyCloud copies your photo originals to your own server.</string>
</dict></plist>`);
  try {
    await run('xcrun', ['swiftc', '-O', '-swift-version', '5', srcPath, '-o', bin, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist], { timeout: 5 * 60 * 1000 });
  } catch (e) {
    if (/xcrun: error|invalid active developer path/i.test(String(e.stderr))) {
      throw new Error('This step needs Apple’s free command line tools. Run: xcode-select --install and then try again.');
    }
    throw new Error(`could not build the ${name} helper: ${String(e.stderr || e.message).split('\n')[0]}`);
  } finally {
    await fs.rm(plist, { force: true });
  }
  return bin;
}

// One status line per step; redraws in place on a terminal, stays quiet when piped.
export class Progress {
  constructor(label, total) {
    this.label = label;
    this.total = total;
    this.count = 0;
    this.tty = process.stderr.isTTY;
    this.last = 0;
  }
  tick(n = 1) {
    this.count += n;
    if (!this.tty || (Date.now() - this.last < 100 && this.count < this.total)) return;
    this.last = Date.now();
    process.stderr.write(`\r  ${this.label}: ${this.count}/${this.total}\x1b[K`);
  }
  done() {
    if (this.tty && this.total) process.stderr.write('\r\x1b[K');
    return this.count;
  }
}

export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'imported';

export const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim().slice(0, 120) || 'Untitled';

export async function walkFiles(root) {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await fs.stat(full);
        out.push({ path: full, rel: path.relative(root, full), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk(root);
  return out;
}

// Run a helper that speaks JSON lines; events are handled one at a time, in order.
export function runHelper(bin, args, input, onEvent) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let chain = Promise.resolve();
    let failure = null;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.event === 'error') failure = new Error(ev.message);
      else chain = chain.then(() => onEvent(ev)).catch((e) => { failure ??= e; child.kill(); });
    });
    child.on('error', reject);
    child.on('close', () => chain.then(() => (failure ? reject(failure) : resolve())));
    child.stdin.end(input ?? '');
  });
}
