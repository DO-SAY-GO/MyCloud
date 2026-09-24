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
let basic, bobBasic;
const basicFor = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-test-'));
  const auth = new Auth(dataDir);
  await auth.load();
  await auth.setPassword(USER, PASS, { create: true });
  await auth.setPassword('bob', 'bob-password-123', { create: true });
  ({ server } = await createServer({ dataDir, log: { error() {} }, env: { MYCLOUD_THUMBNAILS: 'off' } }));
  // DAV only takes device (app) passwords.
  const srvAuth = new Auth(dataDir);
  await srvAuth.load();
  basic = basicFor(USER, (await srvAuth.createAppPassword(USER, 'tests')).password);
  bobBasic = basicFor('bob', (await srvAuth.createAppPassword('bob', 'tests')).password);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 2600)); // the server re-reads users.json every 2s
const api = (method, p, body, headers = {}) => fetch(base + '/api' + p, {
  method,
  headers: { 'X-MyCloud': '1', cookie, ...(body !== undefined && typeof body !== 'string' && { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});
const dav = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { Authorization: basic, ...headers }, body });

test('web login rejects bad passwords and issues a session cookie', async () => {
  await settle();
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
  const work = calendars.find((c) => c.id === 'work');
  assert.deepEqual([work.name, work.color, work.shared], ['Work', '#ff9500', false]);
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

const bobLogin = async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'bob-password-123' }) });
  return r.headers.get('set-cookie').split(';')[0];
};

test('family: invite link creates an account; only the admin can invite', async () => {
  const me = await (await api('GET', '/me')).json();
  assert.equal(me.admin, true); // alice was created first
  const bob = await bobLogin();
  const denied = await api('POST', '/family/invites', { kind: 'join' }, { cookie: bob });
  assert.equal(denied.status, 403);

  const { url } = await (await api('POST', '/family/invites', { kind: 'join' })).json();
  const token = url.split('/').pop();
  assert.equal((await fetch(base + url)).status, 200); // the web app serves the join page
  const info = await (await fetch(`${base}/api/join?token=${token}`)).json();
  assert.equal(info.kind, 'join');
  const join = await fetch(base + '/api/join', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token, username: 'carol', password: 'carol-password-1' }) });
  assert.equal(join.status, 200);
  assert.match(join.headers.get('set-cookie'), /mycloud_session=/);
  const again = await fetch(base + '/api/join', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token, username: 'dave', password: 'dave-password-1' }) });
  assert.equal(again.status, 400); // single use
  const { members } = await (await api('GET', '/family')).json();
  assert.deepEqual(members.map((m) => m.name).sort(), ['alice', 'bob', 'carol']);
});

test('family: reset link sets a new password', async () => {
  const { url } = await (await api('POST', '/family/invites', { kind: 'reset', username: 'carol' })).json();
  const token = url.split('/').pop();
  const r = await fetch(base + '/api/join', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: 'carol-new-password' }) });
  assert.equal((await r.json()).user, 'carol');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: 'carol-new-password' }) });
  assert.equal(login.status, 200);
});

test('family: shared folder and calendar are visible to every member', async () => {
  const bob = await bobLogin();
  assert.equal((await api('PUT', '/files/raw?path=Family/Photos/beach.jpg', 'sand')).status, 200);
  const r = await api('GET', '/files/raw?path=Family/Photos/beach.jpg', undefined, { cookie: bob });
  assert.equal(await r.text(), 'sand');
  const { photos } = await (await api('GET', '/photos', undefined, { cookie: bob })).json();
  assert.ok(photos.some((p) => p.path === 'Family/Photos/beach.jpg'));

  const ics = buildEvent({ uid: 'fam1', title: 'Grandma visits', start: '2026-12-24', allDay: true });
  assert.equal((await dav('PUT', '/dav/calendars/alice/family/fam1.ics', ics)).status, 201);
  const basicBob = bobBasic;
  const list = await (await fetch(base + '/dav/calendars/bob/', { method: 'PROPFIND', headers: { Authorization: basicBob, Depth: '1' } })).text();
  assert.match(list, /\/dav\/calendars\/bob\/family\//);
  const got = await fetch(base + '/dav/calendars/bob/family/fam1.ics', { headers: { Authorization: basicBob } });
  assert.match(await got.text(), /Grandma visits/);

  // Nobody can delete or rename the shared space itself.
  assert.equal((await api('DELETE', '/files?path=Family')).status, 403);
  assert.equal((await dav('DELETE', '/dav/files/alice/Family/')).status, 403);
  assert.equal((await dav('DELETE', '/dav/calendars/alice/family/')).status, 403);
  assert.equal((await api('POST', '/files/move', { from: 'Family', to: 'Mine' })).status, 403);
});

test('import: a multi-event .ics becomes one object per UID, with its timezone', async () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:a@x', 'DTSTART;TZID=Europe/Paris:20261001T090000', 'SUMMARY:Standup', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a@x', 'RECURRENCE-ID;TZID=Europe/Paris:20261002T090000', 'DTSTART;TZID=Europe/Paris:20261002T100000', 'SUMMARY:Standup (late)', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261005', 'SUMMARY:No UID', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'END:VALARM', 'END:VEVENT',
    'END:VCALENDAR', ''].join('\r\n');
  const r = await (await api('POST', '/import?type=calendar&name=Work%20Import', ics, { 'Content-Type': 'text/calendar' })).json();
  assert.equal(r.imported, 2);
  assert.equal(r.target, 'work-import');
  const standup = await (await dav('GET', '/dav/calendars/alice/work-import/a_x.ics')).text();
  assert.match(standup, /BEGIN:VTIMEZONE/);
  assert.equal(standup.match(/BEGIN:VEVENT/g).length, 2);
  const { events } = await (await api('GET', '/events')).json();
  assert.ok(events.some((e) => e.title === 'No UID' && e.start === '2026-10-05'));
});

