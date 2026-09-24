// `mycloud import mac`: copy what iCloud holds on this Mac into MyCloud, through the Mac's own apps.
// Every step is idempotent: items are keyed by their Apple IDs/UIDs, files are skipped when already present.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jxa } from './jxa.js';
import { htmlToMarkdown } from './html2md.js';
import { buildEvent, splitVcards, itemName, fold, escapeText } from '../pim.js';
import { readJson, writeJson } from '../util.js';
import { Progress, slug, safeFileName, walkFiles, swiftHelper, runHelper } from './common.js';

const run = promisify(execFile);
const HOME = os.homedir();
export const MAC_SOURCES = ['contacts', 'calendars', 'reminders', 'notes', 'photos', 'drive', 'voicememos', 'bookmarks'];

const localYmd = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// ---------------------------------------------------------------- Contacts
async function contacts(client, opts) {
  const data = await jxa('Contacts', `function run() {
    const p = Application('Contacts').people;
    return JSON.stringify({ ids: p.id(), vcards: p.vcard() });
  }`);
  let cards = data.vcards.flatMap((v, i) => splitVcards(v, [data.ids[i]]));
  if (opts.limit) cards = cards.slice(0, opts.limit);
  if (opts.dryRun) return { found: cards.length };
  const p = new Progress('Contacts', cards.length);
  for (const c of cards) {
    await client.putItem('addressbooks', 'contacts', itemName(c.uid, 'vcf'), c.vcf);
    p.tick();
  }
  return { found: cards.length, imported: p.done() };
}

// ---------------------------------------------------------------- Calendars (EventKit: fast, and it sees every account)
// Calendar.app's scripting interface needs seconds per hundred events and can hang outright on some calendars,
// so this talks to EventKit directly through the JavaScript-for-Automation Objective-C bridge.
const EVENTKIT_READ = `ObjC.import('EventKit');
function run() {
  const store = $.EKEventStore.alloc.init;
  const status = () => Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  if (status() !== 3) {
    // The completion block never runs inside osascript, so ask and then poll the status.
    if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(() => {});
    else store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, () => {});
    const until = Date.now() + 120000;
    while (status() !== 3 && status() !== 2 && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25));
  }
  if (status() !== 3) return JSON.stringify({ denied: true });
  const str = (v) => (v && !v.isNil() ? ObjC.unwrap(v) : null);
  const cals = store.calendarsForEntityType($.EKEntityTypeEvent);
  const out = { calendars: [] };
  const byId = {};
  for (let i = 0; i < cals.count; i++) {
    const c = cals.objectAtIndex(i);
    const cal = { id: str(c.calendarIdentifier), name: str(c.title), writable: !!c.allowsContentModifications, events: {} };
    byId[cal.id] = cal;
    out.calendars.push(cal);
  }
  const now = new Date().getUTCFullYear();
  for (let y = 1990; y < now + 10; y += 4) {
    const range = store.predicateForEventsWithStartDateEndDateCalendars(
      $.NSDate.dateWithTimeIntervalSince1970(Date.UTC(y, 0, 1) / 1000), $.NSDate.dateWithTimeIntervalSince1970(Date.UTC(y + 4, 0, 1) / 1000), $());
    const evs = store.eventsMatchingPredicate(range);
    for (let i = 0; i < evs.count; i++) {
      const e = evs.objectAtIndex(i);
      const cal = byId[str(e.calendar.calendarIdentifier)];
      if (!cal || !cal.writable || e.isDetached) continue;
      const uid = str(e.calendarItemExternalIdentifier) || str(e.eventIdentifier);
      if (cal.events[uid]) continue; // later occurrence of a repeating event we already have
      const rules = [];
      if (e.hasRecurrenceRules) {
        const rr = e.recurrenceRules;
        for (let k = 0; k < rr.count; k++) {
          const m = /RRULE (\S+)/.exec(str(rr.objectAtIndex(k).description) || '');
          if (m) rules.push(m[1]);
        }
      }
      cal.events[uid] = {
        uid, title: str(e.title), location: str(e.location), notes: str(e.notes), url: e.URL.isNil() ? null : str(e.URL.absoluteString),
        allDay: !!e.allDay, start: e.startDate.timeIntervalSince1970 * 1000, end: e.endDate.timeIntervalSince1970 * 1000,
        tz: e.timeZone.isNil() ? null : str(e.timeZone.name), rrule: rules[0] || null,
      };
    }
  }
  for (const c of out.calendars) c.events = Object.values(c.events);
  return JSON.stringify(out);
}`;

