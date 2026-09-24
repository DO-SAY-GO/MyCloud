// Run JavaScript for Automation against the Mac's own apps and parse the JSON it prints.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function jxa(app, script, args = [], { timeout = 30 * 60 * 1000, hint = '' } = {}) {
  try {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', script, ...args], { maxBuffer: 2 ** 31 - 1, timeout });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/-1743|Not authorized/i.test(msg)) {
      throw new Error(`macOS blocked access to ${app}. Allow it in System Settings › Privacy & Security › Automation (enable ${app} under your terminal app), then run this again.`);
    }
    if (e.killed || /-1712|timed out/i.test(msg)) throw new Error(`${app} did not answer in time.${hint ? ` ${hint}` : ''}`);
    throw new Error(`${app}: ${msg.replace(/^.*execution error: /s, '').trim().split('\n')[0]}`);
  }
}
