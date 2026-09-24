// Third follow-up review (at 7d572d0): overwrites and the disk reserve, metadata writes, and destructive
// rejected overwrites. Each reviewer probe is reproduced here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Limits, accounted, ENTRY_COST } from '../lib/limits.js';
import { setup, ics, GB } from './storage-helpers.js';

const MiB = 1024 * 1024;
const docs = (s) => fs.readdir(path.join(s.dir, 'users/q/files/Documents'));

// ---- 1. Overwrites must reserve their peak disk use ----------------------------------------------------------------
test('reserve: replacing a file needs room for the whole new copy (probe: 2 MiB replacement, 1 MiB free)', async () => {
  const disk = { bavail: (2 * GB + MiB) / 4096, bsize: 4096 };
  const limits = new Limits(new Store(os.tmpdir()), { MYCLOUD_DISK_RESERVE_GB: '2' }, { statfs: async () => disk });
  // Declared: refused up front even though the net growth is zero.
  await assert.rejects(limits.reserve('q', 2 * MiB, 2 * MiB), /out of space/);
  // Streamed: refused once the staged bytes cross the floor, whatever it replaces.
  const r = await limits.reserve('q', NaN, 2 * MiB);
  let staged = 0;
  assert.throws(() => {
    for (let i = 0; i < 32; i++) {
      limits.consume(r, 64 * 1024);
      staged += 64 * 1024;
    }
  }, /out of space/);
  assert.ok(staged <= MiB, `staged ${staged} bytes past the floor`);
  limits.release(r, false);
});

test('reserve: an overwrite that would cross the floor fails end to end and keeps the original', async () => {
  const s = await setup({ reserveBelowFree: 24 * MiB });
  try {
    const original = Buffer.alloc(12 * MiB, 7);
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/big.bin', original)).status, 201);
    // Net growth is zero, but the 20 MiB replacement can't be staged beside the original within ~12 MiB.
    const r = await s.dav('PUT', '/dav/files/q/Documents/big.bin', new Uint8Array(20 * MiB)).catch(() => null);
    if (r) assert.equal(r.status, 507);
    const kept = await fs.readFile(path.join(s.dir, 'users/q/files/Documents/big.bin'));
    assert.equal(kept.length, original.length);
    assert.equal(kept[0], 7);
    assert.deepEqual((await docs(s)).filter((n) => n.startsWith('.mycloud')), []);
  } finally {
    await s.close();
  }
});

// ---- 2. Metadata writes go through the gate ------------------------------------------------------------------------
test('metadata: collections count toward the quota; their properties are capped bookkeeping', async () => {
  const s = await setup({ headroom: 1024 });
  try {
    // A new calendar is a user entry (a 4 KB block): no room for it.
    const mk = await s.dav('MKCALENDAR', '/dav/calendars/q/extra/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>');
    assert.equal(mk.status, 507);
    // Properties of an existing collection are server bookkeeping: not the user's quota, but capped at 64 KB
    // (and reserved against the disk floor, see audit5).
    const body = (n) => `<d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:z"><d:set><d:prop><z:${n}>${'x'.repeat(40 * 1024)}</z:${n}></d:prop></d:set></d:propertyupdate>`;
    assert.equal((await s.dav('PROPPATCH', '/dav/calendars/q/personal/', body('a'))).status, 207);
    assert.equal((await s.dav('PROPPATCH', '/dav/calendars/q/personal/', body('b'))).status, 413);
  } finally {
    await s.close();
  }
});

test('metadata: LOCK cannot create files past the limits (probe: 100 LOCKs at zero headroom)', async () => {
  const s = await setup({ headroom: 0 });
  try {
    const statuses = [];
    for (let i = 0; i < 100; i++) statuses.push((await s.dav('LOCK', `/dav/files/q/Documents/lock-${i}.txt`, '<d:lockinfo xmlns:d="DAV:"/>')).status);
    assert.ok(statuses.every((x) => x === 507), `statuses ${[...new Set(statuses)]}`);
    assert.deepEqual(await docs(s), []);
  } finally {
    await s.close();
  }
});

