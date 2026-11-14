import {
  $, el, svg, glyph, paths, labels, working, busyStatuses, eventTypes, commTypes, badTypes, lifeTypes,
  ms, clock, fullDate, duration, shortDuration, ago, tokens, cost, modelName, elapsedOf,
  agentHost, hostMeta, agentSessionId, copyText, replyPayload, store, mount,
} from './dom.js';
import { areaChart, gauge } from './charts.js';
import { markdown, diffStats } from './conversation.js';

export function pairTools(events = []) {
  const open = new Map();
  const calls = [];
  for (const e of events) {
    if (e.type === 'tool_execution_start') {
      const call = { id: e.toolCallId, name: e.toolName, start: ms(e.time), end: null, isError: false };
      open.set(e.toolCallId, call);
      calls.push(call);
    } else if (e.type === 'tool_execution_end') {
      const call = open.get(e.toolCallId);
      if (call) { call.end = ms(e.time); call.isError = Boolean(e.isError); open.delete(e.toolCallId); }
      else calls.push({ id: e.toolCallId, name: e.toolName, start: ms(e.time), end: ms(e.time), isError: Boolean(e.isError) });
    }
  }
  return { calls, open: [...open.values()] };
}

export function renderLane(agent, tools) {
  const lane = $('#lane');
  const wrap = $('#lane-wrap');
  if (!lane || !wrap) return;
  lane.replaceChildren();
  const width = Math.max(200, wrap.clientWidth);
  const height = 66;
  lane.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const events = agent.events || [];
  const start = Math.min(ms(agent.createdAt) || Infinity, ms(events[0]?.time) || Infinity);
  const live = working.has(agent.status);
  const end = Math.max(live ? Date.now() : 0, ms(agent.activity?.lastWorkAt || agent.updatedAt) || 0, start + 1000);
  const x = t => (Math.min(Math.max(t, start), end) - start) / (end - start) * (width - 4);
  for (const [y, h] of [[2, 24], [32, 14], [50, 14]]) lane.append(svg('rect', { x: 0, y, width: width - 4, height: h, rx: 5, class: 'lane-bg' }));
  for (let i = 1; i < 4; i++) { const gx = (width - 4) * i / 4; lane.append(svg('line', { x1: gx, x2: gx, y1: 0, y2: height, class: 'grid' })); }
  const tip = (node, text) => { node.setAttribute('data-tip', text); return node; };
  for (const call of tools.calls) {
    const x1 = x(call.start);
    const x2 = call.end == null ? x(end) : x(call.end);
    const cls = call.end == null ? 'seg open' : call.isError ? 'seg err' : 'seg';
    lane.append(tip(svg('rect', { x: x1, y: 5, width: Math.max(2, x2 - x1), height: 18, rx: 2, class: cls }),
      `${call.name}${call.isError ? ' · 失败' : ''}\n${clock(call.start)} · ${call.end == null ? `进行中 ${shortDuration(Date.now() - call.start)}` : shortDuration(call.end - call.start)}`));
  }
  for (const e of events) {
    const text = String(e.question || e.message || e.text || e.error || e.reason || '').slice(0, 140);
    if (commTypes.has(e.type)) {
      lane.append(tip(svg('circle', { cx: x(ms(e.time)), cy: 39, r: 4, class: `comm ${e.type === 'question' ? 'question' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    } else if (lifeTypes.has(e.type)) {
      const cx = x(ms(e.time));
      lane.append(tip(svg('path', { d: `M${cx} 51 l4.5 6 l-4.5 6 l-4.5 -6 z`, class: `life ${badTypes.has(e.type) ? 'bad' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    }
  }
  if (live) lane.append(svg('line', { x1: x(end) - 1, x2: x(end) - 1, y1: 0, y2: height, class: 'nowline' }));
  $('#axis-start').textContent = Number.isFinite(start) ? clock(start) : '—';
  $('#axis-mid').textContent = Number.isFinite(start) ? `跨度 ${duration(end - start)}` : '';
  $('#axis-end').textContent = live ? '现在' : Number.isFinite(end) ? clock(end) : '—';
}

export function changedFiles(data) {
  const results = new Map(data.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m]));
  const files = new Map();
  for (const m of data.messages) for (const call of m.calls || []) {
    const result = results.get(call.id);
    if (!result || result.isError || !['edit', 'write'].includes(call.name)) continue;
    const stats = result.diff ? diffStats(result.diff) : { add: String(call.arguments?.content || '').split('\n').length, del: 0 };
    const name = call.arguments?.path || call.arguments?.file_path || '?';
    const total = files.get(name) || { add: 0, del: 0 };
    files.set(name, { add: total.add + stats.add, del: total.del + stats.del });
  }
  return files;
}

export function renderHead(data, tools, state) {
  const agent = data.agent;
  const host = hostMeta(agentHost(agent));
  const sid = agentSessionId(agent);
  $('#d-dot').className = `dot ${agent.status}`;
  $('#d-name').textContent = agent.name || agent.id;
  $('#d-model').textContent = modelName(agent);

  const hostBtn = $('#d-host');
  if (sid) {
    hostBtn.hidden = false;
    hostBtn.className = `d-host ${host.cls}`;
    hostBtn.textContent = `${host.short || host.label} · ${sid.slice(0, 8)}${agent.watcherActive ? ' · 监听中' : ''}`;
    hostBtn.title = `点击复制父会话编号：${sid}`;
    hostBtn.onclick = () => copyText(sid, '已复制父会话编号');
  } else {
    hostBtn.hidden = true;
    hostBtn.onclick = null;
  }

  const chips = [
    ['模型', agent.model?.model || '未知'],
    ['思考', agent.thinking || '默认'],
    host.short && ['宿主', host.label],
    agent.workspaceMode && ['目录', agent.workspaceMode === 'worktree' ? '独立工作树' : agent.workspaceMode === 'shared' ? '共享目录' : agent.workspaceMode],
    agent.ownedPaths?.length && ['范围', `${agent.ownedPaths.length} 项`],
    agent.callback?.enabled && ['回调', `#${agent.callback.antigravityDeliveredSeq || 0}`],
    agent.watcherActive && ['监听', '活跃'],
    agent.temporaryModel && ['临时模型', '结束后恢复'],
    agent.marked && ['标记', '手动'],
  ].filter(Boolean);

  const card = $('#p-status');
  const cardKey = JSON.stringify([agent.id, agent.status, chips, agent.cwd, sid]);
  if (card.dataset.key !== cardKey) {
    card.dataset.key = cardKey;
    mount(card,
      el('div', { class: 'status-top' }, el('span', { class: `pill ${agent.status}` }, el('span', { class: `dot ${agent.status}` }), labels[agent.status] || agent.status), el('span', { class: 'ago', 'data-ago': agent.updatedAt, text: ago(agent.updatedAt) })),
      el('div', { class: 'big-clock' }, el('span', { id: 'p-elapsed', text: duration(elapsedOf(agent)) }), el('small', { text: working.has(agent.status) ? '已用时' : '总用时' })),
      el('div', { class: 'meta-chips' }, chips.map(([k, v]) => el('span', { title: k }, el('span', { class: 'muted', text: k }), el('code', { text: v })))),
      el('div', { class: 'status-actions' },
        el('button', { type: 'button', class: 'btn small', onclick: () => copyText(agent.id, '已复制会话身份') }, glyph(paths.copy), '会话身份'),
        sid ? el('button', { type: 'button', class: 'btn small', onclick: () => copyText(sid, '已复制父会话编号') }, glyph(paths.copy), '父会话') : null,
        el('button', { type: 'button', class: 'btn small', disabled: !agent.cwd, onclick: () => copyText(agent.cwd || '', '已复制工作目录') }, glyph(paths.copy), '工作目录'),
      ),
    );
  }

  const u = agent.usage || {};
  const errors = tools.calls.filter(c => c.isError).length;
  const cacheBase = (u.input || 0) + (u.cacheRead || 0);
  const figures = [
    ['工具调用', tools.calls.length, errors ? `${errors} 失败` : null, errors > 0],
    ['上报费用', cost(u.reportedCost)],
    ['输入', tokens(u.input)],
    ['输出', tokens(u.output)],
    ['缓存命中', tokens(u.cacheRead), cacheBase ? `${Math.round((u.cacheRead || 0) / cacheBase * 100)}%` : null],
    ['事件', `#${agent.sequence ?? 0}`],
  ];
  mount($('#d-figures'), figures.map(([name, value, extra, bad]) => el('div', {}, el('dt', { text: name }), el('dd', { class: bad ? 'bad' : '' }, String(value), extra ? el('small', { text: extra }) : null))));

  const report = $('#d-report');
  report.hidden = !agent.recentMessage;
  const reportBody = report.querySelector('.p-report');
  if (reportBody.dataset.text !== (agent.recentMessage || '')) {
    reportBody.dataset.text = agent.recentMessage || '';
    mount(reportBody, markdown(agent.recentMessage || ''));
    reportBody.classList.remove('expanded');
  }

  const files = changedFiles(data);
  const badge = $('#changes-badge');
  const loaded = state.changes.get(agent.id);
  const count = loaded?.result && loaded.result.git !== false ? loaded.files.length : files.size;
  badge.hidden = !count;
  badge.textContent = count;

  const alerts = $('#d-alerts');
  const alertKey = JSON.stringify([agent.id, (agent.questions || []).map(q => q.questionId), agent.error, agent.status === 'disconnected']);
  if (alerts.dataset.key !== alertKey) {
    alerts.dataset.key = alertKey;
    alerts.replaceChildren();
    for (const q of agent.questions || []) {
      alerts.append(el('div', {
        class: 'alert clamp',
        title: '点击展开或收起',
        onclick: event => { if (!event.target.closest('button')) event.currentTarget.classList.toggle('clamp'); },
      },
      el('div', { class: 'alert-head' }, el('strong', { text: `等待父代理答复 · ${ago(q.time)}前` }), el('button', { type: 'button', class: 'btn small', onclick: () => copyText(replyPayload(q.questionId), '已复制 reply_question 参数') }, '复制答复参数')),
      el('p', { text: q.question }),
      el('small', { text: `问题身份 ${q.questionId}` })));
    }
    if (agent.error) alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '错误' }), el('p', { text: agent.error })));
    if (agent.status === 'disconnected') alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '控制进程已离线' }), el('p', { text: '在所属聊天中用 list_agents(includeSaved=true) 和 resume_agent 恢复。' })));
  }

  const bar = $('#d-now');
  const openCall = busyStatuses.has(agent.status) ? tools.open.at(-1) : null;
  const last = agent.activity?.lastEvent;
  const barKey = JSON.stringify([agent.id, agent.status, openCall?.id, data.live?.message?.blocks?.some(b => b?.type === 'text'), last?.type, last?.time]);
  $('#dock').hidden = false;
  if (bar.dataset.key === barKey) return;
  bar.dataset.key = barKey;
  bar.className = `dock-bar ${['failed', 'disconnected'].includes(agent.status) ? 'bad' : ''}`;
  bar.replaceChildren();
  const clockNode = el('span', { class: 'clock' }, el('small', { text: working.has(agent.status) ? '已用时' : '总用时' }), el('span', { id: 'd-elapsed', text: duration(elapsedOf(agent)) }));
  if (openCall) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow' }, '正在执行 ', el('code', { text: openCall.name }), ' ', el('span', { class: 'muted', 'data-since': openCall.start, text: shortDuration(Date.now() - openCall.start) })), clockNode);
  else if (agent.status === 'waiting') bar.append(el('span', { class: 'dot waiting' }), el('span', { class: 'grow', text: '暂停在提问上，等所属聊天答复' }), clockNode);
  else if (working.has(agent.status)) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow shimmer', text: data.live?.message?.blocks?.some(b => b?.type === 'text') ? '正在回复' : '正在思考' }), clockNode);
  else {
    const suffix = last ? ` · 最后动作 ${eventTypes[last.type] || last.type}${last.toolName ? ` ${last.toolName}` : ''} · ${ago(last.time)}前` : '';
    bar.append(el('span', { class: `dot ${agent.status}` }), el('span', { class: 'grow', text: `${labels[agent.status] || agent.status}${suffix}` }), clockNode);
  }
}

