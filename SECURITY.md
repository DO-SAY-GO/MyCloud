# Security

MyCloud holds a family's photos, calendars, contacts and files, so it errs on the side of boring and explicit.
This page says what it defends against, how to deploy it safely, how to back it up, and what is **not** done yet.

Found a problem? Report it privately via **Security › Report a vulnerability** on GitHub, not in a public issue.

## Recommended deployments

| Profile | Suits | Do this |
|---|---|---|
| **Private (recommended)** | you and family on your own devices | `mycloud serve --host 127.0.0.1` + `tailscale serve`. Nothing is on the public internet. |
| **Public** | share links for outsiders, no VPN | the Docker/Caddy compose file (sets `--public-url` and `--trust-proxy` for you). |

In both cases:

- Put the data directory on an **encrypted** disk (FileVault, LUKS, encrypted volume).
- Take **snapshots** (see Backups) and test a restore once.
- Give family members their own accounts through invites. Never share the admin's account.

Behind any reverse proxy, run with `--trust-proxy` (exactly one proxy in front) and `--public-url https://your.domain`
(`--trust-proxy` refuses to start without it). The Docker image doesn't trust proxies by itself; compose turns it on
next to the Caddy it trusts.
MyCloud then takes the client address from the entry *that proxy appended* to `X-Forwarded-For`, derives cookie
security and every generated link from the configured URL rather than from request headers, and sends HSTS.

## What is defended

- **Passwords:** scrypt with per-hash parameters (upgradeable), timing-safe comparison, and throttling per client
  address and per account.
- **Devices** (Calendar, Contacts, Finder, importers) authenticate with per-device **app passwords only**. DAV never
  accepts the account password (unless `MYCLOUD_DAV_ACCOUNT_PASSWORD=1`), so a leaky client can't expose it.
- **Changing a password** signs out every other browser and, unless you choose to keep them, disconnects every device.
  **Reset links and `mycloud passwd`** (account recovery) always do both, and void undelivered setup profiles.
- **Web sessions** use HttpOnly, SameSite=Lax cookies, Secure whenever the browser is on HTTPS (also behind a proxy).
  Every state-changing API call needs a custom header, so a cross-site form can't forge it.
- **Uploaded content** is served under a `sandbox` Content-Security-Policy, so an uploaded HTML or SVG can't run as you.
- **Paths** are validated per segment, and each user is confined to their own tree plus the shared Family space.
- **Invite and reset links** are single-use, even under concurrent redemption, and expire (7 days / 24 hours).
- **Share links** can't publish a whole Drive. Family content can only be published by the admin, decided by where
  the content *really* lives (after following links) both when a link is made and on every access, and WebDAV
  refuses to copy the Family link. Links expire after 7 days by default, folder links say plainly that they are
  recursive, and access is logged. This stops *accidental or direct* publishing; a member who can read Family
  content can always download it and share a copy, and no server can prevent that.
- **Calendar links** pasted into Import can't reach private or loopback addresses. Addresses are compared as bytes, so
  every spelling counts (`::ffff:7f00:1`, IPv4-compatible, NAT64, 6to4). The check runs inside the connection's own
  address lookup, before any byte is sent, so DNS rebinding doesn't get around it either.
- **Storage admission:** every operation that grows storage passes one gate before writing: Drive and WebDAV uploads,
  CalDAV/CardDAV writes, `.ics`/`.vcf` imports, new events and contacts, WebDAV COPY (sized recursively), moves into
  another budget, new folders and collections, collection properties (PROPPATCH), files created by WebDAV LOCK, and
  the thumbnail cache.
  - Every filesystem entry is charged a 4 KB block on top of its content, and each budget has a file-and-folder limit
    (`MYCLOUD_MAX_FILES`, default 1,000,000) plus a free-inode reserve (`MYCLOUD_INODE_RESERVE`, default 10,000), so
    empty files and metadata can't exhaust the filesystem.
  - Disk space is reserved at an operation's *peak*: a replacement needs room for its whole new copy, because it is
    written in full beside the original before the swap. Only the quota is charged the net difference.
  - A copy or move is admitted and fully staged before anything at the destination is touched; the swap is a single
    rename. A refused or failed overwrite leaves the destination as it was, and a replaced Drive item goes to
    Recently Deleted.
  - Budgets: each user (`MYCLOUD_QUOTA_GB`), the shared Family space (`MYCLOUD_FAMILY_QUOTA_GB`, defaulting to the user
    quota so Family isn't a way around it), and a system budget for thumbnails (nobody's quota, still bound by the
    disk reserve). Where a write is billed is decided by where it really lands, with links followed.
  - The disk reserve (`MYCLOUD_DISK_RESERVE_GB`, default 2) is a byte ledger: free space at the last measurement,
    minus bytes written since, minus bytes other operations have claimed. It's checked on every reservation and every
    streamed chunk, so even a small upload can't cross the floor. Real measurements refresh it.
  - Reservations are claimed atomically, count everything in flight across protocols, bill overwrites only for the
    difference, and are released on every error path. Files are capped at `MYCLOUD_MAX_UPLOAD_GB` (default 50), and
    collection properties at 64 KB. Silent connections are dropped after two minutes; partial uploads are cleaned up.
