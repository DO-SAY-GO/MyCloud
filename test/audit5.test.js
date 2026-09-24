// Fourth follow-up review (at 18f7836): server bookkeeping (sync logs, trash records) must not let quota accounting
// drift, and must still be reserved against the disk and inode floors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { Limits, SYSTEM, accounted } from '../lib/limits.js';
import { setup, ics, vcf, GB } from './storage-helpers.js';

const fresh = (s) => accounted(s.store.userRoot('q'), s.store.cacheRoot('q'));

test('bookkeeping: 250 same-size contact overwrites stay within the quota (auditor probe)', async () => {
  const s = await setup({ headroom: 8192 });
  try {
    const card = vcf('same', 200);
    for (let i = 0; i < 250; i++) {
      const r = await s.dav('PUT', '/dav/addressbooks/q/contacts/same.vcf', card);
      assert.ok(r.status === 201 || r.status === 204, `overwrite ${i}: ${r.status}`);
    }
    const quota = s.userBase + 8192;
    assert.ok((await fresh(s)).bytes <= quota, `accounted ${(await fresh(s)).bytes} of ${quota}`);
    // The sync log grew (it's bookkeeping), but it is capped and outside the quota.
    const sync = await fs.stat(path.join(s.dir, 'users/q/addressbooks/contacts/.sync.json'));
    assert.ok(sync.size > 5000);
  } finally {
    await s.close();
  }
});

test('bookkeeping: cached usage equals a fresh recount after every kind of write and removal', async () => {
  const s = await setup({ headroom: 10 * 1024 * 1024 });
  const check = async (label) => {
    const cached = s.limits.usage.get('q');
    const real = await fresh(s);
    assert.deepEqual({ bytes: cached.bytes, entries: cached.entries }, real, `after ${label}`);
  };
  try {
    await s.dav('PUT', '/dav/files/q/Documents/a.bin', new Uint8Array(3000)); // primes the cache
    await check('upload');
    await s.dav('PUT', '/dav/files/q/Documents/a.bin', new Uint8Array(5000));
    await check('overwrite');
    await s.dav('PUT', '/dav/calendars/q/personal/e.ics', ics('e', 300));
    await s.dav('PUT', '/dav/calendars/q/personal/e.ics', ics('e', 900));
    await check('calendar writes');
    await s.dav('DELETE', '/dav/calendars/q/personal/e.ics');
    await check('calendar delete');
    await s.api('POST', '/import?type=contacts', vcf('i1', 50) + vcf('i2', 60));
    await check('import');
    await s.dav('COPY', '/dav/files/q/Documents/a.bin', null, { Destination: `${s.base}/dav/files/q/Documents/b.bin` });
    await s.dav('COPY', '/dav/files/q/Documents/a.bin', null, { Destination: `${s.base}/dav/files/q/Documents/b.bin` }); // over: old b to trash
    await check('copies');
    await s.dav('MKCALENDAR', '/dav/calendars/q/work/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>');
    await s.dav('PUT', '/dav/calendars/q/work/w.ics', ics('w', 100));
    await check('new calendar');
    await s.dav('DELETE', '/dav/calendars/q/work/');
    await check('calendar collection delete');
    await s.api('DELETE', '/files?path=Documents/b.bin');
    await check('delete to trash');
    const { items } = await (await s.api('GET', '/trash')).json();
    for (const it of items) await s.api('DELETE', `/trash?id=${it.id}&shared=0`);
    await check('empty trash');
    await s.api('PUT', '/files/raw?path=Family/f.bin', new Uint8Array(2000));
    await s.api('POST', '/files/move', JSON.stringify({ from: 'Family/f.bin', to: 'Documents/f.bin' }), { 'Content-Type': 'application/json' });
    await check('move out of Family');
    await s.dav('MOVE', '/dav/files/q/Documents/f.bin', null, { Destination: `${s.base}/dav/files/q/Family/f.bin` });
    await check('move into Family');
    const fam = s.limits.usage.get('#family');
    assert.deepEqual({ bytes: fam.bytes, entries: fam.entries }, await accounted(s.store.familyRoot()), 'family budget');
  } finally {
    await s.close();
  }
});