const partNames = [
  ['system', '系统提示', 'var(--c7)'], ['user', '任务与消息', 'var(--c2)'], ['assistant', '模型回复', 'var(--c1)'],
  ['thinking', '思考', 'var(--c3)'], ['toolCalls', '工具调用', 'var(--c4)'], ['toolResults', '工具结果', 'var(--c6)'],
];

export function renderContext(data, ptab) {
  const ctx = data.context;
  const box = $('#p-context');
  const key = JSON.stringify([data.agent.id, ctx?.requests, ctx?.used, ctx?.contextWindow, ptab]);
  if (box.dataset.key === key) return;
  const animate = box.dataset.agent !== data.agent.id;
  box.dataset.key = key;
  box.dataset.agent = data.agent.id;
  if (!ctx || !ctx.requests) {
    mount(box, el('section', { class: 'card empty-card' }, glyph(paths.empty), data.transcriptError ? `会话记录无法读取：${data.transcriptError}` : '还没有完成的模型请求，暂时没有上下文数据。'));
    return;
  }
  const windowSize = ctx.contextWindow;
  const fraction = windowSize ? ctx.used / windowSize : null;
  const top = el('section', { class: 'card' },
    el('header', { class: 'card-head' }, el('h3', { text: '上下文占用' }), el('span', { class: 'card-meta', text: `最近一次请求 · 共 ${ctx.requests} 次` })),
    el('div', { class: 'ctx-top' },
      gauge(fraction ?? 0, fraction == null ? tokens(ctx.used) : `${Math.round(fraction * 100)}%`, fraction == null ? '窗口未知' : '已使用'),
      el('dl', { class: 'ctx-figs' }, [['当前', tokens(ctx.used)], ['窗口', windowSize ? tokens(windowSize) : '未知'], ['剩余', windowSize ? tokens(Math.max(0, windowSize - ctx.used)) : '—'], ['峰值', tokens(ctx.peak)], ['缓存命中', ctx.used ? `${Math.round(ctx.cached / ctx.used * 100)}%` : '—'], ['压缩', `${ctx.compactions} 次`]].map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v })))),
    ),
  );
  const parts = { system: ctx.sections.reduce((s, x) => s + x.tokens, 0), ...ctx.parts };
  const total = Object.values(parts).reduce((s, v) => s + v, 0) || 1;
  const stack = el('div', { class: 'stack' });
  const list = el('ul', { class: 'breakdown' });
  for (const [k, name, color] of partNames) {
    const v = parts[k] || 0;
    if (!v) continue;
    const seg = el('i', { title: `${name} 约 ${tokens(v)}` });
    seg.style.background = color;
    seg.style.flexGrow = animate ? 0 : v;
    stack.append(seg);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { seg.style.flexGrow = v; }));
    const dot = el('i');
    dot.style.background = color;
    list.append(el('li', {}, dot, el('span', { text: name }), el('span', { class: 'v', text: tokens(v) }), el('span', { class: 'p', text: `${Math.round(v / total * 100)}%` })));
  }
  const compose = el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '构成' }), el('span', { class: 'card-meta', text: '按文字估算' })), stack, list, el('p', { class: 'ctx-note', text: '实际占用以模型上报为准；估算只用来看各部分的比例。最近的会话记录最多读取 500 条。' }));
  const values = ctx.series.map((s, i) => ({ x: i, y: s.used }));
  const cached = ctx.series.map((s, i) => ({ x: i, y: s.cached }));
  const showLimit = Boolean(windowSize && ctx.peak > windowSize * 0.6);
  const chart = areaChart({
    width: 320, height: 110, animate,
    series: [{ values, color: 'var(--c2)', label: '占用' }, { values: cached, color: 'var(--c1)', opacity: 0.12, dot: false, label: '缓存' }],
    yMax: showLimit ? windowSize * 1.02 : undefined,
    refLines: showLimit ? [{ y: windowSize, cls: 'limit' }] : [],
    tooltip: i => {
      const s = ctx.series[i];
      return [`第 ${i + 1} 次请求 · ${clock(s.at)}`, ['占用 ', { b: tokens(s.used) }, windowSize ? `（${Math.round(s.used / windowSize * 100)}%）` : ''], ['缓存 ', { b: tokens(s.cached) }, '  输出 ', { b: tokens(s.output) }], s.reasoning ? ['推理 ', { b: tokens(s.reasoning) }] : null].filter(Boolean);
    },
  });
  const growth = el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '增长' }), el('span', { class: 'card-meta', text: `最高 ${tokens(ctx.peak)}` })), chart, el('div', { class: 'legend' }, el('span', { style: '--c: var(--c2)', text: '每次请求的占用' }), el('span', { style: '--c: var(--c1)', text: '其中缓存' }), showLimit ? el('span', { style: '--c: var(--fail)', text: '窗口上限' }) : null));
  const cards = [top, compose, growth];
  if (ctx.sections.length) {
    const max = Math.max(...ctx.sections.map(s => s.tokens));
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '系统提示' }), el('span', { class: 'card-meta', text: `约 ${tokens(parts.system)}` })), el('ul', { class: 'bars' }, ctx.sections.slice().sort((a, b) => b.tokens - a.tokens).map((s, i) => {
      const bar = el('i'); bar.style.width = `${s.tokens / max * 100}%`; bar.style.animationDelay = `${i * 40}ms`; if (!animate) bar.style.animation = 'none';
      return el('li', {}, el('span', { text: s.name }), el('span', { class: 'v', text: tokens(s.tokens) }), el('div', { class: 'meter' }, bar));
    }))));
  }
  mount(box, cards);
}

