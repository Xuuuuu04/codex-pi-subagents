import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = 'pi-subagents';
const args = process.argv.slice(2);
const remove = args.includes('--remove');
const target = args.find(arg => arg.startsWith('--target='))?.slice(9) || 'all';
if (args.some(arg => arg !== '--remove' && !arg.startsWith('--target=')) || !['all', 'codex', 'claude', 'antigravity'].includes(target)) {
  throw new Error('Usage: install.js [--target=all|codex|claude|antigravity] [--remove]');
}

function resolve(command) {
  try {
    return execFileSync('/bin/zsh', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).trim();
  } catch (error) {
    if (error?.status == null && error?.code == null) throw error;
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, command);
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }
}

const antigravityBaseDir = process.env.PI_ANTIGRAVITY_PLUGINS_DIR || path.join(os.homedir(), '.gemini/config/plugins');
const clients = {
  codex: resolve('codex'),
  claude: resolve('claude'),
  antigravity: resolve('agy') || (fs.existsSync(path.dirname(antigravityBaseDir)) || process.env.PI_ANTIGRAVITY_PLUGINS_DIR || target === 'antigravity' ? 'plugin-dir' : ''),
};

const selected = (target === 'all' ? ['codex', 'claude', 'antigravity'] : [target]).filter(client => {
  if (clients[client]) return true;
  if (target !== 'all') throw new Error(`${client} CLI was not found`);
  console.log(`Skipped ${client}: CLI not found.`);
  return false;
});

const backup = process.env.PI_CONFIG_BACKUP_DIR || path.join(root, '.agents/records/config-backups');
fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
const configs = {
  codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
  claude: path.join(os.homedir(), '.claude.json'),
};
for (const client of selected) {
  if (!configs[client] || !fs.existsSync(configs[client])) continue;
  const copy = path.join(backup, `${client}-${Date.now()}${path.extname(configs[client])}`);
  fs.copyFileSync(configs[client], copy);
  fs.chmodSync(copy, 0o600);
}