test('bookkeeping: sync-log, property and trash writes are reserved against the disk floor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-book-'));
  try {
    const disk = { bavail: (2 * GB + 16 * 1024) / 4096, bsize: 4096, ffree: 1e9 }; // 16 KB above the floor
    const store = new Store(dir);
    await store.ensureUser('q');
    const limits = new Limits(store, { MYCLOUD_DISK_RESERVE_GB: '2' }, { statfs: async () => disk });
    store.gate = (bytes, replacing, entries, fn) => limits.withBytes(SYSTEM, bytes, replacing, fn, { entries });
    const coll = store.collectionDir('q', 'addressbooks', 'contacts');
    // A property rewrite larger than the headroom is refused before anything is written.
    await assert.rejects(store.patchProps(coll, { '{urn:z}big': 'x'.repeat(40 * 1024) }), /out of space/);
    // Sync-log growth: fill the log until its rewrite no longer fits, then it must be refused, not written.
    let refused = null;
    for (let i = 0; i < 400 && !refused; i++) {
      await store.writeItem(coll, `n${'x'.repeat(40)}${i}.vcf`, 'BEGIN:VCARD\r\nEND:VCARD\r\n').catch((e) => { refused = e; });
    }
    assert.match(String(refused), /out of space/);
    // Trash records reserve their folder and meta.json too.
    const f = path.join(store.filesRoot('q'), 'Documents', 't.txt');
    await fs.writeFile(f, 'x');
    disk.bavail = (2 * GB) / 4096; // no headroom at all
    limits.measured.at = 0;
    await assert.rejects(store.trash('q', f, 'Documents/t.txt'), /out of space/);
    assert.ok(await fs.stat(f)); // nothing moved
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bookkeeping: concurrent metadata-heavy operations keep accounting exact and leak no reservations', async () => {
  const s = await setup({ headroom: 10 * 1024 * 1024 });
  try {
    await s.dav('PUT', '/dav/files/q/Documents/seed.bin', new Uint8Array(100)); // prime the cache
    await s.dav('MKCALENDAR', '/dav/calendars/q/second/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"/>');
    const ops = [];
    for (let i = 0; i < 40; i++) {
      ops.push(s.dav('PUT', `/dav/calendars/q/personal/p${i}.ics`, ics(`p${i}`, 50 + i)));
      ops.push(s.dav('PUT', `/dav/calendars/q/second/s${i}.ics`, ics(`s${i}`, 80)));
      ops.push(s.dav('PUT', `/dav/addressbooks/q/contacts/c${i % 5}.vcf`, vcf(`c${i % 5}`, 100 + i))); // overwrites race
      ops.push(s.dav('PUT', `/dav/files/q/Documents/f${i}.txt`, `file ${i}`).then(() => s.dav('DELETE', `/dav/files/q/Documents/f${i}.txt`)));
      ops.push(s.dav('PROPPATCH', '/dav/calendars/q/second/', `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>Second ${i}</d:displayname></d:prop></d:set></d:propertyupdate>`));
    }
    const statuses = (await Promise.all(ops)).map((r) => r.status);
    assert.ok(statuses.every((x) => x < 300), `unexpected ${[...new Set(statuses)]}`);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.dav('DELETE', `/dav/calendars/q/personal/p${i}.ics`)));
    const cached = s.limits.usage.get('q');
    assert.deepEqual({ bytes: cached.bytes, entries: cached.entries }, await fresh(s));
    assert.equal(s.limits.active.size, 0); // every reservation released, bookkeeping included
    // Every sync log still parses: concurrent writers never interleaved a rewrite.
    for (const c of ['calendars/personal', 'calendars/second', 'addressbooks/contacts']) {
      JSON.parse(await fs.readFile(path.join(s.dir, 'users/q', c, '.sync.json'), 'utf8'));
    }
  } finally {
    await s.close();
  }
});