function parseDiff(diff = '') {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.*)$/.exec(line); file = { path: m ? m[1] : line.slice(11), status: 'M', add: 0, del: 0, lines: [] }; files.push(file); continue; }
    if (!file) continue;
    if (line.startsWith('new file')) file.status = 'A';
    else if (line.startsWith('deleted file')) file.status = 'D';
    else if (line.startsWith('rename to ')) { file.path = line.slice(10); file.status = 'R'; }
    else if (line.startsWith('@@')) { const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line); oldLine = Number(m?.[1] || 0); newLine = Number(m?.[2] || 0); file.lines.push({ type: 'hunk', text: line }); }
    else if (/^(\+\+\+|---|index |similarity|rename from|old mode|new mode)/.test(line)) continue;
    else if (line.startsWith('+')) { file.add++; file.lines.push({ type: 'add', text: line.slice(1), n: newLine++ }); }
    else if (line.startsWith('-')) { file.del++; file.lines.push({ type: 'del', text: line.slice(1), o: oldLine++ }); }
    else if (line.startsWith(' ') || line === '') { if (file.lines.length) file.lines.push({ type: 'ctx', text: line.slice(1), o: oldLine++, n: newLine++ }); }
    else if (line.startsWith('Binary')) file.lines.push({ type: 'hunk', text: '二进制文件' });
  }
  return files;
}

