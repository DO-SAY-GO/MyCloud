// Seventh remediation review (at eb0f2ad): the rollback intention must be durable before rolling back, and a folder
// move must not race writes beneath it (web app and WebDAV share one locking path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { accounted } from '../lib/limits.js';
import { setup, ics } from './storage-helpers.js';

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Journal: durable rollback intention ------------------------------------------------------------------------
async function overwriteWorld() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-rb-'));
  const store = new Store(dir);
  await store.ensureUser('q');
  const coll = store.collectionDir('q', 'calendars', 'personal');
  await store.writeItem(coll, 'keep.ics', ics('ORIGINAL'));
  const read = () => fs.readFile(path.join(coll, 'keep.ics'), 'utf8').catch(() => null);
  return { dir, store, coll, read, before: await read(), close: () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

for (const crashAt of ['rolled-back', 'undo:0', 'undo:1', 'rolling-back']) {
  test(`journal: a crash at "${crashAt}" during a rollback recovers with the original intact (auditor probe)`, async () => {
    const w = await overwriteWorld();
    try {
      w.store.journal.fault = async (label) => {
        if (label === 'synced') throw new Error('injected failure after the overwrite applied'); // → rollback
        if (label === crashAt) throw Object.assign(new Error('power cut'), { crash: true });
      };
      await assert.rejects(w.store.writeItem(w.coll, 'keep.ics', ics('REPLACEMENT', 200)));
      const restarted = new Store(w.dir);
      assert.equal(await restarted.journal.recover(), 1);
      assert.deepEqual(restarted.journal.stuck, []);
      assert.equal(await w.read(), w.before, 'the original survives');
      assert.deepEqual(await fs.readdir(path.join(w.dir, 'journal')), []);
      // And recovering twice changes nothing (the rollback is safe to repeat).
      assert.equal(await new Store(w.dir).journal.recover(), 0);
      assert.equal(await w.read(), w.before);
    } finally {
      await w.close();
    }
  });
}

// ---- 2. A folder move and writes beneath it --------------------------------------------------------------------------
const exactBoth = async (s) => {
  for (const [budget, root, skip] of [['q', s.store.userRoot('q'), s.store.cacheRoot('q')], ['#family', s.store.familyRoot()]]) {
    const c = s.limits.usage.get(budget);
    assert.deepEqual({ bytes: c.bytes, entries: c.entries }, await accounted(root, skip), `budget ${budget}`);
  }
  assert.equal(s.limits.active.size, 0);
};

for (const via of ['web app', 'WebDAV']) {
  test(`folder move (${via}): an upload racing into the moving folder can't slip in unbilled (auditor probe)`, async () => {
    const s = await setup({ headroom: 50 * MiB, familyHeadroom: 50 * MiB });
    try {
      await s.api('PUT', '/files/raw?path=Family/album/a.bin', new Uint8Array(1000));
      await s.api('PUT', '/files/raw?path=Documents/prime.bin', new Uint8Array(10));
      // The upload streams, then waits at its commit; the move measures, then lets the upload try to commit inside
      // the window between measuring and renaming.
      let atCommit;
      const reachedCommit = new Promise((r) => { atCommit = r; });
      let release;
      const gate = new Promise((r) => { release = r; });
      s.drive_.hooks.beforeCommit = async (target) => {
        if (target.endsWith('late.bin')) { atCommit(); await gate; }
      };
      s.drive_.hooks.afterMeasure = async () => { release(); await sleep(150); };
      const upload = s.api('PUT', '/files/raw?path=Family/album/late.bin', new Uint8Array(2 * MiB));
      await reachedCommit;
      const move = via === 'web app'
        ? s.api('POST', '/files/move', JSON.stringify({ from: 'Family/album', to: 'Documents/album' }), { 'Content-Type': 'application/json' })
        : s.dav('MOVE', '/dav/files/q/Family/album/', null, { Destination: `${s.base}/dav/files/q/Documents/album/` });
      const [u, m] = await Promise.all([upload, move]);
      assert.ok(m.status === 200 || m.status === 201, `move ${m.status}`);
      // The upload lost the race: its folder had moved by the time it could commit.
      assert.ok(u.status === 409 || u.status === 404, `upload ${u.status}`);
      assert.equal(await fs.stat(path.join(s.dir, 'users/q/files/Documents/album/late.bin')).catch(() => null), null);
      await exactBoth(s);
    } finally {
      await s.close();
    }
  });
}

test('folder move: an upload that commits first is moved and billed with the folder', async () => {
  const s = await setup({ headroom: 50 * MiB, familyHeadroom: 50 * MiB });
  try {
    await s.api('PUT', '/files/raw?path=Family/album/a.bin', new Uint8Array(1000));
    await s.api('PUT', '/files/raw?path=Documents/prime.bin', new Uint8Array(10));
    s.drive_.hooks.beforeMoveLock = () => s.api('PUT', '/files/raw?path=Family/album/early.bin', new Uint8Array(2 * MiB));
    const m = await s.dav('MOVE', '/dav/files/q/Family/album/', null, { Destination: `${s.base}/dav/files/q/Documents/album/` });
    assert.equal(m.status, 201);
    assert.equal((await fs.stat(path.join(s.dir, 'users/q/files/Documents/album/early.bin'))).size, 2 * MiB);
    await exactBoth(s);
  } finally {
    await s.close();
  }
});

test('staging: in-flight uploads never sit inside user folders', async () => {
  const s = await setup({ headroom: 50 * MiB });
  try {
    let seen = null;
    s.drive_.hooks.beforeCommit = async () => {
      seen = {
        documents: await fs.readdir(path.join(s.dir, 'users/q/files/Documents')),
        staging: await fs.readdir(path.join(s.dir, 'users/q/.staging')),
      };
    };
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/x.bin', new Uint8Array(4096))).status, 201);
    assert.deepEqual(seen.documents, []);
    assert.equal(seen.staging.length, 1);
    assert.deepEqual(await fs.readdir(path.join(s.dir, 'users/q/.staging')), []);
  } finally {
    await s.close();
  }
});
