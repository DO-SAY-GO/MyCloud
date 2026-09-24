// MyCloud web app — no framework, no build step.
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// replaceChildren that tolerates the same null/false/nested-array children as h().
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

class ApiError extends Error {}
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'X-MyCloud': '1', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new ApiError('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || res.statusText);
  return data;
}

const qs = (params) => '?' + new URLSearchParams(params);
const rawUrl = (path, extra = {}) => '/api/files/raw' + qs({ path, ...extra });
const thumbUrl = (path) => '/api/thumb' + qs({ path });
const joinPath = (...parts) => parts.flatMap((p) => String(p).split('/')).filter(Boolean).join('/');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
const fail = (e) => { if (!(e instanceof ApiError && e.message === 'signed out')) toast(e.message || String(e)); };

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Generic modal form. Resolves to field values, or null when cancelled.
function ask({ title, text, fields = [], submit = 'OK', danger = false, extra }) {
  const dialog = $('#dialog');
  const form = $('#dialog-form');
  fill(form, 
    h('h3', {}, title),
    text ? h('p', { class: 'muted' }, text) : null,
    extra ?? null,
    ...fields.map((f) => f.type === 'checkbox'
      ? h('label', { class: 'row' }, h('input', { type: 'checkbox', name: f.name, checked: !!f.value, style: { width: 'auto' } }), f.label)
      : f.type === 'file'
        ? h('label', {}, f.label, h('input', { type: 'file', name: f.name, accept: f.accept || '', required: !!f.required }))
      : f.type === 'select'
        ? h('label', {}, f.label, h('select', { name: f.name }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l))))
        : f.type === 'textarea'
          ? h('label', {}, f.label, h('textarea', { name: f.name, rows: 3 }, f.value ?? ''))
          : h('label', {}, f.label, h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', required: !!f.required, placeholder: f.placeholder || '', autocomplete: 'off' }))),
    h('div', { class: 'buttons' },
      submit ? h('button', { value: 'cancel', formNoValidate: true }, 'Cancel') : null,
      h('button', { value: 'ok', class: danger ? 'danger' : 'primary' }, submit || 'Done')),
  );
  dialog.returnValue = '';
  dialog.showModal();
  form.querySelector('input:not([type=checkbox]),textarea')?.select?.();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'ok') return resolve(null);
      const out = {};
      for (const f of fields) {
        const input = form.elements[f.name];
        out[f.name] = f.type === 'checkbox' ? input.checked : f.type === 'file' ? input.files[0] ?? null : input.value.trim();
      }
      resolve(out);
    }, { once: true });
  });
}

