import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJson, writeJson, parseCookies } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const BASIC_CACHE_TTL = 5 * 60 * 1000;
export const SESSION_COOKIE = 'mycloud_session';

async function hashSecret(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(secret, salt, 64);
  return { salt, hash: key.toString('hex') };
}

async function verifySecret(secret, { salt, hash }) {
  const key = await scrypt(secret, salt, 64);
  return crypto.timingSafeEqual(key, Buffer.from(hash, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export class Auth {
  constructor(dataDir) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.basicCache = new Map();
    this.failures = new Map(); // ip -> { count, until }
  }

  async load() {
    this.users = await readJson(this.usersFile, {});
    this.sessions = await readJson(this.sessionsFile, {});
    const now = Date.now();
    for (const [k, s] of Object.entries(this.sessions)) if (s.expires < now) delete this.sessions[k];
  }

  // Re-read users.json if something outside this process (the CLI) changed it.
  async reloadUsers() {
    const onDisk = await readJson(this.usersFile, {});
    if (JSON.stringify(onDisk) === JSON.stringify(this.users)) return false;
    this.users = onDisk;
    this.basicCache.clear();
    return true;
  }

  saveUsers() { return writeJson(this.usersFile, this.users); }
  saveSessions() { return writeJson(this.sessionsFile, this.sessions); }

  async setPassword(username, password) {
    if (!USERNAME_RE.test(username)) throw new Error('username must be lowercase letters, digits, . _ -');
    if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
    const user = this.users[username] ?? { created: new Date().toISOString(), appPasswords: [] };
    user.password = await hashSecret(password);
    this.users[username] = user;
    this.basicCache.clear();
    // A password change signs out every web session for that user.
    for (const [k, s] of Object.entries(this.sessions)) if (s.user === username) delete this.sessions[k];
    await Promise.all([this.saveUsers(), this.saveSessions()]);
  }

  async checkPassword(username, password, { allowAppPasswords = false } = {}) {
    const user = this.users[username];
    if (!user || typeof password !== 'string') {
      await hashSecret(String(password)); // equalize timing for unknown users
      return false;
    }
    if (await verifySecret(password, user.password)) return true;
    if (allowAppPasswords) {
      for (const ap of user.appPasswords) {
        if (await verifySecret(password, ap)) {
          ap.lastUsed = new Date().toISOString();
          this.saveUsers().catch(() => {});
          return true;
        }
      }
    }
    return false;
  }

  // Throttle brute force per client address: exponential lockout after 5 failures.
  throttled(ip) {
    const f = this.failures.get(ip);
    return f && f.until > Date.now();
  }
  noteFailure(ip) {
    const f = this.failures.get(ip) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) f.until = Date.now() + Math.min(2 ** (f.count - 5), 900) * 1000;
    this.failures.set(ip, f);
  }
  noteSuccess(ip) { this.failures.delete(ip); }

  async createSession(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions[sha256(token)] = { user: username, expires: Date.now() + SESSION_TTL };
    await this.saveSessions();
    return token;
  }

  async destroySession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token && this.sessions[sha256(token)]) {
      delete this.sessions[sha256(token)];
      await this.saveSessions();
    }
  }

  sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = token && this.sessions[sha256(token)];
    if (!s || s.expires < Date.now() || !this.users[s.user]) return null;
    return s.user;
  }

  // HTTP Basic for DAV clients (Calendar, Contacts, Finder). Accepts the account or an app password.
  async basicUser(req) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Basic ')) return null;
    const key = sha256(h);
    const cached = this.basicCache.get(key);
    if (cached && cached.expires > Date.now() && this.users[cached.user]) return cached.user;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    const username = decoded.slice(0, i).toLowerCase();
    const ip = req.socket.remoteAddress;
    if (this.throttled(ip)) return null;
    if (!(await this.checkPassword(username, decoded.slice(i + 1), { allowAppPasswords: true }))) {
      this.noteFailure(ip);
      return null;
    }
    this.noteSuccess(ip);
    this.basicCache.set(key, { user: username, expires: Date.now() + BASIC_CACHE_TTL });
    return username;
  }

  listAppPasswords(username) {
    return this.users[username].appPasswords.map(({ id, label, created, lastUsed }) => ({ id, label, created, lastUsed }));
  }

  async createAppPassword(username, label) {
    // Grouped like Apple's app-specific passwords: xxxx-xxxx-xxxx-xxxx
    const raw = crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').toLowerCase().slice(0, 16);
    const secret = raw.match(/.{4}/g).join('-');
    const entry = { id: crypto.randomUUID(), label: String(label || 'Device').slice(0, 64), created: new Date().toISOString(), ...(await hashSecret(secret)) };
    this.users[username].appPasswords.push(entry);
    await this.saveUsers();
    return { id: entry.id, label: entry.label, password: secret };
  }

  async revokeAppPassword(username, id) {
    const user = this.users[username];
    user.appPasswords = user.appPasswords.filter((a) => a.id !== id);
    this.basicCache.clear();
    await this.saveUsers();
  }
}
