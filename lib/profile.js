// Apple configuration profile (.mobileconfig) that adds MyCloud's CalDAV + CardDAV accounts in one tap.
import crypto from 'node:crypto';
import { esc } from './xml.js';

// Stable UUIDs per server+user, so reinstalling replaces the old profile instead of duplicating it.
function stableUuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

export function buildProfile({ url, user, password }) {
  const host = url.hostname;
  const ssl = url.protocol === 'https:';
  const port = Number(url.port) || (ssl ? 443 : 80);
  const id = `com.dosaygo.mycloud.${host}.${user}`;
  const principal = `/dav/principals/${encodeURIComponent(user)}/`;
  const account = (kind, type) => `
    <dict>
      <key>${kind}AccountDescription</key><string>MyCloud</string>
      <key>${kind}HostName</key><string>${esc(host)}</string>
      <key>${kind}Port</key><integer>${port}</integer>
      <key>${kind}PrincipalURL</key><string>${esc(principal)}</string>
      <key>${kind}UseSSL</key>${ssl ? '<true/>' : '<false/>'}
      <key>${kind}Username</key><string>${esc(user)}</string>
      <key>${kind}Password</key><string>${esc(password)}</string>
      <key>PayloadType</key><string>${type}</string>
      <key>PayloadIdentifier</key><string>${esc(id)}.${kind.toLowerCase()}</string>
      <key>PayloadUUID</key><string>${stableUuid(`${id}.${kind}`)}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadDisplayName</key><string>MyCloud ${kind === 'CalDAV' ? 'Calendars' : 'Contacts'}</string>
    </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>${account('CalDAV', 'com.apple.caldav.account')}${account('CardDAV', 'com.apple.carddav.account')}
  </array>
  <key>PayloadDisplayName</key><string>MyCloud (${esc(host)})</string>
  <key>PayloadDescription</key><string>Adds your MyCloud calendars and contacts to this device.</string>
  <key>PayloadOrganization</key><string>MyCloud</string>
  <key>PayloadIdentifier</key><string>${esc(id)}</string>
  <key>PayloadUUID</key><string>${stableUuid(id)}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>
`;
}
