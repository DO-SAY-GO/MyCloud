// Every Drive write goes through here, from the web app and from WebDAV alike, so both share one path for locking
// and storage accounting.
//
// Locking: each budget (a user's space, the Family space) has a readers-writer lock. Anything that changes something
// *inside* a Drive (an upload's commit, a new folder, a delete, a restore, a copy's commit, a LOCK-created file) holds
// its budget lock shared, so those run concurrently. Moving a folder holds both budgets' locks exclusively (in a
// fixed order): nothing can be written beneath it while it is measured and moved, so it is billed for exactly what
// moves. Path locks nest inside budget locks.
//
// Staging: uploads and copies are written to the budget's own .staging folder (never inside a user folder, where a
// concurrent folder move could carry them away), then renamed into place.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { HttpError, statOrNull } from './util.js';
import { treeStats, meteredCopy, ENTRY_COST } from './limits.js';

const vanished = (what) => Object.assign(new Error(`${what} vanished`), { code: 'ENOENT' });

export class Drive {
  constructor(store, limits) {
    this.store = store;
    this.limits = limits;
    this.hooks = {}; // test seams: beforeStage, beforeMoveLock, afterMeasure, beforeCommit (race windows)
  }

  async stagePath(near) {
    const dir = path.join(await this.store.budgetRootOf(near), '.staging');
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, crypto.randomBytes(8).toString('hex'));
  }

  // Missing ancestors of dir (inside the user's tree), outermost first.
  async missingAncestors(dir) {
    const missing = [];
    for (let d = dir; !(await statOrNull(d)); d = path.dirname(d)) missing.unshift(d);
    return missing;
  }

  async mkdir(user, dir) {
    const missing = await this.missingAncestors(dir);
    if (!missing.length) return;
    await this.limits.withBytes(await this.limits.budgetFor(user, dir), 0, 0,
      () => this.store.withBudgets([dir], false, () => fs.mkdir(dir, { recursive: true })), { entries: missing.length });
  }

  // Upload a stream to `target`. Returns { replaced }.
  async put(user, target, req) {
    await this.mkdir(user, path.dirname(target));
    const tmp = await this.stagePath(target);
    const old = await statOrNull(target);
    let replaced = !!old;
    try {
      await this.limits.guard(await this.limits.budgetFor(user, target), req, old?.size ?? 0, async (meter, res) => {
        await pipeline(req, meter, createWriteStream(tmp, { mode: 0o600 }));
        await this.hooks.beforeCommit?.(target);
        await this.store.withBudgets([target], false, () => this.store.withLock(target, async () => {
          if (!(await statOrNull(path.dirname(target)))?.isDirectory()) throw new HttpError(409, 'the folder was moved or deleted');
          // Settle against what is there now (a concurrent upload may have created or replaced it), then swap.
          const now = await statOrNull(target);
          replaced = !!now;
          this.limits.settle(res, { replacing: now?.size ?? 0, entries: now ? 0 : 1 });
          await fs.rename(tmp, target);
        }));
      // The staged file always needs one physical inode. It becomes the final entry, so an overwrite still adds zero
      // persistent/quota entries while reserving one peak entry until the rename.
      }, { entries: old ? 0 : 1, peakEntries: 1 });
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return { replaced };
  }

  trash(user, fsPath, rel) {
    return this.store.withBudgets([fsPath], false, () => this.store.trash(user, fsPath, rel));
  }

  async restore(user, id, shared) {
    return this.store.withBudgets([this.store.trashItemDir(user, id, shared)], false, () => this.store.restore(user, id, shared));
  }

  // A WebDAV LOCK on a new name creates an empty file (Finder relies on it).
  async lockCreate(user, fsPath) {
    await this.limits.withBytes(await this.limits.budgetFor(user, fsPath), 0, 0,
      () => this.store.withBudgets([fsPath], false, () => fs.writeFile(fsPath, '', { flag: 'wx', mode: 0o600 }).catch(() => {})), { entries: 1 });
  }

  // Copy or move a Drive item (file or folder) to `dest`. `overwrite` false answers 412 if something is there at
  // commit time. A replaced destination goes to Recently Deleted. Returns { replaced }.
  async transfer({ user, move, src, dest, destRel, overwrite }) {
    const { store, limits } = this;
    const srcStat = await fs.lstat(src).catch(() => null);
    if (!srcStat) throw vanished('source');
    const from = await limits.budgetFor(user, src);
    const to = await limits.budgetFor(user, path.dirname(dest));
    const cross = from !== to;
    const estimate = await treeStats(src);
    let moved = estimate;
    let replaced = false;

    // Under the destination's path lock: honour Overwrite against what is there now, set aside a replaced item, swap.
    const commit = async (placeFrom) => {
      const now = await fs.lstat(dest).catch(() => null);
      if (now && !overwrite) throw new HttpError(412, 'destination exists');
      replaced = !!now;
      let trashed = null;
      try {
        if (now) trashed = await store.trash(user, dest, destRel);
        await fs.rename(placeFrom, dest);
      } catch (e) {
        if (trashed) await store.restore(user, trashed.id, trashed.shared).catch(() => {});
        throw e;
      }
    };

    if (move) {
      const run = async (res) => {
        await this.hooks.beforeMoveLock?.(src);
        // Decide nothing from the pre-lock file type: another request could replace a file with a directory before
        // this lock is acquired. Every MOVE takes the involved budget locks exclusively, so the object is stable
        // while it is remeasured and moved (files are cheap enough that the conservative serialization is worth it).
        await store.withBudgets([src, dest], true, () => store.withLocks([src, dest], async () => {
          if (!(await fs.lstat(src).catch(() => null))) throw vanished('source');
          if (res && cross) {
            moved = await treeStats(src);
            limits.settle(res, { bytes: moved.bytes, entries: moved.entries });
          }
          await this.hooks.afterMeasure?.(src);
          await commit(src);
        }));
      };
      if (cross) await limits.withBytes(to, estimate.bytes, 0, run, { entries: estimate.entries });
      else await limits.withBytes(to, 0, 0, run);
      if (cross) await limits.freed(from, { bytes: moved.bytes + moved.entries * ENTRY_COST, entries: moved.entries });
    } else {
      const stage = await this.stagePath(dest);
      await limits.withBytes(to, estimate.bytes, 0, async (res) => {
        try {
          await this.hooks.beforeStage?.(src);
          // Each entry is claimed before it is created and every byte passes the meter: the copy is charged for what it
          // really copies, and limits hold during the copy, even if the source grew after it was first measured.
          await meteredCopy(src, stage, (n) => limits.consume(res, n), () => limits.claimEntry(res));
          limits.settle(res, { entries: res.usedEntries ?? 0, peakEntries: res.usedEntries ?? 0 });
          await store.withBudgets([dest], false, () => store.withLocks([dest], () => commit(stage)));
        } catch (e) {
          await fs.rm(stage, { recursive: true, force: true });
          throw e;
        }
      }, { entries: estimate.entries });
    }
    return { replaced };
  }
}