function minibar(add, del) {
  const total = add + del;
  const box = el('span', { class: 'minibar' });
  const a = total ? Math.round(add / total * 5) : 0;
  const d = total ? Math.min(5 - a, Math.round(del / total * 5)) : 0;
  for (let i = 0; i < 5; i++) box.append(el('i', { class: i < a ? 'a' : i < a + d ? 'd' : '' }));
  return box;
}

function diffTable(file) {
  const body = el('tbody');
  const clip = text => text.length > 1000 ? `${text.slice(0, 1000)} …（本行还有 ${text.length - 1000} 字）` : text;
  for (const line of file.lines.slice(0, 1500)) {
    if (line.type === 'hunk') body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: line.text })));
    else body.append(el('tr', { class: line.type }, el('td', { class: 'ln', text: line.o ?? '' }), el('td', { class: 'ln', text: line.n ?? '' }), el('td', { class: 'code' }, el('span', { class: 'mk', text: line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }), clip(line.text))));
  }
  if (file.lines.length > 1500) body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: `还有 ${file.lines.length - 1500} 行未显示` })));
  return el('div', { class: 'dscroll' }, el('table', { class: 'dtable' }, body));
}

export async function loadChanges(id, state, apiFetch, force = false) {
  const cached = state.changes.get(id);
  if (!force && cached && (cached.loading || Date.now() - cached.at < 15000)) return;
  state.changes.set(id, { ...cached, loading: true });
  if (state.ptab === 'changes') renderChanges(state.detail, state, apiFetch, true);
  try {
    const result = await apiFetch(`/api/agents/${id}/changes`);
    state.changes.set(id, { result, files: parseDiff(result.diff), at: Date.now() });
  } catch (error) {
    state.changes.set(id, { error: error.message, at: Date.now() });
  }
  if (state.detail?.agent.id === id) {
    renderChanges(state.detail, state, apiFetch, true);
    renderHead(state.detail, pairTools(state.detail.agent.events), state);
  }
}

