# ☁️ MyCloud

**Your own iCloud.** Drive, Photos, Notes, Calendar and Contacts, running on hardware you control. Open source. Zero dependencies.

**iCloud, unbundled.** Apple's walled garden, broken back into plain folders, plain files and the open protocols it was built on all along: CalDAV, CardDAV and WebDAV. Your calendar is a folder of `.ics` files. Your contacts are `.vcf` files. Your notes are Markdown. Your photos are just your photos.

MyCloud speaks the same open protocols that iCloud uses under the hood: **CalDAV**, **CardDAV** and **WebDAV**. The built-in apps on your iPhone, iPad and Mac (and Android via DAVx⁵, and Thunderbird) sync with it natively, so you don't need a special app. A clean web app covers everything else.

```
npx github:DO-SAY-GO/MyCloud adduser you
npx github:DO-SAY-GO/MyCloud serve
```

Open http://localhost:8080 and you're in.

## Why not Nextcloud + Immich?

They're great, and they do far more than MyCloud does. But look at what "self-hosting iCloud" actually means today:

| | Nextcloud + Immich | MyCloud |
|---|---|---|
| Things to run | PHP app, web server, database, Redis, cron, Immich server, ML container, a second database | **One process** |
| Dependencies | Hundreds of packages across two stacks | **Zero.** Node's standard library only |
| Where your data lives | Files plus database rows that have to stay in sync | **Plain files.** `.ics`, `.vcf`, `.md` and your photos, untouched |
| Backup | Dump both databases, snapshot the volumes, hope they match | `rsync -a ~/.mycloud elsewhere:` |
| Upgrading | Schema migrations, app compatibility, major-version steps | Replace the files and restart |
| Leaving | Export tools | You already have your files |
| Reading the code | Hundreds of thousands of lines | **~4,000 lines**, importers included. One afternoon, by you or your AI |

**The cost of self-hosting was never the server. It was the sysadmin.** Compute is getting almost free. A spare mini-PC, a $4 VPS or the idle CPU in the box under your TV can run a personal cloud. What stays expensive is attention: the 2 a.m. database migration, the container that won't start after an update, not knowing what's in the software holding your family photos.

MyCloud is built for that world:

- **Small enough to trust.** You (or an agent you trust) can read every line that touches your data. Nobody can audit Nextcloud before breakfast. You can audit MyCloud.
- **Boring on purpose.** No database, no background jobs, no plugins. There's nothing to corrupt, drift or migrate.
- **Native, not another app.** Your iPhone already has a Calendar, Contacts and Files app. MyCloud feeds them over the open protocols iCloud itself uses, so there's nothing to install on your phone.
- **Your files outlive the software.** Stop running MyCloud tomorrow and you still have a folder of standard calendar, contact, note and photo files that every OS on earth can open.
- **One per person, not one per company.** It's designed to run a thousand times over, once for each family, not as one big instance for thousands of users.

**Where the others win (honestly):** Immich has face recognition, smart search and a background auto-upload app. Nextcloud has an office suite, collaboration and a huge app store. If you need those, run them. If you want *your iCloud back* with the least possible machinery between you and your files, run this.

## Bring your stuff

On your Mac, one command copies everything iCloud keeps there into MyCloud:

```bash
npx github:DO-SAY-GO/MyCloud import mac --server https://cloud.example.com --user you
```

| Brings | How | Notes |
|---|---|---|
| Contacts | Contacts.app | every card, including photos |
| Calendars | EventKit | all accounts; repeating events keep their time zone; subscribed calendars are skipped |
| Reminders | EventKit | each list becomes a CalDAV list that shows up in the Reminders app |
| Notes | Notes.app | Markdown, with inline images saved alongside; locked notes are skipped |
| Photos | PhotoKit | **originals** (plus Live Photo videos and RAW pairs), downloaded from iCloud if needed, filed by capture date |
| iCloud Drive | the folder on disk | original modification dates kept |
| Voice Memos | the folder on disk | needs Full Disk Access for your terminal |
| Safari bookmarks | Bookmarks.plist | a standard `bookmarks.html` any browser imports; needs Full Disk Access |

It's **safe to run again**: items are keyed by their Apple IDs, files already on the server are skipped, and Photos resumes where it stopped. Try `--dry-run` first to see the counts, and use `--only photos,notes` to pick sources. macOS will ask once for each app; click OK.

**iPhone over USB:** plug it in, unlock it, tap Trust, then:

```bash
npx github:DO-SAY-GO/MyCloud import iphone --server https://cloud.example.com --user you
```

**Anything else** (an SD card, a Google Takeout, an old backup drive):

```bash
npx github:DO-SAY-GO/MyCloud import folder ~/Takeout/Photos --photos --server … --user you
```

