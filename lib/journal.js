// A small durable journal that makes a group of renames all-or-nothing, even across a crash.
//
// Operations (all targets in their own directories, all sources already staged):
//   { kind: 'put',    tmp,  target }  staged new content replaces (or creates) target
//   { kind: 'move',   from, target }  an existing file moves to target (replacing it, if present)
//   { kind: 'remove', target }         target is deleted
// Any target that exists is first renamed to a backup beside it, so every step can be undone.
//
// Protocol: write the journal (fsynced) → apply each op → mark committed (fsynced) → delete backups and journal.
// On an error, applied steps are undone in reverse. After a crash, recover() finishes a committed journal (deletes
// its backups) or rolls a prepared one back from what is actually on disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const exists = async (p) => !!(await fs.lstat(p).catch(() => null));

async function durableWrite(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  await syncDir(path.dirname(file));
}

async function syncDir(dir) {
  const fh = await fs.open(dir, 'r').catch(() => null);
  if (!fh) return;
  await fh.sync().catch(() => {}); // not every platform can fsync a directory; best effort
  await fh.close();
}

export class Journal {
  // fault(label): test hook called at every boundary; throwing simulates an I/O failure there.
  // A thrown error with { crash: true } skips the in-process rollback, as if the process had died.
  constructor(dir, { fault } = {}) {
    this.dir = dir;
    this.fault = fault ?? (async () => {});
  }

  async run(ops) {
    await fs.mkdir(this.dir, { recursive: true });
    const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const file = path.join(this.dir, `${id}.json`);
    const plan = [];
    for (const [i, op] of ops.entries()) {
      const hadTarget = await exists(op.target);
      plan.push({ ...op, hadTarget, backup: hadTarget ? path.join(path.dirname(op.target), `.mycloud-backup-${id}-${i}`) : null, step: 0 });
    }
    await durableWrite(file, JSON.stringify({ id, state: 'prepared', ops: plan }));
    try {
      await this.fault('prepared');
      for (const [i, op] of plan.entries()) {
        if (op.backup) {
          await fs.rename(op.target, op.backup);
          op.step = 1;
          await this.fault(`backup:${i}`);
        }
        if (op.kind === 'put') await fs.rename(op.tmp, op.target);
        else if (op.kind === 'move') await fs.rename(op.from, op.target);
        op.step = 2;
        await this.fault(`applied:${i}`);
      }
      await durableWrite(file, JSON.stringify({ id, state: 'committed', ops: plan }));
      await this.fault('committed');
    } catch (e) {
      if (!e.crash) {
        await Journal.undo(plan, (op) => op.step);
        await fs.rm(file, { force: true });
      }
      throw e;
    }
    await Journal.finish(plan);
    await fs.rm(file, { force: true });
  }

  // Undo in reverse. `stepOf(op)` says how far the op got: 2 = new content in place, 1 = only backed up.
  static async undo(plan, stepOf) {
    for (const op of [...plan].reverse()) {
      const step = await stepOf(op);
      if (step >= 2) {
        if (op.kind === 'move') await fs.rename(op.target, op.from).catch(() => {});
        else if (op.kind === 'put') await fs.rm(op.target, { recursive: true, force: true });
      }
      if (step >= 1 && op.backup) await fs.rename(op.backup, op.target).catch(() => {});
      if (op.kind === 'put') await fs.rm(op.tmp, { recursive: true, force: true });
    }
  }

  static async finish(plan) {
    for (const op of plan) if (op.backup) await fs.rm(op.backup, { recursive: true, force: true });
  }

  // At startup: settle every journal a crash left behind, judging each op by what is on disk.
  async recover() {
    const names = await fs.readdir(this.dir).catch(() => []);
    let recovered = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!name.endsWith('.json')) {
        await fs.rm(file, { force: true }); // a journal write that never completed
        continue;
      }
      let j;
      try {
        j = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        await fs.rm(file, { force: true });
        continue;
      }
      if (j.state === 'committed') await Journal.finish(j.ops);
      else {
        await Journal.undo(j.ops, async (op) => {
          const backedUp = op.backup && (await exists(op.backup));
          if (op.kind === 'remove') return backedUp ? 1 : 0;
          // New content is in place if its source is gone and the target exists.
          const sourceGone = !(await exists(op.kind === 'move' ? op.from : op.tmp));
          const placed = sourceGone && (await exists(op.target));
          return placed ? 2 : backedUp ? 1 : 0;
        });
      }
      await fs.rm(file, { force: true });
      recovered++;
    }
    return recovered;
  }
}
