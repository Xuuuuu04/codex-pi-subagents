import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const name = 'pi-subagents';
const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const args = process.argv.slice(2);
if (args.some(arg => !['--remove'].includes(arg))) throw new Error('Use no arguments to install, or --remove to uninstall.');
const backup = path.join(root, '.agents/records/config-backups');
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
if (fs.existsSync(config)) {
  const target = path.join(backup, `config-${Date.now()}.toml`);
  fs.copyFileSync(config, target); fs.chmodSync(target, 0o600);
}
if (args.includes('--remove')) {
  execFileSync('codex', ['mcp', 'remove', name], { stdio: 'inherit' });
} else {
  execFileSync('pi', ['--version'], { stdio: 'inherit' });
  const pi = execFileSync('/bin/zsh', ['-lc', 'command -v pi'], { encoding: 'utf8' }).trim();
  if (!path.isAbsolute(pi)) throw new Error('pi must resolve to an absolute executable path');
  const executablePath = [...new Set([path.dirname(process.execPath), path.dirname(pi), ...(process.env.PATH || '').split(path.delimiter)])].join(path.delimiter);
  execFileSync('codex', ['mcp', 'add', name, '--env', `PI_EXECUTABLE=${pi}`, '--env', `PATH=${executablePath}`, '--', process.execPath, path.join(root, 'src/server.js')], { stdio: 'inherit' });
  console.log('Installed pi-subagents. Restart the Codex client to load it. Other MCP entries were preserved.');
}
