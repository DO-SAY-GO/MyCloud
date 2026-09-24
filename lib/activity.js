// Append-only activity log (JSON lines) for sign-ins, sharing, deletions, resets and device passwords.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

export class Activity {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'activity.log');
    this.chain = Promise.resolve();
  }

  log(event, { user = null, ip = null, ...detail } = {}) {
    const line = JSON.stringify({ t: new Date().toISOString(), event, user, ip, ...detail }) + '\n';
    this.chain = this.chain.then(async () => {
      const st = await fs.stat(this.file).catch(() => null);
      if (st && st.size > MAX_BYTES) await fs.rename(this.file, `${this.file}.1`);
      await fs.appendFile(this.file, line, { mode: 0o600 });
    }).catch(() => {});
    return this.chain;
  }

  async recent({ user, limit = 100 } = {}) {
    await this.chain;
    const text = await fs.readFile(this.file, 'utf8').catch(() => '');
    const rows = [];
    for (const l of text.trim().split('\n').reverse()) {
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (!user || r.user === user || r.target === user) rows.push(r);
      } catch { /* torn line */ }
      if (rows.length >= limit) break;
    }
    return rows;
  }
}
