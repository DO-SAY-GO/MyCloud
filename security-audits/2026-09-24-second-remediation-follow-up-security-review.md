# MyCloud Second Remediation Follow-up Security Review

**Date:** 2026-09-24 (America/New_York)  
**Prepared by:** OpenAI Codex, at the repository owner's request  
**Signature:** OpenAI Codex — follow-up security review artifact  
**Reviewed commit:** `723d8f1ac5a46d5e63956cc578430bf8c3ff2b7d`  
**Prior follow-up:** `security-audits/2026-09-24-remediation-follow-up-security-review.md`

## Scope and verification

This review evaluated the fixes made in response to the first remediation follow-up. It checked the four reported bypasses, the smaller residual issues, their regression coverage, and adjacent storage-limit boundaries.

Verification performed at the reviewed commit:

- The working tree was clean before the review.
- The complete automated suite passed locally: **45 tests, 0 failures, 0 skipped**.
- `docker compose config --quiet`, JavaScript syntax checks, `git diff --check`, and repository object checks passed.
- Source review covered canonical share authorization, DAV copy behavior, upload reservations, thumbnail isolation, SSRF address handling, importer cleanup, authentication concurrency, and proxy defaults.
- Focused probes tested the remaining disk-growth paths and the precision of the free-space reserve during chunked uploads.

The reviewer did not independently reproduce the reported Ubuntu 24.04 or live HTTPS Docker runs. The repository owner's reported 45/45 Linux result and Docker smoke test were not contradicted by this review.

## Executive verdict

The four bypasses from the preceding follow-up are closed at the reviewed commit:

- Family content cannot be published through a copied or swapped alias.
- Concurrent and chunked Drive uploads cannot bypass the per-user quota.
- Thumbnail jobs have a substantially stronger single-input boundary and bounded input/output sizes.
- IPv4-mapped IPv6 forms are rejected before an HTTP request is sent to a private destination.

The smaller follow-up items are also resolved: importer credentials are cleaned up on failure, parallel password verification is rationed, proxy trust is no longer embedded in the base image and requires a public URL, and unpinned Alpine packages are documented as a known gap.

However, **the release should not yet be tagged `v0.1.1`**. The boundary review found that storage quotas and the free-space reserve are not enforced across every disk-growing operation. The remaining finding is **medium-high severity** because an authenticated user can bypass the controls intended to prevent one account or protocol from exhausting the server's storage.

## Confirmed closed findings

### Family publication through aliases

Authorization is now based on the canonical location of an object, rather than its visible path alone, and is checked both when a share is created and when it is opened. DAV rejects copying the Family link, recursive folder copies exclude symbolic links, and a private object that is later swapped for an alias is no longer served by an existing link.

The documented security boundary is now accurate: these controls prevent direct or accidental publication through MyCloud, but cannot prevent a family member with legitimate read access from downloading data and sharing a separate copy.

### Chunked and concurrent Drive quota bypass

Drive uploads now reserve capacity while streaming. Declared sizes are claimed atomically, chunked transfers are metered as bytes arrive, concurrent uploads share the same reservation accounting, and overwrites count only their net growth.

The regression suite covers the original 2,048-byte chunked upload against 1,210 bytes of remaining quota, plus concurrent declared-size and chunked cases.

### Thumbnail isolation gaps

The Docker worker obtains its single-job slot before accepting an input, limits inputs to 384 MB, deletes scratch files before replying, and returns only output that MyCloud validates as a genuine JPEG below 2 MB. The Linux bubblewrap policy masks common host-data and temporary-file locations in addition to the application data and TLS paths.

The real-bubblewrap escape probe covers access to other application data, unrelated temporary files, and the network. Disabling thumbnails when the host will not permit the sandbox is a safe failure mode.

### IPv4-mapped IPv6 SSRF

Resolved addresses are classified using their normalized bytes before any request is transmitted, including alternate IPv4-mapped IPv6 representations. The loopback regression test covers seven spellings and confirms that the target server receives no request.

### Smaller residual items

- The importer uses guaranteed cleanup for its temporary device password and web session, including failure paths.
- Authentication work is bounded so a parallel burst is throttled rather than admitting every password verification.
- Proxy-header trust is enabled by the Compose deployment instead of the base image and requires `--public-url`.
- The limits of Alpine package reproducibility are recorded in `SECURITY.md`.

## Remaining finding

### Medium-high: storage enforcement does not cover every disk-growing path

The reservation mechanism protects Drive file uploads, but other authenticated write paths can still grow storage without acquiring quota or free-space capacity. These include:

- Calendar and CardDAV resource writes.
- Calendar and contact imports.
- WebDAV `COPY`, including recursive directory copies.
- Thumbnail cache growth.

Two focused probes demonstrated the boundary failure.

#### Contact import bypasses the user quota

With an account already using 186 bytes and only 1,210 bytes of configured quota remaining, a contact import containing an approximately 2 KB note returned HTTP `200` and imported one contact. The address-book data grew to 2,409 bytes.

This shows that the configured per-user quota is a Drive-upload limit rather than an account-wide storage limit on the current code path.

#### WebDAV COPY duplicates data without a reservation

With 1,500 bytes of quota headroom, uploading a 1,000-byte file returned HTTP `201`. Copying it through WebDAV returned HTTP `201` again, leaving two separate 1,000-byte files. The copy therefore exceeded the remaining quota even though the initial upload was admitted correctly.

Repeated copies, imports, or DAV object writes can likewise consume the filesystem reserve because those operations do not participate in the central reservation accounting.

**Impact:** An authenticated account can exceed its configured quota and can fill space intended to keep state updates, deletion recovery, and administration reliable. Per-request body limits reduce the size of an individual operation but do not stop repetition or concurrent use of different write paths.

**Recommendation:**

- Make one storage-admission and reservation layer mandatory for every operation that can increase persistent bytes.
- Cover Drive PUT, CalDAV/CardDAV PUT, imports, WebDAV COPY, recursive copies, and thumbnail-cache writes.
- Attribute each operation to the appropriate user or system budget and reserve its worst-case or measured growth before committing it.
- Calculate net growth for replacements; recursively size copies and imports; release reservations on every error and cancellation path.
- Add regression tests that attempt quota and reserve bypasses through each protocol and mutation type, including concurrent mixed-protocol operations.

### Disk-reserve enforcement is too coarse for small chunked uploads

The stream meter refreshes filesystem free space only after 16 MiB of progress. In a focused probe, the reserve was set to approximately 1 MiB below the current free space and a 2 MiB chunked Drive upload was sent. It returned HTTP `200` and stored the complete file, crossing the configured reserve without triggering another check.

**Recommendation:** Treat free space as a logical capacity budget, not only as an occasional `statfs` observation. Reserve declared capacity atomically, decrement a shared reservation as chunked bytes arrive, and reject before the aggregate committed-plus-reserved growth crosses the configured floor. Filesystem checks should remain as defense in depth for external disk use and accounting drift.

## Release guidance

Keep `v0.1.1` untagged until storage admission covers all persistent growth paths and the small-stream reserve gap is regression-tested. The four named bypasses from the preceding audit can be closed; the remaining release blocker is the cross-protocol storage-control boundary.

After that change, the next review should specifically test mixed concurrent operations—for example, a Drive upload racing a DAV copy and a contacts import—against both the user quota and filesystem reserve.

---

Signed and dated on 2026-09-24 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request.
