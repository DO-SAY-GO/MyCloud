# MyCloud Third Remediation Follow-up Security Review

**Date:** 2026-09-24 (America/New_York)  
**Prepared by:** OpenAI Codex, at the repository owner's request  
**Signature:** OpenAI Codex — follow-up security review artifact  
**Reviewed commit:** `18f7836fec077f1f65d1e7ebff07a6e041644996`  
**Prior audit artifact:** `security-audits/2026-09-24-second-remediation-follow-up-security-review.md`

## Scope and verification

This review evaluated the changes made after the storage-admission boundary review of commit `7d572d063286980f6c2d311488c4d419dc82b747`. It tested the three reported findings directly and inspected the expanded byte, entry, and inode accounting for adjacent bypasses.

Verification performed at the reviewed commit:

- The working tree was clean before and after the review.
- The complete automated suite passed independently: **61 tests, 0 failures, 0 skipped**.
- The regression suite reproduces the reviewer probes for replacement peak space, PROPPATCH growth, LOCK-created empty files, and non-destructive DAV overwrites.
- `docker compose config` accepted the configuration when supplied a test public domain.
- JavaScript syntax checks, `git diff --check`, and repository object checks passed.
- Focused local probes tested quota accounting for server-generated synchronization metadata.

The reviewer did not independently repeat the reported Linux or live HTTPS Docker smoke tests. The repository owner's reported 61/61 Linux result and Docker smoke test were not contradicted by this review.

## Executive verdict

The three findings from the preceding review are closed at the reviewed commit:

- Replacements reserve enough physical space for the complete staged copy while charging only net growth to the user's quota.
- WebDAV PROPPATCH and file-creating LOCK operations pass through storage admission, with per-entry charges, per-budget entry limits, and a filesystem inode reserve.
- DAV COPY and MOVE stage and admit their work before touching an existing destination. The exact CalDAV and Drive failure probes preserve the original destination.

One deeper accounting gap remains. MyCloud-generated synchronization and trash metadata is included when usage is recounted, but its growth is not included in the live reservation that permits the triggering operation. An authenticated user can therefore exceed the configured quota between recounts using operations whose user payload does not grow.

The remaining finding is **medium severity**. Hold the proposed `v0.1.2` tag until it is fixed and regression-tested.

## Confirmed closed findings

### Replacement writes reserve peak disk use

Quota accounting and physical disk accounting are now separated appropriately. Replacing a file charges the quota only for net growth, while the disk ledger claims the full new copy because it is staged beside the original.

The exact probe—attempting a 2 MiB replacement with only 1 MiB available above the disk floor—is rejected. An end-to-end DAV overwrite that would cross the reserve also fails with the original file intact and no partial staging files left behind.

### PROPPATCH and LOCK pass through storage admission

Collection-property updates reserve their projected serialized growth. A roughly 40 KiB property change with only 1,024 bytes of quota headroom is rejected without altering the properties file.

A LOCK on a missing DAV path now reserves the new file entry. The original probe of 100 LOCK requests at zero quota headroom produces no files. The implementation also adds:

- A 4 KiB quota charge for every filesystem entry in addition to its content.
- A per-budget file-and-folder limit through `MYCLOUD_MAX_FILES`, defaulting to 1,000,000.
- A free-inode floor through `MYCLOUD_INODE_RESERVE`, defaulting to 10,000.

These controls materially improve resistance to empty-file and inode-exhaustion attacks.

### Refused DAV overwrites preserve existing data

COPY and MOVE operations are admitted and staged before the destination is changed. The exact CalDAV probe—copying `a.ics` over `b.ics` while at quota—returns HTTP `507` and leaves `b.ics` unchanged.

Matching Drive COPY and cross-budget MOVE failure cases also preserve both sides. A successful same-budget Drive replacement keeps the displaced destination in Recently Deleted.

## Remaining finding

### Medium: server-generated metadata is omitted from live reservations

Calendar and address-book item mutations call `recordChange`, which rewrites and grows the collection's `.sync.json`. The enclosing storage reservation is sized for the user item, but not for this synchronization-log growth.

A focused probe configured a quota exactly large enough for one contact and its filesystem-entry charge, then overwrote that contact 250 times without changing its payload size. Every overwrite was accepted. The result was:

- Configured quota: 65,772 bytes.
- Actual accounted usage: 84,997 bytes.
- Usage above quota: 19,225 bytes.
- Final `.sync.json` size: 19,252 bytes.

The usage recount includes `.sync.json`, so the configured quota and the live cached accounting disagree until the cache expires and usage is walked again.

Recently Deleted has the same structural problem. Moving an item to trash creates a trash directory and `meta.json`; Drive replacement also does this when preserving the displaced destination. Those bytes and entries are not part of the surrounding reservation.

**Impact:** An authenticated user can temporarily exceed byte and entry limits through same-size calendar/contact overwrites and trash-producing operations. Because this metadata also bypasses the live disk and inode ledger, sufficiently large or concurrent workloads can consume part of the configured safety floors before a real filesystem measurement corrects the ledger. The synchronization log is bounded per collection, but the behavior composes across collections and trash entries.

**Recommendation:**

- Include the projected `.sync.json` replacement in the same reservation as each collection mutation. Account for its atomic-write peak as well as its net quota growth.
- Reserve the trash directory, `meta.json`, and serialized metadata size before any delete or Drive overwrite that creates a Recently Deleted entry.
- Update byte and entry caches from the actual committed deltas, or conservatively reserve an upper bound and reconcile immediately after the mutation.
- Add regression tests for repeated same-size CalDAV/CardDAV overwrites at quota, deletion at the entry limit, and Drive overwrite trash metadata against both byte and inode floors.

An alternative policy is to exclude internal metadata from per-user quotas explicitly. If that policy is chosen, internal writes must still reserve global disk space and inodes so they cannot cross the server's safety floors.

## Release guidance

Do not tag `v0.1.2` yet. Close the server-generated metadata accounting gap and run the complete suite plus focused concurrent metadata tests first.

When preparing the release, update the package version from `0.1.1` to `0.1.2`. If `v0.1.1` has already been published, leave that tag immutable and issue the fixes under the new version.

---

Signed and dated on 2026-09-24 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request.
