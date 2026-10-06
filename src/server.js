#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Manager } from './manager.js';
import { dashboardInfo, ensureDashboard } from './dashboard-launcher.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const instructions = `Pi external subagents supplement Codex's own capabilities, enabling large-scale parallel work with configured domestic Chinese models. Use this capability only when the human user has explicitly authorized external model delegation in the conversation. A generic coding request or available quota is not authorization. Respect the authorized task, providers/models, concurrency and spending limits; continue within existing authorization without repeatedly asking. Ask the user before expanding beyond it, including additional paid usage. Read-only inspection does not require delegation authorization. Use list_models then spawn_agent with an explicit provider/model, absolute cwd, ownedPaths and concrete acceptance criteria. Spawn returns immediately; accepted does not mean completed. While children run, use wait_agent with each returned nextSequence as after[agentId], read_agent for details and reply_question for blocking questions. Send messages via send_message; steer is delivered at a Pi turn boundary. Waits return events, including progress; inspect status and keep waiting until completed, failed, interrupted or closed. Change models only when idle, or interrupt first; next_run restores the previous model after a settled run. Claims of success need actual changes/checks, not model prose. MCP cannot automatically inject native Codex subagent messages or wake an ended parent turn. Keep coordinating until the assigned tasks finish. Git worktrees preserve only the explicit committed baseRef; review/merge changes separately. Shared ownership is coordination, not filesystem security. Credentials remain in Pi. Do not send provider secrets in tools. Never auto-deploy or send external messages. Use resume_agent for saved sessions after reconnecting; do not rerun completed work blindly.`;

export async function createServer(options = {}) {
  const manager = await new Manager({
    root: options.root || process.env.PI_SUBAGENTS_STATE_DIR || path.join(projectRoot, '.agents/runtime'),
    executable: options.executable || process.env.PI_EXECUTABLE || 'pi',
    maxAgents: options.maxAgents || Number(process.env.PI_SUBAGENTS_MAX_AGENTS || 8),
    ...(options.processFactory ? { processFactory: options.processFactory } : {}),
  }).start();
  const server = new McpServer({ name: 'pi-subagents', version: '1.0.0' }, { instructions });
  function register(name, description, shape, handler, readOnly = false) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } }, async (values, extra) => {
      try {
        const data = await handler(values, extra);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  const id = z.string().uuid();
  const text = z.string().min(1).max(24000);
  const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  register('list_models', 'List authenticated Pi model choices and catalog metadata. Explicitly choose provider/model for each agent; prices are catalog values, not measured charges.', {
    provider: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(200).default(60),
  }, async ({ provider, search, limit }) => {
    const models = (await manager.models(provider)).filter(m => !search || `${m.provider}/${m.model} ${m.name}`.toLowerCase().includes(search.toLowerCase()));
    return { models: models.slice(0, limit), total: models.length, truncated: models.length > limit };
  }, true);
  register('spawn_agent', 'Supplement Codex with a domestic/multi-model Pi coding subagent. Requires explicit human authorization for external model delegation within this task and budget; ask if absent. Return its ID immediately. Declare owned files and acceptance in prompt. auto uses an independent Git worktree; shared requires non-overlapping paths.', {
    cwd: z.string().min(1), prompt: text, provider: z.string().min(1), model: z.string().min(1), name: z.string().max(100).optional(),
    ownedPaths: z.array(z.string().min(1)).min(1).max(100), context: z.string().max(40000).default(''),
    workspaceMode: z.enum(['auto', 'worktree', 'shared']).default('auto'), baseRef: z.string().optional(), thinking: thinking.default('high'),
  }, values => manager.spawn(values));
  register('list_agents', 'Inspect current children, or include saved sessions for explicit recovery. Returns the private local dashboard URL when running.', {
    includeSaved: z.boolean().default(false),
  }, ({ includeSaved }) => ({ agents: manager.list(includeSaved), dashboardUrl: dashboardInfo(manager.storage.root)?.url }), true);
  register('read_agent', 'Read durable agent status and recent events after a sequence. Optionally retrieve a bounded transcript from the active Pi process.', {
    agentId: id, afterSequence: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), transcript: z.boolean().default(false),
  }, async ({ agentId, afterSequence, limit, transcript }) => {
    const result = manager.read(agentId, afterSequence, limit);
    if (transcript) {
      const agent = manager.get(agentId);
      if (!agent.rpc || agent.rpc.exited) throw new Error('Resume the saved session before reading its transcript');
      const data = await agent.rpc.command('get_messages');
      let remaining = 40000;
      result.messages = data.messages.slice(-Math.min(limit, 20)).map(message => {
        const original = JSON.stringify(message.content);
        const content = original.slice(0, Math.min(remaining, 6000)); remaining -= content.length;
        return { role: message.role, content, stopReason: message.stopReason, truncated: content.length < original.length };
      });
    }
    return result;
  }, true);
  register('send_message', 'Send a new task or communicate within the user-authorized delegation scope. Ask before expanding work or paid usage beyond it. steer delivers after current tools finish; follow_up waits until work finishes. Answer blocking questions with reply_question.', {
    agentId: id, message: text, mode: z.enum(['steer', 'follow_up']).default('steer'),
  }, ({ agentId, message, mode }) => manager.send(agentId, message, mode));
  register('reply_question', 'Answer an actual pending child question. Only an explicit answer releases the waiting tool.', {
    questionId: id, message: text,
  }, ({ questionId, message }) => manager.channel.reply(questionId, message));
  register('wait_agent', 'Wait until a selected child emits a new event, or a bounded timeout. Reuse nextSequence in after to avoid repeated events. Progress also wakes this call; completed means Pi settled, not business acceptance.', {
    agentIds: z.array(id).min(1).max(8), after: z.record(z.number().int().min(0)).default({}), timeoutMs: z.number().int().min(0).max(45000).default(25000),
  }, ({ agentIds, after, timeoutMs }, extra) => manager.wait(agentIds, after, timeoutMs, extra.signal), true);
  register('set_agent_model', 'Change an idle session model within the user-authorized model and spending scope; ask before exceeding it. Global Pi defaults stay unchanged. next_run restores the prior model and thinking after one settled run. Interrupt busy work explicitly first.', {
    agentId: id, provider: z.string().min(1), model: z.string().min(1), thinking: thinking.optional(), scope: z.enum(['session', 'next_run']).default('session'),
  }, ({ agentId, ...options }) => manager.setModel(agentId, options));
  register('interrupt_agent', 'Clear queued instructions and abort current Pi work. Edits already made remain; stopping is not rollback.', { agentId: id }, ({ agentId }) => manager.interrupt(agentId));
  register('close_agent', 'Stop and close this child while preserving its Pi session and worktree. Does not merge or delete source changes.', { agentId: id }, ({ agentId }) => manager.closeAgent(agentId));
  register('resume_agent', 'Reopen a saved child within explicit human delegation authorization, retaining its model and directory. Fails if another live controller owns it. Does not automatically repeat previous work.', { agentId: id }, ({ agentId }) => manager.resume(agentId));
  return { server, manager };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Custom verification roots do not create a persistent service. Default production connections reuse one viewer.
  if (!process.env.PI_SUBAGENTS_STATE_DIR && process.env.PI_DASHBOARD_AUTO !== '0') {
    try { await ensureDashboard(); }
    catch (error) { process.stderr.write(`Pi dashboard: ${error.message}\n`); }
  }
  const { server, manager } = await createServer();
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await manager.close(); await server.close();
  }
  const transport = new StdioServerTransport();
  server.server.onclose = () => { shutdown().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; }); };
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
  await server.connect(transport);
}