async function calendars(client, opts) {
  const data = await jxa('Calendar', EVENTKIT_READ, [], { timeout: 10 * 60 * 1000 });
  if (data.denied) throw new Error('macOS denied calendar access. Allow your terminal app in System Settings › Privacy & Security › Calendars (Full Access), then run this again.');
  const result = { found: 0, imported: 0, skipped: [] };
  const usedIds = new Set();
  for (const cal of data.calendars) {
    if (!cal.writable) { result.skipped.push(`${cal.name} (read-only/subscribed)`); continue; }
    const events = opts.limit ? cal.events.slice(0, opts.limit) : cal.events;
    result.found += events.length;
    if (opts.dryRun || !events.length) continue;
    let id = slug(cal.name);
    for (let n = 2; usedIds.has(id); n++) id = `${slug(cal.name)}-${n}`; // two accounts can both have a "Work"
    usedIds.add(id);
    await client.ensureCollection('calendars', id, cal.name);
    const p = new Progress(`Calendar “${cal.name}”`, events.length);
    for (const ev of events) {
      const ics = buildEvent({
        uid: ev.uid,
        title: ev.title || '',
        allDay: ev.allDay,
        start: ev.allDay ? localYmd(ev.start) : new Date(ev.start).toISOString(),
        end: ev.allDay ? localYmd(ev.end + 1000) : new Date(ev.end).toISOString(), // EventKit all-day ends at 23:59:59
        tzid: ev.allDay ? null : ev.tz,
        location: ev.location,
        description: [ev.notes, ev.url].filter(Boolean).join('\n\n') || undefined,
        rrule: ev.rrule,
      });
      await client.putItem('calendars', id, itemName(ev.uid, 'ics'), ics);
      p.tick();
    }
    result.imported += p.done();
  }
  return result;
}

