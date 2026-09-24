import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../lib/import/html2md.js';
import { buildEvent, parseEvents } from '../lib/pim.js';
import { buildProfile } from '../lib/profile.js';

test('Apple Notes HTML becomes readable Markdown with images pulled out', () => {
  const png = Buffer.from('fake-png').toString('base64');
  const html = '<div><h1>Trip</h1></div><div>Pack <b>passport</b> &amp; <i>charger</i></div><div><br></div><ul><li>tickets</li><li class="checked">hotel</li></ul><div><a href="https://x.io">site</a></div><div><img src="data:image/png;base64,' + png + '"></div>';
  const { markdown, attachments } = htmlToMarkdown(html);
  assert.match(markdown, /^# Trip\n/);
  assert.match(markdown, /Pack \*\*passport\*\* & \*charger\*/);
  assert.match(markdown, /- tickets\n- \[x\] hotel/);
  assert.match(markdown, /\[site\]\(https:\/\/x\.io\)/);
  assert.equal(attachments.length, 1);
  assert.match(markdown, new RegExp(`!\\[\\]\\(attachments/${attachments[0].name}\\)`));
});

test('repeating events keep their wall-clock time zone', () => {
  // 09:00 in New York on a winter Monday = 14:00Z
  const ics = buildEvent({ uid: 'r1', title: 'Standup', start: '2026-01-05T14:00:00Z', end: '2026-01-05T14:15:00Z', tzid: 'America/New_York', rrule: 'FREQ=WEEKLY' });
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260105T090000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY/);
  const [ev] = parseEvents(ics);
  assert.equal(ev.start, '2026-01-05T09:00:00');
  // Unknown zones fall back to UTC instead of writing a TZID clients cannot resolve.
  assert.match(buildEvent({ uid: 'r2', title: 'x', start: '2026-01-05T14:00:00Z', tzid: 'Mars/Olympus' }), /DTSTART:20260105T140000Z/);
});

test('device profile includes a home-screen web clip when an icon is available', () => {
  const xml = buildProfile({ url: new URL('https://cloud.example.com'), user: 'alice', password: 'pw', icon: Buffer.from('png') });
  assert.match(xml, /com\.apple\.webClip\.managed/);
  assert.match(xml, /<key>URL<\/key><string>https:\/\/cloud\.example\.com\/<\/string>/);
  assert.match(xml, /<key>CalDAVUseSSL<\/key><true\/>/);
  assert.match(xml, /<key>CalDAVPort<\/key><integer>443<\/integer>/);
  assert.doesNotMatch(buildProfile({ url: new URL('http://h:8080'), user: 'a', password: 'p' }), /webClip/);
});
