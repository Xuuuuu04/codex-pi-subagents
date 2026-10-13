#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Manager, defaultMaxAgents, maxAgentLimit } from './manager.js';
import { connectController } from './controller-client.js';
import { FileTaskStore, RemoteTaskStore } from './task-store.js';
import { installCommunication } from './mcp-communication.js';
import { installTaskTool } from './mcp-tasks.js';
import { installCallbacks, callbackShape } from './callbacks.js';
import { agentChanges } from './agent-changes.js';
import { Storage } from './storage.js';
import { getProviderQuota, quotaProviders } from './quota-providers.js';
import { dashboardInfo, ensureDashboard } from './dashboard-launcher.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const instructions = `Pi external subagents supplement Codex's own capabilities, enabling large-scale parallel work with configured domestic Chinese models. Use this capability only when the human user has explicitly authorized external model delegation in the conversation. A generic coding request or available quota is not authorization. Respect the authorized task, providers/models, concurrency and spending limits; continue within existing authorization without repeatedly asking. Ask the user before expanding beyond it, including additional paid usage. Read-only inspection does not require delegation authorization. Use get_client_capabilities to inspect notifications/task support. Use list_models then spawn_agent with an explicit provider/model, absolute cwd, ownedPaths and concrete acceptance criteria. Spawn returns immediately; accepted does not mean completed. While children run, use wait_agent with each returned nextSequence as after[agentId], read_agent for details and reply_question for blocking questions. Send messages via send_message; steer is delivered at a Pi turn boundary. Waits return events, including progress; inspect status and keep waiting until completed, failed, interrupted or closed. Change models only when idle, or interrupt first; next_run restores the previous model after a settled run. Claims of success need actual changes/checks, not model prose. Standard resource, logging and task notifications are available, but host UI support does not guarantee model-turn wake after a parent turn ended. Keep coordinating until the assigned tasks finish. spawn_agent enables wake-up callbacks by default: Claude Code gets channel notifications when this server is enabled as a channel; Codex parents should pass callback.codexThreadId from the shell command "echo $CODEX_THREAD_ID" so settled/question events are queued into their thread. Callbacks are hints, never acceptance. Use get_agent_changes to review actual files. Git worktrees preserve only the explicit committed baseRef; review/merge changes separately. New agents use OS-restricted tool processes. Declare ownedPaths and policy allowedModels/request/time/token limits. Tokens are observed, so an in-flight request can exceed the threshold; these limits do not guarantee an exact currency charge. Supply stable requestId/messageId on retries; uncertain delivery must be inspected, not replayed. Credentials remain in Pi; get_quota reads Pi credentials only to perform account-scoped read-only quota queries. Quota is not spending authorization. Do not send provider secrets in tools. Never auto-deploy or send external messages. The independent controller keeps agents/questions alive after MCP disconnects. Use resume_agent or resume_task to attach to their saved identities after reconnecting; do not rerun completed work blindly.`;

export async function createServer(options = {}) {
  const managerOptions = {
    root: options.root || process.env.PI_SUBAGENTS_STATE_DIR || path.join(projectRoot, '.agents/runtime'),
    executable: options.executable || process.env.PI_EXECUTABLE || 'pi',
    maxAgents: options.maxAgents || Number(process.env.PI_SUBAGENTS_MAX_AGENTS || defaultMaxAgents),
    ...(options.processFactory ? { processFactory: options.processFactory } : {}),
  };
  const manager = options.processFactory || options.embedded ? await new Manager(managerOptions).start() : await connectController(managerOptions);
  const taskStore = manager.call ? new RemoteTaskStore(manager) : new FileTaskStore(manager.storage.root, manager);
  const server = new McpServer({ name: 'pi-subagents', version: '1.2.0' }, { instructions, taskStore, capabilities: { logging: {}, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } });
  function register(name, description, shape, handler, readOnly = false) {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } }, async (values, extra) => {
      try {
        const data = await handler(values, extra);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { result: data } };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  register('get_quota', 'Read plan quotas or balance directly using Pi credentials for Codex, GLM (zhipu/zai), MiniMax Token Plan, DeepSeek and OpenCode Go. Default all queries configured supported providers; choose provider to query one. Returns each service separately, including visible failures. Missing fields are unknown; credit units and currency amounts differ. Quota does not grant spending permission: respect explicit user budget, ask before extra paid usage or reset credits. Never purchases, redeems, refreshes credentials or calls models.', {
    provider: z.enum(['all', ...quotaProviders]).default('all'),
  }, (values, extra) => getProviderQuota({ ...values, agentDir: options.piAgentDir, signal: extra.signal }), true);
  const id = z.string().uuid();
  const text = z.string().min(1).max(24000);
  const policy = z.object({ allowedModels: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1).max(50).optional(), maxModelRequests: z.number().int().min(1).max(1000000).optional(), maxTotalTokens: z.number().int().min(1).max(1e12).optional(), maxRuntimeMs: z.number().int().min(1000).max(2147483647).optional(), maxOutputTokens: z.number().int().min(1).max(1000000).optional(), allowNetwork: z.boolean().optional(), sandboxMode: z.enum(['strict', 'dev', 'bypass']).optional() });
  const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  register('list_models', 'List authenticated Pi model choices and catalog metadata. Explicitly choose provider/model for each agent; prices are catalog values, not measured charges.', {
    provider: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(200).default(60),
  }, async ({ provider, search, limit }) => {
    const models = (await manager.models(provider)).filter(m => !search || `${m.provider}/${m.model} ${m.name}`.toLowerCase().includes(search.toLowerCase()));
    return { models: models.slice(0, limit), total: models.length, truncated: models.length > limit };
  }, true);
  const spawnShape = {
    requestId: id.optional(), policy: policy.optional(), cwd: z.string().min(1), prompt: text, provider: z.string().min(1), model: z.string().min(1), name: z.string().max(100).optional(),
    ownedPaths: z.array(z.string().min(1)).min(1).max(100), context: z.string().max(40000).default(''),
    workspaceMode: z.enum(['auto', 'worktree', 'shared']).default('auto'), baseRef: z.string().optional(), thinking: thinking.default('high'),
  };
  let callbacks;
  register('spawn_agent', 'Start an independent Pi agent within explicit user delegation and spending authorization. Supply a stable requestId for safe retries; declare owned files and acceptance criteria. OS tool permissions and policy limits are enforced. Returns immediately; accepted is not completed. callback (default enabled) wakes the parent on settle/question; Codex must supply callback.codexThreadId.', { ...spawnShape, callback: callbackShape.optional() }, async ({ callback, ...values }) => {
    const agent = await manager.spawn(values);
    return { ...agent, callback: callbacks.configure(agent.id, callback, agent.sequence) };
  });
  installTaskTool(server, manager, spawnShape, taskStore);
  register('list_agents', 'Inspect current children, or include saved sessions for explicit recovery. Returns the private local dashboard URL when running.', {
    includeSaved: z.boolean().default(false),
  }, async ({ includeSaved }) => ({ agents: await manager.list(includeSaved), dashboardUrl: dashboardInfo(manager.storage.root)?.url }), true);
  register('read_agent', 'Read durable agent status and recent events after a sequence. Optionally retrieve a bounded transcript from the active Pi process.', {
    agentId: id, afterSequence: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50), transcript: z.boolean().default(false),
  }, async ({ agentId, afterSequence, limit, transcript }) => {
    const result = await manager.read(agentId, afterSequence, limit);
    if (transcript) {
      const data = manager.transcript ? await manager.transcript(agentId) : await manager.get(agentId).rpc.command('get_messages');
      let remaining = 40000;
      result.messages = data.messages.slice(-Math.min(limit, 20)).map(message => {
        const original = JSON.stringify(message.content);
        const content = original.slice(0, Math.min(remaining, 6000)); remaining -= content.length;
        return { role: message.role, content, stopReason: message.stopReason, truncated: content.length < original.length };
      });
    }
    return result;
  }, true);
  register('send_message', 'Send a new task or communicate within the user-authorized delegation scope. Ask before expanding work or paid usage beyond it. Use a stable messageId when retrying; inspect uncertain receipts before dispatching again. steer delivers after current tools finish; follow_up waits until work finishes. Answer blocking questions with reply_question.', {
    agentId: id, message: text, mode: z.enum(['steer', 'follow_up']).default('steer'), messageId: id.optional(),
  }, ({ agentId, message, mode, messageId }) => manager.send(agentId, message, mode, messageId));
  register('reply_question', 'Answer an actual pending child question. Only an explicit answer releases the waiting tool.', {
    questionId: id, message: text,
  }, ({ questionId, message }) => (manager.reply ? manager.reply(questionId, message) : manager.channel.reply(questionId, message)));
  register('wait_agent', 'Wait until a selected child emits a new event, or a bounded timeout. Reuse nextSequence in after to avoid repeated events. Progress also wakes this call; completed means Pi settled, not business acceptance.', {
    agentIds: z.array(id).min(1).max(maxAgentLimit), after: z.record(z.number().int().min(0)).default({}), timeoutMs: z.number().int().min(0).max(45000).default(25000),
  }, async ({ agentIds, after, timeoutMs }, extra) => {
    let progress = 0;
    const onEvent = event => { if (agentIds.includes(event.agentId) && extra._meta?.progressToken !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: ++progress, message: event.type } }).catch(error => process.stderr.write(error.message + '\n')); };
    manager.on('event', onEvent);
    try { return await manager.wait(agentIds, after, timeoutMs, extra.signal); }
    finally { manager.off('event', onEvent); }
  }, true);
  register('set_agent_model', 'Change an idle session model within the user-authorized model and spending scope; ask before exceeding it. Global Pi defaults stay unchanged. next_run restores the prior model and thinking after one settled run. Interrupt busy work explicitly first.', {
    agentId: id, provider: z.string().min(1), model: z.string().min(1), thinking: thinking.optional(), scope: z.enum(['session', 'next_run']).default('session'),
  }, ({ agentId, ...options }) => manager.setModel(agentId, options));
  register('interrupt_agent', 'Clear queued instructions and abort current Pi work. Edits already made remain; stopping is not rollback.', { agentId: id }, ({ agentId }) => manager.interrupt(agentId));
  register('close_agent', 'Stop and close this child while preserving its Pi session and worktree. Does not merge or delete source changes.', { agentId: id }, ({ agentId }) => manager.closeAgent(agentId));
  register('resume_agent', 'Reopen a saved child within explicit human delegation authorization, retaining its model and directory. Fails if another live controller owns it. Does not automatically repeat previous work.', { agentId: id }, ({ agentId }) => manager.resume(agentId));
  register('read_messages', 'Read durable message receipts, reports and questions. accepted is transport acceptance; consumed means included in model context; acknowledged means parent explicitly confirmed reading. Reuse cursors.', { agentId: id, afterMessageId: id.optional(), limit: z.number().int().min(1).max(100).default(50), unacknowledgedOnly: z.boolean().default(false) }, values => manager.call ? manager.call('readMessages', values) : manager.messages.read(values.agentId, values), true);
  register('ack_messages', 'Confirm the parent has read specific messages; does not mean the task passed acceptance checks.', { agentId: id, messageIds: z.array(id).min(1).max(100) }, values => manager.call ? manager.call('ackMessages', values) : manager.messages.acknowledge(values.agentId, values.messageIds));
  register('update_agent_policy', 'Change limits or allowed models for an idle agent only after explicit human authorization. authorizationReference records the actual user instruction; it is a host assertion, not server proof of identity. If supported, the client additionally displays a confirmation form. Restart retains the Pi session and does not replay tasks.', { agentId: id, policy, authorizationReference: z.string().min(1).max(2000) }, async values => {
    if (process.env.PI_SUBAGENTS_CONFIRM_POLICY === '1' && server.server.getClientCapabilities()?.elicitation?.form) {
      const confirmation = await server.server.elicitInput({ mode: 'form', message: `Allow changing Pi agent ${values.agentId}? Requested limits: ${JSON.stringify(values.policy)}. Authorization cited by host: ${values.authorizationReference}`, requestedSchema: { type: 'object', properties: { approved: { type: 'boolean', title: 'Allow the requested policy change' } }, required: ['approved'] } });
      if (confirmation.action !== 'accept' || confirmation.content?.approved !== true) throw new Error('User did not approve the policy change');
    }
    return manager.call ? manager.call('updatePolicy', values) : manager.updatePolicy(values.agentId, values.policy, values.authorizationReference);
  });
  register('resume_task', 'Explicitly take over a persisted MCP task after its previous parent disconnected. Does not replay completed work or allow taking control from an attached parent.', { taskId: id }, values => manager.call ? manager.call('adoptTask', values) : Promise.reject(new Error('Task adoption requires the independent controller')));
  register('get_agent_changes', 'Read-only review of an owned agent\'s actual file changes: Git status, commits and bounded diff against its worktree base commit (or HEAD limited to owned paths in shared mode). Use before accepting or merging work.', {
    agentId: id, includeDiff: z.boolean().default(true), maxBytes: z.number().int().min(1000).max(200000).default(20000),
  }, async ({ agentId, ...options }) => {
    await manager.read(agentId, 0, 1); // Ownership check; the saved record also has owned paths for older controllers.
    return agentChanges(new Storage(manager.storage.root).load(agentId), options);
  }, true);
  installCommunication(server, manager, register);
  callbacks = installCallbacks(server, manager, register);
  return { server, manager, taskStore };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Default production connections also reuse a separate read-only viewer. Verification roots omit the viewer.
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
