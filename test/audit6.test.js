// Fourth remediation review (at 9a58add): bookkeeping must be excluded by location, never by name, and a
// calendar/contact change must commit its content and its sync log together or not at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Limits, SYSTEM, ENTRY_COST, accounted } from '../lib/limits.js';
import { setup, vcf, ics, GB } from './storage-helpers.js';

const MiB = 1024 * 1024;
const fresh = (s) => accounted(s.store.userRoot('q'), s.store.cacheRoot('q'));

// ---- 1. Exclusion by location ----------------------------------------------------------------------------------------
test('bookkeeping names in Drive are ordinary content (probe: 1 MiB Documents/.sync.json)', async () => {
  const s = await setup({ headroom: 3 * MiB });
  try {
    const before = await fresh(s);
    assert.equal((await s.dav('PUT', '/dav/files/q/Documents/.sync.json', new Uint8Array(MiB))).status, 201);
    assert.equal((await s.api('PUT', '/files/raw?path=Documents/calendars/x/.props.json', new Uint8Array(1000))).status, 200);
    const after = await fresh(s);
    assert.equal(after.bytes - before.bytes, MiB + 1000 + 4 * ENTRY_COST); // 2 files + calendars/ and x/ folders
    assert.equal(after.entries - before.entries, 4);
    // Still counted after the cache is thrown away (a restart or the 10-minute recount): the quota holds.
    s.limits.usage.clear();
    const r = await s.dav('PUT', '/dav/files/q/Documents/more.bin', new Uint8Array(2 * MiB));
    assert.equal(r.status, 507);
    // Same rule for the Family space.
    const famBefore = await accounted(s.store.familyRoot());
    await s.api('PUT', '/files/raw?path=Family/.sync.json', new Uint8Array(5000));
    assert.equal((await accounted(s.store.familyRoot())).bytes - famBefore.bytes, 5000 + ENTRY_COST);
  } finally {
    await s.close();
  }
});

