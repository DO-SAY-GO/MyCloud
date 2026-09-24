// Sixth remediation review (at d52b3e6): a copy or move is charged for what it really copies or moves, and the journal
// never loses its recovery record, even when a rollback fails or a power cut loses renames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { accounted, ENTRY_COST, Limits, meteredCopy } from '../lib/limits.js';
import { setup, ics } from './storage-helpers.js';

const MiB = 1024 * 1024;
const exactFor = async (s, budget, root, skip) => {
  const c = s.limits.usage.get(budget);
  assert.deepEqual({ bytes: c.bytes, entries: c.entries }, await accounted(root, skip), `budget ${budget}`);
};
const exact = async (s) => {
  await exactFor(s, 'q', s.store.userRoot('q'), s.store.cacheRoot('q'));
  assert.equal(s.limits.active.size, 0);
};

// ---- 1. Charged for what is really copied or moved ------------------------------------------------------------------
test('sizing: a Drive COPY whose source grows after sizing is charged in full (auditor probe)', async () => {
  const s = await setup({ headroom: 10 * MiB });
  try {
    await s.dav('PUT', '/dav/files/q/Documents/src.bin', new Uint8Array(50));
    // Grows (through MyCloud, so it is charged) between the COPY's sizing and its copying.
    s.dav_.hooks.beforeStage = () => s.dav('PUT', '/dav/files/q/Documents/src.bin', new Uint8Array(MiB + 50));
    assert.equal((await s.dav('COPY', '/dav/files/q/Documents/src.bin', null, { Destination: `${s.base}/dav/files/q/Documents/dst.bin` })).status, 201);
    assert.equal((await fs.stat(path.join(s.dir, 'users/q/files/Documents/dst.bin'))).size, MiB + 50);
    await exact(s);
  } finally {
    await s.close();
  }
});

test('sizing: the grown copy is refused when it no longer fits, and leaves nothing behind', async () => {
  const s = await setup({ headroom: 50 + ENTRY_COST + 700 * 1024 }); // room for the grown source, not for its copy too
  try {
    await s.dav('PUT', '/dav/files/q/Documents/src.bin', new Uint8Array(50));
    s.dav_.hooks.beforeStage = () => s.dav('PUT', '/dav/files/q/Documents/src.bin', new Uint8Array(512 * 1024));
    const r = await s.dav('COPY', '/dav/files/q/Documents/src.bin', null, { Destination: `${s.base}/dav/files/q/Documents/dst.bin` });
    assert.equal(r.status, 507);
    assert.deepEqual((await fs.readdir(path.join(s.dir, 'users/q/files/Documents'))).sort(), ['src.bin']); // no copy, no staging
    await exact(s);
  } finally {
    await s.close();
  }
});

test('sizing: a calendar COPY is measured under the source lock', async () => {
  const s = await setup({ headroom: 10 * MiB });
  try {
    await s.dav('PUT', '/dav/calendars/q/personal/src.ics', ics('src'));
    s.dav_.store.hooks.beforeTransferLock = () => s.dav('PUT', '/dav/calendars/q/personal/src.ics', ics('src', 64 * 1024));
    assert.equal((await s.dav('COPY', '/dav/calendars/q/personal/src.ics', null, { Destination: `${s.base}/dav/calendars/q/personal/dst.ics` })).status, 201);
    await exact(s);
  } finally {
    await s.close();
  }
});

test('sizing: cross-budget moves (Drive and calendar) bill and credit what really moved', async () => {
  const s = await setup({ headroom: 10 * MiB, familyHeadroom: 10 * MiB });
  try {
    await s.api('PUT', '/files/raw?path=Family/f.bin', new Uint8Array(10));
    await s.dav('PUT', '/dav/files/q/Documents/prime.bin', new Uint8Array(10));
    s.dav_.hooks.beforeMoveLock = () => s.api('PUT', '/files/raw?path=Family/f.bin', new Uint8Array(MiB));
    assert.equal((await s.dav('MOVE', '/dav/files/q/Family/f.bin', null, { Destination: `${s.base}/dav/files/q/Documents/f.bin` })).status, 201);
    await exact(s);
    await exactFor(s, '#family', s.store.familyRoot());
    await s.dav('PUT', '/dav/calendars/q/personal/m.ics', ics('m'));
    s.dav_.store.hooks.beforeTransferLock = () => s.dav('PUT', '/dav/calendars/q/personal/m.ics', ics('m', 32 * 1024));
    assert.equal((await s.dav('MOVE', '/dav/calendars/q/personal/m.ics', null, { Destination: `${s.base}/dav/calendars/q/family/m.ics` })).status, 201);
    await exact(s);
    await exactFor(s, '#family', s.store.familyRoot());
  } finally {
    await s.close();
  }
});

