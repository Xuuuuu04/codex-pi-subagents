import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Route model messages to its owning MCP controller without exposing provider credentials. */
export default function (pi: ExtensionAPI) {
  async function call(action: string, values: object, signal?: AbortSignal) {
    const response = await fetch(process.env.PI_SUBAGENT_ENDPOINT!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PI_SUBAGENT_TOKEN}` },
      body: JSON.stringify({ action, agentId: process.env.PI_SUBAGENT_ID, ...values }),
      signal,
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || 'Controller request failed');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
  }
  pi.registerTool({
    name: 'agent_message', label: '子代理消息',
    description: 'Send a progress report to parent, or send a message to a sibling agent ID supplied by parent. Messages to siblings become steering/follow-up instructions. Do not include credentials.',
    parameters: Type.Object({ recipient: Type.String(), message: Type.String({ maxLength: 12000 }) }),
    execute: (_id, values, signal) => call('message', values, signal),
  });
  pi.registerTool({
    name: 'ask_parent', label: '询问主代理',
    description: 'Ask parent Codex a specific blocking question and wait for its answer. Use only when project evidence cannot resolve a required decision. The tool waits; do not repeatedly ask or invent an answer.',
    parameters: Type.Object({ question: Type.String({ maxLength: 12000 }) }),
    execute: (_id, values, signal) => call('question', values, signal),
  });
}
