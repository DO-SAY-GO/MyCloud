// Second follow-up audit: storage admission must cover every operation that grows persistent storage,
// and the disk reserve must hold for small streams. One test per write path, plus mixed concurrent operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../lib/server.js';
import { Auth } from '../lib/auth.js';
import { Store } from '../lib/store.js';
import { Limits, SYSTEM } from '../lib/limits.js';

const quiet = { error() {} };
const GB = 1024 ** 3;

async function bytesUnder(dir, skip) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (p === skip) continue;
    if (e.isDirectory()) n += await bytesUnder(p, skip);
    else if (e.isFile()) n += (await fs.stat(p)).size;
  }
  return n;
}

// A server where user "q" (the admin) has `headroom` bytes of quota left, and Family `familyHeadroom`.
async function setup({ headroom = Infinity, familyHeadroom = Infinity, reserveBelowFree } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-audit3-'));
  const a = new Auth(dir);
  await a.load();
  await a.setPassword('q', 'q-password-12', { create: true });
  const app = (await a.createAppPassword('q', 't')).password;
  const store = new Store(dir);
  await store.ensureUser('q');
  const userBase = await bytesUnder(store.userRoot('q'), store.cacheRoot('q'));
  const familyBase = await bytesUnder(store.familyRoot());
  const env = { MYCLOUD_THUMBNAILS: 'off' };
  if (headroom !== Infinity) env.MYCLOUD_QUOTA_GB = String((userBase + headroom) / GB);
  if (familyHeadroom !== Infinity) env.MYCLOUD_FAMILY_QUOTA_GB = String((familyBase + familyHeadroom) / GB);
  if (reserveBelowFree !== undefined) {
    const s = await fs.statfs(dir);
    env.MYCLOUD_DISK_RESERVE_GB = String((s.bavail * s.bsize - reserveBelowFree) / GB);
  }
  const { server } = await createServer({ dataDir: dir, log: quiet, env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'q', password: 'q-password-12' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const auth = 'Basic ' + Buffer.from(`q:${app}`).toString('base64');
  return {
    dir, store, base,
    api: (method, p, body, headers = {}) => fetch(`${base}/api${p}`, { method, headers: { 'X-MyCloud': '1', cookie, ...headers }, body, duplex: 'half' }),
    dav: (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { Authorization: auth, ...headers }, body, duplex: 'half' }),
    userBytes: () => bytesUnder(store.userRoot('q'), store.cacheRoot('q')),
    userBase,
    close: async () => { server.close(); await fs.rm(dir, { recursive: true, force: true }); },
  };
}

const ics = (uid, pad = 0) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260924T100000Z\r\nSUMMARY:x\r\nDESCRIPTION:${'x'.repeat(pad)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const vcf = (uid, pad = 0) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Pat\r\nNOTE:${'n'.repeat(pad)}\r\nEND:VCARD\r\n`;
const chunked = (bytes, pieces = 4) => new ReadableStream({
  start(ctl) {
    for (let i = 0; i < pieces; i++) ctl.enqueue(new Uint8Array(bytes / pieces));
    ctl.close();
  },
});

test('storage: CalDAV and CardDAV writes are held to the quota', async () => {
  const s = await setup({ headroom: 1210 });
  try {
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/big.ics', ics('big', 2000))).status, 507);
    assert.equal((await s.dav('PUT', '/dav/addressbooks/q/contacts/big.vcf', vcf('big', 2000))).status, 507);
    assert.equal((await s.dav('PUT', '/dav/calendars/q/personal/ok.ics', ics('ok', 100))).status, 201);
    assert.ok((await s.userBytes()) <= s.userBase + 1210);
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
  const s = await setup({ headroom: 1500 });
  try {
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/a.bin', new Uint8Array(1000))).status, 201);
    const copy = await s.dav('COPY', '/dav/files/q/Documents/a.bin', null, { Destination: `${s.base}/dav/files/q/Documents/b.bin` });
    assert.equal(copy.status, 507);
    assert.equal(await fs.stat(path.join(s.dir, 'users/q/files/Documents/b.bin')).catch(() => null), null);
    const tree = await s.dav('COPY', '/dav/files/q/Documents/', null, { Destination: `${s.base}/dav/files/q/Documents2/` });
    assert.equal(tree.status, 507);
    assert.equal(await fs.stat(path.join(s.dir, 'users/q/files/Documents2')).catch(() => null), null);
    assert.ok((await s.userBytes()) <= s.userBase + 1500);
  } finally {
    await s.close();
  }
});

test('storage: Family has its own budget, and moving out of it bills the destination', async () => {
  const s = await setup({ headroom: 500, familyHeadroom: 1500 });
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
  const s = await setup({ headroom: 2600 });
  try {
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/seed.bin', new Uint8Array(1000))).status, 201); // 1600 left
    const results = await Promise.all([
      s.api('PUT', '/files/raw?path=Documents/up.bin', chunked(1000)),
      s.dav('COPY', '/dav/files/q/Documents/seed.bin', null, { Destination: `${s.base}/dav/files/q/Documents/copy.bin` }),
      s.api('POST', '/import?type=contacts', vcf('race', 900)),
      s.dav('PUT', '/dav/calendars/q/personal/race.ics', ics('race', 900)),
    ]);
    const statuses = results.map((r) => r.status);
    assert.ok(statuses.filter((x) => x === 507).length >= 2, `statuses ${statuses}`);
    assert.ok((await s.userBytes()) <= s.userBase + 2600, `used ${await s.userBytes()} of ${s.userBase + 2600}`);
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
