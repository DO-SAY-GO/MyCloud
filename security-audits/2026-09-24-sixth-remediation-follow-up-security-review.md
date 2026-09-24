# MyCloud Sixth Remediation Follow-up Security Review

**Date:** 2026-09-24 (America/New_York)
**Prepared by:** OpenAI Codex, at the repository owner's request
**Signature:** OpenAI Codex — follow-up security review artifact
**Reviewed commit:** `eb0f2adc0e6979001d1f1ef6547bb3c51641c939`
**Prior committed audit artifact:** `security-audits/2026-09-24-fourth-remediation-follow-up-security-review.md`

## Purpose and scope

This document records the later portion of a lengthy red-team/blue-team exchange that continued after the fourth committed follow-up. It reviews the storage-accounting, concurrent COPY/MOVE, and calendar/contact transaction changes through `eb0f2ad`. It also records the short stress-testing detour that occurred while the sixth remediation was being prepared, distinguishing test-harness failures from the two product defects that remain at this baseline.

The review was non-destructive and used temporary local data. It covered source inspection, the complete automated test suite, focused concurrency and crash-state probes, Compose validation, JavaScript syntax checks, Git whitespace and object checks, and repository/tag state. The reviewer did not independently repeat the reported Linux run or live HTTPS Docker smoke test.

## Chronology of the exchange

The work evolved through repeated narrow reviews rather than one monolithic audit:

1. The original review was committed as `9808b7b`. Remediation through `6bd1d45` added the first major hardening set, including invitation, upload, thumbnail, session, sharing, SSRF, proxy, device-password, deletion, activity, state-file, and container protections.
2. The first follow-up, committed as `f3d2545`, found four bypasses involving Family aliases, concurrent quota admission, thumbnail isolation, and IPv4-mapped IPv6 SSRF. Those were remediated in `723d8f1`.
3. The second follow-up, committed as `e06c335`, was followed by the storage-gate work through `18f7836`: peak overwrite reservations, metadata admission, file and inode accounting, and non-destructive COPY/MOVE failure behavior.
4. The third and fourth committed follow-ups (`cbb6a86` and `27d09fa`) drove bookkeeping out of user quota while keeping it inside physical safety floors, then constrained that exclusion to genuine server-owned locations and made content plus synchronization-log changes transactional. The corresponding implementation commits were `9a58add` and `5c6a084`.
5. Review of `5c6a084` found destination races in concurrent COPY/MOVE and failure/crash atomicity gaps at the final calendar/contact renames. Commit `d52b3e6` introduced destination serialization and a filesystem journal.
6. Review of `d52b3e6` found that COPY/MOVE admission could retain a stale source size, and that rollback failures or insufficient fsync ordering could lose the journal needed for recovery. During remediation, a heavy parallel stress run produced intermittent cleanup, disk-measurement, and one unexplained COPY failure. The developer tightened server shutdown and cleanup in the tests, replaced real free-space observations with a deterministic virtual disk for reserve tests, and added failure diagnostics. The COPY failure did not reproduce after seed-status and response-body diagnostics were added.
7. Before `eb0f2ad` was committed, a short follow-up noted two more boundary requirements: copied directory entries must be claimed before creation, and deletion of a completed transaction record must itself be durable. `eb0f2ad` addressed both and added regression tests.
8. The present review confirms those improvements but identifies two remaining boundaries: a crash window between completing rollback and durably recording that rollback, and non-hierarchical locking during cross-budget directory MOVE.

## Verification at `eb0f2ad`

- The repository was clean; `HEAD` and `origin/main` both resolved to `eb0f2adc0e6979001d1f1ef6547bb3c51641c939`.
- The reviewed commit carried a valid Git signature from the repository's configured ED25519 signing key.
- The complete suite passed independently: **91 tests, 0 failures, 0 skipped**.
- The focused concurrent COPY/MOVE, source-sizing, journal rollback, recovery, fsync-order, and inode-claim tests passed.
- `docker compose config`, JavaScript syntax checks, `git diff --check`, and Git object checks completed successfully. Git reported only an existing dangling tag object, not repository corruption.
- `package.json` remained at `0.1.1`; no tag pointed at the reviewed commit.
- The owner reported 91/91 on Linux and macOS and a successful HTTPS Docker smoke test. Those platform-specific runs were not repeated independently in this review.

## Confirmed remediation

### Copies are charged for content actually copied

Drive COPY now meters bytes as they are streamed into the staging tree. It claims every file and directory entry before creating it, including entries discovered after the initial sizing pass. Calendar/contact copies and cross-budget moves remeasure under their applicable locks and can increase their reservation before committing.

The new probes correctly reject a grown copy that no longer fits, remove its staging tree, release its reservation, and preserve cached-versus-recounted usage. A directory that gains entries after initial sizing is stopped before crossing the simulated inode floor.

### Journal rollback failures retain their recovery record

