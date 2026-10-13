import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const waitScript = path.join(projectRoot, 'scripts/wait-events.js');
const working = new Set(['starting', 'running', 'finishing']);

/** 启动或派新任务之后附在返回值里：模型每次拿到 id 都会同时看到“必须去等”。 */
export function spawnReminder(agentId) {
  return {
    rule: '子代理已在后台运行，但这只是受理，不是完成。结束本轮回答之前，必须对它调用 wait_agent 直到状态变成 completed、failed、interrupted 或 closed；如果确实要提前结束本轮，要明确告诉用户它仍在后台运行以及怎么查看。',
    next: `立刻调用 wait_agent，agentIds 填 ["${agentId}"]，after 先用本次返回的 sequence。`,
    claudeCode: `Claude Code：另外把这条命令作为后台命令运行，事件到达时会唤醒你：node ${waitScript} --agent ${agentId}`,
  };
}

/** wait_agent 返回后，列出仍未结束的代理，提醒继续等或明确交代。 */
export function waitReminder(result) {
  const pending = [], asking = [];
  for (const item of result.results || []) {
    const status = item.agent?.status;
    const entry = { agentId: item.agent?.id, status, after: item.nextSequence };
    if (working.has(status)) pending.push(entry); else if (status === 'waiting') asking.push(entry);
  }
  if (!pending.length && !asking.length) return result;
  return {
    ...result, pending, asking,
    reminder: [asking.length ? '有代理正在等待答复：先读取它的提问，用 reply_question 回答，否则它不会继续。' : null,
      pending.length ? '仍有代理在工作：把各自的 after 填进下一次 wait_agent 继续等，不要在它们结束前收尾本轮；若必须结束，要先告诉用户它们仍在后台运行。' : null].filter(Boolean).join(' '),
  };
}