// ---- 2. The journal never loses its recovery record -----------------------------------------------------------------
async function world() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-j2-'));
  const store = new Store(dir);
  await store.ensureUser('q');
  await store.createCollection('q', 'calendars', 'work', {});
  const personal = store.collectionDir('q', 'calendars', 'personal');
  const work = store.collectionDir('q', 'calendars', 'work');
  await store.writeItem(personal, 'mv.ics', ics('mv'));
  await store.writeItem(work, 'mv.ics', ics('old destination'));
  const snap = async () => {
    const out = {};
    for (const d of [personal, work]) for (const n of (await fs.readdir(d)).sort()) out[`${path.basename(d)}/${n}`] = await fs.readFile(path.join(d, n), 'utf8');
    return out;
  };
  const move = () => store.transferItem({ move: true, from: path.join(personal, 'mv.ics'), fromDir: personal, toDir: work, toName: 'mv.ics', overwrite: true });
  return { dir, store, snap, move, journals: () => fs.readdir(path.join(dir, 'journal')).catch(() => []), close: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test('journal: a rollback that fails keeps the journal, and startup recovery finishes it (auditor probe)', async () => {
  const w = await world();
  try {
    const before = await w.snap();
    // The move is applied, then the transaction fails, then its reverse renames fail too.
    w.store.journal.fault = async (label) => {
      if (label === 'synced') throw new Error('injected failure after the move applied');
      if (label.startsWith('undo:')) throw new Error('injected rollback failure');
    };
    const err = await w.move().catch((e) => e);
    assert.match(err.message, /injected failure/);
    assert.ok(err.rollbackIncomplete?.length > 0);
    assert.equal((await w.journals()).length, 1, 'the recovery record must survive');
    // Next start: recovery completes the rollback.
    const restarted = new Store(w.dir);
    assert.equal(await restarted.journal.recover(), 1);
    assert.deepEqual(restarted.journal.stuck, []);
    assert.deepEqual(await w.snap(), before);
    assert.deepEqual(await w.journals(), []);
  } finally {
    await w.close();
  }
});

test('journal: recovery that still cannot finish keeps the record for the next start', async () => {
  const w = await world();
  try {
    w.store.journal.fault = async (label) => { if (label === 'applied:0') throw Object.assign(new Error('crash'), { crash: true }); };
    await w.move().catch(() => {});
    const blocked = new Store(w.dir);
    blocked.journal.fault = async (label) => { if (label.startsWith('undo:')) throw new Error('disk still unhappy'); };
    assert.equal(await blocked.journal.recover(), 0);
    assert.equal(blocked.journal.stuck.length, 1);
    assert.equal((await w.journals()).length, 1);
    assert.equal(await new Store(w.dir).journal.recover(), 1); // a later start succeeds
    assert.deepEqual(await w.journals(), []);
  } finally {
    await w.close();
  }
});

test('journal: a committed record whose renames were lost (power cut) is rolled forward, not trusted blindly', async () => {
  const w = await world();
  try {
    // Learn the committed result.
    const ref = await world();
    await ref.move();
    const after = await ref.snap();
    await ref.close();
    // Crash right after the commit record, then undo the renames on disk as a power cut would.
    w.store.journal.fault = async (label) => { if (label === 'committed') throw Object.assign(new Error('crash'), { crash: true }); };
    await w.move().catch(() => {});
    const [name] = await w.journals();
    const j = JSON.parse(await fs.readFile(path.join(w.dir, 'journal', name), 'utf8'));
    assert.equal(j.state, 'committed');
    for (const op of [...j.ops].reverse()) {
      if (op.kind === 'move') await fs.rename(op.target, op.from);
      if (op.kind === 'put') await fs.rename(op.target, op.tmp);
      if (op.backup) await fs.rename(op.backup, op.target);
    }
    assert.equal(await new Store(w.dir).journal.recover(), 1);
    assert.deepEqual(await w.snap(), after);
    assert.deepEqual((await fs.readdir(path.dirname(j.ops[0].target))).filter((n) => n.startsWith('.mycloud')), []);
  } finally {
    await w.close();
  }
});

test('journal: durability order — renames are synced before the commit record is written', async () => {
  const w = await world();
  try {
    const labels = [];
    w.store.journal.fault = async (l) => { labels.push(l); };
    await w.move();
    // prepared → applied… → synced → committed → (record) removing
    assert.equal(labels[0], 'prepared');
    const lastApplied = labels.findLastIndex((l) => l.startsWith('applied:'));
    assert.equal(labels.indexOf('synced'), lastApplied + 1);
    assert.equal(labels.indexOf('committed'), lastApplied + 2);
    assert.equal(labels.at(-1), 'removing');
  } finally {
    await w.close();
  }
});

// ---- Follow-up: entries are claimed before they are created; journal deletions are durable -----------------------
test('entries: a copy claims each entry before creating it and stops at the inode floor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-inodes-'));
  try {
    const src = path.join(dir, 'src');
    await fs.mkdir(src);
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(src, `f${i}`), 'x');
    const disk = { bavail: 1e9, bsize: 4096, ffree: 10 + 5 }; // 5 entries above a 10-inode floor
    const limits = new Limits(new Store(dir), { MYCLOUD_INODE_RESERVE: '10', MYCLOUD_DISK_RESERVE_GB: '0' }, { statfs: async () => disk });
    const r = await limits.reserve('#system', 0, 0, 1); // sized as a single entry before the source grew
    const dst = path.join(dir, 'dst');
    await assert.rejects(meteredCopy(src, dst, (n) => limits.consume(r, n), () => limits.claimEntry(r)), /out of space/);
    const created = 1 + (await fs.readdir(dst).catch(() => [])).length;
    assert.ok(created <= 5, `created ${created} entries with 5 to spare`);
    limits.release(r, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('entries: through DAV, a folder that grows after sizing cannot be copied past the inode floor', async () => {
  const s = await setup({ diskAboveFloor: 50 * MiB, inodesAboveFloor: 20 });
  try {
    await s.dav('MKCOL', '/dav/files/q/Documents/box/');
    await s.dav('PUT', '/dav/files/q/Documents/box/a.txt', 'a');
    s.dav_.hooks.beforeStage = async (srcDir) => { for (let i = 0; i < 60; i++) await fs.writeFile(path.join(srcDir, `g${i}`), 'g'); };
    const r = await s.dav('COPY', '/dav/files/q/Documents/box/', null, { Destination: `${s.base}/dav/files/q/Documents/box2/` });
    assert.equal(r.status, 507);
    assert.deepEqual((await fs.readdir(path.join(s.dir, 'users/q/files/Documents'))).sort(), ['box']); // no copy, no staging
  } finally {
    await s.close();
  }
});

test('journal: a rolled-back transaction whose record deletion is lost cannot undo the restore (auditor probe)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-resurrect-'));
  try {
    const store = new Store(dir);
    await store.ensureUser('q');
    const coll = store.collectionDir('q', 'calendars', 'personal');
    await store.writeItem(coll, 'keep.ics', ics('original'));
    const before = await fs.readFile(path.join(coll, 'keep.ics'), 'utf8');
    // Fail after the overwrite applied; rollback restores the original. Capture the record a crash would resurrect
    // (what is on disk just before its deletion).
    let resurrect = null;
    store.journal.fault = async (label, file) => {
      if (label === 'synced') throw new Error('injected failure after apply');
      if (label === 'removing') resurrect = { file, data: await fs.readFile(file, 'utf8') };
    };
    await assert.rejects(store.writeItem(coll, 'keep.ics', ics('replacement', 300)), /injected/);
    assert.equal(await fs.readFile(path.join(coll, 'keep.ics'), 'utf8'), before);
    // Power cut: the deletion of the record never reached the disk.
    await fs.writeFile(resurrect.file, resurrect.data);
    assert.equal(await new Store(dir).journal.recover(), 1);
    assert.equal(await fs.readFile(path.join(coll, 'keep.ics'), 'utf8'), before, 'the restored original must survive recovery');
    assert.deepEqual(await fs.readdir(path.join(dir, 'journal')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
