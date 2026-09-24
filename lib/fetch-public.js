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

// Classify by the address's bytes, never its spelling: "::ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1" and
// "127.0.0.1" are the same loopback address. IPv6 forms that embed an IPv4 address are judged by that address.
function v4Private([a, b]) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function v6Bytes(ip) {
  let s = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const q = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/.test(g) || Number.isNaN(n)) return null;
    out.push(n >> 8, n & 255);
  }
  return out;
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4Private(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return true; // anything unparseable is refused
  const b = v6Bytes(ip);
  if (!b) return true;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, and NAT64 64:ff9b::a.b.c.d carry an IPv4 address.
  if ((zero(0, 10) && b[10] === 255 && b[11] === 255) || zero(0, 12) || (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12))) {
    return zero(0, 16) || v4Private(b.slice(12, 16)) || (zero(0, 15) && b[15] === 1);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return v4Private(b.slice(2, 6)); // 6to4 2002:a.b.c.d::/48
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo tunnels to arbitrary IPv4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation range
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // discard-only 100::/64
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff; // ULA, link-local, multicast
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
