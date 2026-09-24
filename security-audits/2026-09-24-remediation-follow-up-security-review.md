# MyCloud Remediation Follow-up Security Review

**Date:** 2026-09-24 (America/New_York)  
**Prepared by:** OpenAI Codex, at the repository owner's request  
**Signature:** OpenAI Codex — follow-up security review artifact  
**Reviewed commit:** `4a1c848c396488b854670cbdc25e73b9fd43eb95`  
**Security-remediation commits included:** `210aace`, `6bd1d45`

## Scope and verification

This review followed the 2026-09-23 red-team/blue-team audit and evaluated the implemented remediations rather than relying only on their description. The working tree was clean at the reviewed revision.

Verification performed:

- Source review of authentication, invites, shares, upload limits, DAV behavior, deletion recovery, SSRF defenses, proxy handling, activity logging, thumbnail isolation, import credential lifecycle, and container hardening.
- The complete automated suite passed: **31 tests, 0 failures**.
- `docker compose config` accepted and expanded the production Compose configuration successfully.
- JavaScript syntax checks and `git diff --check` passed.
- Focused local probes were used for concurrency throttling, Family-share aliases, chunked quota enforcement, and IPv4-mapped IPv6 SSRF behavior.

The reviewer did not restart Colima or independently repeat the live HTTPS Docker smoke test. The repository owner's reported Caddy/MyCloud/thumbnailer smoke test was not contradicted by static inspection.

## Executive assessment

The remediation is a substantial security improvement. Invite atomicity, password recovery, canonical URL handling, proxy cookies, DAV credential separation, state-file locking, deletion recovery, logging, and container hardening are materially better.

Not every original finding is fully closed. Four controls remain bypassable or incomplete: Family publishing authorization, streaming user quotas, thumbnail job isolation, and private-address filtering for IPv4-mapped IPv6. No critical unauthenticated compromise was identified, but these issues should remain open until fixed and covered by regression tests.

## Findings

### Medium-high: Family publishing restriction is bypassable through a DAV symlink alias

A non-admin can WebDAV `COPY` the `Family` symlink under another name, then create a public recursive share of the alias because the API checks only whether the visible first path segment is literally `Family`.

The local probe produced:

- WebDAV `COPY`: HTTP `201`
- Copied object: symbolic link resolving to `family/files`
- Non-admin public share creation: HTTP `200`

The authorization check is name-based in `lib/api.js`, while `lib/dav.js` permits `COPY` and `fs.cp` preserves the symbolic link.

**Impact:** A non-admin can directly publish the shared Family tree despite the admin-only control. Aliases also complicate trash restoration and create additional shared links that ordinary users cannot remove because all symlinks are treated as the protected Family link.

**Recommendation:**

- Refuse WebDAV `COPY` of symbolic links.
- At share creation and on every public access, resolve the target with `realpath` and authorize based on canonical containment.
- Distinguish the one legitimate Family link from arbitrary symlinks when protecting move/delete operations.
- Describe the admin-only control as preventing accidental/direct publication, not malicious exfiltration: a family member with read access can always download and republish content manually.

### Medium-high: chunked uploads bypass configured per-user quotas

The streaming meter checks the per-file maximum and disk reserve but does not check the configured user quota. Quota enforcement in `admit()` depends on a declared `Content-Length`; a chunked upload is admitted with a declared size of zero.

In the local probe, the user had 1,210 bytes available under the configured quota. A 2,048-byte chunked upload returned HTTP `200` and stored all 2,048 bytes.

Concurrent uploads can also collectively consume the disk reserve because each independently observes free space and no capacity is reserved. The check occurs at 64 MB intervals after admission.

**Impact:** A user can bypass the optional quota using ordinary chunked transfer, including the streaming behavior used by import clients. Concurrent requests may consume the space intended to keep state and recovery operations working.

**Recommendation:**

- Give each stream meter the user's remaining quota and reject as soon as streamed bytes exceed it.
- Reserve quota and free-disk capacity under a lock before and during uploads so concurrent requests cannot claim the same bytes.
- Account for the size of a file being replaced.
- Add separate regression tests for chunked quota enforcement and concurrent disk-reserve enforcement.

### Medium-high: thumbnail isolation does not provide a one-input boundary

The separate thumbnail container is a strong architectural improvement, but inputs are received and staged in its shared `/tmp` before the conversion concurrency slot is acquired. More than one input can therefore be present and readable by the same container and Unix user.

If a hostile media file achieves code execution in ImageMagick or FFmpeg, it may read another user's concurrently staged image or video and encode that material into its own returned thumbnail.

