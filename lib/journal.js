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

async function syncFile(file) {
  const fh = await fs.open(file, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function syncDirs(paths) {
  for (const dir of new Set(paths.map((p) => path.dirname(p)))) await syncDir(dir);
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
    // Durability order: staged content (and its folders) reach the disk before the record that names them…
    for (const op of plan) if (op.kind === 'put') await syncFile(op.tmp);
    await syncDirs(plan.map((op) => op.tmp).filter(Boolean));
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
      // …and every rename reaches the disk before the record that says the transaction committed.
      await syncDirs(Journal.touched(plan));
      await this.fault('synced');
      await durableWrite(file, JSON.stringify({ id, state: 'committed', ops: plan }));
      await this.fault('committed');
    } catch (e) {
      if (e.crash) throw e;
      // Rollback protocol: (1) durably record the intention to roll back, with each op's progress; (2) roll back;
      // (3) sync the folders; (4) durably mark it aborted; (5) remove the record. A crash anywhere leaves a record
      // recovery can act on correctly: "prepared" (nothing undone yet), "rolling-back" (resume from the recorded
      // steps; safe to repeat), or "aborted" (done).
      try {
        await durableWrite(file, JSON.stringify({ id, state: 'rolling-back', ops: plan }));
        await this.fault('rolling-back');
      } catch (err) {
        if (err.crash) throw err;
        e.rollbackIncomplete = [{ error: `could not record the rollback: ${err.message}` }]; // still "prepared": nothing undone
        throw e;
      }
      const failures = await Journal.rollback(plan, this.fault);
      if (failures.length) {
        e.rollbackIncomplete = failures; // the "rolling-back" record stays; recovery resumes it
        throw e;
      }
      await syncDirs(Journal.touched(plan));
      await this.fault('rolled-back');
      await durableWrite(file, JSON.stringify({ id, state: 'aborted' }));
      await this.fault('aborted');
      await this.remove(file);
      throw e;
    }
    // Committed: the transaction has happened. Cleaning up is best effort; a record left behind (say, a failed
    // deletion) is finished and removed by recovery at the next start.
    try {
      await Journal.finish(plan);
      await this.remove(file);
    } catch { /* recovery completes it */ }
  }

  // Delete a journal record and make the deletion itself durable.
  async remove(file) {
    await this.fault('removing', file);
    await fs.rm(file, { force: true });
    await syncDir(this.dir);
  }

  static touched(plan) {
    return plan.flatMap((op) => [op.target, op.backup, op.from, op.tmp]).filter(Boolean);
  }

  // Undo in reverse. `stepOf(op)` says how far the op got: 2 = new content in place, 1 = only backed up.
  // Each op stops at its first failed step (continuing could overwrite what that step failed to restore); other ops
  // still get undone. Returns the failures: while any remain, the journal must be kept.
  static async undo(plan, stepOf, fault = async () => {}) {
    const failures = [];
    for (const [i, op] of [...plan.entries()].reverse()) {
      try {
        const step = await stepOf(op);
        await fault(`undo:${i}`);
        if (step >= 2) {
          if (op.kind === 'move') await fs.rename(op.target, op.from);
          else if (op.kind === 'put') await fs.rm(op.target, { recursive: true, force: true });
        }
        if (step >= 1 && op.backup) await fs.rename(op.backup, op.target);
        if (op.kind === 'put') await fs.rm(op.tmp, { recursive: true, force: true });
      } catch (err) {
        failures.push({ op: i, target: op.target, error: err.message });
      }
    }
    return failures;
  }

  // Roll back using each op's recorded progress plus what is on disk now, so it is safe to run again after a crash
  // part-way through (a restored original is never mistaken for new content: the backup's absence says it's back).
  static async rollback(plan, fault = async () => {}) {
    const failures = [];
    for (const [i, op] of [...plan.entries()].reverse()) {
      try {
        await fault(`undo:${i}`);
        const backedUp = op.backup ? await exists(op.backup) : false;
        if (op.kind === 'put') {
          if (op.backup) {
            if (backedUp) {
              await fs.rm(op.target, { recursive: true, force: true });
              await fs.rename(op.backup, op.target);
            }
          } else if (op.step >= 2) await fs.rm(op.target, { recursive: true, force: true }); // it had no original
          await fs.rm(op.tmp, { recursive: true, force: true });
        } else if (op.kind === 'move') {
          const moveBack = op.step >= 2 && (await exists(op.target)) && !(await exists(op.from));
          if (op.backup) {
            if (backedUp) {
              if (moveBack) await fs.rename(op.target, op.from);
              await fs.rename(op.backup, op.target);
            }
          } else if (moveBack) await fs.rename(op.target, op.from);
        } else if (op.kind === 'remove' && backedUp) {
          await fs.rename(op.backup, op.target);
        }
      } catch (err) {
        failures.push({ op: i, target: op.target, error: err.message });
      }
    }
    return failures;
  }

  static async finish(plan) {
    for (const op of plan) if (op.backup) await fs.rm(op.backup, { recursive: true, force: true });
  }

  // A committed record means every op was meant to happen. Verify each against the disk and finish any whose rename
  // didn't persist (a power cut can lose renames the process saw succeed) before the backups are discarded.
  static async complete(plan) {
    for (const op of plan) {
      const pending = op.kind === 'put' ? await exists(op.tmp) : op.kind === 'move' ? await exists(op.from) : await exists(op.target);
      if (!pending) continue;
      if (op.backup && !(await exists(op.backup)) && (await exists(op.target))) await fs.rename(op.target, op.backup);
      if (op.kind === 'put') await fs.rename(op.tmp, op.target);
      else if (op.kind === 'move') await fs.rename(op.from, op.target);
    }
    await syncDirs(Journal.touched(plan));
  }

  // At startup: settle every journal a crash left behind, judging each op by what is on disk.
  async recover() {
    this.stuck = [];
    const names = await fs.readdir(this.dir).catch(() => []);
    let recovered = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!name.endsWith('.json')) {
        await this.remove(file); // a journal write that never completed
        continue;
      }
      let j;
      try {
        j = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        await fs.rm(file, { force: true });
        continue;
      }
      let failures = [];
      if (j.state === 'rolling-back') {
        failures = await Journal.rollback(j.ops, this.fault);
      } else if (j.state === 'aborted') {
        await this.remove(file); // already rolled back; only the record's deletion was lost
        recovered++;
        continue;
      }
      if (j.state === 'committed') {
        try {
          await Journal.complete(j.ops);
          await Journal.finish(j.ops);
        } catch (err) {
          failures = [{ error: err.message }];
        }
      } else if (j.state === 'prepared') {
        // Nothing was undone yet (the rollback intention would have been recorded first): judge progress by the disk.
        failures = await Journal.undo(j.ops, async (op) => {
          const backedUp = op.backup && (await exists(op.backup));
          if (op.kind === 'remove') return backedUp ? 1 : 0;
          // New content is in place if its source is gone and the target exists.
          const sourceGone = !(await exists(op.kind === 'move' ? op.from : op.tmp));
          const placed = sourceGone && (await exists(op.target));
          return placed ? 2 : backedUp ? 1 : 0;
        }, this.fault);
      }
      if (failures.length) {
        this.stuck.push({ journal: name, failures }); // kept for the next start; reported by the caller
        continue;
      }
      await syncDirs(Journal.touched(j.ops));
      await this.remove(file);
      recovered++;
    }
    return recovered;
  }
}
