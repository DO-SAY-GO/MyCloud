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
export async function setup({ headroom = Infinity, familyHeadroom = Infinity, reserveBelowFree, env: extraEnv = {} } = {}) {
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

export const ics = (uid, pad = 0) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260924T100000Z\r\nSUMMARY:x\r\nDESCRIPTION:${'x'.repeat(pad)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
export const vcf = (uid, pad = 0) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Pat\r\nNOTE:${'n'.repeat(pad)}\r\nEND:VCARD\r\n`;
export const chunked = (bytes, pieces = 4) => new ReadableStream({
  start(ctl) {
    for (let i = 0; i < pieces; i++) ctl.enqueue(new Uint8Array(bytes / pieces));
    ctl.close();
  },
});

