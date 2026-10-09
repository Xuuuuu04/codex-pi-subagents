// Configure pi-subagents for Codex and Claude Code. Only client configs change: running MCP bridges, the controller
// and Pi agents keep their current processes; new client sessions load the updated source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const name = 'pi-subagents';
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const target = args.find(arg => arg.startsWith('--target='))?.slice(9) || 'all';
if (args.some(arg => arg !== '--remove' && !arg.startsWith('--target=')) || !['all', 'codex', 'claude'].includes(target)) throw new Error('Usage: install.js [--target=all|codex|claude] [--remove]');
const resolve = command => { try { return execFileSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const clients = { codex: resolve('codex'), claude: resolve('claude') };
const selected = (target === 'all' ? ['codex', 'claude'] : [target]).filter(client => {
  if (clients[client]) return true;
  if (target !== 'all') throw new Error(`${client} CLI was not found`);
  console.log(`Skipped ${client}: CLI not found.`); return false;
});
const backup = path.join(root, '.agents/records/config-backups');
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
const configs = { codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), claude: path.join(os.homedir(), '.claude.json') };
for (const client of selected) {
  if (!fs.existsSync(configs[client])) continue;
  const copy = path.join(backup, `${client}-${Date.now()}${path.extname(configs[client])}`);
  fs.copyFileSync(configs[client], copy); fs.chmodSync(copy, 0o600);
}
const run = (client, values, quiet = false) => execFileSync(clients[client], values, { stdio: quiet ? 'ignore' : 'inherit' });
const removeFrom = { codex: () => run('codex', ['mcp', 'remove', name], true), claude: () => run('claude', ['mcp', 'remove', name, '-s', 'user'], true) };
if (remove) {
  for (const client of selected) { try { removeFrom[client](); console.log(`Removed ${name} from ${client}.`); } catch { console.log(`${client} had no ${name} entry.`); } }
} else {
  execFileSync('pi', ['--version'], { stdio: 'inherit' });
  const pi = resolve('pi');
  if (!path.isAbsolute(pi)) throw new Error('pi must resolve to an absolute executable path');
  const executablePath = [...new Set([path.dirname(process.execPath), path.dirname(pi), ...Object.values(clients).filter(Boolean).map(path.dirname), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  const env = { PI_EXECUTABLE: pi, PATH: executablePath, ...(clients.codex ? { CODEX_EXECUTABLE: clients.codex } : {}) };
  const command = [process.execPath, path.join(root, 'src/server.js')];
  for (const client of selected) {
    try { removeFrom[client](); } catch { /* First installation. */ }
    if (client === 'codex') run('codex', ['mcp', 'add', name, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', ...command]);
    else run('claude', ['mcp', 'add-json', '-s', 'user', name, JSON.stringify({ type: 'stdio', command: command[0], args: command.slice(1), env })]);
    console.log(`Installed ${name} for ${client}.`);
  }
  console.log('Running sessions keep their current bridge; open a new Codex/Claude Code session to load this version. Other MCP entries were preserved.');
}
