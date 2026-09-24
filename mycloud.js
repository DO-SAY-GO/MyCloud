#!/usr/bin/env node
// MyCloud — your own iCloud. Drive, Photos, Notes, Calendar and Contacts on hardware you control.
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { createServer } from './lib/server.js';
import { thumbnailService } from './lib/thumbs.js';
import { Auth } from './lib/auth.js';
import { Store } from './lib/store.js';
import { DavClient, connectWithAccountPassword } from './lib/import/client.js';
import { importMac, MAC_SOURCES } from './lib/import/mac.js';
import { importIphone, importFolder } from './lib/import/devices.js';

const USAGE = `mycloud — your own iCloud

Usage:
  mycloud serve   [--port 8080] [--host 0.0.0.0] [--data DIR] [--public-url https://cloud.example.com]
                  [--cert FILE --key FILE] [--trust-proxy]   (--trust-proxy: behind exactly one reverse proxy)
  mycloud adduser <name> [--data DIR]     create a user (prompts for a password)
  mycloud passwd  <name> [--data DIR]     reset a password (also disconnects that user's devices)
  mycloud thumbnailer [--port 8081]       isolated thumbnail worker for MYCLOUD_THUMBNAILER_URL (Docker)

Bring your stuff (run on the machine that has it; talks to your server with an app password):
  mycloud import mac    --server URL --user NAME [--only contacts,calendars,…] [--dry-run] [--limit N]
                        Contacts, Calendars, Reminders, Notes, Photos, iCloud Drive, Voice Memos, Safari bookmarks
  mycloud import iphone --server URL --user NAME   camera roll of a USB-connected iPhone/iPad
  mycloud import folder <dir> --server URL --user NAME [--to REMOTE_DIR] [--photos]

Environment: MYCLOUD_DATA, MYCLOUD_PORT, MYCLOUD_HOST, MYCLOUD_PASSWORD (non-interactive adduser/passwd),
             MYCLOUD_PUBLIC_URL, MYCLOUD_TRUST_PROXY=1, MYCLOUD_MAX_UPLOAD_GB, MYCLOUD_DISK_RESERVE_GB, MYCLOUD_QUOTA_GB,
             MYCLOUD_THUMBNAILS=auto|off|unsafe, MYCLOUD_SIGN_CERT/KEY/CHAIN,
             MYCLOUD_SERVER, MYCLOUD_USER, MYCLOUD_APP_PASSWORD (non-interactive import)
Default data dir: ~/.mycloud`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' },
    cert: { type: 'string' }, key: { type: 'string' }, 'trust-proxy': { type: 'boolean' }, 'public-url': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    server: { type: 'string' }, user: { type: 'string' }, only: { type: 'string' }, limit: { type: 'string' },
    'dry-run': { type: 'boolean' }, to: { type: 'string' }, photos: { type: 'boolean' },
  },
});

const dataDir = path.resolve(values.data || process.env.MYCLOUD_DATA || path.join(os.homedir(), '.mycloud'));
const [command = 'serve', name] = positionals;

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword() {
  if (process.env.MYCLOUD_PASSWORD) return process.env.MYCLOUD_PASSWORD;
  if (!process.stdin.isTTY) {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s.split(/\r?\n/)[0];
  }
  const a = await promptHidden('Password: ');
  const b = await promptHidden('Repeat:   ');
  if (a !== b) throw new Error('passwords do not match');
  return a;
}