**No Mac?** In the web app, Calendar › Import takes `.ics` files or a public iCloud calendar link (`webcal://…`), and Contacts › Import takes `.vcf` exports from iCloud.com or Google.

Apple doesn't let any tool export these, so they stay behind: **Passwords** (export a CSV from the Passwords app yourself), **Messages**, **Health**, and iCloud Mail.

## Bring your family

One MyCloud is one household. The first account is the admin. In **Settings › Family › Invite someone**, a link is created that you send by Messages. Your family member picks a username and password and is in.

- Everyone shares a **Family** folder, a **Family** photo album and a **Family** calendar (your iCloud "Family" calendar imports straight into it). Everything else stays private to each person.
- Forgot a password? The admin sends a one-time **reset link**.
- Removing someone revokes their access immediately and sets their files aside instead of deleting them.

## One-tap device setup

In **Settings › Add MyCloud to this device**, a configuration profile is downloaded. It's the same file format iOS uses for work accounts, but it isn't MDM: it can't manage, watch or wipe anything. It just adds:

- your **Calendars** (CalDAV) and **Contacts** (CardDAV) accounts, with a fresh per-device app password already filled in, and
- a **MyCloud icon** on the Home Screen.

Install it via Settings › Profile Downloaded. Remove it any time; revoke that device's app password to cut it off. The profile is **signed** with your server's certificate when MyCloud has it (`--cert/--key`), or with `MYCLOUD_SIGN_CERT` / `MYCLOUD_SIGN_KEY` / `MYCLOUD_SIGN_CHAIN` when a proxy like Caddy holds the certificate. Without that, iOS shows it as "Unverified" but it works the same.

## What you get

| | Web app | Native sync |
|---|---|---|
| **Drive** | Folders, drag-and-drop upload, rename, share links | Finder: *Go › Connect to Server*, Windows Explorer, any WebDAV client |
| **Photos** | Timeline grid, lightbox, video playback, HEIC thumbnails | Any WebDAV photo-backup app (e.g. PhotoSync) or an iOS Shortcuts automation |
| **Notes** | Markdown notes with autosave | They're plain `.md` files in `Drive/Notes`, so any editor works |
| **Calendar** | Month view, create and delete events | iOS/macOS Calendar and Reminders, Thunderbird, DAVx⁵ |
| **Contacts** | Search, create and delete | iOS/macOS Contacts, DAVx⁵ |
| **Family** | Invites, reset links, shared folder/album/calendar | The shared calendar syncs to everyone's devices |
| **Account** | App-specific passwords, one-tap device profiles, share-link management | |

Your data stays as plain files on disk: `.ics`, `.vcf`, `.md`, and your photos exactly as uploaded. Back it up with `rsync`, and leave whenever you like.

## Install

Requires Node.js 20+. Nothing to `npm install`.

```bash
git clone https://github.com/DO-SAY-GO/MyCloud && cd MyCloud
./mycloud.js adduser you          # prompts for a password
./mycloud.js serve --port 8080    # data lives in ~/.mycloud (override with --data)
```

### With Docker + automatic HTTPS

```bash
MYCLOUD_DOMAIN=cloud.example.com docker compose up -d
docker compose exec mycloud node mycloud.js adduser you
```

Caddy fetches a Let's Encrypt certificate for your domain. Point the domain's DNS at the box first.

## Hosting options

MyCloud wants a machine with a real disk. Pick based on who needs to reach it:

| Option | Best for | Uploads | Who can see your traffic | Effort |
|---|---|---|---|---|
| **Home box + Tailscale** ⭐ | Just you and your family's devices | Unlimited | Nobody (end-to-end WireGuard) | Lowest |
| **VPS + Caddy** | Public share links, no hardware at home | Unlimited | Nobody (TLS ends on your box) | Low |
| **Home box + Cloudflare Tunnel** | Public access without opening ports | **100 MB per file** on Free/Pro | Cloudflare (TLS ends at their edge) | Low |
| Cloudflare Workers / R2 | Not supported | — | — | A rewrite |

### Recommended: a box you own + Tailscale

Use an old laptop, a mini-PC, a Raspberry Pi 5 or a NAS that runs Docker. Your photos stay in your house, and storage costs you one hard drive.

```bash
./mycloud.js serve --host 127.0.0.1
tailscale serve --bg 8080        # https://<machine>.<tailnet>.ts.net
```

Install Tailscale on your phone and laptop, then use the `ts.net` address as the server in Settings. You don't open any ports, you don't need a domain, and there's no upload limit. It's reachable only from your own devices.

### Public: a VPS + Caddy

A $4–6/month VPS (Hetzner, DigitalOcean, Vultr…) with a block-storage volume for photos. Point a domain at it, then:

