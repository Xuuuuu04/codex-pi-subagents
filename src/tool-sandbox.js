import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const inside = (target, directory) => target === directory || target.startsWith(directory + path.sep);
/** Resolve existing ancestors before checking a path, including new files under symlinked directories. */
export function canonicalPath(value) {
  let parent = path.resolve(value); const suffix = [];
  while (!fs.existsSync(parent)) { if (parent === path.dirname(parent)) throw new Error('Cannot resolve path'); suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}
export function assertToolPath(value, policy, write = false) {
  const target = canonicalPath(path.resolve(policy.cwd, value));
  const allowed = write ? policy.ownedPaths.map(value => canonicalPath(path.resolve(policy.cwd, value))) : [fs.realpathSync(policy.cwd)];
  if (!allowed.some(directory => inside(target, directory))) throw new Error('Tool path is outside the permitted file scope');
  const state = canonicalPath(policy.stateRoot);
  const workspace = fs.realpathSync(policy.cwd);
  if (inside(target, state) && !(inside(workspace, state) && inside(target, workspace))) throw new Error('Tool cannot read controller state');
  for (const directory of [path.join(os.homedir(), '.pi'), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.ssh')]) if (inside(target, directory)) throw new Error('Tool cannot read private credentials');
  return target;
}
const filter = value => `(subpath ${JSON.stringify(canonicalPath(value))})`;
/** macOS Seatbelt profile applies to every shell and file-operation subprocess, including descendants. */
export function sandboxProfile(policy) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw new Error('Strict tool sandbox requires macOS sandbox-exec; unsupported platforms fail closed.');
  const read = [policy.cwd, policy.tempDir, path.dirname(path.dirname(process.execPath)), '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc', '/private/var/db', '/dev', ...(fs.existsSync('/opt/homebrew') ? ['/opt/homebrew'] : [])];
  const workspace = canonicalPath(policy.cwd);
  const owned = policy.ownedPaths.map(value => canonicalPath(path.resolve(policy.cwd, value)));
  if (owned.some(value => !inside(value, workspace))) throw new Error('Owned path resolves outside the workspace');
  const write = [...owned, policy.tempDir, '/dev/null', '/dev/tty'];
  const privateDirectories = ['.pi', '.codex', '.ssh'].map(value => path.join(os.homedir(), value)).filter(value => fs.existsSync(value));
  // dyld must inspect the root directory when loading the shared cache; this grants only that literal path.
  return `(version 1) (allow default)
(deny file-read* (require-not (require-any (literal "/") ${read.map(filter).join(' ')})))
(deny file-write* (require-not (require-any ${write.map(filter).join(' ')})))
${privateDirectories.map(value => `(deny file-read* ${filter(value)}) (deny file-write* ${filter(value)})`).join('\n')}
(deny file-read* (require-all ${filter(policy.stateRoot)} (require-not (require-any ${inside(canonicalPath(policy.cwd), canonicalPath(policy.stateRoot)) ? filter(policy.cwd) : ''} ${filter(policy.tempDir)}))))
(deny file-write* (require-all ${filter(policy.stateRoot)} (require-not (require-any ${inside(canonicalPath(policy.cwd), canonicalPath(policy.stateRoot)) ? filter(policy.cwd) : ''} ${filter(policy.tempDir)}))))
${policy.allowNetwork ? '' : '(deny network*)'}
(deny appleevent-send) (deny mach-lookup) (deny process-info*) (deny signal)`;
}
const children = new Set(); let cleanupInstalled = false;
function terminateChildren() { for (const pid of children) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') process.stderr.write(`Tool shutdown failed: ${error.message}\n`); } } }
export function runSandboxed(policy, executable, args, { signal, timeout = 60000, onData = () => {}, input } = {}) {
  const profile = sandboxProfile(policy);
  if (!cleanupInstalled) { cleanupInstalled = true; process.once('exit', terminateChildren); process.once('SIGTERM', () => { terminateChildren(); process.exit(143); }); }
  // Provider credentials and controller capability tokens never enter a tool subprocess environment.
  const env = { PATH: process.env.PATH, LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: policy.tempDir };
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], { cwd: policy.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child.pid);
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); } };
    const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', error => { children.delete(child.pid); clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.on('close', (code, termination) => { children.delete(child.pid); clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ exitCode: code ?? (termination ? 137 : 1) }); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
    if (signal?.aborted) stop();
  });
}

const worker = `const fs=require('fs'); const [operation,file]=process.argv.slice(1);
if(operation==='read') process.stdout.write(fs.readFileSync(file));
else if(operation==='access') fs.accessSync(file);
else {let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>{fs.mkdirSync(require('path').dirname(file),{recursive:true});fs.writeFileSync(file,value)});}`;
export async function fileOperation(policy, operation, filename, content) {
  const file = assertToolPath(filename, policy, operation === 'write');
  const chunks = [];
  const result = await runSandboxed(policy, process.execPath, ['-e', worker, operation, file], { input: content, onData: chunk => chunks.push(chunk) });
  if (result.exitCode !== 0) throw new Error('Sandboxed file operation failed or was denied');
  return Buffer.concat(chunks);
}