export function renderChanges(data, state, apiFetch, force = false) {
  if (!data) return;
  const box = $('#p-changes');
  const id = data.agent.id;
  const entry = state.changes.get(id);
  const key = JSON.stringify([id, entry?.at, entry?.loading, data.pullRequests?.length]);
  if (!force && box.dataset.key === key) return;
  box.dataset.key = key;
  if (!entry || (entry.loading && !entry.result)) {
    mount(box, el('section', { class: 'card' }, el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton w80' })), el('section', { class: 'card' }, el('div', { class: 'skeleton tall' })));
    return;
  }
  const refresh = el('button', { type: 'button', class: `btn small ghost ${entry.loading ? 'spinning' : ''}`, title: '重新读取', onclick: () => loadChanges(id, state, apiFetch, true) }, glyph(paths.refresh), '刷新');
  const cards = [];
  const prs = data.pullRequests || [];
  const r = entry.result;
  if (entry.error) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)), el('p', { class: 'muted', text: `读取失败：${entry.error}` })));
  else if (r.git === false) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)), el('p', { class: 'muted', text: '工作目录不是 Git 仓库，下面是对话里记录的编辑。' })));
  else {
    const add = entry.files.reduce((s, f) => s + f.add, 0);
    const del = entry.files.reduce((s, f) => s + f.del, 0);
    const sum = el('div', { class: 'sumbar' });
    const a = el('i', { class: 'a' }); a.style.flexGrow = add || 0;
    const d = el('i', { class: 'd' }); d.style.flexGrow = del || 0;
    sum.append(a, d);
    cards.push(el('section', { class: 'card' },
      el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)),
      el('div', { class: 'git-line' }, glyph(paths.repo), el('code', { text: r.repository?.split('/').pop() || r.cwd }), el('span', { class: 'muted', text: r.mode === 'worktree' ? '独立工作树' : '共享目录' })),
      el('div', { class: 'git-line' }, glyph(paths.branch), el('code', { text: r.branch || '当前分支' }), el('span', { class: 'muted', text: `基于 ${String(r.base).slice(0, 8)}` })),
      el('div', { class: 'git-line' }, glyph(paths.commit), el('span', { text: `${entry.files.length} 个文件` }), el('span', { class: 'diffstat muted' }, el('span', { class: 'plus', text: `+${add}` }), el('span', { class: 'minus', text: `−${del}` }))),
      (add + del) ? sum : null,
      r.note && r.mode !== 'worktree' ? el('p', { class: 'ctx-note', text: '共享目录：只看声明的文件范围，可能包含其他人的修改。' }) : null,
    ));
    if (r.commits?.length) {
      cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '提交' }), el('span', { class: 'card-meta', text: `${r.commits.length} 个` })), el('ul', { class: 'commits' }, r.commits.slice(0, 20).map(line => el('li', {}, el('i'), el('code', { text: line.slice(0, 7) }), el('span', { text: line.slice(8), title: line.slice(8) }))))));
    }
  }
  if (prs.length) {
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'PR 记录' }), el('span', { class: 'card-meta', text: `${prs.length} 个` })), el('ul', { class: 'prs' }, prs.slice().reverse().map(pr => el('li', {}, el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, el('span', { class: `pr-ico ${pr.merged ? 'merged' : ''}` }, glyph(pr.merged ? paths.merge : paths.pr)), el('span', { style: 'min-width:0;display:grid' }, el('b', { text: `#${pr.number}` }), el('span', { class: 'repo', text: pr.repo })), el('span', { class: 'state', text: pr.merged ? '已合并' : pr.created ? '已创建' : '已引用' })))))));
  }
  const files = r && r.git !== false ? entry.files : [...changedFiles(data)].map(([filePath, f]) => ({ path: filePath, status: 'M', add: f.add, del: f.del, lines: [] }));
  if (files.length) {
    const list = el('ul', { class: 'files' }, files.map((f, i) => {
      const slash = f.path.lastIndexOf('/');
      return el('li', {}, el('button', { type: 'button', title: f.path, onclick: () => { const target = box.querySelector(`[data-file="${i}"]`); if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } }, el('span', { class: `st ${f.status}`, text: f.status }), el('span', { class: 'fname' }, el('bdi', {}, el('span', { class: 'muted', text: f.path.slice(0, slash + 1) }), f.path.slice(slash + 1))), el('span', { class: 'diffstat' }, el('span', { class: 'plus', text: `+${f.add}` }), el('span', { class: 'minus', text: `−${f.del}` })), minibar(f.add, f.del)));
    }));
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '文件' }), el('span', { class: 'card-meta', text: `${files.length} 个` })), list));
  }
  if (r && r.git !== false && entry.files.length) {
    cards.push(el('section', { class: 'card', style: 'padding:10px' }, el('header', { class: 'card-head', style: 'padding:4px 5px 0' }, el('h3', { text: '差异' }), el('span', { class: 'card-meta', text: r.diffTruncated ? '内容较多，只显示前一部分' : '' })), entry.files.map((f, i) => {
      const node = el('details', { class: 'dfile', 'data-file': i }, el('summary', {}, glyph(paths.chevron), el('span', { text: f.path }), el('span', { class: 'diffstat' }, el('span', { class: 'plus', text: `+${f.add}` }), el('span', { class: 'minus', text: `−${f.del}` }))));
      node.open = i < 3 && f.lines.length < 400;
      node.addEventListener('toggle', () => { if (node.open && !node.querySelector('.dscroll')) node.append(diffTable(f)); });
      if (node.open) node.append(diffTable(f));
      return node;
    })));
  }
  if (!files.length && !prs.length && !entry.error) cards.push(el('section', { class: 'card empty-card' }, glyph(paths.empty), '没有发现改动。'));
  mount(box, cards);
}

