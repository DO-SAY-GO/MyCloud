// Regression tests for the follow-up audit: each confirmed bypass gets a test that reproduces it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../lib/server.js';
import { Auth } from '../lib/auth.js';
import { Thumbnailer, thumbnailService } from '../lib/thumbs.js';
import { connectWithAccountPassword } from '../lib/import/client.js';
import { accounted, ENTRY_COST } from '../lib/limits.js';

const run = promisify(execFile);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const quiet = { error() {} };
let dataDir, server, base, aliceApp, bobApp;

async function login(u, p, b = base) {
  const r = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  assert.equal(r.status, 200, `login ${u}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const api = (cookie, method, p, body, headers = {}) => fetch(base + '/api' + p, {
  method, headers: { 'X-MyCloud': '1', cookie, ...(body !== undefined && typeof body !== 'string' && { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-audit2-'));
  const a = new Auth(dataDir);
  await a.load();
  await a.setPassword('alice', 'alice-password-1', { create: true }); // admin
  await a.setPassword('bob', 'bob-password-1', { create: true });
  aliceApp = (await a.createAppPassword('alice', 't')).password;
  bobApp = (await a.createAppPassword('bob', 't')).password;
  ({ server } = await createServer({ dataDir, log: quiet, env: { MYCLOUD_THUMBNAILS: 'off' } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

// ---- 1. Family publishing ------------------------------------------------------------------------------------------
test('family: a member cannot COPY the Family link to an alias', async () => {
  const r = await fetch(`${base}/dav/files/bob/Family/`, { method: 'COPY', headers: { Authorization: basic('bob', bobApp), Destination: `${base}/dav/files/bob/Alias/` } });
  assert.equal(r.status, 403);
  assert.equal(await fs.lstat(path.join(dataDir, 'users/bob/files/Alias')).catch(() => null), null);
});

test('family: copying a folder never carries links along', async () => {
  await fs.mkdir(path.join(dataDir, 'users/bob/files/Box'));
  await fs.writeFile(path.join(dataDir, 'users/bob/files/Box/a.txt'), 'a');
  await fs.symlink(path.join(dataDir, 'family/files'), path.join(dataDir, 'users/bob/files/Box/sneaky'));
  const r = await fetch(`${base}/dav/files/bob/Box/`, { method: 'COPY', headers: { Authorization: basic('bob', bobApp), Destination: `${base}/dav/files/bob/Box2/` } });
  assert.equal(r.status, 201);
  assert.deepEqual((await fs.readdir(path.join(dataDir, 'users/bob/files/Box2'))).sort(), ['a.txt']);
});

test('family: shares are authorized by where content really lives, at creation and on every access', async () => {
  const bob = await login('bob', 'bob-password-1');
  await fs.writeFile(path.join(dataDir, 'family/files/secret.txt'), 'family only');
  // However the alias came to exist, sharing through it is refused for a non-admin…
  await fs.symlink(path.join(dataDir, 'family/files'), path.join(dataDir, 'users/bob/files/Alias2'));
  assert.equal((await api(bob, 'POST', '/shares', { path: 'Alias2' })).status, 403);
  assert.equal((await api(bob, 'POST', '/shares', { path: 'Alias2/secret.txt' })).status, 403);
  // …and a link made to a private folder stops working if that folder is later swapped for an alias.
  await fs.mkdir(path.join(dataDir, 'users/bob/files/Mine'));
  await fs.writeFile(path.join(dataDir, 'users/bob/files/Mine/ok.txt'), 'mine');
  const { url } = await (await api(bob, 'POST', '/shares', { path: 'Mine' })).json();
  assert.equal((await fetch(`${base}${url}/ok.txt`)).status, 200);
  await fs.rm(path.join(dataDir, 'users/bob/files/Mine'), { recursive: true });
  await fs.symlink(path.join(dataDir, 'family/files'), path.join(dataDir, 'users/bob/files/Mine'));
  assert.equal((await fetch(`${base}${url}/secret.txt`)).status, 404);
  // The admin may still publish Family content.
  const alice = await login('alice', 'alice-password-1');
  assert.equal((await api(alice, 'POST', '/shares', { path: 'Family/secret.txt' })).status, 200);
});

// ---- 2. Quotas -----------------------------------------------------------------------------------------------------
const userBytes = async (dir) => (await accounted(dir, path.join(dir, 'cache'))).bytes;

async function quotaServer(extraBytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-quota-'));
  const a = new Auth(dir);
  await a.load();
  await a.setPassword('q', 'q-password-12', { create: true });
  const { store } = await createServer({ dataDir: dir, log: quiet, env: { MYCLOUD_THUMBNAILS: 'off' } }).then((x) => (x.server.close(), x));
  await store.ensureUser('q');
  const baseline = await userBytes(path.join(dir, 'users/q'));
  const { server: s } = await createServer({ dataDir: dir, log: quiet, env: { MYCLOUD_THUMBNAILS: 'off', MYCLOUD_QUOTA_GB: String((baseline + extraBytes) / 1024 ** 3) } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const cookie = await login('q', 'q-password-12', b);
  const put = (p, body, headers = {}) => fetch(`${b}/api/files/raw?path=${p}`, { method: 'PUT', headers: { 'X-MyCloud': '1', cookie, ...headers }, body, duplex: 'half' });
  return { dir, s, put, close: async () => { s.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

const chunked = (bytes, pieces = 2, delay = 0) => new ReadableStream({
  async start(ctl) {
    for (let i = 0; i < pieces; i++) {
      ctl.enqueue(new Uint8Array(bytes / pieces));
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    ctl.close();
  },
});

// Headroom includes one filesystem-entry charge (ENTRY_COST) per file a test means to allow.
test('quota: a chunked upload over quota is stopped and leaves nothing behind', async () => {
  const q = await quotaServer(1210 + ENTRY_COST);
  try {
    const r = await q.put('Documents/big.bin', chunked(2048));
    assert.equal(r.status, 507);
    const docs = await fs.readdir(path.join(q.dir, 'users/q/files/Documents'));
    assert.deepEqual(docs, []);
    assert.equal((await q.put('Documents/small.bin', chunked(1000))).status, 200); // under quota still works
  } finally {
    await q.close();
  }
});

test('quota: concurrent uploads cannot jointly exceed it (declared and chunked)', async () => {
  const q = await quotaServer(1210 + ENTRY_COST);
  try {
    const declared = await Promise.all([1, 2].map((i) => q.put(`Documents/d${i}.bin`, new Uint8Array(800), { 'Content-Length': '800' })));
    assert.deepEqual(declared.map((r) => r.status).sort(), [200, 507]);
    await fs.rm(path.join(q.dir, 'users/q/files/Documents'), { recursive: true });
    await fs.mkdir(path.join(q.dir, 'users/q/files/Documents'));
    // Chunked: both stream at once, 800 bytes each in slow pieces; together they'd pass 1210.
    const streamed = await Promise.all([1, 2].map((i) => q.put(`Documents/c${i}.bin`, chunked(800, 4, 30))));
    assert.ok(streamed.some((r) => r.status === 507), `statuses ${streamed.map((r) => r.status)}`);
  } finally {
    await q.close();
  }
});

test('quota: overwriting a file only counts the difference', async () => {
  const q = await quotaServer(1210 + ENTRY_COST);
  try {
    assert.equal((await q.put('Documents/f.bin', new Uint8Array(1000))).status, 200);
    assert.equal((await q.put('Documents/f.bin', new Uint8Array(1100))).status, 200); // +100, still under
    assert.equal((await q.put('Documents/f.bin', chunked(1100))).status, 200); // chunked replacement too
  } finally {
    await q.close();
  }
});

// ---- 3. Thumbnails -------------------------------------------------------------------------------------------------
async function startService(opts) {
  const s = thumbnailService({ log: quiet, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}

test('thumbnailer: one job at a time, and no job can see another', async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-work-'));
  const violations = [];
  const { s, url } = await startService({
    workRoot,
    convert: async ({ output }) => {
      const present = await fs.readdir(workRoot);
      if (present.length !== 1) violations.push(present);
      await new Promise((r) => setTimeout(r, 40));
      await fs.writeFile(output, JPEG);
    },
  });
  try {
    const res = await Promise.all([1, 2, 3, 4].map(() => fetch(`${url}/thumb?ext=jpg`, { method: 'POST', body: JPEG })));
    assert.deepEqual(res.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(s.stats.maxActive, 1);
    assert.deepEqual(violations, []);
    assert.deepEqual(await fs.readdir(workRoot), []);
  } finally {
    s.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('thumbnailer: oversized inputs are refused, declared or streamed', async () => {
  process.env.MYCLOUD_THUMBNAIL_MAX_MB = String(1024 / 1024 / 1024); // 1 KB
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-work-'));
  const { s, url } = await startService({ workRoot, convert: async ({ output }) => fs.writeFile(output, JPEG) });
  try {
    assert.equal((await fetch(`${url}/thumb?ext=jpg`, { method: 'POST', body: new Uint8Array(4096) })).status, 413);
    assert.equal((await fetch(`${url}/thumb?ext=jpg`, { method: 'POST', body: chunked(4096), duplex: 'half' })).status, 413);
    assert.deepEqual(await fs.readdir(workRoot), []);
  } finally {
    delete process.env.MYCLOUD_THUMBNAIL_MAX_MB;
    s.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('thumbnailer: MyCloud accepts only a small, genuine JPEG back', async () => {
  const replies = [
    ['huge', 'image/jpeg', Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)])],
    ['not a jpeg', 'image/jpeg', Buffer.from('%PDF-1.7 secrets')],
    ['wrong type', 'text/plain', JPEG],
    ['good', 'image/jpeg', JPEG],
  ];
  let i = 0;
  const fake = http.createServer((req, res) => {
    req.resume();
    const [, type, body] = replies[i++];
    res.writeHead(200, { 'Content-Type': type }).end(body);
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-thumbclient-'));
  try {
    const src = path.join(dir, 'p.jpg');
    await fs.writeFile(src, JPEG);
    const t = new Thumbnailer({ dataDir: dir, remote: `http://127.0.0.1:${fake.address().port}`, log: quiet });
    const results = [];
    for (let k = 0; k < replies.length; k++) results.push(await t.makeRemote(src, path.join(dir, `out-${k}.jpg`)));
    assert.deepEqual(results.map(Boolean), [false, false, false, true]);
  } finally {
    fake.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('thumbnail sandbox: only the input is readable; data, other temp files and the network are not', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-sbx-')));
  const th = new Thumbnailer({ dataDir: dir, log: quiet });
  const tools = await th.detect();
  if (!tools.sandbox) return t.skip('no host sandbox on this machine');
  const input = path.join(dir, 'in.jpg');
  const secret = path.join(dir, 'users.json');
  await fs.writeFile(input, 'INPUT');
  await fs.writeFile(secret, 'SECRET');
  const otherTmp = await fs.realpath(await fs.mkdtemp(path.join(tools.sandbox === 'darwin' ? '/private/tmp' : os.tmpdir(), 'other-')));
  await fs.writeFile(path.join(otherTmp, 'x'), 'OTHER USER');
  const job = await fs.realpath(await fs.mkdtemp(path.join(tools.sandbox === 'darwin' ? '/private/tmp' : os.tmpdir(), 'mycloud-thumb-')));
  const inJob = tools.sandbox === 'bwrap' ? path.join(job, 'input.jpg') : input;
  if (tools.sandbox === 'bwrap') await fs.writeFile(inJob, '');
  const inside = async (bin, args) => {
    const [b, a] = th.wrap(tools, bin, args, { job, realSrc: input, input: inJob });
    return run(b, a, { timeout: 15_000 }).then((r) => r.stdout, () => null);
  };
  try {
    assert.equal(await inside('/bin/cat', [inJob]), 'INPUT');
    assert.equal(await inside('/bin/cat', [secret]), null);
    assert.equal(await inside('/bin/cat', [path.join(otherTmp, 'x')]), null);
    // macOS refuses the listing; Linux shows the data directory as an empty mount. Either way nothing is visible.
    const listing = (await inside('/bin/ls', ['-a', dir])) ?? '';
    assert.ok(!listing.includes('users.json') && !listing.includes('in.jpg'), listing);
    const curl = ['/usr/bin/curl', '/bin/curl'].find((c) => existsSync(c));
    if (curl) assert.equal(await inside(curl, ['-sS', '-m', '5', '-o', '/dev/null', 'http://1.1.1.1/']), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(otherTmp, { recursive: true, force: true });
    await fs.rm(job, { recursive: true, force: true });
  }
});

// ---- 4. SSRF -------------------------------------------------------------------------------------------------------
test('calendar links: IPv4-mapped IPv6 loopback never receives a request', async () => {
  let hits = 0;
  const canary = http.createServer((req, res) => { hits++; res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'); });
  await new Promise((r) => canary.listen(0, '::', r));
  const port = canary.address().port;
  const alice = await login('alice', 'alice-password-1');
  try {
    for (const host of ['[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:127.0.0.1]', '[::1]', '[::7f00:1]', '127.0.0.1', 'localhost']) {
      const r = await api(alice, 'POST', '/import?type=calendar&url=' + encodeURIComponent(`http://${host}:${port}/cal.ics`));
      assert.equal(r.status, 400, host);
    }
    assert.equal(hits, 0);
  } finally {
    canary.close();
  }
});

// ---- smaller items -------------------------------------------------------------------------------------------------
test('importer: its device password and web session are thrown away afterwards', async () => {
  const { client, revoke } = await connectWithAccountPassword({ server: base, user: 'alice', accountPassword: 'alice-password-1', label: 'Import test' });
  await client.check();
  const alice = await login('alice', 'alice-password-1');
  const before = (await (await api(alice, 'GET', '/app-passwords')).json()).appPasswords.length;
  await revoke();
  const afterList = (await (await api(alice, 'GET', '/app-passwords')).json()).appPasswords;
  assert.equal(afterList.length, before - 1);
  assert.ok(!afterList.some((a) => a.label === 'Import test'));
  await assert.rejects(client.check(), /wrong username or app password/);
});

test('sign-in: a burst of parallel guesses is rationed, not all verified', async () => {
  const res = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'nope-nope-nope' }),
  })));
  const counts = res.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  assert.ok((counts[429] ?? 0) >= 10, JSON.stringify(counts));
  assert.ok((counts[401] ?? 0) <= 8, JSON.stringify(counts));
});

test('proxy trust requires a public URL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-proxy2-'));
  try {
    await assert.rejects(createServer({ dataDir: dir, trustProxy: true, log: quiet }), /--public-url/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
