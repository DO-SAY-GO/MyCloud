// `mycloud import iphone` (camera roll over USB) and `mycloud import folder` (anything on disk).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Progress, walkFiles, swiftHelper, runHelper } from './common.js';
import { isImage, isVideo } from '../util.js';


const photoFolder = (ms) => {
  const d = new Date(ms);
  return `Photos/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export async function importIphone(client, opts, log) {
  if (process.platform !== 'darwin') throw new Error('`import iphone` runs on a Mac (it uses the same framework as Image Capture).');
  const bin = await swiftHelper('iphone');
  const items = [];
  await runHelper(bin, ['list'], '', (ev) => {
    if (ev.event === 'device') log(`  Found ${ev.name}`);
    if (ev.event === 'locked') log(`  ${ev.message}`);
    if (ev.event === 'item') items.push(ev);
  });
  items.sort((a, b) => b.created - a.created);
  // Skip what the server already has (same name + size in the month folder it would land in).
  const todo = [];
  for (const it of opts.limit ? items.slice(0, opts.limit) : items) {
    if ((await client.remoteSize(`${photoFolder(it.created * 1000)}/${it.name}`)) !== it.size) todo.push(it);
  }
  log(`  ${items.length} photos and videos on the device, ${todo.length} not in MyCloud yet${opts.dryRun && todo.length ? ` (would import ${todo.length}, newest first)` : ''}`);
  if (opts.dryRun || !todo.length) return { found: items.length, toImport: todo.length };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-iphone-'));
  const p = new Progress('iPhone', todo.length);
  const skipped = [];
  let imported = 0;
  try {
    await runHelper(bin, ['download', tmp], JSON.stringify(todo.map((t) => t.key)), async (ev) => {
      if (ev.event === 'skip') { skipped.push(`${ev.key} (${ev.message})`); p.tick(); }
      if (ev.event !== 'file') return;
      const st = await fs.stat(ev.path);
      if ((await client.uploadOnce(photoFolder(ev.created * 1000), path.basename(ev.path), ev.path, st.size, ev.created * 1000)) === 'uploaded') imported++;
      await fs.rm(ev.path, { force: true });
      p.tick();
    });
  } finally {
    p.done();
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return { found: items.length, imported, skipped };
}

// Any folder: an SD card, an Image Capture export, a Google Takeout, an old backup drive.
export async function importFolder(client, dir, opts, log) {
  const root = path.resolve(dir);
  let files = await walkFiles(root);
  files = files.filter((f) => !f.rel.split(path.sep).some((s) => s.startsWith('.')));
  if (opts.photos) files = files.filter((f) => isImage(f.rel) || isVideo(f.rel));
  if (opts.limit) files = files.slice(0, opts.limit);
  const remoteRoot = opts.to || path.basename(root);
  log(`  ${files.length} files (${(files.reduce((a, f) => a + f.size, 0) / 1e9).toFixed(2)} GB) → ${opts.photos ? 'Photos/<year>/<month>' : remoteRoot}`);
  if (opts.dryRun) return { found: files.length };
  const p = new Progress('Uploading', files.length);
  let imported = 0;
  for (const f of files) {
    const dest = opts.photos ? photoFolder(f.mtimeMs) : path.posix.join(remoteRoot, path.posix.dirname(f.rel.split(path.sep).join('/')));
    if ((await client.uploadOnce(dest.replace(/\/\.$/, ''), path.basename(f.rel), f.path, f.size, f.mtimeMs)) === 'uploaded') imported++;
    p.tick();
  }
  p.done();
  return { found: files.length, imported, alreadyThere: files.length - imported };
}
