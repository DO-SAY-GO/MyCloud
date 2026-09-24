# MyCloud Red-Team / Blue-Team Security Review

**Date:** 2026-09-23 (America/New_York)  
**Prepared by:** OpenAI Codex, at the repository owner's request  
**Signature:** OpenAI Codex — security review artifact  
**Audit base commit observed during review:** `6c512f3a069ad74d08d41f0da60d521c85be4afe`  
**Subsequent repository commit containing most reviewed in-progress importer/profile work:** `580cb32594119247706c698a4121aee99f04d2a4`

## Provenance and scope

This review was performed against the working tree on 2026-09-23. At test time, `HEAD` was `6c512f3a069ad74d08d41f0da60d521c85be4afe` and the tree contained pre-existing, uncommitted importer, profile, server, API, and web-app changes. Those changes were not made by the reviewer. Most were subsequently committed by the repository owner as `580cb32594119247706c698a4121aee99f04d2a4`; because the working tree continued changing, this report does not claim that either commit alone exactly reproduces every byte reviewed.

The review covered authentication and authorization, public shares, DAV isolation, path handling, proxy and cookie behavior, calendar URL fetching, media processing, storage safety, deployment defaults, and adversarial test coverage. It was a source review plus focused local probes, not a production penetration test or proof of formal security.

The test suite present during the audit passed: 20 tests, 0 failures. Passing functional tests did not address the concurrency, resource-exhaustion, proxy, recovery, or consent-boundary findings below.

## Executive assessment

MyCloud has a strong small-codebase foundation and several sound controls. It was not yet suitable for direct public-Internet exposure or for accounts belonging to partially trusted family members.

The defensible deployment at the time of review was one trusted user behind Tailscale, backed by automatic immutable filesystem snapshots. The largest risks were availability and data loss, account-recovery gaps, reverse-proxy configuration, public-sharing boundaries, and privileged parsing of uploaded media.

## Findings

### High: invite redemption is not single-use under concurrency

The invite is checked before asynchronous password hashing and removed afterward. Two simultaneous redemptions of the same join invite both succeeded in a local probe, creating two accounts from one supposedly single-use token.

**Impact:** A leaked or intercepted invite can be raced to create additional persistent accounts. Reset links can likewise be raced, producing unpredictable final credentials.

**Recommendation:** Serialize redemption per invite and atomically mark the token consumed before expensive password work. If later work fails, fail closed rather than making the token reusable. Add a concurrency test requiring exactly one successful redemption.

### High: unbounded uploads and disabled request timeout enable denial of service

Drive uploads are streamed without a byte limit, while the HTTP server disables its request timeout to support slow large uploads.

**Impact:** Any account or stolen app password can fill the disk, exhaust file descriptors, or hold connections indefinitely. A full disk can also prevent credential, session, and sync-state writes, turning an availability incident into corruption or recovery trouble.

**Recommendation:** Add streaming request limits, per-user quotas, reserved free-space enforcement, idle and total-duration limits, a minimum transfer rate, connection limits, and reliable cleanup of interrupted temporary files.

### High: thumbnailers process hostile files with access to all cloud data

ImageMagick, `sips`, and FFmpeg are executed directly on uploaded files under the MyCloud process's security context. A timeout limits duration but not parser privileges, network access, memory, child processes, or readable files.

**Impact:** A media-decoder vulnerability can expose or corrupt every user's files and server credentials, even though the main service runs as a non-root user.

**Recommendation:** Put conversion in a separate sandbox or worker container with no network, one read-only input, an output-only directory, strict CPU/memory/process limits, a restrictive seccomp profile, and explicit format policies. Make thumbnails opt-in if that isolation is unavailable.

### High: password recovery does not revoke app passwords

Changing or resetting the account password invalidates web sessions but preserves DAV app passwords.

**Impact:** A stolen device credential survives the user's attempt to recover the account and continues granting file, calendar, and contact access.

**Recommendation:** A recovery/reset flow should revoke sessions, app passwords, pending profile downloads, and cached Basic authentication. An ordinary authenticated password change may separately offer an explicit option to retain selected trusted devices.

### High: public share scope permits accidental or non-consensual disclosure

The share API accepts an empty path, allowing a public share of the user's entire file root. A local probe confirmed this behavior. Any family member can also publish the shared Family folder or items within it without approval from the other affected users.

**Impact:** A single API call can expose all private Drive content. One family member can expose recursively shared family material without the consent of its other owners.

**Recommendation:** Reject root and empty-path shares. Require an explicit recursive-directory confirmation, display the precise public scope, and require administrator or owner approval before Family content can be made public. Consider file-only shares as the default.

