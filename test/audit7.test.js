// Fifth remediation review (at 5c6a084): concurrent COPY/MOVE must serialize on the destination, and calendar /
// contact transactions must be failure-atomic through their final renames, including across a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { accounted } from '../lib/limits.js';
import { setup, ics, vcf } from './storage-helpers.js';

const fresh = (s) => accounted(s.store.userRoot('q'), s.store.cacheRoot('q'));
const exact = async (s) => {
  const c = s.limits.usage.get('q');
  assert.deepEqual({ bytes: c.bytes, entries: c.entries }, await fresh(s));
  assert.equal(s.limits.active.size, 0);
};

// ---- 1. Concurrent COPY / MOVE ------------------------------------------------------------------------------------
test('concurrency: 240 COPYs across 12 destinations serialize (auditor probe)', async () => {
  const s = await setup({ headroom: 50 * 1024 * 1024 });
  try {
    for (let k = 0; k < 20; k++) await s.dav('PUT', `/dav/files/q/Documents/src${k}.bin`, new Uint8Array(1000 + k));
    const res = await Promise.all(Array.from({ length: 240 }, (_, i) => s.dav('COPY', `/dav/files/q/Documents/src${i % 20}.bin`, null,
      { Destination: `${s.base}/dav/files/q/Documents/dst${i % 12}.bin` })));
    const statuses = res.map((r) => r.status);
    assert.ok(statuses.every((x) => x === 201 || x === 204), `unexpected ${[...new Set(statuses)]}`);
    assert.equal(statuses.filter((x) => x === 201).length, 12); // exactly one creator per destination
    // Every overwrite (204) kept its predecessor in Recently Deleted, and nothing else went there.
    const { items } = await (await s.api('GET', '/trash')).json();
    assert.equal(items.length, statuses.filter((x) => x === 204).length);
    await exact(s);
    assert.deepEqual((await fs.readdir(path.join(s.dir, 'users/q/files/Documents'))).filter((n) => n.startsWith('.mycloud')), []);
  } finally {
    await s.close();
  }
});

test('concurrency: Overwrite: F races to one missing destination give one 201 and 412s (auditor probe)', async () => {
  const s = await setup({ headroom: 50 * 1024 * 1024 });
  try {
    for (let k = 0; k < 20; k++) await s.dav('PUT', `/dav/files/q/Documents/v${k}.txt`, `version ${k}`);
    const res = await Promise.all(Array.from({ length: 20 }, (_, k) => s.dav('COPY', `/dav/files/q/Documents/v${k}.txt`, null,
      { Destination: `${s.base}/dav/files/q/Documents/only.txt`, Overwrite: 'F' })));
    const statuses = res.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, ...Array(19).fill(412)]);
    const winner = res.findIndex((r) => r.status === 201);
    assert.equal(await fs.readFile(path.join(s.dir, 'users/q/files/Documents/only.txt'), 'utf8'), `version ${winner}`);
    await exact(s);
  } finally {
    await s.close();
  }
});

test('concurrency: calendar objects too (Overwrite: F, sync logs intact)', async () => {
  const s = await setup({ headroom: 50 * 1024 * 1024 });
  try {
    for (let k = 0; k < 10; k++) await s.dav('PUT', `/dav/calendars/q/personal/e${k}.ics`, ics(`e${k}`));
    const res = await Promise.all(Array.from({ length: 10 }, (_, k) => s.dav('COPY', `/dav/calendars/q/personal/e${k}.ics`, null,
      { Destination: `${s.base}/dav/calendars/q/personal/one.ics`, Overwrite: 'F' })));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, ...Array(9).fill(412)]);
    const log = JSON.parse(await fs.readFile(path.join(s.dir, 'users/q/calendars/personal/.sync.json'), 'utf8'));
    assert.equal(log.log.filter((e) => e.name === 'one.ics').length, 1);
    await exact(s);
  } finally {
    await s.close();
  }
});

test('concurrency: opposite MOVEs cannot deadlock', async () => {
  const s = await setup({ headroom: 50 * 1024 * 1024 });
  try {
    await s.dav('PUT', '/dav/files/q/Documents/a.txt', 'a');
    await s.dav('PUT', '/dav/files/q/Documents/b.txt', 'b');
    const race = Promise.all(Array.from({ length: 20 }, (_, i) => s.dav('MOVE', `/dav/files/q/Documents/${i % 2 ? 'a' : 'b'}.txt`, null,
      { Destination: `${s.base}/dav/files/q/Documents/${i % 2 ? 'b' : 'a'}.txt` })));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 10_000));
    const res = await Promise.race([race, timeout]);
    assert.ok(res.every((r) => [201, 204, 404].includes(r.status)), `${[...new Set(res.map((r) => r.status))]}`);
    await exact(s);
  } finally {
    await s.close();
  }
});

// ---- 2. Failure atomicity through the final renames, and crash recovery ---------------------------------------------
async function snapshot(dirs) {
  const out = {};
  for (const d of dirs) {
    for (const name of (await fs.readdir(d).catch(() => [])).sort()) out[`${path.basename(d)}/${name}`] = await fs.readFile(path.join(d, name), 'utf8');
  }
  return out;
}

async function world() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-journal-'));
  const store = new Store(dir);
  await store.ensureUser('q');
  await store.createCollection('q', 'calendars', 'work', {});
  const personal = store.collectionDir('q', 'calendars', 'personal');
  const work = store.collectionDir('q', 'calendars', 'work');
  await store.writeItem(personal, 'keep.ics', ics('keep'));
  await store.writeItem(personal, 'mv.ics', ics('mv'));
  return { dir, store, personal, work, close: () => fs.rm(dir, { recursive: true, force: true }) };
}

const SCENARIOS = {
  'single write': (w) => w.store.writeItem(w.personal, 'keep.ics', ics('keep', 500)),
  'multi-item import': (w) => w.store.writeItems(w.personal, [['n1.ics', ics('n1')], ['n2.ics', ics('n2')], ['keep.ics', ics('keep', 99)]]),
  delete: (w) => w.store.deleteItem(w.personal, 'keep.ics'),
  'move between calendars': (w) => w.store.transferItem({ move: true, from: path.join(w.personal, 'mv.ics'), fromDir: w.personal, toDir: w.work, toName: 'mv.ics', overwrite: true }),
};

for (const [name, run] of Object.entries(SCENARIOS)) {
  test(`journal: ${name} is all-or-nothing at every rename boundary, in-process and after a crash`, async () => {
    // Learn the boundaries and the committed result from a clean run.
    const probe = await world();
    const labels = [];
    probe.store.journal.fault = async (l) => { labels.push(l); };
    await run(probe);
    const after = await snapshot([probe.personal, probe.work]);
    await probe.close();
    assert.ok(labels.length >= 3, `boundaries ${labels}`);

    for (const label of labels) {
      for (const crash of [false, true]) {
        const w = await world();
        try {
          const before = await snapshot([w.personal, w.work]);
          w.store.journal.fault = async (l) => { if (l === label) throw Object.assign(new Error(`injected at ${l}`), { crash }); };
          await assert.rejects(run(w), /injected/);
          if (crash) {
            // A fresh process finds the journal and settles it.
            const restarted = new Store(w.dir);
            assert.equal(await restarted.journal.recover(), 1);
          }
          const expected = crash && label === 'committed' ? after : before;
          assert.deepEqual(await snapshot([w.personal, w.work]), expected, `${label} ${crash ? 'crash' : 'error'}`);
          assert.deepEqual(await fs.readdir(path.join(w.dir, 'journal')).catch(() => []), []);
        } finally {
          await w.close();
        }
      }
    }
  });
}