export function renderToolsTab(tools) {
  const stats = new Map();
  for (const c of tools.calls) {
    const s = stats.get(c.name) || { name: c.name, count: 0, errors: 0, time: 0, timed: 0 };
    s.count++;
    if (c.isError) s.errors++;
    if (c.end != null) { s.time += c.end - c.start; s.timed++; }
    stats.set(c.name, s);
  }
  const rows = [...stats.values()].sort((a, b) => b.count - a.count);
  if (!rows.length) return [el('p', { class: 'records-empty', text: '还没有工具调用。' }), ''];
  const max = Math.max(1, ...rows.map(r => r.count));
  const meter = n => { const bar = el('i'); bar.style.width = `${n / max * 100}%`; return el('div', { class: 'meter' }, bar); };
  const summary = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '工具' }), el('th', { text: '次数' }), el('th', { class: 'num', text: '调用' }), el('th', { class: 'num', text: '失败' }), el('th', { class: 'num', text: '平均耗时' }), el('th', { class: 'num', text: '合计' }))), el('tbody', {}, rows.map(r => el('tr', {}, el('td', {}, el('code', { text: r.name })), el('td', {}, meter(r.count)), el('td', { class: 'num', text: r.count }), el('td', { class: `num ${r.errors ? 'bad' : ''}`, text: r.errors }), el('td', { class: 'num', text: r.timed ? shortDuration(r.time / r.timed) : '—' }), el('td', { class: 'num', text: r.timed ? shortDuration(r.time) : '—' })))));
  const recent = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '开始' }), el('th', { text: '工具' }), el('th', { text: '结果' }), el('th', { class: 'num', text: '耗时' }))), el('tbody', {}, tools.calls.slice(-40).reverse().map(c => el('tr', { class: c.isError ? 'err' : '' }, el('td', { class: 'mono', text: clock(c.start) }), el('td', {}, el('code', { text: c.name })), el('td', { class: c.isError ? 'bad' : '', text: c.end == null ? '进行中' : c.isError ? '失败' : '成功' }), c.end == null ? el('td', { class: 'num', 'data-since': c.start, text: shortDuration(Date.now() - c.start) }) : el('td', { class: 'num', text: shortDuration(c.end - c.start) })))));
  return [[summary, el('p', { class: 'section-title', text: '最近 40 次调用' }), recent], '根据最近 500 条事件统计；耗时从工具开始到结束事件计算。'];
}

