import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../lib/server.js';
import { Auth } from '../lib/auth.js';
import { parseEvents, buildEvent, parseContact, buildContact } from '../lib/pim.js';
import { parseXml } from '../lib/xml.js';

let dataDir, server, base, cookie;
const USER = 'alice';
const PASS = 'correct horse battery';
const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-test-'));
  const auth = new Auth(dataDir);
  await auth.load();
  await auth.setPassword(USER, PASS);
  await auth.setPassword('bob', 'bob-password-123');
  ({ server } = await createServer({ dataDir, log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const api = (method, p, body, headers = {}) => fetch(base + '/api' + p, {
  method,
  headers: { 'X-MyCloud': '1', cookie, ...(body !== undefined && typeof body !== 'string' && { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const dav = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { Authorization: basic, ...headers }, body });

test('web login rejects bad passwords and issues a session cookie', async () => {
  const bad = await api('POST', '/login', { username: USER, password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/login', { username: USER, password: PASS });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  const me = await (await api('GET', '/me')).json();
  assert.equal(me.user, USER);
});

test('mutations without the CSRF header are refused', async () => {
  const r = await fetch(base + '/api/files/mkdir', { method: 'POST', headers: { cookie }, body: '{"path":"x"}' });
  assert.equal(r.status, 403);
});

test('drive: upload, list, range download, rename, delete', async () => {
  assert.equal((await api('PUT', '/files/raw?path=Documents/hello.txt', 'hello world')).status, 200);
  const { items } = await (await api('GET', '/files?path=Documents')).json();
  assert.deepEqual(items.map((i) => i.name), ['hello.txt']);
  const ranged = await api('GET', '/files/raw?path=Documents/hello.txt', undefined, { Range: 'bytes=6-' });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), 'world');
  assert.match(ranged.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await api('POST', '/files/move', { from: 'Documents/hello.txt', to: 'Documents/hi.txt' })).status, 200);
  assert.equal((await api('DELETE', '/files?path=Documents/hi.txt')).status, 200);
  assert.equal((await api('GET', '/files/raw?path=Documents/hi.txt')).status, 404);
});

test('path traversal is rejected everywhere', async () => {
  for (const p of ['../../users.json', 'Documents/../../../etc/passwd', '..%2f..%2fusers.json']) {
    const r = await api('GET', '/files/raw?path=' + p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await dav('GET', '/dav/files/alice/..%2f..%2fusers.json')).status, 400);
});

test('share links serve files publicly and stop after revoke', async () => {
  await api('PUT', '/files/raw?path=Documents/share.txt', 'shared!');
  const { token, url } = await (await api('POST', '/shares', { path: 'Documents/share.txt' })).json();
  assert.equal(await (await fetch(base + url)).text(), 'shared!');
  await api('DELETE', '/shares?token=' + token);
  assert.equal((await fetch(base + url)).status, 404);
});

test('dav requires auth and isolates users', async () => {
  assert.equal((await fetch(base + '/dav/files/alice/', { method: 'PROPFIND' })).status, 401);
  assert.equal((await dav('PROPFIND', '/dav/files/bob/', null, { Depth: '0' })).status, 403);
});

test('well-known redirects and principal discovery', async () => {
  const r = await fetch(base + '/.well-known/caldav', { redirect: 'manual' });
  assert.equal(r.status, 301);
  const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
  const root = await dav('PROPFIND', '/dav/', body, { Depth: '0' });
  assert.equal(root.status, 207);
  assert.match(await root.text(), /<d:href>\/dav\/principals\/alice\/<\/d:href>/);
  const homes = '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><c:calendar-home-set/><card:addressbook-home-set/></d:prop></d:propfind>';
  const txt = await (await dav('PROPFIND', '/dav/principals/alice/', homes, { Depth: '0' })).text();
  assert.match(txt, /\/dav\/calendars\/alice\//);
  assert.match(txt, /\/dav\/addressbooks\/alice\//);
});

test('caldav: list calendars, PUT, multiget, sync-collection, delete', async () => {
  const list = await (await dav('PROPFIND', '/dav/calendars/alice/', '<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:resourcetype/><cs:getctag/><d:sync-token/></d:prop></d:propfind>', { Depth: '1' })).text();
  assert.match(list, /\/dav\/calendars\/alice\/personal\//);
  assert.match(list, /<c:calendar\/>/);
  const token1 = /<d:sync-token>([^<]+)</.exec(list)[1];

  const ics = buildEvent({ uid: 'e1', title: 'Launch, party; yay', start: '2026-09-23T10:00:00Z', end: '2026-09-23T11:00:00Z' });
  const put = await dav('PUT', '/dav/calendars/alice/personal/e1.ics', ics, { 'Content-Type': 'text/calendar', 'If-None-Match': '*' });
  assert.equal(put.status, 201);
  const etag = put.headers.get('etag');
  assert.ok(etag);
  assert.equal((await dav('PUT', '/dav/calendars/alice/personal/e1.ics', ics, { 'If-None-Match': '*' })).status, 412);
  assert.equal((await dav('PUT', '/dav/calendars/alice/personal/bad.ics', 'not a calendar')).status, 415);

  const mg = await (await dav('REPORT', '/dav/calendars/alice/personal/', '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>/dav/calendars/alice/personal/e1.ics</d:href><d:href>/dav/calendars/alice/personal/nope.ics</d:href></c:calendar-multiget>', { Depth: '1' })).text();
  const parsed = parseXml(mg);
  assert.equal(parsed.children.length, 2);
  assert.match(mg, /Launch\\, party\\; yay/);
  assert.match(mg, /404 Not Found/);

  const syncBody = (t) => `<d:sync-collection xmlns:d="DAV:"><d:sync-token>${t}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
  const s1 = await (await dav('REPORT', '/dav/calendars/alice/personal/', syncBody(token1))).text();
  assert.match(s1, /e1\.ics/);
  const token2 = /<d:sync-token>([^<]+)</.exec(s1)[1];
  assert.notEqual(token1, token2);
  const s2 = await (await dav('REPORT', '/dav/calendars/alice/personal/', syncBody(token2))).text();
  assert.doesNotMatch(s2, /e1\.ics/);

  assert.equal((await dav('DELETE', '/dav/calendars/alice/personal/e1.ics', null, { 'If-Match': '"wrong"' })).status, 412);
  assert.equal((await dav('DELETE', '/dav/calendars/alice/personal/e1.ics', null, { 'If-Match': etag })).status, 204);
  const s3 = await (await dav('REPORT', '/dav/calendars/alice/personal/', syncBody(token2))).text();
  assert.match(s3, /e1\.ics<\/d:href><d:status>HTTP\/1.1 404/);
  assert.equal((await dav('REPORT', '/dav/calendars/alice/personal/', syncBody('bogus'))).status, 403);
});

test('caldav: MKCALENDAR + PROPPATCH colour', async () => {
  const mk = await dav('MKCALENDAR', '/dav/calendars/alice/work/', '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Work</d:displayname></d:prop></d:set></c:mkcalendar>');
  assert.equal(mk.status, 201);
  const pp = await dav('PROPPATCH', '/dav/calendars/alice/work/', '<d:propertyupdate xmlns:d="DAV:" xmlns:ical="http://apple.com/ns/ical/"><d:set><d:prop><ical:calendar-color>#ff9500FF</ical:calendar-color></d:prop></d:set></d:propertyupdate>');
  assert.equal(pp.status, 207);
  const { calendars } = await (await api('GET', '/calendars')).json();
  assert.deepEqual(calendars.find((c) => c.id === 'work'), { id: 'work', name: 'Work', color: '#ff9500' });
});

test('carddav + web API agree', async () => {
  const vcf = buildContact({ uid: 'c1', name: 'Ada Lovelace', emails: ['ada@example.com'], phones: ['+44 1'] });
  assert.equal((await dav('PUT', '/dav/addressbooks/alice/contacts/c1.vcf', vcf)).status, 201);
  const { contacts } = await (await api('GET', '/contacts')).json();
  assert.equal(contacts[0].name, 'Ada Lovelace');
  assert.deepEqual(contacts[0].emails, ['ada@example.com']);
  const created = await (await api('POST', '/contacts', { name: 'Grace Hopper', emails: ['grace@example.com'] })).json();
  const q = await (await dav('REPORT', '/dav/addressbooks/alice/contacts/', '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>', { Depth: '1' })).text();
  assert.match(q, /Grace Hopper/);
  assert.match(q, new RegExp(created.file));
});

test('webdav: Finder-style MKCOL, PUT, LOCK, MOVE, PROPFIND', async () => {
  assert.equal((await dav('MKCOL', '/dav/files/alice/Projects/')).status, 201);
  const lock = await dav('LOCK', '/dav/files/alice/Projects/a.txt', '<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>');
  assert.ok(lock.headers.get('lock-token'));
  assert.equal((await dav('PUT', '/dav/files/alice/Projects/a.txt', 'A')).status, 204);
  const mv = await dav('MOVE', '/dav/files/alice/Projects/a.txt', null, { Destination: `${base}/dav/files/alice/Projects/b%20c.txt` });
  assert.equal(mv.status, 201);
  const pf = await (await dav('PROPFIND', '/dav/files/alice/Projects/', null, { Depth: '1' })).text();
  assert.match(pf, /<d:href>\/dav\/files\/alice\/Projects\/b%20c\.txt<\/d:href>/);
  assert.equal(await (await dav('GET', '/dav/files/alice/Projects/b%20c.txt')).text(), 'A');
  assert.equal((await dav('PUT', '/dav/files/alice/missing/dir/x.txt', 'x')).status, 409);
});

test('photos listing finds nested media', async () => {
  await api('PUT', '/files/raw?path=Photos/2026-09/cat.jpg', 'not really a jpeg');
  await api('PUT', '/files/raw?path=Photos/2026-09/clip.mov', 'nope');
  const { photos } = await (await api('GET', '/photos')).json();
  assert.deepEqual(photos.map((p) => p.name).sort(), ['cat.jpg', 'clip.mov']);
});

test('ical/vcard round-trips', () => {
  const [ev] = parseEvents(buildEvent({ uid: 'x', title: 'a,b;c\nd', start: '2026-01-02', end: '2026-01-03', allDay: true, location: 'Here' }));
  assert.deepEqual({ title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, location: ev.location }, { title: 'a,b;c\nd', start: '2026-01-02', end: '2026-01-03', allDay: true, location: 'Here' });
  const alarm = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART;TZID=Europe/Paris:20260101T090000\r\nSUMMARY:Long\r\n  folded\r\nBEGIN:VALARM\r\nSUMMARY:alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [e2] = parseEvents(alarm);
  assert.equal(e2.title, 'Long folded');
  assert.equal(e2.start, '2026-01-01T09:00:00');
  const c = parseContact('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nitem1.EMAIL;type=INTERNET:j@x.io\r\nEND:VCARD');
  assert.equal(c.name, 'Jane Doe');
  assert.deepEqual(c.emails, ['j@x.io']);
});
