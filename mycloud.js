#!/usr/bin/env node
// MyCloud — your own iCloud. Drive, Photos, Notes, Calendar and Contacts on hardware you control.
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { createServer } from './lib/server.js';
import { Auth } from './lib/auth.js';
import { Store } from './lib/store.js';

const USAGE = `mycloud — your own iCloud

Usage:
  mycloud serve   [--port 8080] [--host 0.0.0.0] [--data DIR] [--cert FILE --key FILE] [--trust-proxy]
  mycloud adduser <name> [--data DIR]     create a user (prompts for a password)
  mycloud passwd  <name> [--data DIR]     change a user's password

Environment: MYCLOUD_DATA, MYCLOUD_PORT, MYCLOUD_HOST, MYCLOUD_PASSWORD (non-interactive adduser/passwd)
Default data dir: ~/.mycloud`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' }, host: { type: 'string' }, data: { type: 'string' },
    cert: { type: 'string' }, key: { type: 'string' }, 'trust-proxy': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const dataDir = path.resolve(values.data || process.env.MYCLOUD_DATA || path.join(os.homedir(), '.mycloud'));
const [command = 'serve', name] = positionals;

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
    await auth.setPassword(name, await readPassword());
    await new Store(dataDir).ensureUser(name);
    return console.error(`✓ ${command === 'adduser' ? 'created' : 'updated'} ${name} in ${dataDir}`);
  }

  if (command !== 'serve') throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  if (!!values.cert !== !!values.key) throw new Error('--cert and --key go together');
  const port = Number(values.port || process.env.MYCLOUD_PORT || 8080);
  const host = values.host || process.env.MYCLOUD_HOST || '0.0.0.0';
  const { server, auth } = await createServer({ dataDir, cert: values.cert, key: values.key, trustProxy: values['trust-proxy'] });
  server.listen(port, host, () => {
    const scheme = values.cert ? 'https' : 'http';
    console.error(`☁️  MyCloud on ${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${port}   (data: ${dataDir})`);
    if (!Object.keys(auth.users).length) console.error('   No users yet. Create one: mycloud adduser <name>');
  });
}

main().catch((e) => {
  console.error(`mycloud: ${e.message}`);
  process.exit(1);
});