export function renderEventsTab(agent, state, onToggle) {
  const toggle = el('input', { type: 'checkbox', checked: state.hideTools, onchange: event => { state.hideTools = event.target.checked; store.set('hideTools', state.hideTools); onToggle(); } });
  const events = (agent.events || []).filter(e => !state.hideTools || !e.type.startsWith('tool_execution')).slice(-200).reverse();
  const list = el('ul', { class: 'events', onclick: event => event.target.closest('li')?.classList.toggle('open') }, events.map(e => {
    const cls = e.type === 'question' ? 'question' : commTypes.has(e.type) ? 'comm' : badTypes.has(e.type) || e.isError ? 'bad' : e.type.startsWith('tool_') ? 'tool' : '';
    const text = e.question || e.message || e.error || e.text || e.reason || '';
    return el('li', {}, el('time', { title: fullDate(e.time), text: clock(e.time) }), el('span', { class: `type ${cls}`, text: eventTypes[e.type] || e.type }), el('div', { class: 'body' }, el('span', { class: 'seq', text: `#${e.sequence}` }), e.toolName ? el('code', { text: e.toolName }) : null, e.isError ? ' 失败' : null, text ? `${e.toolName ? ' · ' : ''}${text}` : null));
  }));
  return [[el('div', { class: 'subbar' }, el('label', {}, toggle, '隐藏工具事件')), events.length ? list : el('p', { class: 'records-empty', text: '暂时没有事件。' })], '最近 200 条状态与通信记录，最新在前。'];
}

