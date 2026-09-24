// Fetch a URL the user pasted (a calendar subscription) without letting it reach into the server's own network.
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './util.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublic(url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'only http(s) and webcal links are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `could not resolve ${host}`);
  if (addrs.some(isPrivate)) throw new HttpError(400, 'links to private network addresses are not allowed');
}

export async function fetchPublicText(raw) {
  let url;
  try {
    url = new URL(String(raw).trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new HttpError(400, 'that does not look like a link');
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'MyCloud/0.1 (+https://github.com/DO-SAY-GO/MyCloud)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw new HttpError(502, `the link answered ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new HttpError(413, 'that calendar is too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new HttpError(502, 'too many redirects');
}
