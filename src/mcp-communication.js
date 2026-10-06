import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Standard resources, subscriptions and log notifications; host UI/turn wake-up is a separate capability. */
export function installCommunication(server, manager, register) {
  const subscribed = new Set();
  const uriOf = agentId => `pi-agent://${agentId}/events`;
  const parse = uri => { const match = /^pi-agent:\/\/([0-9a-f-]{36})\/events$/.exec(uri); if (!match) throw new Error('Unknown agent resource'); return match[1]; };
  server.registerResource('agent-events', new ResourceTemplate('pi-agent://{agentId}/events', { list: async () => ({ resources: (await manager.list(false)).map(agent => ({ uri: uriOf(agent.id), name: agent.name, mimeType: 'application/json' })) }) }),
    { description: 'Durable Pi agent status and recent events', mimeType: 'application/json' }, async (uri, values) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await manager.read(String(values.agentId))) }] }));
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true }, logging: {} });
  server.server.setRequestHandler(SubscribeRequestSchema, async request => { await manager.read(parse(request.params.uri)); subscribed.add(request.params.uri); return {}; });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async request => { subscribed.delete(request.params.uri); return {}; });
  const notify = notification => server.server.notification(notification).catch(error => { process.stderr.write(`Pi notification delivery failed: ${error.message}\n`); });
  manager.on('event', event => {
    const uri = uriOf(event.agentId);
    if (['ready', 'resumed', 'closed'].includes(event.type)) notify({ method: 'notifications/resources/list_changed' });
    if (subscribed.has(uri)) notify({ method: 'notifications/resources/updated', params: { uri } });
    if (['question', 'settled', 'process_failed', 'budget_limit'].includes(event.type)) server.server.sendLoggingMessage({ level: event.type === 'process_failed' ? 'error' : 'info', logger: 'pi-subagents', data: { agentId: event.agentId, sequence: event.sequence, type: event.type, questionId: event.questionId, status: event.status } }).catch(error => process.stderr.write(`Pi log notification failed: ${error.message}\n`));
  });
  manager.on('controller_error', error => { process.stderr.write(`Pi controller: ${error.message}\n`); });
  register('get_client_capabilities', 'Inspect negotiated MCP client capabilities and supported server features. Notifications do not imply that the host automatically wakes the Codex model after a turn has ended. Use wait/read fallback if the host does not consume asynchronous events.', {}, () => ({
    client: server.server.getClientVersion(), negotiated: server.server.getClientCapabilities(),
    server: { durableMessages: true, independentController: Boolean(manager.call), resourceSubscriptions: true, logNotifications: true, progressNotifications: true, tasks: 'experimental MCP 2025-11-25' },
    automaticCodexTurnWake: { supported: false, reason: 'MCP does not expose a portable model-turn wake API; host notification display is not model execution.' },
  }), true);
  if (manager.watch) { server.server.oninitialized = () => { manager.watch().catch(error => process.stderr.write(`Pi watcher: ${error.message}\n`)); }; }
}