// Uploads use XHR for progress reporting.
function uploadFile(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', rawUrl(path));
    xhr.setRequestHeader('X-MyCloud', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

async function uploadAll(files, dirFor) {
  const bar = document.body.appendChild(h('div', { class: 'progress', style: { width: '0' } }));
  const total = files.reduce((a, f) => a + f.size, 0) || 1;
  let done = 0;
  try {
    for (const f of files) {
      await uploadFile(joinPath(dirFor(f), f.name), f, (p) => { bar.style.width = `${((done + p * f.size) / total) * 100}%`; });
      done += f.size;
    }
    toast(`Uploaded ${files.length} item${files.length === 1 ? '' : 's'}`);
  } finally {
    bar.remove();
  }
}

function pickFiles(accept = '') {
  const input = $('#file-input');
  input.accept = accept;
  input.value = '';
  return new Promise((resolve) => {
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

function enableDrop(el, onFiles) {
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('dropping'); };
  el.ondragleave = () => el.classList.remove('dropping');
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('dropping');
    const files = [...e.dataTransfer.files];
    if (files.length) onFiles(files);
  };
}

// ---------------------------------------------------------------- Drive
async function driveView(view, pathParts) {
  const cwd = pathParts.join('/');
  const { items } = await api('GET', '/files' + qs({ path: cwd }));
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const go = (p) => { location.hash = '#drive/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/'); };
  const refresh = () => route();

  const upload = async (files) => { await uploadAll(files, () => cwd).catch(fail); refresh(); };
  const crumbs = h('div', { class: 'crumbs' }, h('a', { href: '#drive' }, 'Drive'),
    pathParts.map((p, i) => [' › ', h('a', { href: '#drive/' + pathParts.slice(0, i + 1).map(encodeURIComponent).join('/') }, p)]));

  const row = (it) => {
    const full = joinPath(cwd, it.name);
    const open = () => (it.dir ? go(full) : window.open(rawUrl(full), '_blank'));
    return h('tr', {},
      h('td', { class: 'name', onclick: open }, `${it.shared ? '👨‍👩‍👧' : it.dir ? '📁' : fileIcon(it.name)}  ${it.name}`, it.shared ? h('small', { class: 'muted' }, '  shared with your family') : null),
      h('td', { class: 'meta hide-sm' }, it.dir ? '—' : fmtSize(it.size)),
      h('td', { class: 'meta hide-sm' }, fmtDate(it.mtime)),
      h('td', { class: 'actions' },
        it.dir ? null : h('button', { class: 'icon', title: 'Download', onclick: () => { location.href = rawUrl(full, { download: 1 }); } }, '⬇️'),
        h('button', { class: 'icon', title: 'Share link', onclick: () => shareItem(full, it.dir) }, '🔗'),
        it.shared ? null : h('button', { class: 'icon', title: 'Rename', onclick: async () => {
          const r = await ask({ title: 'Rename', fields: [{ name: 'name', label: 'Name', value: it.name, required: true }], submit: 'Rename' });
          if (r && r.name !== it.name) await api('POST', '/files/move', { from: full, to: joinPath(cwd, r.name) }).then(refresh, fail);
        } }, '✏️'),
        it.shared ? null : h('button', { class: 'icon', title: 'Delete', onclick: async () => {
          if (await ask({ title: `Delete “${it.name}”?`, text: `${it.dir ? 'The folder and everything in it move' : 'It moves'} to Recently Deleted for 30 days.`, submit: 'Delete', danger: true })) {
            await api('DELETE', '/files' + qs({ path: full })).then(refresh, fail);
          }
        } }, '🗑️')));
  };

  const table = items.length
    ? h('table', { class: 'files' }, h('tbody', {}, items.map(row)))
    : h('div', { class: 'empty' }, 'This folder is empty. Drop files here to upload.');
  const card = h('div', { class: 'card' }, table);
  enableDrop(card, upload);

  fill(view, 
    h('div', { class: 'view-head' },
      h('h2', {}, pathParts.at(-1) || 'Drive'),
      h('button', { onclick: async () => {
        const r = await ask({ title: 'New folder', fields: [{ name: 'name', label: 'Name', required: true }], submit: 'Create' });
        if (r) await api('POST', '/files/mkdir', { path: joinPath(cwd, r.name) }).then(refresh, fail);
      } }, 'New folder'),
      h('button', { onclick: () => { location.hash = '#trash'; } }, 'Recently Deleted'),
      h('button', { class: 'primary', onclick: async () => upload(await pickFiles()) }, 'Upload')),
    crumbs, card);
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (/^(png|jpe?g|gif|webp|heic|heif|avif|svg)$/.test(ext)) return '🖼️';
  if (/^(mp4|mov|m4v|webm)$/.test(ext)) return '🎬';
  if (/^(mp3|m4a|wav|flac|aac)$/.test(ext)) return '🎵';
  if (ext === 'pdf') return '📕';
  if (/^(zip|gz|tar|7z|rar)$/.test(ext)) return '📦';
  if (/^(md|txt|rtf|docx?|pages)$/.test(ext)) return '📄';
  return '📄';
}

async function shareItem(path, isDir = false) {
  const name = path.split('/').pop();
  const r = await ask({
    title: `Share “${name}”`,
    text: isDir
      ? `Anyone with the link can browse and download everything inside “${name}”, including its subfolders and anything added later.`
      : 'Anyone with the link can view and download this file.',
    fields: [{ name: 'days', label: 'Link works for', type: 'select', value: '7', options: [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['365', '1 year'], ['0', 'Until I revoke it']] }],
    submit: 'Create link',
  });
  if (!r) return;
  try {
    const { url } = await api('POST', '/shares', { path, days: Number(r.days) });
    const full = location.origin + url;
    await navigator.clipboard?.writeText(full).catch(() => {});
    await ask({ title: 'Link copied', text: 'Revoke it any time in Settings › Share links.', extra: h('div', { class: 'secret small' }, full), submit: null });
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- Recently Deleted
async function trashView(view) {
  const { items } = await api('GET', '/trash');
  fill(view,
    h('div', { class: 'view-head' }, h('h2', {}, 'Recently Deleted'), h('a', { href: '#drive' }, '‹ Drive')),
    h('p', { class: 'muted' }, 'Deleted items stay here for 30 days. Things deleted from the Family folder can be restored by anyone in the family.'),
    items.length ? h('div', { class: 'card' }, h('table', { class: 'files trash' }, h('tbody', {}, items.map((it) => h('tr', {},
      h('td', { class: 'name' }, `${it.shared ? '👨‍👩‍👧' : it.dir ? '📁' : fileIcon(it.rel)}  ${it.rel}`, h('small', { class: 'muted' }, `  deleted by ${it.by}`)),
      h('td', { class: 'meta hide-sm' }, fmtDate(Date.parse(it.deletedAt))),
      h('td', { class: 'actions' },
        h('button', { onclick: () => api('POST', '/trash/restore', { id: it.id, shared: it.shared }).then((r) => { toast(`Restored to ${r.path}`); route(); }, fail) }, 'Restore'),
        !it.shared || me.admin ? h('button', { class: 'icon danger', title: 'Delete now', onclick: async () => {
          if (await ask({ title: 'Delete forever?', text: `“${it.rel}” will be erased and can’t be restored.`, submit: 'Delete forever', danger: true })) {
            await api('DELETE', '/trash' + qs({ id: it.id, shared: it.shared ? 1 : 0 })).then(() => route(), fail);
          }
        } }, '✕') : null))))))
      : h('div', { class: 'card empty' }, 'Nothing here.'));
}

// ---------------------------------------------------------------- Photos
async function photosView(view) {
  const { photos } = await api('GET', '/photos');
  const upload = async (files, root = 'Photos') => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await uploadAll(files, () => `${root}/${month}`).catch(fail);
    route();
  };
  const grid = h('div', { class: 'grid' });
  let lastMonth = '';
  photos.forEach((p, i) => {
    const month = new Date(p.mtime).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (month !== lastMonth) { grid.append(h('div', { class: 'month-label' }, month)); lastMonth = month; }
    const img = h('img', { src: thumbUrl(p.path), loading: 'lazy', alt: p.name, onerror: () => img.replaceWith(h('div', { class: 'empty' }, p.video ? '🎬' : '🖼️')) });
    const badge = [p.video ? '▶︎' : '', p.path.startsWith('Family/') ? '👨‍👩‍👧' : ''].join(' ').trim();
    grid.append(h('button', { class: 'tile', onclick: () => lightbox(photos, i) }, img, badge ? h('span', { class: 'badge' }, badge) : null));
  });
  const body = photos.length ? grid : h('div', { class: 'card empty' }, 'No photos yet. Upload some, or point your phone’s backup app at the Photos folder.');
  enableDrop(view, upload);
  fill(view, 
    h('div', { class: 'view-head' }, h('h2', {}, 'Photos'), h('span', { class: 'muted' }, `${photos.length} items`),
      h('button', { title: 'Everyone in your family sees these', onclick: async () => upload(await pickFiles('image/*,video/*'), 'Family/Photos') }, 'Share with family'),
      h('button', { class: 'primary', onclick: async () => upload(await pickFiles('image/*,video/*')) }, 'Upload')),
    body);
}

function lightbox(photos, index) {
  let i = index;
  const stage = h('div');
  const caption = h('div', { class: 'caption' });
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
  const show = () => {
    const p = photos[i];
    const media = p.video
      ? h('video', { src: rawUrl(p.path), controls: true, autoplay: true, playsInline: true })
      : h('img', { src: rawUrl(p.path), alt: p.name, onerror: (e) => { if (!e.target.dataset.fallback) { e.target.dataset.fallback = 1; e.target.src = thumbUrl(p.path); } } });
    fill(stage, media);
    caption.textContent = `${p.name} · ${fmtDate(p.mtime)} · ${fmtSize(p.size)}`;
  };
  const step = (d) => { i = (i + d + photos.length) % photos.length; show(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
  const box = h('div', { class: 'lightbox', onclick: (e) => { if (e.target === box) close(); } },
    stage, caption,
    h('button', { class: 'nav prev', onclick: () => step(-1) }, '‹'),
    h('button', { class: 'nav next', onclick: () => step(1) }, '›'),
    h('div', { class: 'bar' },
      h('button', { onclick: () => { location.href = rawUrl(photos[i].path, { download: 1 }); } }, 'Download'),
      h('button', { onclick: () => shareItem(photos[i].path) }, 'Share'),
      h('button', { onclick: close }, 'Close')));
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  show();
}

// ---------------------------------------------------------------- Notes
const notesState = { current: null };
async function notesView(view) {
  const { items } = await api('GET', '/files' + qs({ path: 'Notes' }));
  const notes = items.filter((it) => !it.dir && /\.(md|txt)$/i.test(it.name)).sort((a, b) => b.mtime - a.mtime);
  if (!notes.some((n) => n.name === notesState.current)) notesState.current = notes[0]?.name ?? null;

  const list = h('div', { class: 'card note-list' });
  const textarea = h('textarea', { placeholder: 'Start typing…', spellcheck: true });
  const status = h('div', { class: 'note-status' });
  const editor = h('div', { class: 'card note-editor' }, textarea, status);

  const renderList = () => fill(list, ...(notes.length ? notes.map((n) => h('button', {
    class: n.name === notesState.current ? 'active' : '',
    onclick: () => { notesState.current = n.name; renderList(); load(); },
  }, n.name.replace(/\.(md|txt)$/i, ''), h('small', {}, fmtDate(n.mtime)))) : [h('div', { class: 'empty' }, 'No notes')]));

  let timer;
  let saving = Promise.resolve();
  const save = (name) => {
    saving = saving.then(async () => {
      status.textContent = 'Saving…';
      const res = await fetch(rawUrl(`Notes/${name}`), { method: 'PUT', headers: { 'X-MyCloud': '1' }, body: textarea.value });
      status.textContent = res.ok ? 'Saved' : 'Save failed';
    }).catch(() => { status.textContent = 'Save failed'; });
  };
  textarea.oninput = () => {
    const name = notesState.current;
    if (!name) return;
    status.textContent = 'Edited';
    clearTimeout(timer);
    timer = setTimeout(() => save(name), 700);
  };
  const load = async () => {
    textarea.disabled = !notesState.current;
    textarea.value = '';
    status.textContent = '';
    if (!notesState.current) return;
    const res = await fetch(rawUrl(`Notes/${notesState.current}`), { cache: 'no-store' });
    textarea.value = res.ok ? await res.text() : '';
    textarea.focus();
  };

  fill(view, 
    h('div', { class: 'view-head' }, h('h2', {}, 'Notes'),
      notesState.current ? h('button', { class: 'danger', onclick: async () => {
        if (await ask({ title: `Delete “${notesState.current}”?`, submit: 'Delete', danger: true })) {
          await api('DELETE', '/files' + qs({ path: `Notes/${notesState.current}` })).then(() => { notesState.current = null; route(); }, fail);
        }
      } }, 'Delete') : null,
      h('button', { class: 'primary', onclick: async () => {
        const r = await ask({ title: 'New note', fields: [{ name: 'title', label: 'Title', required: true }], submit: 'Create' });
        if (!r) return;
        const name = `${r.title.replace(/[\\/:]/g, '-')}.md`;
        await fetch(rawUrl(`Notes/${name}`), { method: 'PUT', headers: { 'X-MyCloud': '1' }, body: `# ${r.title}\n\n` });
        notesState.current = name;
        route();
      } }, 'New note')),
    h('div', { class: 'notes' }, list, editor));
  renderList();
  load();
}

// ---------------------------------------------------------------- Calendar
const calState = { month: new Date(new Date().getFullYear(), new Date().getMonth(), 1) };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localDate = (s) => (s.length === 10 ? new Date(`${s}T00:00:00`) : new Date(s));

// Expand simple RRULEs (FREQ/INTERVAL/COUNT/UNTIL) into occurrence start dates inside [from, to).
function occurrences(ev, from, to) {
  const start = localDate(ev.start);
  if (!ev.rrule) return start < to ? [start] : [];
  const rule = Object.fromEntries(ev.rrule.split(';').map((kv) => kv.split('=')));
  const interval = Number(rule.INTERVAL || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? localDate(rule.UNTIL.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')) : null;
  const out = [];
  const d = new Date(start);
  for (let n = 0; n < count && d < to && n < 5000; n++) {
    if (until && d > new Date(until.getTime() + 86400000)) break;
    if (d >= new Date(from.getTime() - 40 * 86400000)) out.push(new Date(d));
    if (rule.FREQ === 'DAILY') d.setDate(d.getDate() + interval);
    else if (rule.FREQ === 'WEEKLY') d.setDate(d.getDate() + 7 * interval);
    else if (rule.FREQ === 'MONTHLY') d.setMonth(d.getMonth() + interval);
    else if (rule.FREQ === 'YEARLY') d.setFullYear(d.getFullYear() + interval);
    else break;
  }
  return out;
}

async function calendarView(view) {
  const [{ calendars }, { events }] = await Promise.all([api('GET', '/calendars'), api('GET', '/events')]);
  const color = Object.fromEntries(calendars.map((c) => [c.id, c.color]));
  const first = calState.month;
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start Monday
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const byDay = new Map();
  for (const ev of events.filter((e) => !e.recurrenceId)) {
    const durDays = ev.allDay && ev.end ? Math.max(1, Math.round((localDate(ev.end) - localDate(ev.start)) / 86400000)) : 1;
    for (const occ of occurrences(ev, gridStart, gridEnd)) {
      for (let k = 0; k < durDays; k++) {
        const day = new Date(occ);
        day.setDate(day.getDate() + k);
        const key = ymd(day);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push({ ev, at: occ });
      }
    }
  }

  const today = ymd(new Date());
  const cal = h('div', { class: 'card cal' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('div', { class: 'dow' }, d)));
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + i);
    const key = ymd(day);
    const list = (byDay.get(key) ?? []).sort((a, b) => (b.ev.allDay - a.ev.allDay) || (a.at - b.at));
    cal.append(h('div', {
      class: `day${day.getMonth() !== first.getMonth() ? ' other' : ''}${key === today ? ' today' : ''}`,
      onclick: (e) => { if (e.target === e.currentTarget || e.target.classList.contains('num')) addEvent(key, calendars); },
    },
    h('div', { class: 'num' }, h('span', {}, day.getDate())),
    list.map(({ ev, at }) => h('button', {
      class: 'chip', style: { background: color[ev.calendar] || '#0a84ff' },
      title: ev.title,
      onclick: () => eventDetails(ev, at),
    }, `${ev.allDay ? '' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ' '}${ev.title || '(untitled)'}`))));
  }

  const shift = (n) => { calState.month = new Date(first.getFullYear(), first.getMonth() + n, 1); route(); };
  fill(view, 
    h('div', { class: 'view-head' },
      h('h2', {}, first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
      h('button', { onclick: () => shift(-1) }, '‹'),
      h('button', { onclick: () => { calState.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); route(); } }, 'Today'),
      h('button', { onclick: () => shift(1) }, '›'),
      h('button', { onclick: () => importCalendar(calendars) }, 'Import'),
      h('button', { class: 'primary', onclick: () => addEvent(ymd(new Date()), calendars) }, 'New event')),
    cal);
}

async function importInto(type, params, body) {
  const res = await fetch('/api/import' + qs({ type, ...params }), { method: 'POST', headers: { 'X-MyCloud': '1' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'import failed');
  toast(`Imported ${data.imported} ${type === 'calendar' ? 'event' : 'contact'}${data.imported === 1 ? '' : 's'}`);
  route();
}

async function importCalendar(calendars) {
  const r = await ask({
    title: 'Import a calendar', submit: 'Import',
    text: 'Choose an .ics file exported from iCloud.com, Google or Outlook — or paste a calendar link, like the webcal:// link from a shared iCloud calendar.',
    fields: [
      { name: 'file', label: '.ics file', type: 'file', accept: '.ics,text/calendar' },
      { name: 'url', label: 'or a calendar link', placeholder: 'webcal://…' },
      { name: 'target', label: 'Into', type: 'select', value: '', options: [['', 'A new calendar'], ...calendars.map((c) => [c.id, c.name])] },
    ],
  });
  if (!r) return;
  if (!r.file && !r.url) return toast('Choose a file or paste a link');
  const name = r.file ? r.file.name.replace(/\.ics$/i, '') : 'Imported calendar';
  await importInto('calendar', { target: r.target, name, ...(r.url && !r.file && { url: r.url }) }, r.file ?? undefined).catch(fail);
}

async function addEvent(date, calendars) {
  const r = await ask({
    title: 'New event', submit: 'Add',
    fields: [
      { name: 'title', label: 'Title', required: true },
      { name: 'date', label: 'Date', type: 'date', value: date, required: true },
      { name: 'allDay', label: 'All day', type: 'checkbox' },
      { name: 'from', label: 'Starts', type: 'time', value: '09:00' },
      { name: 'to', label: 'Ends', type: 'time', value: '10:00' },
      { name: 'location', label: 'Location' },
      { name: 'calendar', label: 'Calendar', type: 'select', options: calendars.map((c) => [c.id, c.name]), value: calendars[0]?.id },
    ],
  });
  if (!r) return;
  let body;
  if (r.allDay) {
    const end = localDate(r.date);
    end.setDate(end.getDate() + 1);
    body = { title: r.title, allDay: true, start: r.date, end: ymd(end) };
  } else {
    const start = new Date(`${r.date}T${r.from || '09:00'}`);
    let end = new Date(`${r.date}T${r.to || r.from || '10:00'}`);
    if (end <= start) end = new Date(start.getTime() + 3600000);
    body = { title: r.title, start: start.toISOString(), end: end.toISOString() };
  }
  await api('POST', '/events', { ...body, location: r.location, calendar: r.calendar }).then(() => route(), fail);
}

async function eventDetails(ev, at) {
  const when = ev.allDay ? at.toLocaleDateString(undefined, { dateStyle: 'full' }) : at.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const text = [when, ev.location, ev.rrule && 'Repeats — deleting removes the whole series', ev.description].filter(Boolean).join('\n');
  const r = await ask({ title: ev.title || '(untitled)', extra: h('p', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, text), submit: 'Delete', danger: true });
  if (r) await api('DELETE', '/events' + qs({ calendar: ev.calendar, file: ev.file })).then(() => route(), fail);
}

// ---------------------------------------------------------------- Contacts
const contactState = { selected: null, filter: '' };
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

async function contactsView(view) {
  const { contacts } = await api('GET', '/contacts');
  const list = h('div', { class: 'card contact-list' });
  const detail = h('div', { class: 'card contact-card' });
  const search = h('input', { type: 'search', placeholder: 'Search', value: contactState.filter });

  const renderDetail = () => {
    const c = contacts.find((x) => x.file === contactState.selected);
    if (!c) return fill(detail, h('div', { class: 'empty' }, contacts.length ? 'Select a contact' : 'No contacts yet. Add one, or sync from your phone.'));
    const field = (label, values) => values.filter(Boolean).map((v) => [h('dt', {}, label), h('dd', {}, v)]);
    fill(detail, 
      h('div', { class: 'avatar big' }, initials(c.name)),
      h('h2', {}, c.name || '(no name)'),
      c.org ? h('div', { class: 'muted' }, c.org) : null,
      h('dl', {},
        c.emails.map((e) => [h('dt', {}, 'email'), h('dd', {}, h('a', { href: `mailto:${e}` }, e))]),
        c.phones.map((p) => [h('dt', {}, 'phone'), h('dd', {}, h('a', { href: `tel:${p}` }, p))]),
        field('note', [c.note])),
      h('p', {}, h('button', { class: 'danger', onclick: async () => {
        if (await ask({ title: `Delete ${c.name}?`, submit: 'Delete', danger: true })) {
          await api('DELETE', '/contacts' + qs({ book: c.book, file: c.file })).then(() => { contactState.selected = null; route(); }, fail);
        }
      } }, 'Delete contact')));
  };
  const renderList = () => {
    const f = contactState.filter.toLowerCase();
    const shown = contacts.filter((c) => !f || [c.name, c.org, ...c.emails, ...c.phones].join(' ').toLowerCase().includes(f));
    fill(list, ...shown.map((c) => h('button', {
      class: c.file === contactState.selected ? 'active' : '',
      onclick: () => { contactState.selected = c.file; renderList(); renderDetail(); },
    }, h('span', { class: 'avatar' }, initials(c.name)), h('span', {}, c.name || '(no name)'))));
  };
  search.oninput = () => { contactState.filter = search.value; renderList(); };

  fill(view, 
    h('div', { class: 'view-head' }, h('h2', {}, 'Contacts'), h('span', { class: 'muted' }, contacts.length),
      h('button', { class: 'primary', onclick: async () => {
        const r = await ask({ title: 'New contact', submit: 'Add', fields: [
          { name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email' },
          { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'org', label: 'Company' }, { name: 'note', label: 'Note', type: 'textarea' }] });
        if (!r) return;
        await api('POST', '/contacts', { name: r.name, emails: [r.email], phones: [r.phone], org: r.org, note: r.note })
          .then(({ file }) => { contactState.selected = file; route(); }, fail);
      } }, 'New contact'),
      h('button', { onclick: async () => {
        const r = await ask({ title: 'Import contacts', submit: 'Import', text: 'Choose a .vcf file — e.g. from iCloud.com › Contacts › select all › Export vCard, or Google Contacts › Export.',
          fields: [{ name: 'file', label: '.vcf file', type: 'file', accept: '.vcf,text/vcard', required: true }] });
        if (r?.file) await importInto('contacts', {}, r.file).catch(fail);
      } }, 'Import')),
    h('div', { class: 'contacts' }, h('div', { style: { display: 'grid', gap: '8px', alignContent: 'start' } }, search, list), detail));
  renderList();
  renderDetail();
}

// ---------------------------------------------------------------- Settings
async function settingsView(view) {
  const [{ appPasswords }, { shares }, family, { events }] = await Promise.all([api('GET', '/app-passwords'), api('GET', '/shares'), api('GET', '/family'), api('GET', '/activity')]);
  const secureOrigin = me.secure;
  const cli = (sub) => `npx github:DO-SAY-GO/MyCloud import ${sub} --server ${me.origin} --user ${me.user}`;

  const shareLink = async (title, text, path) => {
    const url = location.origin + path;
    const actions = h('div', { class: 'row' },
      navigator.share ? h('button', { type: 'button', class: 'primary', onclick: () => navigator.share({ title, text, url }).catch(() => {}) }, 'Send…') : null,
      h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied')) }, 'Copy link'));
    await ask({ title, text, extra: [h('div', { class: 'secret small' }, url), actions], submit: null });
  };

  const setUpDevice = h('div', { class: 'card hero' },
    h('h3', {}, 'Set up this iPhone, iPad or Mac'),
    h('p', { class: 'muted' }, 'One tap adds your MyCloud calendars and contacts to the built-in apps. No app to install, and no server addresses to type.'),
    !secureOrigin ? h('p', { class: 'error' }, 'This server isn’t on HTTPS yet. Put it behind Tailscale or Caddy before using it away from home.') : null,
    h('div', { class: 'row' },
      h('button', { class: 'primary big', onclick: async () => {
        const r = await ask({ title: 'Name this device', fields: [{ name: 'label', label: 'Device', value: /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : 'Mac', required: true }], submit: 'Download profile' });
        if (!r) return;
        try {
          const { url } = await api('POST', '/profile', { label: r.label });
          location.href = url;
          await ask({ title: 'Almost there', submit: null, extra: h('ol', { class: 'steps' },
            h('li', {}, 'Tap Allow if asked to download a configuration profile.'),
            h('li', {}, 'iPhone/iPad: open Settings › Profile Downloaded › Install. Mac: System Settings › Privacy & Security › Profiles.'),
            h('li', {}, 'Open Calendar and Contacts — your MyCloud accounts are there.')) });
          route();
        } catch (e) { fail(e); }
      } }, 'Add MyCloud to this device')),
    h('details', {},
      h('summary', {}, 'Other devices and manual setup'),
      h('dl', {},
        h('dt', {}, 'Server'), h('dd', {}, me.origin.replace(/^https?:\/\//, '')),
        h('dt', {}, 'Username'), h('dd', {}, me.user),
        h('dt', {}, 'CalDAV / CardDAV'), h('dd', {}, `${me.origin}/dav/`),
        h('dt', {}, 'Files (WebDAV)'), h('dd', {}, `${me.origin}/dav/files/${encodeURIComponent(me.user)}/`)),
      h('ul', { class: 'muted' },
        h('li', {}, 'Android: DAVx⁵ with the CalDAV/CardDAV URL and an app password.'),
        h('li', {}, 'Finder: Go › Connect to Server (⌘K) and paste the Files URL.'),
        h('li', {}, 'Photo backup: any WebDAV backup app (e.g. PhotoSync) pointed at Photos/.'))));

  const bringStuff = h('div', { class: 'card' },
    h('h3', {}, 'Bring your stuff'),
    h('p', { class: 'muted' }, 'On your Mac, paste this into Terminal. It copies your Contacts, Calendars, Notes, Photos and iCloud Drive into MyCloud. It’s safe to run again, and it picks up where it left off.'),
    h('div', { class: 'code' }, h('code', {}, cli('mac')), h('button', { class: 'icon', title: 'Copy', onclick: () => navigator.clipboard.writeText(cli('mac')).then(() => toast('Copied')) }, '⧉')),
    h('p', { class: 'muted' }, 'Photos straight from an iPhone over USB (plug it in, unlock it, tap Trust):'),
    h('div', { class: 'code' }, h('code', {}, cli('iphone')), h('button', { class: 'icon', title: 'Copy', onclick: () => navigator.clipboard.writeText(cli('iphone')).then(() => toast('Copied')) }, '⧉')),
    h('p', { class: 'muted' }, 'No Mac? Import .ics and .vcf files from the Calendar and Contacts pages.'));

  const familyCard = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', { style: { marginRight: 'auto' } }, 'Family'),
      family.admin ? h('button', { class: 'primary', onclick: async () => {
        try {
          const { url } = await api('POST', '/family/invites', { kind: 'join' });
          await shareLink('Invite to MyCloud', 'Join our family cloud: photos, calendar and files that we own.', url);
          route();
        } catch (e) { fail(e); }
      } }, 'Invite someone') : null),
    h('p', { class: 'muted' }, 'Everyone here shares the Family folder, the Family photo album and the Family calendar. Everything else stays private to each person.'),
    family.members.map((m) => h('div', { class: 'list-row' },
      h('span', { class: 'row' }, h('span', { class: 'avatar' }, initials(m.name)), m.name, m.admin ? h('small', { class: 'pill' }, 'admin') : null, m.name === me.user ? h('small', { class: 'muted' }, '(you)') : null),
      family.admin && m.name !== me.user ? h('span', { class: 'row' },
        h('button', { onclick: async () => {
          try {
            const { url } = await api('POST', '/family/invites', { kind: 'reset', username: m.name });
            await shareLink(`Password reset for ${m.name}`, `Send this to ${m.name}. It works once, for 24 hours.`, url);
          } catch (e) { fail(e); }
        } }, 'Reset password'),
        h('button', { class: 'danger', onclick: async () => {
          if (await ask({ title: `Remove ${m.name}?`, text: 'They lose access right away. Their files are kept on the server (in removed/) until you delete them.', submit: 'Remove', danger: true })) {
            await api('DELETE', '/family/members' + qs({ name: m.name })).then(() => route(), fail);
          }
        } }, 'Remove')) : null)),
    family.invites.filter((i) => i.kind === 'join').map((i) => h('div', { class: 'list-row' },
      h('span', { class: 'muted' }, `Invite link · expires ${fmtDate(i.expires)}`),
      h('button', { class: 'danger', onclick: () => api('DELETE', '/family/invites' + qs({ id: i.id })).then(() => route(), fail) }, 'Revoke'))));

  fill(view,
    h('div', { class: 'view-head' }, h('h2', {}, 'Settings')),
    h('div', { class: 'settings' },
      setUpDevice,
      familyCard,
      bringStuff,

      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h3', { style: { marginRight: 'auto' } }, 'App passwords'),
          h('button', { onclick: async () => {
            const r = await ask({ title: 'New app password', fields: [{ name: 'label', label: 'Device name', placeholder: 'e.g. Thunderbird', required: true }], submit: 'Create' });
            if (!r) return;
            try {
              const { password } = await api('POST', '/app-passwords', { label: r.label });
              await ask({ title: `App password for ${r.label}`, text: 'Enter this as the password on your device. It won’t be shown again.', extra: h('div', { class: 'secret' }, password), submit: null });
              route();
            } catch (e) { fail(e); }
          } }, 'Create')),
        h('p', { class: 'muted' }, 'Each device gets its own password, which you can revoke at any time. Profiles created above show up here too.'),
        appPasswords.length ? appPasswords.map((a) => h('div', { class: 'list-row' },
          h('span', {}, a.label, h('br'), h('small', { class: 'muted' }, `created ${fmtDate(a.created)}${a.lastUsed ? ` · last used ${fmtDate(a.lastUsed)}` : ' · never used'}`)),
          h('button', { class: 'danger', onclick: () => api('DELETE', '/app-passwords' + qs({ id: a.id })).then(() => route(), fail) }, 'Revoke')))
          : null),

      h('div', { class: 'card' },
        h('h3', {}, 'Share links'),
        shares.length ? shares.map((s) => h('div', { class: 'list-row' },
          h('span', {}, s.path, s.dir ? ' (folder, everything inside)' : '', h('br'), h('small', { class: 'muted' }, h('a', { href: `/s/${s.token}`, target: '_blank' }, 'open'),
            ` · created ${fmtDate(s.created)}`, s.expires ? (s.expires < Date.now() ? ' · expired' : ` · expires ${fmtDate(s.expires)}`) : ' · never expires')),
          h('button', { class: 'danger', onclick: () => api('DELETE', '/shares' + qs({ token: s.token })).then(() => route(), fail) }, 'Revoke')))
          : h('p', { class: 'muted' }, 'No active links.')),

      h('div', { class: 'card' },
        h('h3', {}, family.admin ? 'Activity (everyone)' : 'Your activity'),
        h('p', { class: 'muted' }, 'Sign-ins, sharing, deletions, device passwords and invites.'),
        events.length ? h('table', { class: 'files activity' }, h('tbody', {}, events.slice(0, 25).map((e) => h('tr', {},
          h('td', { class: 'meta' }, fmtDate(Date.parse(e.t))),
          h('td', {}, describeEvent(e)),
          h('td', { class: 'meta hide-sm' }, e.ip || ''))))) : h('p', { class: 'muted' }, 'Nothing yet.')),

      h('div', { class: 'card' },
        h('h3', {}, 'Account'),
        me.disk ? h('p', { class: 'muted' }, `${fmtSize(me.disk.free)} free of ${fmtSize(me.disk.total)}`) : null,
        h('div', { class: 'row' },
          h('button', { onclick: async () => {
            const r = await ask({ title: 'Change password', submit: 'Change',
              text: 'Other browsers are signed out. Unless you keep them, your phones and laptops are disconnected too and need to be set up again (safest if you think a password leaked).',
              fields: [
                { name: 'current', label: 'Current password', type: 'password', required: true },
                { name: 'next', label: 'New password (8+ characters)', type: 'password', required: true },
                { name: 'keepDevices', label: 'Keep my devices connected', type: 'checkbox' }] });
            if (r) await api('POST', '/password', r).then(() => { toast(r.keepDevices ? 'Password changed' : 'Password changed. Devices were disconnected.'); route(); }, fail);
          } }, 'Change password'),
          h('button', { onclick: () => api('POST', '/logout').then(showLogin, fail) }, 'Sign out')))));
}

const EVENT_TEXT = {
  login: 'signed in', 'login.fail': 'failed sign-in', 'file.delete': 'deleted', 'file.restore': 'restored', 'file.purge': 'erased from trash',
  'share.create': 'shared', 'share.revoke': 'revoked a link', 'share.access': 'link opened:', 'device.add': 'added device', 'device.revoke': 'revoked a device',
  'device.profile': 'set up device', 'password.change': 'changed password', 'invite.create': 'created an invite', 'invite.reset': 'created a reset link for',
  'invite.redeem': 'joined', 'member.remove': 'removed',
};
function describeEvent(e) {
  const what = [e.path, e.label, e.target].filter(Boolean).join(' ');
  return `${e.user ?? 'someone'} ${EVENT_TEXT[e.event] ?? e.event}${what ? ` ${what}` : ''}`;
}

// ---------------------------------------------------------------- shell
let me = null;
const VIEWS = { trash: trashView, drive: driveView, photos: photosView, notes: notesView, calendar: calendarView, contacts: contactsView, settings: settingsView };

async function route() {
  if (!me) return;
  const [name, ...rest] = location.hash.slice(1).split('/');
  const view = VIEWS[name] ? name : 'drive';
  for (const a of document.querySelectorAll('.sidebar a')) a.classList.toggle('active', a.dataset.view === (view === 'trash' ? 'drive' : view));
  const el = $('#view');
  el.ondragover = el.ondrop = el.ondragleave = null;
  try {
    await VIEWS[view](el, rest.map(decodeURIComponent));
  } catch (e) {
    fail(e);
  }
}

function showLogin() {
  me = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form').password.value = '';
  $('#login-form').username.focus();
}

async function showJoin(token) {
  $('#login').hidden = true;
  const form = $('#join-form');
  $('#join').hidden = false;
  let inv;
  try {
    const res = await fetch('/api/join' + qs({ token }));
    inv = await res.json();
    if (!res.ok) throw new Error(inv.error);
  } catch (e) {
    fill(form, h('img', { src: 'icon.svg', alt: '', class: 'login-logo' }), h('h1', {}, 'Link expired'), h('p', { class: 'muted' }, e.message || 'Ask for a new invite.'), h('a', { href: '/' }, 'Go to sign in'));
    return;
  }
  const reset = inv.kind === 'reset';
  $('#join-title').textContent = reset ? `New password for ${inv.username}` : 'You’re invited';
  $('#join-sub').textContent = reset ? 'Choose a new password.' : `${inv.by} invited you to your family’s MyCloud: private photos, files, calendar and contacts, on hardware you own.`;
  form.username.hidden = reset;
  form.username.required = !reset;
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#join-error').textContent = '';
    if (form.password.value !== form.repeat.value) return ($('#join-error').textContent = 'Passwords don’t match');
    try {
      await api('POST', '/join', { token, username: form.username.value, password: form.password.value });
      history.replaceState(null, '', '/#settings');
      $('#join').hidden = true;
      await start();
      toast(reset ? 'Password updated' : 'Welcome to the family! Add MyCloud to your phone below.');
    } catch (err) {
      $('#join-error').textContent = err.message;
    }
  };
}

async function start() {
  if (location.pathname.startsWith('/join/')) return showJoin(location.pathname.slice(6));
  try {
    me = await api('GET', '/me');
  } catch {
    return showLogin();
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#whoami').textContent = `Signed in as ${me.user}`;
  route();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    await api('POST', '/login', { username: f.username.value, password: f.password.value });
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
window.addEventListener('hashchange', route);
start();