If an in-process undo step fails, the prepared journal remains on disk. Startup recovery retries it; if recovery is still unable to finish, the record is retained and reported rather than discarded. This closes the concrete defect in which the source disappeared, the prior destination was stranded as a backup, and no recovery record remained.

### Staging and committed operations have substantially stronger durability ordering

Staged files and their parent directories are synchronized before the prepared record. Affected directories are synchronized after renames and before the committed record. Recovery of a committed transaction verifies and completes pending operations before deleting backups. Post-commit cleanup is best-effort, allowing startup recovery to finish a committed cleanup rather than incorrectly failing the already-committed user request.

### Stress-test infrastructure is more deterministic

Tests now await server shutdown and activity-log completion before deleting temporary trees, retry cleanup where appropriate, validate seed uploads, and report unexpected response bodies. Disk-floor tests use an injected filesystem measurement whose free space changes only with test writes. These changes address the observed cleanup and real-disk contention without weakening product assertions.

## Remaining findings

### High safety: power loss after rollback but before the aborted marker can delete restored originals

The error path currently performs the destructive rollback first, synchronizes the affected directories, and only then writes the durable `aborted` marker. A power loss between those operations leaves the older `prepared` journal durable after the staged files and backups have already been consumed by the successful rollback.

A deterministic reconstruction captured the prepared record, allowed rollback to restore the original object, and then restored that older record to model loss of the later aborted-record rename. On startup:

```json
{
  "restoredBeforeCrash": "ORIGINAL",
  "recovered": 0,
  "afterRecovery": null,
  "remainingJournals": 1,
  "recoveryState": "stuck"
}
```

Recovery saw the staged source as absent and the restored target as present, inferred that the replacement had been applied, deleted the restored original, and then failed because the already-consumed backup no longer existed. The new regression test covers resurrection after an `aborted` record exists; it does not cover loss of the aborted marker itself.

**Recommendation:** Durably record rollback intent before beginning rollback. For example:

1. Write and fsync a `rolling-back` record containing the current per-operation steps.
2. Undo operations idempotently in reverse.
3. Fsync affected directories.
4. Write and fsync `aborted`.
5. Remove the record and fsync the journal directory.

If writing `rolling-back` fails, no rollback has begun and the prepared-state recovery logic remains applicable. Recovery of `rolling-back` must use its recorded steps and always converge toward the pre-transaction state.

Add a regression that loses the aborted-marker update after the rollback has completed, restarts recovery, and verifies that the original content and synchronization log both survive and the journal is eventually removed.

### Medium: cross-budget directory MOVE can miss concurrent child writes

Remeasuring a directory while holding a lock on only that exact directory path does not prevent writes to its children. Child uploads acquire different exact-path locks. The web file API's move path performs its initial destination check, source sizing, and rename without the shared MOVE locking protocol at all.

Two deterministic probes moved a large Family directory into a user's Drive while a normal MyCloud upload added a 2 MiB child after the move's directory enumeration. One used WebDAV MOVE and one used the web API. Both the move and upload succeeded, and the late file arrived at the destination, but accounting was:

```json
{
  "lateFileAtDestination": 2097152,
  "destinationUsageUndercount": 2097152,
  "sourceUsageOvercount": 2097152,
  "activeReservations": 0
}
```

The destination can therefore exceed its configured quota until a cache expiry or restart recounts it. This is the directory/descendant form of the stale-source-size race: the second measurement is accurate at one instant, but its lock does not exclude the mutations whose size it is supposed to stabilize.

**Recommendation:** Use one mutation-serialization model across the web API and WebDAV. Options include ancestor-aware locks, or a conservative Drive-wide lock per physical budget acquired by MOVE and by every mutation beneath that budget. Acquire all involved budget locks in a stable order. Remeasure only after those locks are held, reserve the exact measured tree, perform the rename, and credit the source from the same measurement.

Add deterministic tests for both API and WebDAV cross-budget directory moves where a child upload is already in flight. The tests should require either that the child completes before measurement and is fully transferred and billed, or that it completes after the move against the new location or fails cleanly. Cached source and destination usage must equal fresh recounts in every outcome.

## Release guidance

Do not tag `v0.1.2` at `eb0f2ad`. The remediation is substantial and closes the exact stale COPY sizing, inode admission, failed-rollback-record, and committed-recovery findings, but the remaining crash window can destroy a restored calendar/contact object and the directory MOVE race permits authenticated quota drift across budgets.

After the next changeset, rerun the complete suite, the two probes above, the existing mutation checks, Linux bubblewrap coverage, and the HTTPS Docker smoke test. Keep the version at `0.1.1` until that review is complete; if it passes, bump the package version before creating a new `v0.1.2` prerelease tag rather than moving an existing tag.

---

Signed and dated on 2026-09-24 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request. The reviewed baseline was signed commit `eb0f2adc0e6979001d1f1ef6547bb3c51641c939`.
