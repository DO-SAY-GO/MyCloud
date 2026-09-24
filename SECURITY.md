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

Behind any reverse proxy, run with `--trust-proxy` (exactly one proxy in front) and `--public-url https://your.domain`.
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
- **Share links** can't publish a whole Drive. Family content can only be published by the admin. Links expire after
  7 days by default, folder links say plainly that they are recursive, and access is logged.
- **Calendar links** pasted into Import can't reach private or loopback addresses. The check happens at connect time,
  so DNS rebinding doesn't get around it.
- **Uploads** are capped per file (`MYCLOUD_MAX_UPLOAD_GB`, default 50) and refused when free space would drop below a
  reserve (`MYCLOUD_DISK_RESERVE_GB`, default 2). Optional per-user quota: `MYCLOUD_QUOTA_GB`. Silent connections are
  dropped after two minutes, and partial uploads are cleaned up.
- **Thumbnails** (ImageMagick, ffmpeg) run in an OS sandbox: `sandbox-exec` on macOS, `bubblewrap` on Linux. They get no
  network, no view of the MyCloud data, home directories or other temp files (except the single input), and can write
  only to a scratch directory. Without a working sandbox, thumbnails are **off** (`MYCLOUD_THUMBNAILS=unsafe` overrides).
- **Deletes** from the web, Finder or the Files app go to **Recently Deleted** for 30 days. Only the admin can
  permanently erase Family items.
- **State files** (`users.json`, `sessions.json`, `invites.json`, `shares.json`) are changed under a lock file with atomic
  replacement, so the server, the CLI and concurrent requests never lose each other's writes.
- **Activity log** (`activity.log`): sign-ins and failures, sharing and link access, deletions and restores, device
  passwords, invites, resets and member removal. Admins see everyone's in Settings; members see their own.
- **Container:** image pinned by digest, non-root user, all capabilities dropped, `no-new-privileges`, read-only root
  filesystem, memory and process limits.

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
- **Family members have write access to all Family content.** Recently Deleted and the activity log make mistakes
  recoverable and visible, but don't prevent them.
