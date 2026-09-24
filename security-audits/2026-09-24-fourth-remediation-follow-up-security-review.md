# MyCloud Fourth Remediation Follow-up Security Review

**Date:** 2026-09-24 (America/New_York)  
**Prepared by:** OpenAI Codex, at the repository owner's request  
**Signature:** OpenAI Codex — follow-up security review artifact  
**Reviewed commit:** `9a58adda9d2512dda36d02418ae880e0083bdbb0`  
**Prior audit artifact:** `security-audits/2026-09-24-third-remediation-follow-up-security-review.md`

## Scope and verification

This review evaluated the changes made in response to the third remediation follow-up, which found that server-generated synchronization and trash metadata could cause live storage accounting to drift from a fresh recount.

Verification performed at the reviewed commit:

- The complete automated suite passed independently: **65 tests, 0 failures, 0 skipped**.
- The regression suite covers 250 same-size contact overwrites, cached-versus-fresh usage after writes and removals, disk-floor enforcement for sync logs, properties and trash records, and 200 concurrent metadata-heavy operations.
- Source review covered quota recount exclusions, bookkeeping reservations, content mutation ordering, removal credits, user and Family budget ownership, and the interaction between nested content and system reservations.
- `docker compose config`, JavaScript syntax checks, `git diff --check`, and repository object checks passed.
- Focused local probes tested user-controlled bookkeeping filenames and failure ordering when a content write succeeds but its synchronization-log reservation is refused.

The reviewer did not independently repeat the reported Linux or live HTTPS Docker smoke tests. The repository owner's reported 65/65 Linux result was not contradicted by this review.

## Executive verdict

The previously reported accounting gap is materially improved:

- Server-owned collection properties, synchronization logs, and trash records are excluded from user quotas.
- Those writes still reserve physical bytes and entries through the system budget.
- Synchronization logs and properties remain bounded.
- Successful content removal credits cached user or Family usage immediately.
- The exact 250-overwrite probe no longer causes user-quota drift.

However, the bookkeeping separation introduces two release-blocking boundary failures. First, bookkeeping filenames are excluded by basename throughout the entire user tree, allowing user-controlled Drive files to disappear from cold quota recounts. Second, collection content is committed before the nested bookkeeping reservation occurs, so a refused metadata update can leave a supposedly failed content mutation on disk and outside live accounting.

Both findings are **medium-high severity** because they permit authenticated quota bypass or produce unsafe partial commits. Hold `v0.1.2` until they are fixed and regression-tested.

## Confirmed remediation

### Bounded bookkeeping is outside user quotas but inside server safety floors

The chosen policy is reasonable: internal synchronization logs, collection properties, and trash records do not consume a user's quota, while the server still reserves their peak writes against disk and inode floors. The synchronization log retains at most 2,000 records per collection and collection properties remain capped at 64 KiB.

The original probe of 250 same-size contact overwrites now stays within the configured user quota even though the synchronization log grows. Tests also confirm that metadata rewrites and trash-record creation are refused when the server has insufficient space.

### Successful removals update cached usage

Calendar and contact deletion, collection deletion, trash purging and expiry, and cross-budget moves now credit the applicable cached budget without waiting for the ten-minute recount. Regression coverage compares cached usage to a fresh filesystem walk across user and Family operations, including concurrent workloads.

## Findings

### Medium-high: user-controlled bookkeeping filenames bypass cold quota recounts

The recount function excludes every file whose basename is `.sync.json` or `.props.json`, regardless of where the file lives. These names are internal bookkeeping only inside calendar and address-book collection directories, but authenticated users can create files with the same names in Drive through the file API or WebDAV.

A focused probe wrote a 1 MiB file at `Documents/.sync.json`. The filesystem contained the full 1,048,576-byte file, but a fresh usage recount reported:

- Accounted byte increase: **0**.
- Accounted entry increase: **0**.

The live reservation initially charges the upload, but the file disappears from quota and file-count accounting after a server restart or the ten-minute cache refresh. A user can repeat the bypass in multiple directories.

**Recommendation:** Make exclusions structural rather than name-based. Exclude only the exact server-owned `.sync.json` and `.props.json` paths inside valid calendar and address-book collection directories. When recounting the contents of a trashed user directory, count all user-controlled names normally. Moving bookkeeping into a dedicated server-only tree would provide a cleaner long-term boundary.

Add regression tests that upload `.sync.json` and `.props.json` through both Drive APIs and WebDAV, expire or reconstruct the usage cache, and verify that bytes and entries remain charged.

### Medium-high: content commits before bookkeeping admission completes

Calendar and contact writes commit the user object first, then call `recordChange`, which separately reserves and rewrites `.sync.json`. If that nested system reservation is refused at the disk floor, the outer request fails but the already-written content remains.

A focused probe gave the outer content reservation enough space while leaving insufficient space for the subsequent synchronization-log rewrite. The result was:

- Returned error: HTTP-equivalent `507`, “the server is out of space.”
- New contact remained on disk: **yes**.
- Active reservations after failure: **0**.
- Cached usage: **45,056 bytes and 11 entries**.
- Fresh recount: **49,202 bytes and 12 entries**.

The failed outer reservation is released as though no content was committed, creating both a client-visible partial commit and a live quota bypass. Deletion has the corresponding ordering risk because the object is removed before synchronization bookkeeping is admitted. A multi-item import can partially commit several objects before a later metadata failure.

**Recommendation:** Acquire the content and projected bookkeeping reservations before changing either file. Treat the content object and synchronization state as one logical transaction: stage both, commit them in a recoverable order, and roll back or replay through a small journal if either filesystem operation fails. Apply the same invariant to create, overwrite, delete, MOVE/COPY of collection items, and multi-item import.

Add injected-disk-floor regression tests that force bookkeeping admission to fail after content admission and verify:

- A failed create leaves no new item.
- A failed overwrite preserves the original item.
- A failed delete preserves the item and synchronization state.
- A failed multi-item import leaves no partial batch.
- Cached usage equals a fresh recount and no reservation remains active after every failure.

## Release guidance

Do not tag `v0.1.2` yet. Fix the path-scoping error in quota recounts and make collection content plus synchronization bookkeeping failure-atomic. Then rerun the complete suite and the focused cold-recount and injected-failure probes.

The reviewed remediation commit is signed. The preceding audit artifact was committed separately as `cbb6a86d3a589c46c58478dc281d34591fddb1a0`, directly on top of the reviewed commit. No `v0.1.2` tag existed at the time of review, and the package version remained `0.1.1`.

---

Signed and dated on 2026-09-24 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request.