// ---- 2. Content and sync log commit together -----------------------------------------------------------------------
// A store + limits pair on a fixed disk: enough room for the content, never enough for the content *and* its log.
async function tight(headroomAboveFloor) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-tx-'));
  const disk = { bavail: (2 * GB + 1024 * 1024) / 4096, bsize: 4096, ffree: 1e9 };
  const store = new Store(dir);
  await store.ensureUser('q');
  const limits = new Limits(store, { MYCLOUD_DISK_RESERVE_GB: '2' }, { statfs: async () => disk });
  store.gate = (bytes, replacing, entries, fn) => limits.withBytes(SYSTEM, bytes, replacing, fn, { entries });
  store.freed = (p, stats) => { limits.ownerOf(p).then((b) => b && limits.freed(b, stats)); };
  await limits.used('q');
  const setFree = (aboveFloor) => { disk.bavail = (2 * GB + aboveFloor) / 4096; limits.measured.at = 0; };
  setFree(headroomAboveFloor);
  const coll = store.collectionDir('q', 'addressbooks', 'contacts');
  const syncText = () => fs.readFile(path.join(coll, '.sync.json'), 'utf8');
  const exact = async () => {
    assert.equal(limits.active.size, 0, 'no reservation left behind');
    const cached = limits.usage.get('q');
    assert.deepEqual({ bytes: cached.bytes, entries: cached.entries }, await accounted(store.userRoot('q'), store.cacheRoot('q')));
  };
  // What DAV does: reserve the content for the user, then write through the store.
  const put = (name, data, replacing = 0, entries = 1) => limits.withBytes('q', Buffer.byteLength(data), replacing,
    (res) => store.writeItem(coll, name, data, { settle: (x) => limits.settle(res, x) }), { entries });
  return { dir, store, limits, coll, syncText, exact, put, setFree, close: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('transaction: a create whose sync-log reservation fails leaves nothing behind', async () => {
  const t = await tight(1024 * 1024);
  try {
    const card = vcf('new', 200);
    t.setFree(Buffer.byteLength(card) + ENTRY_COST + 64); // content fits; content + log does not
    const log = await t.syncText();
    await assert.rejects(t.put('new.vcf', card), /out of space/);
    assert.equal(await fs.stat(path.join(t.coll, 'new.vcf')).catch(() => null), null);
    assert.equal(await t.syncText(), log);
    assert.deepEqual((await fs.readdir(t.coll)).filter((n) => n.startsWith('.mycloud')), []);
    await t.exact();
  } finally {
    await t.close();
  }
});

test('transaction: an overwrite whose sync-log reservation fails keeps the old version', async () => {
  const t = await tight(1024 * 1024);
  try {
    await t.put('c.vcf', vcf('c', 10));
    const log = await t.syncText();
    const replacement = vcf('c', 2000);
    t.setFree(Buffer.byteLength(replacement) + 64); // the replacement is admitted as content, but not with its log
    await assert.rejects(t.put('c.vcf', replacement, 0, 0), /out of space/);
    assert.match(await fs.readFile(path.join(t.coll, 'c.vcf'), 'utf8'), /NOTE:n{10}\r/);
    assert.equal(await t.syncText(), log);
    await t.exact();
  } finally {
    await t.close();
  }
});

test('transaction: a delete whose sync-log reservation fails keeps the object', async () => {
  const t = await tight(1024 * 1024);
  try {
    await t.put('d.vcf', vcf('d', 10));
    const log = await t.syncText();
    t.setFree(0);
    await assert.rejects(t.store.deleteItem(t.coll, 'd.vcf'), /out of space/);
    assert.ok(await fs.stat(path.join(t.coll, 'd.vcf')));
    assert.equal(await t.syncText(), log);
    await t.exact();
  } finally {
    await t.close();
  }
});

test('transaction: a multi-item import is all or nothing', async () => {
  const t = await tight(1024 * 1024);
  try {
    const items = [['i1.vcf', vcf('i1', 100)], ['i2.vcf', vcf('i2', 100)], ['i3.vcf', vcf('i3', 100)]];
    const bytes = items.reduce((n, [, d]) => n + Buffer.byteLength(d), 0);
    t.setFree(bytes + 3 * ENTRY_COST + 64);
    const log = await t.syncText();
    await assert.rejects(t.limits.withBytes('q', bytes, 0, (res) => t.store.writeItems(t.coll, items, { settle: (x) => t.limits.settle(res, x) }), { entries: 3 }), /out of space/);
    for (const [name] of items) assert.equal(await fs.stat(path.join(t.coll, name)).catch(() => null), null);
    assert.equal(await t.syncText(), log);
    await t.exact();
  } finally {
    await t.close();
  }
});

test('transaction: moving an object between calendars commits both logs and the move together, or nothing', async () => {
  const s = await setup();
  try {
    await s.dav('MKCALENDAR', '/dav/calendars/q/work/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>');
    await s.dav('PUT', '/dav/calendars/q/personal/m.ics', ics('m'));
    const mv = await s.dav('MOVE', '/dav/calendars/q/personal/m.ics', null, { Destination: `${s.base}/dav/calendars/q/work/m.ics` });
    assert.equal(mv.status, 201);
    const log = async (c) => JSON.parse(await fs.readFile(path.join(s.dir, 'users/q/calendars', c, '.sync.json'), 'utf8')).log;
    assert.deepEqual((await log('personal')).at(-1), { seq: (await log('personal')).at(-1).seq, name: 'm.ics', deleted: true });
    assert.equal((await log('work')).at(-1).name, 'm.ics');
    assert.ok(await fs.stat(path.join(s.dir, 'users/q/calendars/work/m.ics')));
  } finally {
    await s.close();
  }
});

// ---- the race behind the reservation guesses -----------------------------------------------------------------------
test('concurrent creates of the same new name keep accounting exact (contacts and Drive)', async () => {
  const s = await setup({ headroom: 10 * MiB });
  try {
    await s.dav('PUT', '/dav/files/q/Documents/prime.bin', new Uint8Array(10));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.dav('PUT', '/dav/addressbooks/q/contacts/same.vcf', vcf('same', 100 + i))));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.dav('PUT', '/dav/files/q/Documents/same.bin', new Uint8Array(1000 + i))));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.api('PUT', '/files/raw?path=Documents/same2.bin', new Uint8Array(2000 + i))));
    const cached = s.limits.usage.get('q');
    assert.deepEqual({ bytes: cached.bytes, entries: cached.entries }, await fresh(s));
    assert.equal(s.limits.active.size, 0);
  } finally {
    await s.close();
  }
});