// ---------------------------------------------------------------- Reminders (VTODO, shows up in the Reminders app over CalDAV)
async function reminders(client, opts) {
  const bin = await swiftHelper('reminders');
  const { stdout } = await run(bin, [], { maxBuffer: 1024 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const data = JSON.parse(stdout);
  if (data.denied) throw new Error('macOS denied Reminders access. Allow it in System Settings › Privacy & Security › Reminders, then run this again.');
  const lists = data.lists;
  const result = { found: 0, imported: 0, skipped: [] };
  for (const list of lists) {
    if (list.error) { result.skipped.push(`${list.name} (${list.error})`); continue; }
    const items = opts.limit ? list.items.slice(0, opts.limit) : list.items;
    result.found += items.length;
    if (opts.dryRun || !items.length) continue;
    const id = `reminders-${slug(list.name)}`;
    await client.ensureCollection('calendars', id, list.name, 'VTODO');
    const p = new Progress(`Reminders “${list.name}”`, items.length);
    for (const r of items) {
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DO-SAY-GO//MyCloud//EN', 'BEGIN:VTODO', `UID:${r.id}`, `DTSTAMP:${stamp(Date.now())}`, `SUMMARY:${escapeText(r.title || '')}`];
      if (r.created) lines.push(`CREATED:${stamp(r.created)}`);
      if (r.notes) lines.push(`DESCRIPTION:${escapeText(r.notes)}`);
      if (r.dueDay) lines.push(`DUE;VALUE=DATE:${r.dueDay.replace(/-/g, '')}`);
      else if (r.due) lines.push(`DUE:${stamp(r.due)}`);
      if (r.priority) lines.push(`PRIORITY:${r.priority}`);
      lines.push(r.completed ? 'STATUS:COMPLETED' : 'STATUS:NEEDS-ACTION');
      if (r.completed && r.completedAt) lines.push(`COMPLETED:${stamp(r.completedAt)}`);
      lines.push('END:VTODO', 'END:VCALENDAR');
      await client.putItem('calendars', id, itemName(r.id, 'ics'), fold(lines));
      p.tick();
    }
    result.imported += p.done();
  }
  return result;
}

// ---------------------------------------------------------------- Notes
async function notes(client, opts) {
  // A Notes.app that is waiting on a permission prompt or a welcome/upgrade screen answers nothing at all.
  await jxa('Notes', "Application('Notes').accounts.name(); '1'", [], {
    timeout: 90 * 1000,
    hint: 'Open Notes once (it may be showing a welcome or upgrade screen), accept any permission prompt, then run again with --only notes.',
  });
  const folders = await jxa('Notes', `function run() {
    const out = [];
    for (const f of Application('Notes').folders()) {
      const folder = { name: f.name(), notes: [] };
      try {
        const n = f.notes;
        const cols = [n.id(), n.name(), n.modificationDate(), n.passwordProtected()];
        for (let i = 0; i < cols[0].length; i++) {
          const note = { id: cols[0][i], title: cols[1][i], modified: cols[2][i], locked: cols[3][i] };
          if (!note.locked) { try { note.body = n[i].body(); } catch (e) { note.error = String(e); } }
          folder.notes.push(note);
        }
      } catch (err) { folder.error = String(err); }
      out.push(folder);
    }
    return JSON.stringify(out);
  }`);
  const result = { found: 0, imported: 0, skipped: [] };
  const all = [];
  for (const f of folders) {
    if (/^recently deleted$/i.test(f.name)) continue;
    if (f.error) { result.skipped.push(`folder ${f.name} (${f.error})`); continue; }
    for (const n of f.notes) {
      if (n.locked) { result.skipped.push(`“${n.title}” (locked note)`); continue; }
      if (n.error || n.body == null) { result.skipped.push(`“${n.title}”`); continue; }
      all.push({ ...n, folder: f.name });
    }
  }
  all.sort((a, b) => a.id.localeCompare(b.id)); // stable names across re-runs
  const notesToImport = opts.limit ? all.slice(0, opts.limit) : all;
  result.found = notesToImport.length;
  if (opts.dryRun) return result;
  const used = new Set();
  const p = new Progress('Notes', notesToImport.length);
  for (const n of notesToImport) {
    const base = safeFileName(`${n.folder === 'Notes' ? '' : `${n.folder} – `}${n.title || 'Untitled'}`);
    let name = `${base}.md`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).md`;
    used.add(name.toLowerCase());
    const { markdown, attachments } = htmlToMarkdown(n.body);
    for (const a of attachments) await client.putBytes(`Notes/attachments/${a.name}`, a.data);
    await client.putBytes(`Notes/${name}`, markdown, n.modified ? Date.parse(n.modified) : undefined);
    p.tick();
  }
  result.imported = p.done();
  return result;
}

// ---------------------------------------------------------------- Photos (PhotoKit originals, incl. Live Photo videos and iCloud-only items)
const PHOTO_BATCH = 50;

async function photos(client, opts) {
  const bin = await swiftHelper('photos');
  const assets = [];
  await runHelper(bin, ['list'], '', (ev) => { if (ev.event === 'item') assets.push(ev); });
  const statePath = path.join(HOME, '.mycloud', 'import', `${crypto.createHash('sha1').update(`${client.base}|${client.user}`).digest('hex').slice(0, 16)}.json`);
  const state = await readJson(statePath, { photos: [] });
  const done = new Set(state.photos);
  let todo = assets.filter((a) => !done.has(a.id)); // newest first, straight from PhotoKit
  if (opts.limit) todo = todo.slice(0, opts.limit);
  const result = { found: assets.length, alreadyImported: assets.length - assets.filter((a) => !done.has(a.id)).length, imported: 0, skipped: [] };
  if (opts.dryRun) return { ...result, toImport: todo.length };

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mycloud-photos-'));
  const p = new Progress('Photos', todo.length);
  try {
    for (let i = 0; i < todo.length; i += PHOTO_BATCH) {
      const batch = todo.slice(i, i + PHOTO_BATCH);
      await runHelper(bin, ['export', tmp], JSON.stringify(batch.map((a) => a.id)), async (ev) => {
        if (ev.event === 'skip') result.skipped.push(`${ev.name} (${ev.message})`);
        if (ev.event === 'file') {
          const when = ev.date * 1000;
          const d = new Date(when);
          const st = await fs.stat(ev.path);
          const folder = `Photos/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
          if ((await client.uploadOnce(folder, path.basename(ev.path), ev.path, st.size, when)) === 'uploaded') result.imported++;
          await fs.rm(path.dirname(ev.path), { recursive: true, force: true });
        }
        if (ev.event === 'asset') {
          state.photos.push(ev.id);
          p.tick();
        }
      });
      await writeJson(statePath, state);
    }
  } finally {
    p.done();
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return result;
}