The service also permits inputs up to 4 GB while Compose gives the container a 5 GB tmpfs and a 768 MB memory limit. Because tmpfs consumption counts against container memory on normal Docker deployments, sufficiently large media can repeatedly OOM or restart the thumbnail service. The main service does not cap the thumbnail response it writes into its cache.

For direct Linux-host deployments, bubblewrap read-only binds nearly the entire host and does not mask unrelated `/tmp` content, which is broader than the documented single-input boundary.

**Recommendation:**

- Acquire a single-job semaphore before accepting or staging an input.
- Use one isolated scratch namespace per conversion.
- Set the accepted input size safely below the worker's effective memory/tmpfs limit; return a placeholder for larger media.
- Cap and validate the thumbnail response received by MyCloud.
- Mask `/tmp`, `/var/tmp`, and unrelated host paths in bubblewrap, or construct a minimal filesystem instead of binding `/`.
- Add tests for cross-job visibility, oversized inputs, worker restart behavior, and oversized responses.

### Medium: blind SSRF remains through IPv4-mapped IPv6 forms

Address forms such as `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are not classified as private by the current string-based address checks.

The post-connect peer check rejects the response, but it runs after the HTTP request has reached the destination. Local probes confirmed that both representations reached a loopback HTTP service before MyCloud returned the private-address error.

**Impact:** Response exfiltration is blocked, but an authenticated user can still make blind requests to internal services. Internal GET endpoints with side effects remain exposed.

**Recommendation:** Normalize IPv6 addresses to their binary 16-byte representation before classification, including every IPv4-mapped representation. Reject the address before any HTTP request bytes are transmitted. Retain the peer-address check as defense in depth.

## Smaller residual issues

### Importer credentials are not cleaned up on every exit path

The importer revokes its temporary device password only on successful completion. An exception before the final revocation leaves the password active. The web session created to mint the password is not logged out, leaving a 30-day server-side session record.

Use `try/finally` around the entire import, revoke the device password in the `finally` block, then log out the temporary web session. Report cleanup failure instead of silently swallowing it.

### Authentication throttling does not bound concurrent password checks

Throttling is checked before asynchronous scrypt verification and failures are recorded afterward. A local burst of 20 simultaneous bad logins returned twenty `401` responses and no `429`, demonstrating that all were admitted before the threshold took effect.

Add a bounded global and per-account authentication semaphore, then recheck throttling after a request acquires its slot. This protects the crypto worker pool from burst exhaustion.

### Proxy trust remains a direct-container deployment footgun

`MYCLOUD_TRUST_PROXY=1` is embedded in the Docker image. A user running the image directly with a published port therefore trusts attacker-supplied forwarding headers, even though the hardened Compose topology correctly makes MyCloud reachable only through Caddy.

Set proxy trust in Compose rather than the base image. Prefer requiring a canonical public URL whenever proxy trust is enabled, or fail startup with a clear configuration error.

### Docker builds are not fully reproducible

The Node and Caddy base images are digest-pinned, but packages installed by `apk add` are resolved from mutable repositories without package-version or repository-snapshot pinning. The images are meaningfully safer from tag movement, but the documentation should not claim completely reproducible builds without pinning the package layer.

## Confirmed remediations

The following original findings were confirmed closed or materially resolved:

- Invite tokens are consumed atomically, and racing invitations for the same username preserve the losing token.
- Password recovery and default password changes revoke device credentials and other sessions.
- DAV rejects the account password and accepts device passwords only by default.
- Canonical public origin, Secure cookies, and HSTS work independently of attacker-controlled Host and forwarding-protocol headers when correctly configured.
- Web and DAV authentication use the same proxy-derived client identity under the documented one-proxy topology.
- State-file mutations use inter-process locks, atomic replacement, and owner-only permissions.
- Whole-Drive shares are rejected, share links expire by default, directory scope is disclosed, and access is logged.
- File deletions through the web and DAV enter Recently Deleted and can be restored.
- Security activity is visible in Settings.
- Containers drop capabilities, use `no-new-privileges`, read-only roots, process limits, memory limits, and non-root execution.
- When thumbnail generation is unavailable, large originals, HEIC files, and videos are no longer served as thumbnail fallbacks.
- `SECURITY.md` accurately records major known gaps including versioning, MFA/passkeys, at-rest encryption, advisory DAV locks, and Family write access.

## Release guidance

The service is substantially safer than at the first audit. Invite, recovery, DAV master-password, state-race, and proxy-cookie findings can be closed. Keep upload quotas, Family publication, SSRF, and thumbnail isolation open until the bypasses above are fixed and regression-tested.

Until then, the lowest-risk deployment remains trusted family users behind Tailscale or the hardened Compose topology, with encrypted storage, immutable snapshots, and tested restoration.

---

Signed and dated on 2026-09-24 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request.
