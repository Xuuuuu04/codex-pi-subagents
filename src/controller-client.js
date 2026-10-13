import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultMaxAgents } from './manager.js';

const script = fileURLToPath(new URL('./controller.js', import.meta.url));
/** Private Unix-socket bridge. Closing an MCP bridge detaches its parent without stopping Pi. */
export class ControllerClient extends EventEmitter {
  constructor(root, info, parentId = randomUUID()) { super(); this.storage = { root }; this.info = info; this.parentId = parentId; this.closed = false; }
  /** A replaced controller leaves a stale socket; re-read controller.json, re-attach once and retry. */
  async call(method, values = {}, signal) {
    try { return await this.request(method, values, signal); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || this.closed) throw error;
      const file = path.join(this.storage.root, 'controller.json');
      const latest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (!latest || latest.socket === this.info.socket) throw error;
      this.info = latest;
      await this.request('attach', { pid: process.pid });
      return this.request(method, values, signal);
    }
  }
  request(method, values = {}, signal) {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.info.socket, path: '/rpc', method: 'POST', headers: { authorization: `Bearer ${this.info.token}`, 'content-type': 'application/json' }, signal }, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) response.destroy(new Error('Controller response too large')); });
        response.on('error', reject);
        response.on('end', () => { try { const value = JSON.parse(body); if (value.error) reject(new Error(value.error)); else resolve(value.result); } catch (error) { reject(error); } });
      });
      request.setTimeout(55000, () => request.destroy(new Error('Controller request timed out; inspect operation receipts before retrying mutations.')));
      request.on('error', reject); request.end(JSON.stringify({ parentId: this.parentId, method, values }));
    });
  }
  models(provider) { return this.call('models', { provider }); }
  spawn(values) { return this.call('spawn', values); }
  list(includeSaved) { return this.call('list', { includeSaved }); }
  read(agentId, afterSequence = 0, limit = 50) { return this.call('read', { agentId, afterSequence, limit }); }
  transcript(agentId) { return this.call('transcript', { agentId }); }
  send(agentId, message, mode, messageId) { return this.call('send', { agentId, message, mode, messageId }); }
  reply(questionId, message) { return this.call('reply', { questionId, message }); }
  wait(agentIds, after, timeoutMs, signal) { return this.call('wait', { agentIds, after, timeoutMs }, signal); }
  setModel(agentId, options) { return this.call('setModel', { agentId, ...options }); }
  interrupt(agentId) { return this.call('interrupt', { agentId }); }
  closeAgent(agentId) { return this.call('closeAgent', { agentId }); }
  resume(agentId) { return this.call('resume', { agentId }); }
  async watch() {
    const after = {};
    while (!this.closed) {
      try {
        this.watchAbort = new AbortController();
        const value = await this.call('poll', { after }, this.watchAbort.signal);
        for (const event of value.events) { after[event.agentId] = event.sequence; this.emit('event', event); }
      } catch (error) { if (!this.closed) this.emit('controller_error', error); }
      if (!this.closed) await new Promise(resolve => { this.watchTimer = setTimeout(resolve, 500); this.watchResolve = resolve; });
    }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.watchAbort?.abort(); clearTimeout(this.watchTimer); this.watchResolve?.();
    await this.call('detach');
  }
}

async function probe(root) {
  const file = path.join(root, 'controller.json');
  if (!fs.existsSync(file)) return null;
  try { const info = JSON.parse(fs.readFileSync(file, 'utf8'));  await new ControllerClient(root, info).call('health'); return info; }
  catch { return null; }
}
export async function connectController({ root, executable = 'pi', maxAgents = defaultMaxAgents }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let info = await probe(root);
  if (!info) {
    const log = fs.openSync(path.join(root, 'controller.log'), 'a', 0o600);
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, PI_SUBAGENTS_STATE_DIR: root, PI_EXECUTABLE: executable, PI_SUBAGENTS_MAX_AGENTS: String(maxAgents) } });
    fs.closeSync(log); child.unref(); let failure; child.on('error', error => { failure = error; });
    for (let index = 0; index < 50; index++) {
      info = await probe(root); if (info) break;
      if (failure) throw failure;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!info) throw new Error('Independent Pi controller failed to start; inspect controller.log.');
  }
  const client = new ControllerClient(root, info);
  await client.call('attach', { pid: process.pid }); return client;
}
