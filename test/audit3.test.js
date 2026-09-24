// Second follow-up audit: storage admission must cover every operation that grows persistent storage,
// and the disk reserve must hold for small streams. One test per write path, plus mixed concurrent operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Limits, SYSTEM, ENTRY_COST } from '../lib/limits.js';
import { setup, ics, vcf, chunked, GB } from './storage-helpers.js';

// Headroom includes one filesystem-entry charge (ENTRY_COST) per file a test means to allow.
test('storage: CalDAV and CardDAV writes are held to the quota', async () => {
  const s = await setup({ headroom: 1210 + ENTRY_COST });
  try {
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/big.ics', ics('big', 2000))).status, 507);
    assert.equal((await s.dav('PUT', '/dav/addressbooks/q/contacts/big.vcf', vcf('big', 2000))).status, 507);
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/ok.ics', ics('ok', 100))).status, 201);
    assert.ok((await s.userBytes()) <= s.userBase + 1210 + ENTRY_COST);
  } finally {
    await s.close();
  }
});

test('storage: the auditor probe (a ~2 KB contact import with 1,210 bytes left) is refused, nothing written', async () => {
  const s = await setup({ headroom: 1210 });
  try {
    const r = await s.api('POST', '/import?type=contacts', vcf('imp', 2000));
    assert.equal(r.status, 507);
    assert.deepEqual((await fs.readdir(path.join(s.dir, 'users/q/addressbooks/contacts'))).filter((n) => !n.startsWith('.')), []);
    assert.equal((await s.api('POST', '/import?type=calendar&name=Big', ics('e1', 2000))).status, 507);
    assert.equal((await s.api('POST', '/contacts', JSON.stringify({ name: 'Pat', note: 'n'.repeat(2000) }), { 'Content-Type': 'application/json' })).status, 507);
    assert.equal((await s.api('POST', '/events', JSON.stringify({ title: 'x', start: '2026-09-24T10:00:00Z', description: 'd'.repeat(2000) }), { 'Content-Type': 'application/json' })).status, 507);
  } finally {
    await s.close();
  }
});

test('storage: the auditor probe (WebDAV COPY past the quota) is refused, recursive copies too', async () => {
  const s = await setup({ headroom: 1500 + ENTRY_COST });
  try {
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/a.bin', new Uint8Array(1000))).status, 201);
    const copy = await s.dav('COPY', '/dav/files/q/Documents/a.bin', null, { Destination: `${s.base}/dav/files/q/Documents/b.bin` });
    assert.equal(copy.status, 507);
    assert.equal(await fs.stat(path.join(s.dir, 'users/q/files/Documents/b.bin')).catch(() => null), null);
    const tree = await s.dav('COPY', '/dav/files/q/Documents/', null, { Destination: `${s.base}/dav/files/q/Documents2/` });
    assert.equal(tree.status, 507);
    assert.equal(await fs.stat(path.join(s.dir, 'users/q/files/Documents2')).catch(() => null), null);
    assert.ok((await s.userBytes()) <= s.userBase + 1500 + ENTRY_COST);
  } finally {
    await s.close();
  }
});

test('storage: Family has its own budget, and moving out of it bills the destination', async () => {
  const s = await setup({ headroom: 500, familyHeadroom: 1500 + ENTRY_COST });
  try {
    // A full personal quota doesn't block the shared space, and vice versa.
    assert.equal((await s.api('PUT', '/files/raw?path=Family/f.bin', new Uint8Array(1000))).status, 200);
    assert.equal((await s.api('PUT', '/files/raw?path=Family/g.bin', new Uint8Array(1000))).status, 507);
    // Moving the Family file into a personal folder would exceed the personal quota.
    assert.equal((await s.api('POST', '/files/move', JSON.stringify({ from: 'Family/f.bin', to: 'Documents/f.bin' }), { 'Content-Type': 'application/json' })).status, 507);
    const mv = await s.dav('MOVE', '/dav/files/q/Family/f.bin', null, { Destination: `${s.base}/dav/files/q/Documents/f.bin` });
    assert.equal(mv.status, 507);
    assert.ok(await fs.stat(path.join(s.dir, 'family/files/f.bin')));
  } finally {
    await s.close();
  }
});

