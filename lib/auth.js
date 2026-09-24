import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJson, updateJson, parseCookies, HttpError } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const BASIC_CACHE_TTL = 5 * 60 * 1000;
const MAX_APP_PASSWORDS = 50;
const MAX_PENDING_INVITES = 20;
export const SESSION_COOKIE = 'mycloud_session';

// Hash parameters are stored with every hash so they can be raised later without breaking old ones.
const SCRYPT = { alg: 'scrypt', N: 16384, r: 8, p: 1, keylen: 64 };

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { ...SCRYPT, salt, hash: key.toString('hex') };
}

async function verifySecret(secret, rec) {
  const { N = 16384, r = 8, p = 1, keylen = 64 } = rec;
  const key = await scrypt(secret, rec.salt, keylen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return crypto.timingSafeEqual(key, Buffer.from(rec.hash, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Installs from before family support have no admin: the oldest account becomes it.
function withAdmin(users) {
  const names = Object.keys(users);
  if (names.length && !names.some((n) => users[n].admin)) {
    names.sort((a, b) => users[a].created.localeCompare(users[b].created));
    users[names[0]].admin = true;
  }
  return users;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function validate(username, password) {
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'username must be lowercase letters, digits, . _ -');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  if (password.length > 1024) throw new HttpError(400, 'password is too long');
}

// Brute-force throttling by client address and, separately, by account (shorter cap, so an attacker
// can slow an account down but not lock its owner out for long).
class Throttle {
  constructor(threshold, capSeconds) {
    this.threshold = threshold;
    this.cap = capSeconds;
    this.map = new Map();
  }
  blocked(key) {
    const f = key && this.map.get(key);
    return !!f && f.until > Date.now();
  }
  fail(key) {
    if (!key) return;
    const f = this.map.get(key) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= this.threshold) f.until = Date.now() + Math.min(2 ** (f.count - this.threshold), this.cap) * 1000;
    this.map.set(key, f);
    if (this.map.size > 100_000) this.map.clear(); // bounded memory under a spray
  }
  clear(key) { this.map.delete(key); }
}

export class Auth {
  constructor(dataDir, { davAccountPassword = false } = {}) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.invitesFile = path.join(dataDir, 'invites.json');
    this.basicCache = new Map();
    this.byIp = new Throttle(5, 900);
    this.byAccount = new Throttle(10, 300);
    this.davAccountPassword = davAccountPassword;
    this.revokeListeners = [];
  }

  async load() {
    this.users = withAdmin(await readJson(this.usersFile, {}));
    this.sessions = await readJson(this.sessionsFile, {});
    this.invites = await readJson(this.invitesFile, {});
    const now = Date.now();
    await this.mutate('sessions', (s) => { for (const [k, v] of Object.entries(s)) if (v.expires < now) delete s[k]; });
    await this.mutate('invites', (s) => { for (const [k, v] of Object.entries(s)) if (v.expires < now) delete s[k]; });
  }

  // Every state change: lock, re-read from disk, apply, write, mirror in memory.
  async mutate(which, fn) {
    const file = { users: this.usersFile, sessions: this.sessionsFile, invites: this.invitesFile }[which];
    const { data, result } = await updateJson(file, {}, fn);
    this[which] = which === 'users' ? withAdmin(data) : data;
    return result;
  }

  isAdmin(username) { return !!this.users[username]?.admin; }

  // Pick up changes made by the CLI while the server runs.
  async reloadUsers() {
    const onDisk = withAdmin(await readJson(this.usersFile, {}));
    if (JSON.stringify(onDisk) === JSON.stringify(this.users)) return false;
    this.users = onDisk;
    this.basicCache.clear();
    return true;
  }

  onRevoke(fn) { this.revokeListeners.push(fn); }

  // create: the account must not exist yet. revokeDevices: drop app passwords too (recovery, reset).
  async setPassword(username, password, { create = false, revokeDevices = false, keepSession } = {}) {
    validate(username, password);
    const hashed = await hashSecret(password);
    await this.mutate('users', (users) => {
      if (create && users[username]) throw new HttpError(409, 'that username is taken');
      if (!create && !users[username]) throw new HttpError(404, 'no such user');
      const user = users[username] ?? { created: new Date().toISOString(), appPasswords: [], admin: Object.keys(users).length === 0 };
      user.password = hashed;
      if (revokeDevices) user.appPasswords = [];
      users[username] = user;
    });
    // Every other signed-in browser is signed out; stolen cookies stop working.
    await this.mutate('sessions', (s) => { for (const [k, v] of Object.entries(s)) if (v.user === username && k !== keepSession) delete s[k]; });
    this.basicCache.clear();
    if (revokeDevices) for (const fn of this.revokeListeners) fn(username);
  }

  async checkPassword(username, password, { account = true, appPasswords = false } = {}) {
    const user = this.users[username];
    if (!user || typeof password !== 'string' || password.length > 1024) {
      await hashSecret(String(password).slice(0, 1024)); // equalize timing for unknown users
      return false;
    }
    if (account && (await verifySecret(password, user.password))) return true;
    if (appPasswords) {
      for (const ap of user.appPasswords) {
        if (await verifySecret(password, ap)) {
          if (!ap.lastUsed || Date.now() - Date.parse(ap.lastUsed) > 3600 * 1000) {
            this.mutate('users', (u) => {
              const e = u[username]?.appPasswords.find((x) => x.id === ap.id);
              if (e) e.lastUsed = new Date().toISOString();
            }).catch(() => {});
          }
          return true;
        }
      }
    }
    return false;
  }

  throttled(ip, account) { return this.byIp.blocked(ip) || this.byAccount.blocked(account && `u:${account}`); }
  noteFailure(ip, account) { this.byIp.fail(ip); if (account) this.byAccount.fail(`u:${account}`); }
  noteSuccess(ip, account) { this.byIp.clear(ip); if (account) this.byAccount.clear(`u:${account}`); }

  async createSession(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    await this.mutate('sessions', (s) => { s[sha256(token)] = { user: username, expires: Date.now() + SESSION_TTL }; });
    return token;
  }

  sessionKey(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? sha256(token) : null;
  }

  async destroySession(req) {
    const key = this.sessionKey(req);
    if (key && this.sessions[key]) await this.mutate('sessions', (s) => { delete s[key]; });
  }

  sessionUser(req) {
    const key = this.sessionKey(req);
    const s = key && this.sessions[key];
    if (!s || s.expires < Date.now() || !this.users[s.user]) return null;
    return s.user;
  }

  // HTTP Basic for DAV clients. App passwords only: a misconfigured client never holds the account password
  // (set MYCLOUD_DAV_ACCOUNT_PASSWORD=1 to allow it anyway).
  async basicUser(req, ip) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Basic ') || h.length > 2048) return null;
    const key = sha256(h);
    const cached = this.basicCache.get(key);
    if (cached && cached.expires > Date.now() && this.users[cached.user]) return cached.user;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return null;
    const username = decoded.slice(0, i).toLowerCase();
    if (this.throttled(ip, username)) return null;
    if (!(await this.checkPassword(username, decoded.slice(i + 1), { account: this.davAccountPassword, appPasswords: true }))) {
      this.noteFailure(ip, username);
      return null;
    }
    this.noteSuccess(ip, username);
    if (this.basicCache.size > 10_000) this.basicCache.clear();
    this.basicCache.set(key, { user: username, expires: Date.now() + BASIC_CACHE_TTL });
    return username;
  }

  // ---- family invites -------------------------------------------------
  // kind "join" creates a new account; kind "reset" sets a new password for an existing one.

  async createInvite(by, kind, username) {
    if (kind === 'reset' && !this.users[username]) throw new HttpError(404, 'no such member');
    const token = crypto.randomBytes(24).toString('base64url');
    const ttl = kind === 'reset' ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
    await this.mutate('invites', (inv) => {
      const live = Object.values(inv).filter((i) => i.expires > Date.now()).length;
      if (live >= MAX_PENDING_INVITES) throw new HttpError(429, 'too many open invites; revoke some first');
      inv[sha256(token)] = { id: crypto.randomUUID(), kind, username: kind === 'reset' ? username : undefined, by, created: new Date().toISOString(), expires: Date.now() + ttl };
    });
    return token;
  }

  invite(token) {
    const inv = typeof token === 'string' && this.invites[sha256(token)];
    return inv && inv.expires > Date.now() ? inv : null;
  }

  listInvites() {
    return Object.values(this.invites).filter((i) => i.expires > Date.now()).map(({ id, kind, username, by, created, expires }) => ({ id, kind, username, by, created, expires }));
  }

  async revokeInvite(id) {
    await this.mutate('invites', (inv) => { for (const [k, i] of Object.entries(inv)) if (i.id === id) delete inv[k]; });
  }

  // Consume the token atomically *before* creating anything, so a link works exactly once even under
  // concurrent redemption. A failed account creation gives the token back.
  async redeemInvite(token, username, password) {
    const peek = this.invite(token);
    if (!peek) throw new HttpError(400, 'this invite link has expired or was already used');
    const name = peek.kind === 'reset' ? peek.username : String(username || '').toLowerCase().trim();
    validate(name, password);
    const key = sha256(String(token));
    const inv = await this.mutate('invites', (all) => {
      const i = all[key];
      if (!i || i.expires < Date.now()) throw new HttpError(400, 'this invite link has expired or was already used');
      delete all[key];
      return i;
    });
    try {
      // Account recovery: a reset also drops every device password and signed-in session.
      await this.setPassword(name, password, inv.kind === 'reset' ? { revokeDevices: true } : { create: true });
    } catch (e) {
      await this.mutate('invites', (all) => { all[key] = inv; });
      throw e;
    }
    return { name, kind: inv.kind };
  }

  async deleteUser(username) {
    await this.mutate('users', (u) => { delete u[username]; });
    await this.mutate('sessions', (s) => { for (const [k, v] of Object.entries(s)) if (v.user === username) delete s[k]; });
    this.basicCache.clear();
    for (const fn of this.revokeListeners) fn(username);
  }

  listAppPasswords(username) {
    return this.users[username].appPasswords.map(({ id, label, created, lastUsed }) => ({ id, label, created, lastUsed }));
  }

  async createAppPassword(username, label) {
    // Grouped like Apple's app-specific passwords: xxxx-xxxx-xxxx-xxxx
    const raw = crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').toLowerCase().slice(0, 16);
    const secret = raw.match(/.{4}/g).join('-');
    const entry = { id: crypto.randomUUID(), label: String(label || 'Device').slice(0, 64), created: new Date().toISOString(), ...(await hashSecret(secret)) };
    await this.mutate('users', (u) => {
      if (u[username].appPasswords.length >= MAX_APP_PASSWORDS) throw new HttpError(429, `at most ${MAX_APP_PASSWORDS} device passwords; revoke unused ones first`);
      u[username].appPasswords.push(entry);
    });
    return { id: entry.id, label: entry.label, password: secret };
  }

  async revokeAppPassword(username, id) {
    await this.mutate('users', (u) => { u[username].appPasswords = u[username].appPasswords.filter((a) => a.id !== id); });
    this.basicCache.clear();
  }
}