test('metadata: a per-account file count limit stops empty files and folders', async () => {
  // Limit = what the account already has + 5, counted the way the server counts.
  const probe = await setup();
  const baseline = (await accounted(path.join(probe.dir, 'users/q'), path.join(probe.dir, 'users/q/cache'))).entries;
  await probe.close();
  const t = await setup({ env: { MYCLOUD_MAX_FILES: String(baseline + 5) } });
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.dav('PUT', `/dav/files/q/Documents/e${i}.txt`, '')).status);
    statuses.push((await t.dav('MKCOL', '/dav/files/q/Documents/folder/')).status);
    statuses.push((await t.dav('PUT', '/dav/files/q/Documents/one-too-many.txt', '')).status);
    statuses.push((await t.dav('LOCK', '/dav/files/q/Documents/lock.txt', '<d:lockinfo xmlns:d="DAV:"/>')).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 507, 507]);
    // Overwriting an existing file adds no entry, so it still works.
    assert.equal((await t.dav('PUT', '/dav/files/q/Documents/e0.txt', 'x')).status, 204);
  } finally {
    await t.close();
  }
});

// ---- 3. A rejected overwrite must not destroy the destination --------------------------------------------------------
test('overwrite: a refused CalDAV COPY leaves the destination untouched (probe: a.ics over b.ics at quota)', async () => {
  const s = await setup({ headroom: 3000 + 2 * ENTRY_COST });
  try {
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/a.ics', ics('a', 1500))).status, 201);
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/b.ics', ics('b', 10))).status, 201);
    // Replacing b with a copy of a needs ~1.5 KB more than is left.
    const r = await s.dav('COPY', '/dav/calendars/q/personal/a.ics', null, { Destination: `${s.base}/dav/calendars/q/personal/b.ics`, Overwrite: 'T' });
    assert.equal(r.status, 507);
    const b = await s.dav('GET', '/dav/calendars/q/personal/b.ics');
    assert.equal(b.status, 200);
    assert.match(await b.text(), /UID:b/);
  } finally {
    await s.close();
  }
});

test('overwrite: a refused Drive COPY or MOVE leaves both sides untouched; a successful one keeps the old copy in trash', async () => {
  const s = await setup({ headroom: 2500 + 2 * ENTRY_COST, familyHeadroom: Infinity });
  try {
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/src.bin', new Uint8Array(1500))).status, 201);
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/dst.bin', Buffer.from('keep me'))).status, 201);
    const refused = await s.dav('COPY', '/dav/files/q/Documents/src.bin', null, { Destination: `${s.base}/dav/files/q/Documents/dst.bin` });
    assert.equal(refused.status, 507);
    assert.equal(await fs.readFile(path.join(s.dir, 'users/q/files/Documents/dst.bin'), 'utf8'), 'keep me');
    // A cross-budget MOVE that's refused leaves the source where it was and the destination intact.
    assert.equal((await s.api('PUT', '/files/raw?path=Family/fam.bin', new Uint8Array(1500))).status, 200);
    const mv = await s.dav('MOVE', '/dav/files/q/Family/fam.bin', null, { Destination: `${s.base}/dav/files/q/Documents/dst.bin` });
    assert.equal(mv.status, 507);
    assert.ok(await fs.stat(path.join(s.dir, 'family/files/fam.bin')));
    assert.equal(await fs.readFile(path.join(s.dir, 'users/q/files/Documents/dst.bin'), 'utf8'), 'keep me');
    // A same-budget MOVE over the destination succeeds, and the old destination is recoverable.
    assert.equal((await s.dav('MOVE', '/dav/files/q/Documents/src.bin', null, { Destination: `${s.base}/dav/files/q/Documents/dst.bin` })).status, 204);
    const trash = await (await s.api('GET', '/trash')).json();
    assert.ok(trash.items.some((i) => i.rel === 'Documents/dst.bin'));
    assert.deepEqual((await docs(s)).filter((n) => n.startsWith('.mycloud')), []);
  } finally {
    await s.close();
  }
});
