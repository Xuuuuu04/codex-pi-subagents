// 实时对话：按时间顺序还原子代理的思考、回复和工具窗口。依赖 app.js 中的 el / svg / clock 等小工具（调用时才读取）。

/* ---------- 图标 ---------- */
const icons = {
  shell: 'M4 6l5 5-5 5M11 17h8', file: 'M7 3h7l4 4v14H7zM14 3v4h4', edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16 16l4 4', think: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z',
  tool: 'M14 6a4 4 0 0 0 5 5l-8 8-3-3 8-8a4 4 0 0 0-2-2zM5 19l-1 1', message: 'M4 5h16v11H8l-4 4z', ask: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7V14M12 17.5v.5',
  files: 'M5 4h9l5 5v11H5zM9 13h6M12 10v6',
};
function icon(name, cls = 'ico') { const box = svg('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' }); box.append(svg('path', { d: icons[name] || icons.tool })); return box; }

/* ---------- 轻量 Markdown（只生成 DOM，不解析 HTML） ---------- */
function inline(text) {
  const nodes = []; const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g; let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    nodes.push(token.startsWith('`') ? el('code', { text: token.slice(1, -1) }) : el('strong', { text: token.slice(2, -2) }));
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
function markdown(source) {
  const root = el('div', { class: 'md' }); const parts = source.split(/^```[^\n]*\n?/m);
  parts.forEach((part, index) => {
    if (index % 2) { root.append(el('pre', { class: 'code', text: part.replace(/\n$/, '') })); return; }
    let list = null; let paragraph = [];
    const flush = () => { if (paragraph.length) root.append(el('p', {}, inline(paragraph.join('\n')))); paragraph = []; };
    for (const line of part.split('\n')) {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line); const item = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
      if (heading) { flush(); list = null; root.append(el('h4', {}, inline(heading[2]))); }
      else if (item) { flush(); if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul'); root.append(list); } list.append(el('li', {}, inline(item[1]))); }
      else if (!line.trim()) { flush(); list = null; }
      else { if (list) list = null; paragraph.push(line); }
    }
    flush();
  });
  return root;
}

/* ---------- 工具描述 ---------- */
const parsePath = args => args.path ?? args.file_path ?? args.filePath ?? '';
function describe(call, running) {
  const a = call.arguments || {}; const name = call.name;
  if (name === 'bash') return { icon: 'shell', verb: running ? '正在运行命令' : '运行了命令', target: String(a.command || '').split('\n')[0] };
  if (name === 'read') return { icon: 'file', verb: running ? '正在读取' : '读取了', target: parsePath(a) };
  if (name === 'edit') return { icon: 'edit', verb: running ? '正在编辑' : '编辑了', target: parsePath(a) };
  if (name === 'write') return { icon: 'edit', verb: running ? '正在写入' : '写入了', target: parsePath(a) };
  if (name === 'grep' || name === 'find') return { icon: 'search', verb: running ? '正在搜索' : '搜索了', target: a.pattern || a.query || parsePath(a) };
  if (name === 'ls') return { icon: 'search', verb: running ? '正在列出' : '列出了', target: parsePath(a) || '.' };
  return { icon: 'tool', verb: running ? `正在调用 ${name}` : `调用了 ${name}`, target: '' };
}
function diffStats(diff = '') { let add = 0; let del = 0; for (const line of diff.split('\n')) { if (line.startsWith('+')) add++; else if (line.startsWith('-')) del++; } return { add, del }; }
function diffView(diff) {
  const box = el('div', { class: 'diff' });
  for (const line of diff.split('\n')) box.append(el('div', { class: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.trim() === '...' ? 'gap' : '', text: line || ' ' }));
  return box;
}

/* ---------- 工具窗口 ---------- */
function toolWindow(call, result, liveOutput) {
  const a = call.arguments || {}; const output = liveOutput ?? result?.text ?? '';
  if (call.name === 'bash') {
    const term = el('div', { class: 'term' },
      el('div', { class: 'term-head' }, el('i'), el('i'), el('i'), el('span', { text: 'Shell' }), result?.durationMs != null ? el('em', { text: shortDuration(result.durationMs) }) : null),
      el('pre', { class: 'term-body' }, el('span', { class: 'prompt', text: '$ ' }), String(a.command || ''), output ? `\n${output}` : liveOutput === '' ? '\n' : '', !result ? el('span', { class: 'caret' }) : null));
    if (result) term.append(el('div', { class: `term-foot ${result.isError ? 'bad' : ''}`, text: result.isError ? '命令失败' : '执行成功' }));
    return term;
  }
  if (call.name === 'edit' || call.name === 'write') {
    const diff = result?.diff; const stats = diff ? diffStats(diff) : { add: String(a.content || '').split('\n').length, del: 0 };
    const head = el('div', { class: 'file-head' }, icon('file'), el('code', { text: parsePath(a) }), el('span', { class: 'plus', text: `+${stats.add}` }), el('span', { class: 'minus', text: `-${stats.del}` }));
    const body = diff ? diffView(diff) : call.name === 'write' ? el('pre', { class: 'file-body', text: String(a.content || '') }) :
      el('div', { class: 'diff' }, (a.edits || [a]).flatMap(edit => [...String(edit.oldText ?? edit.old_string ?? '').split('\n').map(line => el('div', { class: 'del', text: `- ${line}` })), ...String(edit.newText ?? edit.new_string ?? '').split('\n').map(line => el('div', { class: 'add', text: `+ ${line}` }))]));
    return el('div', { class: 'file-win' }, head, body, result?.isError ? el('div', { class: 'win-error', text: result.text }) : null);
  }
  const argsText = JSON.stringify(a, null, 2);
  return el('div', { class: 'file-win' },
    el('div', { class: 'file-head' }, icon(describe(call).icon), el('code', { text: parsePath(a) || call.name }), result?.durationMs != null ? el('em', { text: shortDuration(result.durationMs) }) : null),
    call.name === 'read' ? null : el('pre', { class: 'file-body args', text: argsText }),
    output ? el('pre', { class: `file-body ${result?.isError ? 'bad' : ''}`, text: output }) : el('div', { class: 'win-wait', text: result ? '没有输出' : '等待结果…' }));
}

function toolItem(call, result, ctx) {
  const running = !result && ctx.working; const liveOutput = ctx.live?.tools?.[call.id]?.output;
  if (call.name === 'agent_message') {
    return el('div', { class: 'note-item' }, el('div', { class: 'note-head' }, icon('message'), `向${call.arguments?.recipient === 'parent' ? '父代理' : call.arguments?.recipient || ''}报告`, el('time', { text: clock(result?.time) })),
      markdown(String(call.arguments?.message || '')));
  }
  if (call.name === 'ask_parent') {
    return el('div', { class: `ask-item ${result ? '' : 'pending'}` }, el('div', { class: 'note-head' }, icon('ask'), result ? '向父代理提问 · 已答复' : '向父代理提问 · 等待答复'),
      el('p', { class: 'q', text: String(call.arguments?.question || '') }), result ? el('p', { class: 'a', text: result.answer || result.text }) : null);
  }
  const d = describe(call, running);
  const stats = (call.name === 'edit' || call.name === 'write') && result?.diff ? diffStats(result.diff) : null;
  const status = running ? el('span', { class: 'spin' }) : !result ? el('span', { class: 'muted', text: '未完成' }) :
    result.isError ? el('span', { class: 'bad', text: '失败' }) : stats ? el('span', { class: 'stat' }, el('b', { class: 'plus', text: `+${stats.add}` }), el('b', { class: 'minus', text: `-${stats.del}` })) :
    result.durationMs != null ? el('span', { class: 'muted', text: shortDuration(result.durationMs) }) : null;
  const key = `${ctx.agentId}:tool:${call.id}`;
  const node = el('details', { class: `tool-item ${running ? 'running' : ''} ${result?.isError ? 'error' : ''}`, 'data-key': key },
    el('summary', {}, icon(d.icon), el('span', { class: 'verb', text: d.verb }), d.target ? el('code', { class: 'target', text: d.target }) : null, status),
    toolWindow(call, result, liveOutput));
  node.open = ctx.expanded.get(key) ?? (running && liveOutput != null);
  return node;
}

/* ---------- 一次运行的改动汇总 ---------- */
function editsCard(edits, key, ctx) {
  const files = new Map();
  for (const { call, result } of edits) {
    const stats = result.diff ? diffStats(result.diff) : { add: String(call.arguments?.content || '').split('\n').length, del: 0 };
    const name = parsePath(call.arguments || {}); const total = files.get(name) || { add: 0, del: 0 };
    files.set(name, { add: total.add + stats.add, del: total.del + stats.del });
  }
  const sum = [...files.values()].reduce((t, f) => ({ add: t.add + f.add, del: t.del + f.del }), { add: 0, del: 0 });
  const node = el('details', { class: 'edits-card', 'data-key': key },
    el('summary', {}, icon('files'), el('span', { text: `已编辑 ${files.size} 个文件` }), el('b', { class: 'plus', text: `+${sum.add}` }), el('b', { class: 'minus', text: `-${sum.del}` })),
    el('ul', {}, [...files].map(([name, f]) => { const slash = name.lastIndexOf('/'); return el('li', {}, el('span', { class: 'dir', text: name.slice(0, slash + 1) }), el('span', { text: name.slice(slash + 1) }), el('b', { class: 'plus', text: `+${f.add}` }), el('b', { class: 'minus', text: `-${f.del}` })); })));
  node.open = ctx.expanded.get(key) ?? files.size <= 4;
  return node;
}

/* ---------- 主渲染 ---------- */
function thinkingRow(message, ctx) {
  const spent = Date.parse(message.time) - Date.parse(message.startedAt);
  const label = `思考了 ${Number.isFinite(spent) ? shortDuration(spent) : ''}`;
  if (!message.thinking) return el('div', { class: 'think-row flat' }, icon('think'), label, message.thinkingRedacted ? el('span', { class: 'muted', text: ' · 模型未公开思考内容' }) : null);
  const key = `${ctx.agentId}:think:${message.id}`;
  const node = el('details', { class: 'think-row', 'data-key': key }, el('summary', {}, icon('think'), label), el('div', { class: 'think-text' }, markdown(message.thinking)));
  node.open = ctx.expanded.get(key) ?? false;
  return node;
}
function userBubble(message, ctx) {
  const text = message.text.replace(/^\[Pi message [^\]]+\]\n/, '');
  const key = `${ctx.agentId}:user:${message.id}`; const long = text.length > 220 || text.split('\n').length > 4;
  const bubble = el('div', { class: `bubble ${long && !ctx.expanded.get(key) ? 'clamped' : ''}`, 'data-key': key }, el('div', { class: 'bubble-text', text }));
  if (long) bubble.append(el('button', { type: 'button', class: 'more', text: ctx.expanded.get(key) ? '收起' : '显示更多', onclick: event => {
    const open = bubble.classList.toggle('clamped'); ctx.expanded.set(key, !open); event.target.textContent = open ? '显示更多' : '收起';
  } }));
  return el('div', { class: 'turn-user' }, el('time', { text: clock(message.time) }), bubble);
}
function liveTail(data, ctx, pendingCalls, lastTime) {
  const tail = el('div', { class: 'live-tail' }); const live = data.live; const agent = data.agent;
  if (agent.status === 'waiting') { tail.append(el('div', { class: 'live-row wait' }, icon('ask'), '暂停在提问上，等待所属聊天答复')); return tail; }
  if (!ctx.working) return null;
  if (live?.message) {
    const since = Date.parse(live.message.startedAt);
    for (const block of live.message.blocks.filter(Boolean)) {
      if (block.type === 'thinking') tail.append(el('div', { class: 'live-think' }, el('div', { class: 'live-row shimmer' }, icon('think'), '正在思考', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })), block.text ? el('div', { class: 'think-text live' }, markdown(block.text.slice(-1600))) : null));
      else if (block.type === 'text') tail.append(el('div', { class: 'live-text' }, markdown(block.text), el('span', { class: 'caret' })));
      else if (block.type === 'toolCall') tail.append(el('div', { class: 'live-row shimmer' }, icon('tool'), block.done ? `准备调用 ${block.name}` : `正在写 ${block.name || '工具'} 的参数`, el('span', { class: 'muted', text: `${block.text.length} 字` })));
    }
    if (!live.message.blocks.filter(Boolean).length) tail.append(el('div', { class: 'live-row shimmer' }, icon('think'), '正在等待模型响应', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })));
    return tail;
  }
  if (!pendingCalls) {
    const since = Date.parse(lastTime) || Date.now();
    tail.append(el('div', { class: 'live-row shimmer' }, icon('think'), '正在思考', el('span', { class: 'muted', 'data-since': since, text: shortDuration(Date.now() - since) })));
    return tail;
  }
  return null;
}
function renderConversation(data, expanded) {
  const ctx = { agentId: data.agent.id, expanded, working: ['starting', 'running', 'finishing'].includes(data.agent.status), live: data.live };
  const results = new Map(data.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
  const convo = el('div', { class: 'convo' }); let edits = []; let runKey = 'start'; let pending = 0;
  const flushEdits = () => { if (edits.length) convo.append(editsCard(edits, `${ctx.agentId}:edits:${runKey}`, ctx)); edits = []; };
  for (const message of data.messages) {
    if (message.role === 'user') { flushEdits(); runKey = message.id; convo.append(userBubble(message, ctx)); continue; }
    if (message.role !== 'assistant') continue;
    pending = 0; // Only the latest assistant turn can still be waiting for its tools.
    const turn = el('div', { class: 'turn-agent' });
    if (message.thinking || message.thinkingRedacted) turn.append(thinkingRow(message, ctx));
    if (message.text) turn.append(markdown(message.text));
    if (message.error) turn.append(el('div', { class: 'win-error', text: `模型请求失败：${message.error}` }));
    for (const call of message.calls) {
      const result = results.get(call.id); if (!result) pending++;
      turn.append(toolItem(call, result, ctx));
      if (result && !result.isError && (call.name === 'edit' || call.name === 'write')) edits.push({ call, result });
    }
    if (turn.childNodes.length) convo.append(turn);
  }
  flushEdits();
  const tail = liveTail(data, ctx, ctx.working && pending > 0, data.messages.at(-1)?.time); if (tail) convo.append(tail);
  if (!data.messages.length && !tail) convo.append(el('p', { class: 'records-empty', text: '暂时没有已保存的对话。' }));
  return convo;
}
