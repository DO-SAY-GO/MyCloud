import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Join URL-style path segments under root, refusing traversal and odd segments.
export function safeJoin(root, segments) {
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || /[\\/\0]/.test(s)) throw new HttpError(400, 'invalid path');
  }
  const p = path.join(root, ...segments);
  if (p !== root && !p.startsWith(root + path.sep)) throw new HttpError(400, 'invalid path');
  return p;
}

export function splitPath(p) {
  return String(p || '').split('/').filter(Boolean);
}

export function decodeSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, 'invalid path encoding');
  }
}

export const encodePath = (segments) => segments.map(encodeURIComponent).join('/');

export async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

export async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Atomic write: temp file + rename, so a crash never leaves a half-written file.
export async function writeFileAtomic(p, data) {
  const tmp = `${p}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

export const writeJson = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2));

// Read-modify-write of a JSON state file under a lock file, so the server, the CLI and concurrent
// requests never overwrite each other's newer state. `fn` mutates the object synchronously and may throw to abort.
const inProcess = new Map();
export function updateJson(p, fallback, fn) {
  const prev = inProcess.get(p) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => withFileLock(p, async () => {
    const data = await readJson(p, structuredClone(fallback));
    const result = fn(data);
    await writeJson(p, data);
    return { data, result };
  }));
  inProcess.set(p, next);
  next.finally(() => { if (inProcess.get(p) === next) inProcess.delete(p); }).catch(() => {});
  return next;
}

async function withFileLock(p, fn) {
  const lock = `${p}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await statOrNull(lock);
      if (st && Date.now() - st.mtimeMs > 30_000) await fs.rm(lock, { force: true }); // holder crashed
      else if (Date.now() > deadline) throw new HttpError(503, 'server busy, try again');
      else await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

export function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const etagOf = (stat) => `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip',
  ics: 'text/calendar; charset=utf-8', vcf: 'text/vcard; charset=utf-8',
};
export const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
export const isImage = (name) => /\.(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(name);
export const isVideo = (name) => /\.(mp4|mov|m4v|webm)$/i.test(name);

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const uid = () => crypto.randomUUID();
