// Shared setup for the storage-admission tests: a server where user "q" has a known amount of room left.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../lib/server.js';
import { Auth } from '../lib/auth.js';
import { Store } from '../lib/store.js';
import { accounted } from '../lib/limits.js';

const quiet = { error() {} };
export const GB = 1024 ** 3;

// Count exactly as the server does (content plus a block per entry), so quotas in tests mean what they say.
export async function bytesUnder(dir, skip) {
  return (await accounted(dir, skip)).bytes;
}

// A server where user "q" (the admin) has `headroom` bytes of quota left, and Family `familyHeadroom`.
// A virtual disk for reserve tests: free space starts `aboveFloor` bytes above a 1 GB reserve and shrinks by exactly
// what is written into the data folder, so the tests are deterministic however busy the real disk is.
async function du(dir) {
  let bytes = 0;
  let entries = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    entries++;
    if (e.isDirectory()) {
      const sub = await du(p);
      bytes += sub.bytes;
      entries += sub.entries;
    } else if (e.isFile()) bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return { bytes, entries };
}

export async function setup({ headroom = Infinity, familyHeadroom = Infinity, diskAboveFloor, inodesAboveFloor = 1e9, env: extraEnv = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-audit3-'));
  const a = new Auth(dir);
  await a.load();
  await a.setPassword('q', 'q-password-12', { create: true });
  const app = (await a.createAppPassword('q', 't')).password;
  const store = new Store(dir);
  await store.ensureUser('q');
  const userBase = await bytesUnder(store.userRoot('q'), store.cacheRoot('q'));
  const familyBase = await bytesUnder(store.familyRoot());
  const env = { MYCLOUD_THUMBNAILS: 'off', ...extraEnv };
  if (headroom !== Infinity) env.MYCLOUD_QUOTA_GB = String((userBase + headroom) / GB);
  if (familyHeadroom !== Infinity) env.MYCLOUD_FAMILY_QUOTA_GB = String((familyBase + familyHeadroom) / GB);
  let statfs;
  if (diskAboveFloor !== undefined) {
    env.MYCLOUD_DISK_RESERVE_GB = '1';
    env.MYCLOUD_INODE_RESERVE = '100';
    const start = await du(dir);
    statfs = async () => {
      const now = await du(dir);
      return { bavail: Math.floor((GB + diskAboveFloor - (now.bytes - start.bytes)) / 4096), bsize: 4096, ffree: 100 + inodesAboveFloor - (now.entries - start.entries) };
    };
  }
  const { server, limits, dav, drive, activity } = await createServer({ dataDir: dir, log: quiet, env, statfs });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'q', password: 'q-password-12' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const auth = 'Basic ' + Buffer.from(`q:${app}`).toString('base64');
  return {
    dir, store, base, limits, dav_: dav, drive_: drive,
    api: (method, p, body, headers = {}) => fetch(`${base}/api${p}`, { method, headers: { 'X-MyCloud': '1', cookie, ...headers }, body, duplex: 'half' }),
    dav: (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, headers: { Authorization: auth, ...headers }, body, duplex: 'half' }),
    userBytes: () => bytesUnder(store.userRoot('q'), store.cacheRoot('q')),
    userBase,
    // Wait for the server to stop and its activity log to flush before removing the folder.
    close: async () => {
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await activity.chain;
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export const ics = (uid, pad = 0) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260924T100000Z\r\nSUMMARY:x\r\nDESCRIPTION:${'x'.repeat(pad)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
export const vcf = (uid, pad = 0) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Pat\r\nNOTE:${'n'.repeat(pad)}\r\nEND:VCARD\r\n`;
export const chunked = (bytes, pieces = 4) => new ReadableStream({
  start(ctl) {
    for (let i = 0; i < pieces; i++) ctl.enqueue(new Uint8Array(bytes / pieces));
    ctl.close();
  },
});