```bash
MYCLOUD_DOMAIN=cloud.example.com docker compose up -d
```

Caddy gets a certificate on its own. TLS terminates on your box, so no third party sees your data in transit, and big video uploads work. The tradeoff: your data sits on someone else's disk, so encrypt the volume if that matters to you.

### Cloudflare Tunnel (with caveats)

```bash
cloudflared tunnel --url http://localhost:8080   # quick test; use a named tunnel for real
```

This is handy for public share links from a home box without port forwarding. But:

- **The 100 MB request cap** on Cloudflare's Free and Pro plans breaks uploads of long iPhone videos.
- **Cloudflare terminates TLS**, so your calendar, contacts and photos pass through their edge unencrypted.

A good combination: keep sync on Tailscale and expose only `/s/` share links through the tunnel.

### Why not run it entirely on Cloudflare?

Workers have no filesystem. Running MyCloud on Workers would mean moving storage into R2 plus a database, which gives up the "plain files you own" design. HEIC and video thumbnails also don't fit Workers' CPU limits. A Workers edition might happen one day, but it would be a different product.

### Any other reverse proxy

Proxy to `:8080` and pass `--trust-proxy`, so login throttling sees real client IPs. For native TLS without a proxy: `mycloud serve --cert fullchain.pem --key privkey.pem`.

Use HTTPS before connecting phones over the internet. DAV clients send credentials on every request.

## Connect your devices

Sign in to the web app, go to **Settings › App passwords** and create one per device. Use your username and that app password below.

- **iPhone / iPad**: Settings › Apps › Calendar (or Contacts) › Calendar Accounts › Add Account › Other › *Add CalDAV Account* / *Add CardDAV Account*. Server: `cloud.example.com`.
- **Mac**: System Settings › Internet Accounts › Add Other Account › *CalDAV account* / *CardDAV account*. Account type *Manual*, server `cloud.example.com`.
- **Finder**: Go › Connect to Server (⌘K) › `https://cloud.example.com/dav/files/you/`
- **Android**: [DAVx⁵](https://www.davx5.com/) with base URL `https://cloud.example.com/dav/`
- **Thunderbird**: New Calendar › On the Network › `https://cloud.example.com/dav/`

Discovery via `/.well-known/caldav` and `/.well-known/carddav` is built in.

## Architecture

```
mycloud.js        CLI: serve, adduser, passwd
lib/server.js     HTTP(S) server and routing
lib/dav.js        WebDAV + CalDAV + CardDAV (PROPFIND, REPORT multiget/query/sync-collection, MKCALENDAR, LOCK…)
lib/api.js        JSON API for the web app, plus public share links
lib/auth.js       scrypt passwords, app passwords, sessions, brute-force throttling
lib/store.js      On-disk layout; per-collection change log (CTag + sync-token)
lib/pim.js        Minimal iCalendar / vCard parsing for the web UI
lib/thumbs.js     Thumbnails via sips (macOS), ImageMagick or ffmpeg, when present
lib/xml.js        Tiny namespace-aware XML parser
lib/profile.js    One-tap .mobileconfig (CalDAV + CardDAV + Home Screen icon), optionally signed
lib/fetch-public.js  Calendar-link fetching that refuses private network addresses
lib/import/       Importers: mac (Contacts, EventKit, Notes, PhotoKit, files), iphone (ImageCaptureCore), folder
public/           Web app (vanilla JS, no build step)
```

Data layout:

```
~/.mycloud/
  users.json  sessions.json  shares.json
  users/<name>/files/{Documents,Photos,Notes,…}
  users/<name>/calendars/<id>/*.ics
  users/<name>/addressbooks/<id>/*.vcf
```

## Security

- Passwords and app passwords are hashed with scrypt. After repeated failures, logins lock out with exponential backoff per client IP.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and API writes require a custom header (CSRF).
- User files are served with a `sandbox` Content-Security-Policy, so an uploaded HTML or SVG file can't run script as you.
- Paths are validated segment by segment, and every user is confined to their own tree.
- WebDAV locks are advisory only (enough for Finder, not enforced).

Found something? Please open an issue.

## Status and roadmap

This is an early release, but it works. The tests cover the DAV protocol flows (`npm test`). Contributions are welcome. Some next steps:

- [ ] Server-side recurring-event expansion and time-range filtering for calendar-query
- [ ] Reminders (VTODO) view in the web app
- [ ] Albums, EXIF dates and map view for Photos
- [ ] End-to-end encrypted folders
- [ ] Multi-device photo auto-backup companion
- [ ] "Find My"-style device check-ins

## License

MIT © DOSAYGO. Do whatever you want with it. Host it for your family, your friends, your town.
