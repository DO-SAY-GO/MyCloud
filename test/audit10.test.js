// Eighth remediation review (at 2056678): MOVE must not choose shared locking from a stale source type, and staged
// overwrites must reserve their peak temporary filesystem entry even though they add no persistent quota entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { accounted } from '../lib/limits.js';
import { setup } from './storage-helpers.js';

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exactBoth = async (s) => {
  for (const [budget, root, skip] of [['q', s.store.userRoot('q'), s.store.cacheRoot('q')], ['#family', s.store.familyRoot()]]) {
    const cached = s.limits.usage.get(budget);
    assert.deepEqual({ bytes: cached.bytes, entries: cached.entries }, await accounted(root, skip), `budget ${budget}`);
  }
  assert.equal(s.limits.active.size, 0);
};

test('folder move: a file replaced by a folder before locking still excludes child writes (auditor probe)', async () => {
  const s = await setup({ headroom: 50 * MiB, familyHeadroom: 50 * MiB });
  try {
    await s.api('PUT', '/files/raw?path=Family/swap', new Uint8Array(10));
    await s.api('PUT', '/files/raw?path=Family/replacement/a.bin', new Uint8Array(1000));
    await s.api('PUT', '/files/raw?path=Documents/prime.bin', new Uint8Array(1));

    let swapped = false;
    s.drive_.hooks.beforeMoveLock = async (src) => {
      if (swapped || !src.endsWith('/swap')) return;
      swapped = true;
      const copy = await s.dav('COPY', '/dav/files/q/Family/replacement/', null,
        { Destination: `${s.base}/dav/files/q/Family/swap/` });
      assert.equal(copy.status, 204);
    };
    // If MOVE used a shared lock selected from the old file type, this upload would complete after measurement and
    // ride into the destination unbilled. With an exclusive MOVE it waits, then finds that its parent has moved.
    let lateUpload;
    s.drive_.hooks.afterMeasure = async (src) => {
      if (!src.endsWith('/swap')) return;
      lateUpload = s.api('PUT', '/files/raw?path=Family/swap/late.bin', new Uint8Array(2 * MiB));
      s.drive_.hooks.afterMeasure = null;
      await sleep(100); // shared locking lets the upload commit here; exclusive locking holds it until after MOVE
    };

    const move = await s.dav('MOVE', '/dav/files/q/Family/swap', null,
      { Destination: `${s.base}/dav/files/q/Documents/swap` });
    assert.equal(move.status, 201);
    const response = await lateUpload;
    assert.ok(response.status === 404 || response.status === 409, `late upload ${response.status}`);
    assert.equal(await fs.stat(path.join(s.store.filesRoot('q'), 'Documents/swap/late.bin')).catch(() => null), null);
    await exactBoth(s);
  } finally {
    await s.close();
  }
});

test('overwrite staging reserves its temporary inode at the filesystem floor (auditor probe)', async () => {
  const s = await setup({ headroom: 10 * MiB });
  try {
    assert.equal((await s.api('PUT', '/files/raw?path=Documents/x.bin', new Uint8Array(10))).status, 200);
    // Exactly the configured reserve remains: replacing x adds no quota entry, but staging its replacement needs a
    // temporary inode and must therefore be refused before the temporary file is created.
    s.limits.statfs = async () => ({ bavail: 1e9, bsize: 4096, ffree: s.limits.inodeReserve });
    s.limits.measured.at = 0;
    const response = await s.api('PUT', '/files/raw?path=Documents/x.bin', new Uint8Array(1024));
    assert.equal(response.status, 507);
    assert.equal((await fs.stat(path.join(s.store.filesRoot('q'), 'Documents/x.bin'))).size, 10);
    assert.deepEqual(await fs.readdir(path.join(s.store.userRoot('q'), '.staging')), []);
    assert.equal(s.limits.active.size, 0);
  } finally {
    await s.close();
  }
});

test('bookkeeping rewrites reserve their temporary inode at the filesystem floor', async () => {
  const s = await setup({ headroom: 10 * MiB });
  try {
    const props = path.join(s.store.collectionDir('q', 'calendars', 'personal'), '.props.json');
    const before = await fs.readFile(props, 'utf8');
    s.limits.statfs = async () => ({ bavail: 1e9, bsize: 4096, ffree: s.limits.inodeReserve });
    s.limits.measured.at = 0;
    const body = '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Changed</d:displayname></d:prop></d:set></d:propertyupdate>';
    const response = await s.dav('PROPPATCH', '/dav/calendars/q/personal/', body);
    assert.equal(response.status, 507);
    assert.equal(await fs.readFile(props, 'utf8'), before);
    assert.equal(s.limits.active.size, 0);
  } finally {
    await s.close();
  }
});
