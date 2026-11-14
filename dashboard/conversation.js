import { el, clock, fullDate, shortDuration, safeHref, copyText, morph, replyPayload } from './dom.js';

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch (error) { return error ? String(value) : ''; }
}

export function pairMessages(messages = []) {
  const results = new Map();
  for (const msg of messages) {
    if (msg.role === 'toolResult' && msg.toolCallId) results.set(msg.toolCallId, msg);
  }
  const claimed = new Set();
  for (const msg of messages) {
    for (const c of msg.calls || []) {
      if (c.id && results.has(c.id)) claimed.add(c.id);
    }
  }
  const paired = [];
  for (const msg of messages) {
    if (msg.role === 'toolResult' && msg.toolCallId && claimed.has(msg.toolCallId)) continue;
    const calls = Array.isArray(msg.calls) ? msg.calls.map(call => ({
      ...call,
      result: call.id ? results.get(call.id) || null : null,
    })) : [];
    const searchParts = [
      msg.role,
      msg.text,
      msg.thinking,
      msg.error,
      msg.toolName,
      msg.answer,
      ...calls.flatMap(c => [c.name, textValue(c.arguments), c.result?.text, c.result?.answer, c.result?.diff]),
    ].filter(Boolean);
    paired.push({
      ...msg,
      calls,
      _search: searchParts.join('\n').toLowerCase(),
      _digest: JSON.stringify({
        id: msg.id,
        role: msg.role,
        time: msg.time,
        text: msg.text,
        thinking: msg.thinking,
        thinkingRedacted: msg.thinkingRedacted,
        error: msg.error,
        calls: calls.map(c => ({ id: c.id, name: c.name, args: c.arguments, resId: c.result?.id, isError: c.result?.isError, resText: c.result?.text, answer: c.result?.answer })),
      }),
    });
  }
  return paired;
}

function renderToolCall(call, agent) {
  const res = call.result;
  const status = !res ? 'pending' : res.isError ? 'error' : 'ok';
  const statusText = !res ? '执行中' : res.isError ? '失败' : '完成';
  const isAsk = call.name === 'ask_parent';
  const details = el('details', { className: `tool-card tool-${status}`, open: isAsk || !!res?.isError });
  const dur = Number.isFinite(res?.durationMs) ? shortDuration(res.durationMs) : '';
  const activeQuestion = isAsk ? agent?.questions?.at(-1) : null;

  details.append(
    el('summary', { className: 'tool-head' },
      el('span', { className: 'tool-name' }, call.name || 'tool'),
      dur ? el('span', { className: 'muted' }, dur) : null,
      el('span', { className: `pill pill-${status}` }, statusText),
    ),
    call.arguments !== undefined
      ? el('div', { className: 'tool-sec' },
          el('div', { className: 'tool-sec-label' }, '参数'),
          el('pre', { className: 'code-block' }, textValue(call.arguments)),
        )
      : null,
    res?.answer
      ? el('div', { className: 'tool-sec' },
          el('div', { className: 'tool-sec-label' }, '父会话答复'),
          el('div', { className: 'answer-box' }, res.answer),
        )
      : null,
    activeQuestion && !res?.answer
      ? el('div', { className: 'tool-actions' },
          el('button', {
            type: 'button',
            className: 'btn btn-xs btn-warn',
            onclick: () => copyText(replyPayload(activeQuestion.questionId), '已复制 reply_question 参数'),
          }, '复制答复参数'),
        )
      : null,
    res?.text
      ? el('div', { className: 'tool-sec' },
          el('div', { className: 'tool-sec-label' }, res.isError ? '错误输出' : '结果'),
          el('pre', { className: `code-block ${res.isError ? 'code-error' : ''}` }, res.text),
        )
      : null,
    res?.diff
      ? el('div', { className: 'tool-sec' },
          el('div', { className: 'tool-sec-label' }, '差异'),
          el('pre', { className: 'code-block diff-block' }, res.diff),
        )
      : null,
  );
  return details;
}

function createMessageCard(item, agent) {
  const node = el('article', { className: `msg msg-${item.role || 'assistant'}` });
  updateMessageCard(node, item, agent);
  return node;
}

function updateMessageCard(node, item, agent) {
  if (node.dataset.digest === item._digest && (!item.calls?.some(c => c.name === 'ask_parent'))) return;
  node.dataset.digest = item._digest;
  const roleLabel = item.role === 'user' ? '任务指令' : item.role === 'assistant' ? '子代理' : item.role === 'toolResult' ? `工具 · ${item.toolName || ''}` : item.role;
  const children = [
    el('header', { className: 'msg-head' },
      el('span', { className: `msg-role role-${item.role || 'assistant'}` }, roleLabel),
      el('time', { className: 'msg-time', title: fullDate(item.time) }, clock(item.time)),
    ),
  ];
  if (item.thinking) {
    children.push(el('details', { className: 'think-box' },
      el('summary', {}, `思考过程（${item.thinking.length} 字）`),
      el('pre', { className: 'think-body' }, item.thinking),
    ));
  } else if (item.thinkingRedacted) {
    children.push(el('div', { className: 'muted think-redacted' }, '思考内容由提供商加密省略'));
  }
  if (item.text) children.push(el('pre', { className: 'msg-body' }, item.text));
  if (item.error) children.push(el('div', { className: 'err-card' }, item.error));
  if (item.calls?.length) {
    children.push(el('div', { className: 'tool-list' }, item.calls.map(c => renderToolCall(c, agent))));
  }
  if (item.diff) children.push(el('pre', { className: 'code-block diff-block' }, item.diff));
  node.replaceChildren(...children);
}

