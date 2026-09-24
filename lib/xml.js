// Minimal namespace-aware XML parser and writer — enough for WebDAV/CalDAV/CardDAV bodies.

export const NS = {
  d: 'DAV:',
  c: 'urn:ietf:params:xml:ns:caldav',
  card: 'urn:ietf:params:xml:ns:carddav',
  cs: 'http://calendarserver.org/ns/',
  ical: 'http://apple.com/ns/ical/',
};
const PREFIX = Object.fromEntries(Object.entries(NS).map(([p, ns]) => [ns, p]));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Element: { ns, name, attrs, children: Element[], text }
export function parseXml(src) {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s>/]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root = { children: [], text: '', scope: { xml: 'http://www.w3.org/XML/1998/namespace' } };
  const stack = [root];
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += unescape(m[6]); continue; }
    if (!m[3]) continue; // comment, PI, doctype
    if (m[2]) {
      if (stack.length === 1) throw new Error('unbalanced xml');
      stack.pop();
      continue;
    }
    const scope = { ...top.scope };
    const rawAttrs = {};
    for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = unescape(a[2] ?? a[3]);
      if (a[1] === 'xmlns') scope[''] = value;
      else if (a[1].startsWith('xmlns:')) scope[a[1].slice(6)] = value;
      else rawAttrs[a[1]] = value;
    }
    const [prefix, local] = m[3].includes(':') ? m[3].split(':', 2) : ['', m[3]];
    const el = { ns: scope[prefix] ?? '', name: local, attrs: rawAttrs, children: [], text: '', scope };
    top.children.push(el);
    if (!m[5]) stack.push(el);
  }
  if (stack.length !== 1) throw new Error('unbalanced xml');
  const doc = root.children[0];
  if (!doc) throw new Error('empty xml');
  return doc;
}

export const clark = (el) => `{${el.ns}}${el.name}`;
export const child = (el, ns, name) => el?.children.find((c) => c.ns === ns && c.name === name);
export const childrenOf = (el, ns, name) => el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
export function textOf(el) {
  return el ? el.text + el.children.map(textOf).join('') : '';
}

// Render a Clark-notation property name as an element with optional inner XML.
export function el(clarkName, inner = '') {
  const m = /^\{(.*)\}(.+)$/.exec(clarkName);
  const [ns, name] = m ? [m[1], m[2]] : ['', clarkName];
  const p = PREFIX[ns];
  const tag = p ? `${p}:${name}` : `x:${name}`;
  const decl = p ? '' : ` xmlns:x="${esc(ns)}"`;
  return inner === '' ? `<${tag}${decl}/>` : `<${tag}${decl}>${inner}</${tag}>`;
}

export function multistatus(responses, extra = '') {
  const decls = Object.entries(NS).map(([p, ns]) => `xmlns:${p}="${ns}"`).join(' ');
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${decls}>${responses.join('')}${extra}</d:multistatus>`;
}

// found: Map<clark, innerXml>, missing: clark[]
export function response(href, found, missing = [], status) {
  if (status) return `<d:response><d:href>${esc(href)}</d:href><d:status>HTTP/1.1 ${status}</d:status></d:response>`;
  let out = `<d:response><d:href>${esc(href)}</d:href>`;
  if (found.size) {
    out += '<d:propstat><d:prop>';
    for (const [k, v] of found) out += el(k, v);
    out += '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>';
  }
  if (missing.length) {
    out += '<d:propstat><d:prop>' + missing.map((k) => el(k)).join('') + '</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>';
  }
  return out + '</d:response>';
}