export function renderResultTab(agent) {
  const text = agent.lastText || agent.recentMessage || '';
  const copy = el('button', { type: 'button', class: 'btn small', onclick: () => copyText(text, '已复制结果'), disabled: !text }, glyph(paths.copy), '复制结果');
  return [[el('div', { class: 'subbar' }, copy), text ? markdown(text) : el('p', { class: 'records-empty', text: '暂时没有模型结果。' })], '模型最近保存的回复。是否满足要求，仍需检查实际改动和测试。'];
}

export function renderInfoTab(agent) {
  const code = text => el('code', { text: text || '—' });
  const host = hostMeta(agentHost(agent));
  const sid = agentSessionId(agent);
  const cbText = agent.callback ? `${agent.callback.enabled ? '已开启' : '未开启'} · 已投递 seq ${agent.callback.antigravityDeliveredSeq || 0}${agent.callback.lastObservedBy ? `（${agent.callback.lastObservedBy}）` : ''}${agent.watcherActive ? ' · 监听活跃' : ''}` : '未启用回调';
  const rows = [
    ['身份', code(agent.id)],
    ['状态记录', `${labels[agent.recordedStatus] || agent.recordedStatus} · 控制进程${agent.controllerAlive ? '在线' : '不在线'}${agent.marked ? ' · 面板手动标记' : ''}`],
    ['父会话', sid ? `${host.label} · ${sid}` : '未绑定父会话编号'],
    ['回调状态', cbText],
    ['父会话目录', code(agent.parentInfo?.cwd)],
    ['工作目录', code(agent.cwd)],
    ['来源目录', code(agent.sourceCwd)],
    ['目录模式', agent.workspaceMode === 'worktree' ? '独立 Git 工作目录' : agent.workspaceMode || '—'],
    ['文件范围', agent.ownedPaths?.length ? el('ul', { class: 'paths' }, agent.ownedPaths.map(p => el('li', { text: p }))) : '未限定'],
    ['开始时间', fullDate(agent.createdAt)],
    ['更新时间', fullDate(agent.updatedAt)],
    ['模型', `${modelName(agent)} · 思考 ${agent.thinking || '默认'}${agent.contextWindow ? ` · 窗口 ${tokens(agent.contextWindow)}` : ''}`],
    ['用量明细', `输入 ${agent.usage?.input || 0} · 输出 ${agent.usage?.output || 0} · 缓存读 ${agent.usage?.cacheRead || 0} · 缓存写 ${agent.usage?.cacheWrite || 0}`],
  ];
  return [el('dl', { class: 'info' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)])), '上报费用来自模型服务的返回值，不等于真实扣费记录。'];
}