// ---------------------------------------------------------------- Plain folders: iCloud Drive, Voice Memos
async function uploadTree(client, label, localRoot, remoteRoot, opts, filter = () => true) {
  let files;
  try {
    files = (await walkFiles(localRoot)).filter((f) => filter(f.rel));
  } catch (e) {
    if (e.code === 'ENOENT') return { found: 0, skipped: [`${localRoot} not found`] };
    if (e.code === 'EPERM' || e.code === 'EACCES') return { found: 0, skipped: [`needs Full Disk Access for your terminal app (System Settings › Privacy & Security › Full Disk Access)`] };
    throw e;
  }
  if (opts.limit) files = files.slice(0, opts.limit);
  const bytes = files.reduce((a, f) => a + f.size, 0);
  if (opts.dryRun) return { found: files.length, bytes };
  const p = new Progress(label, files.length);
  let uploaded = 0;
  for (const f of files) {
    const dir = path.posix.join(remoteRoot, path.posix.dirname(f.rel.split(path.sep).join('/')));
    if ((await client.uploadOnce(dir, path.basename(f.rel), f.path, f.size, f.mtimeMs)) === 'uploaded') uploaded++;
    p.tick();
  }
  p.done();
  return { found: files.length, bytes, imported: uploaded, alreadyThere: files.length - uploaded };
}

const drive = (client, opts) => uploadTree(client, 'iCloud Drive', path.join(HOME, 'Library/Mobile Documents/com~apple~CloudDocs'), 'iCloud Drive', opts,
  (rel) => !rel.split(path.sep).some((s) => s.startsWith('.')) && !rel.endsWith('.icloud'));

async function voicememos(client, opts) {
  const candidates = [
    path.join(HOME, 'Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings'),
    path.join(HOME, 'Library/Application Support/com.apple.voicememos/Recordings'),
  ];
  for (const dir of candidates) {
    const r = await uploadTree(client, 'Voice Memos', dir, 'Voice Memos', opts, (rel) => /\.(m4a|qta|caf|wav|mp3)$/i.test(rel));
    if (r.found || !r.skipped?.[0]?.includes('not found')) return r;
  }
  return { found: 0, skipped: ['no Voice Memos found'] };
}

