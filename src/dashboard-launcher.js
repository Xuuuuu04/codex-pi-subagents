import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processAlive } from './storage.js';

export const defaultStateRoot = fileURLToPath(new URL('../.agents/runtime/', import.meta.url));
const script = fileURLToPath(new URL('./dashboard.js', import.meta.url));
export function dashboardInfo(root = defaultStateRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'dashboard.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function running(root) {
  const info = dashboardInfo(root);
  if (!info || !processAlive(info.pid)) return null;
  const url = new URL(info.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Invalid local dashboard address');
  try {
    const response = await fetch(new URL('/api/health', url), { headers: { authorization: `Bearer ${url.hash.slice(1)}` }, signal: AbortSignal.timeout(500) });
    const health = await response.json();
    return response.ok && health.service === 'pi-dashboard' && health.pid === info.pid ? info : null;
  } catch { return null; } // Only a health probe; never substitute an empty agent result.
}

/** Start one independent read-only viewer; controller shutdown leaves ongoing monitoring available. */
export async function ensureDashboard(root = defaultStateRoot) {
  const previous = await running(root); if (previous) return previous;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(root, 'dashboard.log'), 'a', 0o600);
  let failure;
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, PI_SUBAGENTS_STATE_DIR: root } });
  fs.closeSync(log); child.on('error', error => { failure = error; }); child.unref();
  for (let n = 0; n < 30; n++) {
    const info = await running(root); if (info) return info;
    if (failure) throw failure;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Dashboard did not start. Check .agents/runtime/dashboard.log and whether port 4317 is occupied.');
}
