// Just enough iCalendar / vCard to drive the web UI. DAV clients get the raw files untouched.

export function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

// "DTSTART;TZID=Europe/Paris:20260923T100000" -> { name, params, value }
export function parseLine(line) {
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ':' && !inQuote) break;
  }
  const [name, ...rawParams] = line.slice(0, i).split(';');
  const params = {};
  for (const p of rawParams) {
    const j = p.indexOf('=');
    if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase().replace(/^ITEM\d+\./, ''), params, value: line.slice(i + 1) };
}

export const unescapeText = (s) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
export const escapeText = (s) => String(s ?? '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');

// Fold to 75 octets per RFC 5545 §3.1 (approximated by characters).
export function fold(lines) {
  return lines.map((l) => l.match(/.{1,74}/gu)?.join('\r\n ') ?? '').join('\r\n') + '\r\n';
}

// All-day -> "YYYY-MM-DD"; UTC -> ISO with Z; floating/TZID -> local ISO without zone.
function icalDate({ value, params }) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return { date: null, allDay: false };
  if (!m[4] || params.VALUE === 'DATE') return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  return { date: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`, allDay: false };
}

export function parseEvents(text) {
  const events = [];
  let cur = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const { name, params, value } = parseLine(line);
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !cur) { cur = { title: '' }; depth = 0; }
      else if (cur) depth++;
      continue;
    }
    if (name === 'END') {
      if (cur && depth === 0 && value.toUpperCase() === 'VEVENT') { events.push(cur); cur = null; }
      else if (cur) depth--;
      continue;
    }
    if (!cur || depth > 0) continue; // skip VALARM etc.
    if (name === 'SUMMARY') cur.title = unescapeText(value);
    else if (name === 'LOCATION') cur.location = unescapeText(value);
    else if (name === 'DESCRIPTION') cur.description = unescapeText(value);
    else if (name === 'UID') cur.uid = value;
    else if (name === 'RRULE') cur.rrule = value;
    else if (name === 'RECURRENCE-ID') cur.recurrenceId = value;
    else if (name === 'DTSTART') { const d = icalDate({ value, params }); cur.start = d.date; cur.allDay = d.allDay; }
    else if (name === 'DTEND') cur.end = icalDate({ value, params }).date;
  }
  return events.filter((e) => e.start);
}

const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildEvent({ uid, title, start, end, allDay, location, description }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DO-SAY-GO//MyCloud//EN', 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsStamp(Date.now())}`];
  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${start.slice(0, 10).replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${(end || start).slice(0, 10).replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end || start)}`);
  }
  lines.push(`SUMMARY:${escapeText(title)}`);
  if (location) lines.push(`LOCATION:${escapeText(location)}`);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return fold(lines);
}

export function parseContact(text) {
  const c = { name: '', emails: [], phones: [] };
  for (const line of unfold(text)) {
    const { name, value } = parseLine(line);
    if (name === 'FN') c.name = unescapeText(value);
    else if (name === 'N' && !c.name) c.name = value.split(';').slice(0, 2).reverse().map(unescapeText).join(' ').trim();
    else if (name === 'EMAIL') c.emails.push(unescapeText(value));
    else if (name === 'TEL') c.phones.push(unescapeText(value));
    else if (name === 'ORG') c.org = value.split(';').map(unescapeText).filter(Boolean).join(', ');
    else if (name === 'NOTE') c.note = unescapeText(value);
    else if (name === 'UID') c.uid = value;
  }
  return c;
}

export function buildContact({ uid, name, emails = [], phones = [], org, note }) {
  const parts = String(name).trim().split(/\s+/);
  const family = parts.length > 1 ? parts.pop() : '';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//DO-SAY-GO//MyCloud//EN', `UID:${uid}`, `FN:${escapeText(name)}`, `N:${escapeText(family)};${escapeText(parts.join(' '))};;;`];
  for (const e of emails.filter(Boolean)) lines.push(`EMAIL;TYPE=INTERNET:${escapeText(e)}`);
  for (const p of phones.filter(Boolean)) lines.push(`TEL;TYPE=CELL:${escapeText(p)}`);
  if (org) lines.push(`ORG:${escapeText(org)}`);
  if (note) lines.push(`NOTE:${escapeText(note)}`);
  lines.push(`REV:${icsStamp(Date.now())}`, 'END:VCARD');
  return fold(lines);
}
