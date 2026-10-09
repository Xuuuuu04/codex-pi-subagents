import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { maxAgentLimit } from './manager.js';

export const callbackEvents = ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed', 'message'];
const defaultEvents = ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed'];
export const callbackShape = z.object({
  enabled: z.boolean().default(true),
  codexThreadId: z.string().regex(/^[0-9a-f-]{36}$/).optional(),
  events: z.array(z.enum(callbackEvents)).min(1).optional(),
});

/** Text a parent model receives when a child needs attention. Bounded so a callback never floods context. */
export function callbackText(event) {
  const head = `[pi-subagents callback] agent ${event.agentId} event=${event.type} sequence=${event.sequence}`;
  const next = `Continue with wait_agent(agentIds=["${event.agentId}"], after={"${event.agentId}": ${event.sequence}}) or read_agent.`;
  if (event.type === 'question') return `${head}\nBlocking question ${event.questionId}:\n${String(event.question).slice(0, 4000)}\nAnswer with reply_question(questionId="${event.questionId}").`;
  if (event.type === 'settled') return `${head} status=${event.status}${event.error ? `\nError: ${String(event.error).slice(0, 1000)}` : ''}\nLast reply (verify actual changes before accepting):\n${String(event.text || '').slice(-3000)}\n${next}`;
  if (event.type === 'message') return `${head}\nReport:\n${String(event.message).slice(0, 3000)}\n${next}`;
  return `${head}\n${String(event.reason || event.error || '').slice(0, 1000)}\n${next}`;
}

/**
 * Parent wake-up callbacks owned by one MCP bridge. Runs only in the bridge, so it works with an already running
 * controller. Claude Code receives channel notifications; Codex receives `codex queue` messages for a given thread.
 */
export class Callbacks {
  constructor({ root, server, codexExecutable = process.env.CODEX_EXECUTABLE || 'codex', run = execFile }) {
    this.directory = path.join(root, 'callbacks');
    this.server = server; this.codexExecutable = codexExecutable; this.run = run;
    this.queues = new Map();
  }
  file(agentId) {
    if (!/^[0-9a-f-]{36}$/.test(agentId)) throw new Error('Invalid agent ID');
    return path.join(this.directory, agentId + '.json');
  }
  get(agentId) { try { return JSON.parse(fs.readFileSync(this.file(agentId), 'utf8')); } catch { return null; } }
  save(agentId, value) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(agentId), temp = target + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, target);
    return value;
  }
  host() {
    const name = this.server.getClientVersion()?.name || '';
    return /codex/i.test(name) ? 'codex' : /claude/i.test(name) ? 'claude' : 'other';
  }
  routes(config) {
    const host = this.host();
    return { claudeChannel: host === 'claude', codexQueue: Boolean(config.codexThreadId) };
  }
  /** Register or change callbacks. Events at or before `since` are history and never fire. */
  configure(agentId, options = {}, since = 0) {
    const old = this.get(agentId);
    const value = { agentId, enabled: options.enabled ?? true, events: options.events || old?.events || defaultEvents,
      codexThreadId: options.codexThreadId || old?.codexThreadId || process.env.CODEX_THREAD_ID || undefined,
      since: Math.max(since, old?.since || 0), lastDelivery: old?.lastDelivery, updatedAt: new Date().toISOString() };
    this.save(agentId, value);
    return { ...value, routes: this.routes(value) };
  }
  handle(event) {
    const config = this.get(event.agentId);
    if (!config?.enabled || event.sequence <= config.since || !config.events.includes(event.type)) return;
    if (event.type === 'message' && event.recipient !== 'parent') return;
    const previous = this.queues.get(event.agentId) || Promise.resolve();
    const next = previous.then(() => this.deliver(event)).catch(error => process.stderr.write(`Pi callback failed: ${error.message}\n`));
    this.queues.set(event.agentId, next);
    return next;
  }
  async deliver(event) {
    const config = this.get(event.agentId);
    if (!config || event.sequence <= config.since) return;
    config.since = event.sequence; this.save(event.agentId, config); // Mark first: a failed route is reported, not replayed.
    const content = callbackText(event), routes = this.routes(config), results = {};
    if (routes.claudeChannel) {
      try {
        await this.server.notification({ method: 'notifications/claude/channel', params: { content, meta: { agent_id: event.agentId, event: event.type, sequence: String(event.sequence) } } });
        results.claudeChannel = 'sent';
      } catch (error) { results.claudeChannel = `failed: ${error.message}`; }
    }
    if (routes.codexQueue) {
      results.codexQueue = await new Promise(resolve => {
        this.run(this.codexExecutable, ['queue', '--thread', config.codexThreadId, '--message', content], { timeout: 20000, maxBuffer: 64 * 1024 },
          error => resolve(error ? `failed: ${error.message.split('\n')[0]}` : 'queued'));
      });
    }
    config.lastDelivery = { sequence: event.sequence, type: event.type, time: new Date().toISOString(), results };
    this.save(event.agentId, config);
    return results;
  }
}

/** Install callback tools and capability. Channels only wake Claude Code sessions that enabled this server as a channel. */
export function installCallbacks(server, manager, register) {
  server.server.registerCapabilities({ experimental: { 'claude/channel': {} } });
  const callbacks = new Callbacks({ root: manager.storage.root, server: server.server });
  manager.on('event', event => { callbacks.handle(event); });
  register('set_agent_callback', 'Configure parent wake-up callbacks for owned agents. Claude Code receives channel notifications (requires the session to enable this server as a channel); Codex receives `codex queue` messages when codexThreadId is set (read it with `echo $CODEX_THREAD_ID` in your shell). Default events: settled, question, process_failed, budget_limit, control_failed. A callback is a hint to resume coordinating, not acceptance of work.', {
    agentIds: z.array(z.string().uuid()).min(1).max(maxAgentLimit), ...callbackShape.shape,
  }, async ({ agentIds, ...options }) => {
    const result = [];
    for (const agentId of agentIds) {
      const current = await manager.read(agentId, 0, 1);
      result.push(callbacks.configure(agentId, options, current.agent.sequence));
    }
    return { callbacks: result, host: callbacks.host() };
  });
  return callbacks;
}