function createLiveCard(live) {
  const node = el('article', { className: 'msg msg-live' });
  updateLiveCard(node, live);
  return node;
}

function updateLiveCard(node, live) {
  const digest = JSON.stringify({ m: live.message, t: live.tools, u: live.updatedAt });
  if (node.dataset.digest === digest) return;
  node.dataset.digest = digest;
  const body = [
    el('header', { className: 'msg-head' },
      el('span', { className: 'msg-role role-live' }, '正在输出'),
      el('time', { className: 'msg-time' }, clock(live.updatedAt)),
    ),
  ];
  for (const block of live.message?.blocks || []) {
    if (!block) continue;
    if (block.type === 'thinking' && block.text) {
      body.push(el('details', { className: 'think-box', open: true },
        el('summary', {}, '实时思考'),
        el('pre', { className: 'think-body' }, block.text),
      ));
    } else if (block.type === 'text' && block.text) {
      body.push(el('pre', { className: 'msg-body' }, block.text));
    } else if (block.type === 'toolCall') {
      body.push(el('div', { className: 'tool-card tool-pending' },
        el('div', { className: 'tool-head' },
          el('span', { className: 'tool-name' }, block.name || 'tool'),
          el('span', { className: 'pill pill-pending' }, block.done ? '准备执行' : '流式参数'),
        ),
        block.text ? el('pre', { className: 'code-block' }, block.text) : null,
      ));
    }
  }
  const activeTools = Object.entries(live.tools || {});
  if (activeTools.length) {
    body.push(el('div', { className: 'tool-list' }, activeTools.map(([callId, info]) =>
      el('div', { className: 'tool-card tool-pending', dataset: { id: callId } },
        el('div', { className: 'tool-head' },
          el('span', { className: 'tool-name' }, info.name || 'tool'),
          el('span', { className: 'muted' }, clock(info.startedAt)),
          el('span', { className: 'pill pill-pending' }, '执行中'),
        ),
        info.output ? el('pre', { className: 'code-block' }, info.output) : null,
      ),
    )));
  }
  node.replaceChildren(...body);
}

export function renderThread(container, detail, searchQuery = '') {
  const countNode = document.getElementById('thread-count');
  const prBar = document.getElementById('thread-prs');
  if (!detail) {
    if (countNode) countNode.textContent = '';
    if (prBar) prBar.replaceChildren();
    container.replaceChildren(el('div', { className: 'empty-main' }, '从左侧选择一个子代理查看完整对话与工具记录'));
    return;
  }

  if (prBar) {
    const links = (detail.pullRequests || []).map(pr => {
      const href = safeHref(pr.url || pr);
      if (!href) return null;
      const hint = pr.merged ? '已合并' : pr.created ? '已创建' : 'PR';
      return el('a', { href, target: '_blank', rel: 'noopener noreferrer', className: 'pr-pill' }, `${hint} · ${href.replace(/^https?:\/\//, '')}`);
    }).filter(Boolean);
    prBar.replaceChildren(...links);
  }

  const paired = pairMessages(detail.messages || []);
  const q = searchQuery.trim().toLowerCase();
  const filtered = q ? paired.filter(item => item._search.includes(q)) : paired;
  if (countNode) {
    countNode.textContent = q ? `匹配 ${filtered.length} / ${paired.length} 条` : `${paired.length} 条记录`;
  }

  if (!filtered.length && !detail.live) {
    const emptyMsg = detail.transcriptError
      ? `无法读取会话记录：${detail.transcriptError}`
      : q ? `当前会话中没有包含“${searchQuery.trim()}”的记录` : '该子代理还没有会话输出';
    container.replaceChildren(el('div', { className: 'empty-main' }, emptyMsg));
    return;
  }

  const items = filtered.map(item => ({ kind: 'msg', key: item.id, item }));
  if (detail.live && !q) items.push({ kind: 'live', key: '__live__', live: detail.live });
  morph(
    container,
    items,
    entry => entry.key,
    entry => entry.kind === 'live' ? createLiveCard(entry.live) : createMessageCard(entry.item, detail.agent),
    (node, entry) => entry.kind === 'live' ? updateLiveCard(node, entry.live) : updateMessageCard(node, entry.item, detail.agent),
  );
}