async function main() {
  if (values.help || command === 'help') return console.log(USAGE);

  if (command === 'adduser' || command === 'passwd') {
    if (!name) throw new Error(`usage: mycloud ${command} <name>`);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const auth = new Auth(dataDir);
    await auth.load();
    const exists = !!auth.users[name];
    if (command === 'adduser' && exists) throw new Error(`user "${name}" already exists — use: mycloud passwd ${name}`);
    if (command === 'passwd' && !exists) throw new Error(`no user "${name}" — use: mycloud adduser ${name}`);
    await auth.setPassword(name, await readPassword(), command === 'adduser' ? { create: true } : { revokeDevices: true });
    await new Store(dataDir).ensureUser(name);
    return console.error(`✓ ${command === 'adduser' ? 'created' : 'updated'} ${name} in ${dataDir}`);
  }

  if (command === 'import') return runImport(positionals[1], positionals[2]);
  if (command === 'thumbnailer') {
    const port = Number(values.port || 8081);
    thumbnailService().listen(port, values.host || '0.0.0.0', () => console.error(`🖼️  MyCloud thumbnailer on :${port}`));
    return;
  }
  if (command !== 'serve') throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  if (!!values.cert !== !!values.key) throw new Error('--cert and --key go together');
  const port = Number(values.port || process.env.MYCLOUD_PORT || 8080);
  const host = values.host || process.env.MYCLOUD_HOST || '0.0.0.0';
  const publicUrl = values['public-url'] || process.env.MYCLOUD_PUBLIC_URL;
  const trustProxy = !!values['trust-proxy'] || process.env.MYCLOUD_TRUST_PROXY === '1';
  const { server, auth } = await createServer({ dataDir, cert: values.cert, key: values.key, trustProxy, publicUrl });
  server.listen(port, host, () => {
    const scheme = values.cert ? 'https' : 'http';
    console.error(`☁️  MyCloud on ${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${port}   (data: ${dataDir})`);
    if (!Object.keys(auth.users).length) console.error('   No users yet. Create one: mycloud adduser <name>');
  });
}

async function runImport(source, dir) {
  if (!['mac', 'iphone', 'folder'].includes(source)) throw new Error(`usage: mycloud import mac|iphone|folder …\n\n${USAGE}`);
  if (source === 'folder' && !dir) throw new Error('usage: mycloud import folder <dir> --server URL --user NAME');
  const log = (m) => console.error(m);
  const server = values.server || process.env.MYCLOUD_SERVER || (await promptLine('MyCloud address (e.g. https://cloud.example.com): '));
  const user = values.user || process.env.MYCLOUD_USER || (await promptLine('Username: '));
  let client;
  let revoke = async () => {};
  if (process.env.MYCLOUD_APP_PASSWORD) {
    client = new DavClient({ server, user, password: process.env.MYCLOUD_APP_PASSWORD });
  } else {
    if (!process.stdin.isTTY) throw new Error('set MYCLOUD_APP_PASSWORD to import non-interactively');
    const accountPassword = await promptHidden(`MyCloud password for ${user}: `);
    ({ client, revoke } = await connectWithAccountPassword({ server, user, accountPassword, label: `Import from ${os.hostname().replace(/\.local$/, '')}` }));
  }
  process.on('SIGINT', () => revoke().finally(() => process.exit(130)));
  let summary;
  try {
    await client.check();
    log(`☁️  Importing into ${client.base.origin} as ${user}`);
    const opts = { dryRun: !!values['dry-run'], limit: values.limit ? Number(values.limit) : undefined, to: values.to, photos: !!values.photos };
    if (source === 'mac') {
      const only = values.only ? values.only.split(',').map((x) => x.trim()) : MAC_SOURCES;
      const unknown = only.filter((x) => !MAC_SOURCES.includes(x));
      if (unknown.length) throw new Error(`unknown --only value(s): ${unknown.join(', ')} (choose from ${MAC_SOURCES.join(', ')})`);
      log('   macOS may ask to let your terminal control each app. Click OK.');
      summary = await importMac(client, { only, ...opts }, log);
    } else if (source === 'iphone') {
      summary = await importIphone(client, opts, log);
      if (!opts.dryRun) log(`  ✓ ${summary.imported ?? 0} imported${summary.skipped?.length ? `, ${summary.skipped.length} skipped` : ''}`);
    } else {
      summary = await importFolder(client, dir, opts, log);
      if (!opts.dryRun) log(`  ✓ ${summary.imported ?? 0} uploaded${summary.alreadyThere ? `, ${summary.alreadyThere} already there` : ''}`);
    }
    if (opts.dryRun) log('\nDry run: nothing was copied. Run the same command without --dry-run to import.');
    else log('\nDone. Safe to run again: it only brings what is new.');
  } finally {
    await revoke(); // the import's own device password never outlives the import, even on failure
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(`mycloud: ${e.message}`);
  process.exit(1);
});
