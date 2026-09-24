// Apple Notes hands out HTML. Turn it into readable Markdown, pulling inline images out as files.
import crypto from 'node:crypto';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/heic': 'heic', 'image/webp': 'webp', 'image/tiff': 'tiff' };

export function htmlToMarkdown(html) {
  const attachments = [];
  let s = String(html).replace(/\r?\n/g, ' ');
  s = s.replace(/<img\b[^>]*\bsrc="data:([^;"]+);base64,([^"]+)"[^>]*>/gi, (_, type, b64) => {
    const data = Buffer.from(b64, 'base64');
    const name = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 16)}.${EXT[type] || 'bin'}`;
    attachments.push({ name, data });
    return `\n![](attachments/${name})\n`;
  });
  for (let n = 1; n <= 6; n++) s = s.replace(new RegExp(`<h${n}[^>]*>([\\s\\S]*?)</h${n}>`, 'gi'), (_, t) => `\n${'#'.repeat(n)} ${t}\n`);
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `**${t.trim()}**` : t));
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `*${t.trim()}*` : t));
  s = s.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `~~${t}~~`);
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => (t.trim() && t.trim() !== href ? `[${t.trim()}](${href})` : href));
  s = s.replace(/<li\b[^>]*class="[^"]*\bchecked\b[^"]*"[^>]*>/gi, '\n- [x] ');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<tr\b[^>]*>/gi, '\n|').replace(/<\/t[dh]>/gi, ' |');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|ul|ol|table|blockquote|pre)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: s + '\n', attachments };
}