test('storage: mixed concurrent writes (Drive upload, WebDAV COPY, import) cannot jointly exceed the quota', async () => {
  // Room for the seed plus exactly one more ~1 KB write; any two of the racing writes together don't fit.
  const room = 1000 + ENTRY_COST + 1600 + ENTRY_COST;
  const s = await setup({ headroom: room });
  try {
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/seed.bin', new Uint8Array(1000))).status, 201);
    const results = await Promise.all([
      s.api('PUT', '/files/raw?path=Documents/up.bin', chunked(1000)),
      s.dav('COPY', '/dav/files/q/Documents/seed.bin', null, { Destination: `${s.base}/dav/files/q/Documents/copy.bin` }),
      s.api('POST', '/import?type=contacts', vcf('race', 900)),
      s.dav('PUT', '/dav/calendars/q/personal/race.ics', ics('race', 900)),
    ]);
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((x) => x === 507).length, 3, `statuses ${statuses}`);
    assert.ok((await s.userBytes()) <= s.userBase + room, `used ${await s.userBytes()} of ${s.userBase + room}`);
  } finally {
    await s.close();
  }
});

test('storage: the disk reserve holds for a small chunked stream (auditor probe: 2 MiB with 1 MiB above the floor)', async () => {
  // Exact arithmetic against a disk whose free space never moves: 1 MiB above the reserve.
  const disk = { bavail: (2 * GB + 1024 * 1024) / 4096, bsize: 4096 };
  const limits = new Limits(new Store(os.tmpdir()), { MYCLOUD_DISK_RESERVE_GB: '2' }, { statfs: async () => disk });
  const r = await limits.reserve('q', NaN); // chunked: nothing declared
  let written = 0;
  assert.throws(() => {
    for (let i = 0; i < 32; i++) {
      limits.consume(r, 64 * 1024);
      written += 64 * 1024;
    }
  }, /out of space/);
  assert.ok(written <= 1024 * 1024, `wrote ${written} bytes past the floor check`);
  limits.release(r, false);
  // A second stream right after is refused up front only if nothing is left; space came back when the first aborted.
  const r2 = await limits.reserve('q', 512 * 1024);
  limits.release(r2, false);
});

test('storage: the disk reserve holds end to end, whatever the protocol', async () => {
  const s = await setup({ reserveBelowFree: 8 * 1024 * 1024 });
  try {
    // The server may answer 507 mid-stream and close the connection; either way nothing may be stored.
    const r = await s.api('PUT', '/files/raw?path=Documents/big.bin', chunked(32 * 1024 * 1024, 128)).catch(() => null);
    if (r) assert.equal(r.status, 507);
    assert.deepEqual(await fs.readdir(path.join(s.dir, 'users/q/files/Documents')), []);
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/small.ics', ics('small'))).status, 201);
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/five.bin', new Uint8Array(5 * 1024 * 1024))).status, 201);
    assert.equal((await s.dav('COPY', '/dav/files/q/Documents/five.bin', null, { Destination: `${s.base}/dav/files/q/Documents/five2.bin` })).status, 507);
  } finally {
    await s.close();
  }
});

test('storage: the thumbnail cache (system budget) respects the disk reserve', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-sys-'));
  try {
    const st = await fs.statfs(dir);
    const limits = new Limits(new Store(dir), { MYCLOUD_DISK_RESERVE_GB: String((st.bavail * st.bsize - 1024 * 1024) / GB) });
    let wrote = false;
    await assert.rejects(limits.withBytes(SYSTEM, 2 * 1024 * 1024, 0, async () => { wrote = true; }), /out of space/);
    assert.equal(wrote, false);
    await limits.withBytes(SYSTEM, 64 * 1024, 0, async () => { wrote = true; });
    assert.equal(wrote, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('storage: collection properties cannot grow without bound', async () => {
  const s = await setup();
  try {
    const big = 'x'.repeat(40 * 1024);
    const patch = (name) => s.dav('PROPPATCH', '/dav/calendars/q/personal/', `<d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:z"><d:set><d:prop><z:${name}>${big}</z:${name}></d:prop></d:set></d:propertyupdate>`);
    assert.equal((await patch('a')).status, 207);
    assert.equal((await patch('b')).status, 413);
  } finally {
    await s.close();
  }
});