test('import: vcf splitting and calendar links refuse private addresses', async () => {
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:One\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Two\r\nUID:two\r\nEND:VCARD\r\n';
  assert.equal((await (await api('POST', '/import?type=contacts', vcf)).json()).imported, 2);
  const { contacts } = await (await api('GET', '/contacts')).json();
  assert.ok(['One', 'Two'].every((n) => contacts.some((c) => c.name === n)));
  for (const u of [`${base}/api/me`, 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
    const r = await api('POST', '/import?type=calendar&url=' + encodeURIComponent(u));
    assert.equal(r.status, 400, u);
  }
});

test('X-OC-Mtime preserves the original file date', async () => {
  const when = 1500000000; // 2017-07-14
  const put = await dav('PUT', '/dav/files/alice/Photos/old.jpg', 'x', { 'X-OC-Mtime': String(when) });
  assert.equal(put.headers.get('x-oc-mtime'), 'accepted');
  const { photos } = await (await api('GET', '/photos')).json();
  assert.equal(photos.find((p) => p.name === 'old.jpg').mtime, when * 1000);
});

test('one-tap device profile carries both accounts and is single-use', async () => {
  const { url } = await (await api('POST', '/profile', { label: 'Test iPhone' })).json();
  const r = await api('GET', url.replace(/^\/api/, ''));
  assert.equal(r.headers.get('content-type'), 'application/x-apple-aspen-config');
  const xml = await r.text();
  assert.match(xml, /com\.apple\.caldav\.account/);
  assert.match(xml, /com\.apple\.carddav\.account/);
  const password = /CalDAVPassword<\/key><string>([^<]+)</.exec(xml)[1];
  const basicAp = 'Basic ' + Buffer.from(`alice:${password}`).toString('base64');
  assert.equal((await fetch(base + '/dav/principals/alice/', { method: 'PROPFIND', headers: { Authorization: basicAp, Depth: '0' } })).status, 207);
  assert.equal((await api('GET', url.replace(/^\/api/, ''))).status, 404);
});

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('audit: an invite link works exactly once under concurrent redemption', async () => {
  const { url } = await (await api('POST', '/family/invites', { kind: 'join' })).json();
  const token = url.split('/').pop();
  const results = await Promise.all(['r1', 'r2', 'r3', 'r4', 'r5'].map((n) => post('/api/join', { token, username: n, password: `${n}-password-123` })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('audit: two invites racing for one username create one account and keep the loser invite', async () => {
  const t1 = (await (await api('POST', '/family/invites', { kind: 'join' })).json()).url.split('/').pop();
  const t2 = (await (await api('POST', '/family/invites', { kind: 'join' })).json()).url.split('/').pop();
  const [a, b] = await Promise.all([post('/api/join', { token: t1, username: 'same', password: 'same-password-1' }), post('/api/join', { token: t2, username: 'same', password: 'same-password-2' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 200 ? t2 : t1;
  assert.equal((await fetch(`${base}/api/join?token=${loser}`)).status, 200); // still usable
});

test('audit: DAV refuses the account password', async () => {
  assert.equal((await dav('PROPFIND', '/dav/principals/alice/', null, { Authorization: basicFor(USER, PASS), Depth: '0' })).status, 401);
});

test('audit: password change disconnects devices unless kept; reset always does', async () => {
  const auth = new Auth(dataDir);
  await auth.load();
  const { password } = await auth.createAppPassword('bob', 'phone');
  await settle();
  const bobDav = () => fetch(base + '/dav/principals/bob/', { method: 'PROPFIND', headers: { Authorization: basicFor('bob', password), Depth: '0' } });
  assert.equal((await bobDav()).status, 207);
  const bob = await bobLogin();
  assert.equal((await api('POST', '/password', { current: 'bob-password-123', next: 'bob-password-456', keepDevices: true }, { cookie: bob })).status, 200);
  assert.equal((await bobDav()).status, 207); // kept on request
  assert.equal((await api('GET', '/me', undefined, { cookie: bob })).status, 200); // this browser stays signed in
  assert.equal((await api('POST', '/password', { current: 'bob-password-456', next: 'bob-password-123' }, { cookie: bob })).status, 200);
  assert.equal((await bobDav()).status, 401); // default: devices disconnected
  bobBasic = null;
});

test('audit: shares refuse the whole Drive and Family content from non-admins, and expire', async () => {
  assert.equal((await api('POST', '/shares', { path: '' })).status, 400);
  assert.equal((await api('POST', '/shares', { path: '/' })).status, 400);
  const bob = await bobLogin();
  await api('PUT', '/files/raw?path=Family/secret.txt', 'family only');
  assert.equal((await api('POST', '/shares', { path: 'Family/secret.txt' }, { cookie: bob })).status, 403);
  assert.equal((await api('POST', '/shares', { path: 'Family' }, { cookie: bob })).status, 403);
  await api('PUT', '/files/raw?path=Documents/exp.txt', 'x');
  const s = await (await api('POST', '/shares', { path: 'Documents/exp.txt', days: 1 })).json();
  assert.ok(s.expires > Date.now() && s.expires <= Date.now() + 86400 * 1000);
  assert.equal((await fetch(base + s.url)).status, 200);
});

test('audit: deletes go to Recently Deleted and can be restored', async () => {
  await api('PUT', '/files/raw?path=Documents/keep.txt', 'precious');
  await api('DELETE', '/files?path=Documents/keep.txt');
  assert.equal((await api('GET', '/files/raw?path=Documents/keep.txt')).status, 404);
  const { items } = await (await api('GET', '/trash')).json();
  const item = items.find((i) => i.rel === 'Documents/keep.txt');
  assert.ok(item);
  const r = await (await api('POST', '/trash/restore', { id: item.id, shared: item.shared })).json();
  assert.equal(r.path, 'Documents/keep.txt');
  assert.equal(await (await api('GET', '/files/raw?path=Documents/keep.txt')).text(), 'precious');
  // Finder deletes over WebDAV land there too.
  await dav('PUT', '/dav/files/alice/Documents/via-finder.txt', 'f');
  assert.equal((await dav('DELETE', '/dav/files/alice/Documents/via-finder.txt')).status, 204);
  assert.ok((await (await api('GET', '/trash')).json()).items.some((i) => i.rel === 'Documents/via-finder.txt'));
});

test('audit: calendar links by hostname cannot reach loopback', async () => {
  const port = new URL(base).port;
  for (const u of [`http://localhost:${port}/`, `http://127.0.0.1.nip.io:${port}/`]) {
    const r = await api('POST', '/import?type=calendar&url=' + encodeURIComponent(u));
    assert.ok([400, 502].includes(r.status), `${u} -> ${r.status}`);
    assert.notEqual(r.status, 200);
  }
});

test('audit: behind a proxy — Secure cookies, HSTS, canonical URLs, unspoofable client IP, upload cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-proxy-'));
  const a = new Auth(dir);
  await a.load();
  await a.setPassword('pat', 'pat-password-1', { create: true });
  const { server: s2 } = await createServer({ dataDir: dir, trustProxy: true, publicUrl: 'https://cloud.example.com', log: { error() {} }, env: { MYCLOUD_MAX_UPLOAD_GB: String(1024 / 1024 ** 3), MYCLOUD_THUMBNAILS: 'off' } });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const login = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'http', Host: 'evil.example' }, body: JSON.stringify({ username: 'pat', password: 'pat-password-1' }) });
    assert.match(login.headers.get('set-cookie'), /; Secure/);
    assert.match(login.headers.get('strict-transport-security'), /max-age=/);
    const c = login.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(b2 + '/api/me', { headers: { cookie: c, Host: 'evil.example' } })).json();
    assert.equal(me.origin, 'https://cloud.example.com'); // never the Host header
    // Upload cap is enforced while streaming (no Content-Length).
    const big = new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array(4096)); ctl.close(); } });
    const up = await fetch(b2 + '/api/files/raw?path=Documents/big.bin', { method: 'PUT', headers: { cookie: c, 'X-MyCloud': '1' }, body: big, duplex: 'half' });
    assert.equal(up.status, 413);
    assert.deepEqual((await fs.readdir(path.join(dir, 'users/pat/files/Documents'))).filter((n) => n.startsWith('.mycloud-upload')), []);
    // Rotating the (client-controlled) left part of X-Forwarded-For does not dodge throttling.
    let last;
    for (let i = 0; i < 7; i++) {
      last = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'X-MyCloud': '1', 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` }, body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }) });
    }
    assert.equal(last.status, 429);
  } finally {
    s2.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
