// Fetch a URL the user pasted (a calendar subscription) without letting it reach into the server's own network.
// The address check runs inside the socket's DNS lookup, so the address that was validated is the one
// connected to (no rebinding window), and TLS still verifies the certificate against the hostname.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { HttpError } from './util.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) return reject(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    const req = lib.get(url, { lookup: guardedLookup, timeout: 30_000, headers: { 'User-Agent': 'MyCloud/0.1 (+https://github.com/DO-SAY-GO/MyCloud)', Accept: 'text/calendar, */*' } }, (res) => {
      // Belt and braces: the peer actually reached must be public too.
      if (isPrivateAddress(res.socket.remoteAddress ?? '')) {
        res.destroy();
        return reject(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export async function fetchPublicText(raw) {
  let url;
  try {
    url = new URL(String(raw).trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new HttpError(400, 'that does not look like a link');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'only http(s) and webcal links are supported');
    let res;
    try {
      res = await get(url);
    } catch (e) {
      if (e.code === 'EPRIVATE') throw new HttpError(400, 'links to private network addresses are not allowed');
      throw new HttpError(502, `could not fetch that link (${e.code || e.message})`);
    }
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url); // re-validated on the next hop
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new HttpError(502, `the link answered ${res.statusCode}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.destroy();
        throw new HttpError(413, 'that calendar is too large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new HttpError(502, 'too many redirects');
}