- **Sign-in attempts** are rationed (2 in flight per address, 4 overall) and throttled per address and per account,
  so parallel guessing is held to the same limits as sequential guessing.
- **Thumbnails** (ImageMagick, ffmpeg) never run next to your data:
  - **Docker (compose):** in a separate `thumbnailer` container with no data volume, no internet (an `internal`
    network shared only with MyCloud), a read-only root, no capabilities, and memory and process limits. It runs
    **one job at a time**, taking the slot before it accepts the upload, so two people's files are never on it
    together. Inputs are capped (`MYCLOUD_THUMBNAIL_MAX_MB`, default 384) below its memory limit.
  - **Directly on a host:** in an OS sandbox: `sandbox-exec` on macOS, `bubblewrap` on Linux. The sandbox sees the
    system's programs and libraries, the single input and a scratch directory. `/tmp`, `/var`, `/home`, `/root`,
    `/run`, `/mnt`, `/media`, `/srv`, `/sys`, the data directory and the TLS key directories are hidden, and there is
    no network.
  - MyCloud accepts only a genuine JPEG (by its first bytes) under 2 MB back from any converter.
  - **Ubuntu 23.10+ (incl. 24.04)** blocks the user namespaces bubblewrap needs by default, so MyCloud will report
    "thumbnails disabled". Allow bubblewrap alone, rather than lifting the restriction system-wide, with an AppArmor
    profile, then restart MyCloud:
    ```
    sudo tee /etc/apparmor.d/bwrap <<'EOF'
    abi <abi/4.0>,
    include <tunables/global>
    profile bwrap /usr/bin/bwrap flags=(unconfined) {
      userns,
    }
    EOF
    sudo apparmor_parser -r /etc/apparmor.d/bwrap
    ```
  - With neither available, thumbnails are **off** (`MYCLOUD_THUMBNAILS=unsafe` overrides). Only small JPEG/PNG/WebP
    originals stand in; HEIC, video and large files show a placeholder.
- **Deletes** from the web, Finder or the Files app go to **Recently Deleted** for 30 days. Only the admin can
  permanently erase Family items.
- **State files** (`users.json`, `sessions.json`, `invites.json`, `shares.json`) are changed under a lock file with atomic
  replacement, so the server, the CLI and concurrent requests never lose each other's writes.
- **Activity log** (`activity.log`): sign-ins and failures, sharing and link access, deletions and restores, device
  passwords, invites, resets and member removal. Admins see everyone's in Settings; members see their own.
- **Containers:** images pinned by digest, non-root user, all capabilities dropped, `no-new-privileges`, read-only root
  filesystems, memory and process limits. MyCloud itself isn't published on the host, only through Caddy. State files
  are owner-only (`0600`).

## Backups and restore

Everything is plain files under the data directory (default `~/.mycloud`), so standard tools work.

1. **Snapshots:** use a snapshotting filesystem (ZFS, btrfs, APFS) or LVM, and snapshot the data directory daily. A
   snapshot is consistent. A plain `rsync` of a *running* server may catch a file mid-change.
2. **Off-site, encrypted:** back the latest snapshot up with a tool that encrypts client-side and supports immutable or
   append-only storage, e.g. `restic` or `borg` to another machine or to object storage with object lock.
3. **Restore:** stop MyCloud, restore the data directory from a snapshot, check ownership (the service user needs
   read/write), and start MyCloud. Devices reconnect by themselves; calendars and contacts re-sync from the server's
   state.

Test step 3 once, before you need it.

## Known gaps (not done yet)

- **No file versioning:** overwriting a file replaces it. Deletes are recoverable (Recently Deleted); overwrites aren't.
- **WebDAV locks are advisory**, so two clients editing the same file at once can overwrite each other.
- **No MFA or passkeys** for the web account yet.
- **Data at rest is not encrypted by MyCloud.** Use disk encryption. Anyone who controls the running server can read
  everything.
- **Share links** have no password option yet.
- **Alpine packages in the image are not version-pinned** (the base image is pinned by digest). Builds are hardened,
  but not bit-for-bit reproducible over time.
- **Family members have write access to all Family content.** Recently Deleted and the activity log make mistakes
  recoverable and visible, but don't prevent them.