const pluginDir = path.join(antigravityBaseDir, name);
function backupPluginDir() {
  if (!fs.existsSync(pluginDir)) return;
  const dest = path.join(backup, `antigravity-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const item of ['plugin.json', 'mcp_config.json', 'hooks.json', 'README.md']) {
    const src = path.join(pluginDir, item);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, item));
  }
}

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect x="8" y="8" width="112" height="112" rx="28" fill="#171614"/>
  <circle cx="64" cy="64" r="36" stroke="#e27448" stroke-width="6"/>
  <circle cx="64" cy="64" r="11" fill="#f4efe7"/>
  <circle cx="64" cy="28" r="7.5" fill="#e27448"/>
  <circle cx="95" cy="82" r="6" fill="#2f855a"/>
</svg>
`;

const pluginRules = `# Pi Subagents Rules for Antigravity

When delegating tasks to external models through \`pi-subagents\`, follow these rules:

1. Check authorization and model availability first via \`list_models\` (and \`get_subagent_health\` or \`get_quota\` if needed).
2. Always bind the subagent to the current Antigravity session by passing \`antigravitySessionId\` (your Conversation ID) to \`spawn_agent\` / \`resume_agent\`, or call \`bind_session\`.
3. Never treat \`spawn_agent\` acceptance as completion. Wait synchronously with \`wait_agent\` (forwarding \`nextSequence\` into \`after[agentId]\`) or start the background watcher returned in \`mustWait.antigravityBackgroundCommand\` (\`node ".../scripts/wait-events.js" --session <Conversation ID>\` via \`run_command\` with \`WaitMsBeforeAsync: 500\`, \`IsDaemon: false\`).
4. Answer pending \`ask_parent\` questions immediately via \`reply_question\`.
5. Filter children with \`list_agents(sessionId="<Conversation ID>")\` and inspect actual edits with \`get_agent_changes\` before reporting results.
`;

const pluginSkill = `---
name: pi-subagents
description: Orchestrate independent Pi subagents across external models in Antigravity with session binding, reactive wait-events wakeups, and lifecycle hooks.
---

# Pi Subagents Workflow in Antigravity

Use \`pi-subagents\` when delegating parallel research, cross-checking, or coding subtasks to authenticated external models under explicit user authorization.

## Session Binding & Launch

1. Inspect healthy runtime and models with \`get_subagent_health\` and \`list_models\`.
2. Call \`spawn_agent\` with \`antigravitySessionId\` set to your current Conversation ID, an explicit \`provider\` and \`model\`, absolute \`cwd\`, non-overlapping \`ownedPaths\`, and clear acceptance criteria.
3. For work spawned before binding or after reconnect, call \`bind_session({ sessionId: "<Conversation ID>" })\` and isolate inspection with \`list_agents({ sessionId: "<Conversation ID>" })\`.

## Waiting & Wake-Up

- **Synchronous wait**: call \`wait_agent\` passing returned \`nextSequence\` values in \`after\`.
- **Reactive background wait**: run \`mustWait.antigravityBackgroundCommand\` (\`node ".../scripts/wait-events.js" --session <Conversation ID>\`) via \`run_command\` with \`WaitMsBeforeAsync: 500\` and \`IsDaemon: false\`, then end the turn cleanly; the system wakes your session automatically when a child emits \`settled\`, \`question\`, \`process_failed\`, or \`budget_limit\`.
- **Lifecycle safety net**: bundled \`PreInvocation\` and \`Stop\` hooks automatically inject undelivered events and warn before stopping while bound children remain active without a watcher.

## Verification

Before accepting changes from a settled child, call \`get_agent_changes\` (for worktree or shared owned diffs) and run target checks directly.
`;

const pluginReadme = `# Pi Subagents Antigravity Plugin

Bundles the \`pi-subagents\` MCP server, Antigravity \`PreInvocation\` and \`Stop\` lifecycle hooks, session-binding rules, and orchestration skill.

- Repository root: \`${root}\`
- Web dashboard default URL: \`http://127.0.0.1:3141/\`
`;

function writeAntigravityPlugin(env) {
  backupPluginDir();
  fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(pluginDir, 'skills/pi-subagents'), { recursive: true, mode: 0o755 });

  const agyBin = resolve('agy');
  const mcpEnv = { ...env, ...(agyBin ? { AGY_EXECUTABLE: agyBin } : {}) };
  const serverScript = path.join(root, 'src/server.js');
  const hookScript = path.join(root, 'scripts/antigravity-hook.js');
  const hookCommand = `"${process.execPath}" "${hookScript}"`;

  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'pi-subagents',
    displayName: 'Pi Subagents',
    version: pkg.version || '1.6.0',
    description: 'Multi-model Pi subagent orchestration for Antigravity with session binding, reactive wait-events watcher, and PreInvocation/Stop hooks.',
    logo: 'assets/logo.svg',
    author: { name: 'mumu_xsy' },
    repository: 'https://github.com/Xuuuuu04/codex-pi-subagents',
    suggestedPrompts: [
      'List authenticated Pi models and check subagent runtime health',
      'Delegate parallel codebase review subagents using Pi models for this session',
      'Check active Pi subagents bound to this Antigravity conversation',
    ],
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(pluginDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'pi-subagents': {
        command: process.execPath,
        args: [serverScript],
        env: mcpEnv,
      },
    },
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({
    'pi-subagents-callbacks': {
      PreInvocation: [{ type: 'command', command: hookCommand, timeout: 10 }],
      Stop: [{ type: 'command', command: hookCommand, timeout: 10 }],
    },
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(pluginDir, 'rules/AGENTS.md'), pluginRules);
  fs.writeFileSync(path.join(pluginDir, 'skills/pi-subagents/SKILL.md'), pluginSkill);
  fs.writeFileSync(path.join(pluginDir, 'assets/logo.svg'), logoSvg);
  fs.writeFileSync(path.join(pluginDir, 'README.md'), pluginReadme);

  if (agyBin && !process.env.PI_ANTIGRAVITY_PLUGINS_DIR) {
    execFileSync(agyBin, ['plugin', 'validate', pluginDir, '--strict'], { stdio: 'inherit' });
  }
}

const run = (client, values, quiet = false) => execFileSync(clients[client], values, { stdio: quiet ? 'ignore' : 'inherit' });
const removeFrom = {
  codex: () => run('codex', ['mcp', 'remove', name], true),
  claude: () => run('claude', ['mcp', 'remove', name, '-s', 'user'], true),
  antigravity: () => {
    backupPluginDir();
    fs.rmSync(pluginDir, { recursive: true, force: true });
  },
};

if (remove) {
  for (const client of selected) {
    try {
      removeFrom[client]();
      console.log(`Removed ${name} from ${client}.`);
    } catch {
      console.log(`${client} had no ${name} entry.`);
    }
  }
} else {
  const pi = process.env.PI_EXECUTABLE || resolve('pi');
  if (!pi) throw new Error('pi CLI was not found');
  execFileSync(pi, ['--version'], { stdio: 'inherit' });
  if (!path.isAbsolute(pi)) throw new Error('pi must resolve to an absolute executable path');
  const agyPath = resolve('agy');
  const binDirs = [
    path.dirname(process.execPath),
    path.dirname(pi),
    ...[clients.codex, clients.claude, agyPath].filter(Boolean).filter(p => path.isAbsolute(p)).map(path.dirname),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const executablePath = [...new Set(binDirs)].join(path.delimiter);
  const env = { PI_EXECUTABLE: pi, PATH: executablePath, ...(clients.codex ? { CODEX_EXECUTABLE: clients.codex } : {}) };
  const command = [process.execPath, path.join(root, 'src/server.js')];
  for (const client of selected) {
    if (client === 'antigravity') {
      writeAntigravityPlugin(env);
      console.log(`Installed ${name} Antigravity plugin at ${pluginDir}.`);
      continue;
    }
    try { removeFrom[client](); }
    catch (error) { if (error?.status == null && error?.code !== 'ENOENT') throw error; }
    if (client === 'codex') {
      run('codex', ['mcp', 'add', name, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--', ...command]);
    } else if (client === 'claude') {
      run('claude', ['mcp', 'add-json', '-s', 'user', name, JSON.stringify({ type: 'stdio', command: command[0], args: command.slice(1), env })]);
    }
    console.log(`Installed ${name} for ${client}.`);
  }
  console.log('Running sessions keep their current bridge; open a new Codex/Claude Code/Antigravity session to load this version. Other MCP entries were preserved.');
}