// ---------------------------------------------------------------- Safari bookmarks -> a standard bookmarks.html any browser imports
async function bookmarks(client, opts) {
  // Foundation reads the binary plist; only titles, URLs and folders cross back as JSON.
  let tree;
  try {
    tree = await jxa('Safari bookmarks', `ObjC.import('Foundation');
    function run(argv) {
      const d = $.NSDictionary.dictionaryWithContentsOfFile(argv[0]);
      if (d.isNil()) return JSON.stringify({ unreadable: true });
      const walk = (n) => {
        const s = (k) => { const v = n.objectForKey(k); return v.isNil() ? null : ObjC.unwrap(v); };
        const kids = n.objectForKey('Children');
        const out = { WebBookmarkType: s('WebBookmarkType'), Title: s('Title'), URLString: s('URLString') };
        const uri = n.objectForKey('URIDictionary');
        if (!uri.isNil()) out.URIDictionary = { title: ObjC.unwrap(uri.objectForKey('title')) };
        if (!kids.isNil()) { out.Children = []; for (let i = 0; i < kids.count; i++) out.Children.push(walk(kids.objectAtIndex(i))); }
        return out;
      };
      return JSON.stringify(walk(d));
    }`, [path.join(HOME, 'Library/Safari/Bookmarks.plist')], { timeout: 60 * 1000 });
  } catch (e) {
    throw new Error(e.message);
  }
  if (tree.unreadable) return { found: 0, skipped: ['Safari bookmarks unreadable: grant your terminal app Full Disk Access (System Settings › Privacy & Security)'] };
  let count = 0;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const render = (node, depth) => {
    const pad = '    '.repeat(depth);
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf') {
      count++;
      return `${pad}<DT><A HREF="${esc(node.URLString)}">${esc(node.URIDictionary?.title || node.URLString)}</A>\n`;
    }
    if (node.WebBookmarkType !== 'WebBookmarkTypeList') return '';
    const title = { BookmarksBar: 'Favorites', BookmarksMenu: 'Bookmarks Menu', 'com.apple.ReadingList': 'Reading List' }[node.Title] ?? node.Title;
    const inner = (node.Children ?? []).map((c) => render(c, depth + 1)).join('');
    return depth === 0 ? inner : `${pad}<DT><H3>${esc(title)}</H3>\n${pad}<DL><p>\n${inner}${pad}</DL><p>\n`;
  };
  const body = render(tree, 0);
  if (opts.dryRun) return { found: count };
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Safari Bookmarks</H1>\n<DL><p>\n${body}</DL><p>\n`;
  await client.putBytes('Bookmarks/Safari Bookmarks.html', html);
  return { found: count, imported: count };
}

const SOURCES = { contacts, calendars, reminders, notes, photos, drive, voicememos, bookmarks };

export async function importMac(client, { only = MAC_SOURCES, ...opts }, log) {
  if (process.platform !== 'darwin') throw new Error('`import mac` runs on a Mac. Elsewhere, use `import folder` or the web app’s Import buttons.');
  const summary = {};
  for (const name of only) {
    log(`\n▸ ${name}${opts.dryRun ? ' (dry run)' : ''}`);
    try {
      summary[name] = { ...(await SOURCES[name](client, opts)), ...(opts.dryRun && { dryRun: true }) };
    } catch (e) {
      summary[name] = { error: e.message };
    }
    const s = summary[name];
    log(s.error ? `  ✗ ${s.error}` : `  ✓ ${describe(s)}`);
    for (const skip of (s.skipped ?? []).slice(0, 8)) log(`    skipped: ${skip}`);
    if ((s.skipped?.length ?? 0) > 8) log(`    …and ${s.skipped.length - 8} more skipped`);
  }
  return summary;
}

function describe(s) {
  const parts = [`${s.found ?? 0} found`];
  if (s.toImport !== undefined) parts.push(`${s.toImport} to import`);
  if (s.alreadyImported) parts.push(`${s.alreadyImported} imported earlier`);
  if (s.imported !== undefined && !s.dryRun) parts.push(`${s.imported} imported`);
  if (s.alreadyThere) parts.push(`${s.alreadyThere} already there`);
  if (s.bytes) parts.push(`${(s.bytes / 1e9).toFixed(2)} GB`);
  return parts.join(', ');
}