### Medium-high: calendar URL fetching is vulnerable to DNS rebinding

The importer resolves and validates a hostname, then performs a normal `fetch()` which can resolve it again. An attacker-controlled DNS name can return a public address during validation and a private address during the connection.

**Impact:** An authenticated user may induce requests to loopback, link-local, cloud metadata, or internal services. Data extraction depends on response shape, but blind reads and state-changing internal GET requests remain possible.

**Recommendation:** Pin a validated public address for the actual connection while preserving TLS SNI and hostname verification. Validate the connected peer address and repeat the procedure independently for every redirect. Expand IPv6 special-range handling.

### Medium-high: reverse-proxy cookies are not marked Secure

Cookie security is derived from whether MyCloud itself terminates TLS. In the recommended Caddy topology, TLS terminates at Caddy and MyCloud emits a session cookie without the `Secure` attribute. This was confirmed in a local proxy-mode probe.

**Impact:** A browser can send the session cookie on an initial plaintext HTTP request before a redirect, permitting theft on an untrusted network unless HSTS was already established.

**Recommendation:** Configure the canonical external origin and secure-cookie policy explicitly. Default to secure cookies in trusted-proxy HTTPS deployments. Send HSTS from the public TLS endpoint after confirming HTTPS-only operation.

### Medium: proxy-aware login throttling is inconsistent

Web login uses the first `X-Forwarded-For` value when proxy trust is enabled. DAV authentication uses the direct socket address even behind a proxy.

**Impact:** Depending on proxy behavior, attackers can spoof addresses to evade web throttling, or all DAV clients can share one throttle bucket and be denied service by a single attacker.

**Recommendation:** Configure trusted proxy addresses or hop counts, derive one verified client identity, and use it consistently. Rate-limit by both account and client address, with bounded global authentication concurrency.

### Medium: durable state lacks cross-process transactions

JSON writes use temporary-file replacement, which protects against partial individual files, but there is no transaction or cross-process lock around read-modify-write operations. The CLI, server, and concurrent requests can race.

**Impact:** Sessions, users, shares, or invites can be lost or resurrected during concurrent mutation. A live `rsync` is not guaranteed to capture a consistent state across related files.

**Recommendation:** Serialize state mutations across processes or use a small transactional database with strict durability settings. Document a snapshot-based backup procedure and test restoration.

### Medium: destructive shared access has no recovery layer

Family members have write and delete access to shared material. Deletes are immediate and recursive, DAV locks are advisory, and there is no trash, versioning, retention, or undo.

**Impact:** A compromised device, mistaken operation, buggy sync client, or malicious family account can destroy shared data quickly.

**Recommendation:** Add trash and version retention, immutable snapshots, encrypted off-site backup, restore tooling, and deletion/activity records. Treat backups as part of the security model rather than an optional operational extra.

## Additional hardening recommendations

- Generate URLs and device profiles from a configured canonical public origin, not unvalidated request host and forwarding headers.
- Add optional share expiration, password protection, download-only behavior, access logs, and clear recursive-scope labeling.
- Provide session and device management, security-event notifications, and MFA or passkeys for web access.
- Prefer app passwords exclusively for DAV so a client compromise does not disclose the master web credential.
- Add HSTS, a conservative `Permissions-Policy`, and explicit cache controls for sensitive responses.
- Pin container base images by digest and use dropped capabilities, `no-new-privileges`, read-only application files, and resource limits.
- Store explicit password-hashing parameters and a format version so hashing cost can be upgraded safely.
- Bound app-password, session, share, and invite counts.
- Add adversarial tests for invite races, proxy headers, secure cookies, DNS rebinding, interrupted/quota-exceeded uploads, reset revocation, root shares, symlink behavior, and malformed XML/ranges.

## Existing strengths

- Strong random session, invite, share, and app-password tokens.
- Scrypt password hashing and timing-safe comparison.
- Clear per-user DAV owner checks.
- Segment-level rejection of ordinary path traversal.
- `HttpOnly` and `SameSite=Lax` session cookies.
- A meaningful CSRF barrier using a non-simple request header.
- A sandboxing CSP for most uploaded user content.
- Non-root container execution.
- A small application dependency and code surface.

## Recommended release gate

Before recommending public or multi-member deployments, fix invite atomicity, upload controls, thumbnail isolation, credential-reset semantics, root/Family sharing policy, secure proxy cookies, and backup/recovery behavior. Until then, prefer private-network access, trusted users only, isolated thumbnailing, encrypted host storage, and automatic immutable snapshots.

---

Signed and dated on 2026-09-23 by **OpenAI Codex**, acting as a security reviewer at the repository owner's request.
