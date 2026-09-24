# ☁️ MyCloud

**Your own iCloud.** Drive, Photos, Notes, Calendar and Contacts, running on hardware you control. Open source. Zero dependencies.

MyCloud speaks the same open protocols that iCloud uses under the hood: **CalDAV**, **CardDAV** and **WebDAV**. The built-in apps on your iPhone, iPad and Mac (and Android via DAVx⁵, and Thunderbird) sync with it natively, so you don't need a special app. A clean web app covers everything else.

```
npx github:DO-SAY-GO/MyCloud adduser you
npx github:DO-SAY-GO/MyCloud serve
```

Open http://localhost:8080 and you're in.

## What you get

| | Web app | Native sync |
|---|---|---|
| **Drive** | Folders, drag-and-drop upload, rename, share links | Finder: *Go › Connect to Server*, Windows Explorer, any WebDAV client |
| **Photos** | Timeline grid, lightbox, video playback, HEIC thumbnails | Any WebDAV photo-backup app (e.g. PhotoSync) or an iOS Shortcuts automation |
| **Notes** | Markdown notes with autosave | They're plain `.md` files in `Drive/Notes`, so any editor works |
| **Calendar** | Month view, create and delete events | iOS/macOS Calendar and Reminders, Thunderbird, DAVx⁵ |
| **Contacts** | Search, create and delete | iOS/macOS Contacts, DAVx⁵ |
| **Account** | App-specific passwords, share-link management | |

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

### Other ways to put it online

- **Tailscale**: run `mycloud serve` and use `tailscale serve 8080`. You get HTTPS and access only from your own devices.
- **Your own reverse proxy**: proxy to `:8080` and pass `--trust-proxy` so MyCloud sees the real client IP (used for login throttling).
- **Native TLS**: `mycloud serve --cert fullchain.pem --key privkey.pem`.

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
