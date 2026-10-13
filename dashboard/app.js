// Pi 调度台：只读查看本机会话。所有代理操作仍由所属聊天通过 MCP 完成。
const $ = selector => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';

/* ---------- 文案与分类 ---------- */
const labels = { starting: '正在启动', running: '运行中', waiting: '等待答复', finishing: '正在结束', idle: '空闲', completed: '已完成', failed: '失败', interrupted: '已中断', closed: '已关闭', disconnected: '控制进程离线' };
const order = ['running', 'starting', 'finishing', 'waiting', 'idle', 'completed', 'interrupted', 'failed', 'disconnected', 'closed'];
const colors = { running: '--run', starting: '--run', finishing: '--run', waiting: '--wait', idle: '--idle', completed: '--done', interrupted: '--idle', failed: '--fail', disconnected: '--off', closed: '--closed' };
const working = new Set(['starting', 'running', 'waiting', 'finishing']);
const groups = [
  { key: 'attention', title: '需要处理', match: s => ['waiting', 'failed', 'disconnected'].includes(s) },
  { key: 'working', title: '正在工作', match: s => ['starting', 'running', 'finishing'].includes(s) },
  { key: 'done', title: '已结束', match: s => ['idle', 'completed', 'interrupted'].includes(s) },
  { key: 'closed', title: '已关闭', match: s => s === 'closed' },
];
const filters = [
  { key: 'all', title: '全部', match: () => true },
  { key: 'working', title: '工作中', match: s => working.has(s) },
  { key: 'waiting', title: '待答复', match: s => s === 'waiting' },
  { key: 'completed', title: '已完成', match: s => s === 'completed' },
  { key: 'problem', title: '异常', match: s => s === 'failed' || s === 'disconnected' },
  { key: 'closed', title: '已关闭', match: s => s === 'closed' },
];
const eventTypes = { ready: '准备就绪', started: '开始执行', instruction: '收到任务', message_consumed: '消息已读入', question: '向父代理提问', answer: '父代理答复', message: '向父代理报告', tool_execution_start: '开始工具', tool_execution_end: '工具结束', settled: '本次执行结束', model_changed: '模型已更换', model_restored: '原模型已恢复', resumed: '会话已恢复', interrupted: '执行已中断', closed: '会话已关闭', process_failed: '进程失败', control_failed: '控制命令失败', extension_error: '扩展失败', question_cancelled: '问题已取消', instruction_failed: '任务发送失败' };
const commTypes = new Set(['instruction', 'message', 'question', 'answer', 'question_cancelled']);
const badTypes = new Set(['process_failed', 'control_failed', 'extension_error', 'instruction_failed', 'interrupted']);
const lifeTypes = new Set(['ready', 'started', 'settled', 'resumed', 'interrupted', 'closed', 'model_changed', 'model_restored', 'process_failed', 'control_failed', 'extension_error', 'instruction_failed']);
const notifyOn = { waiting: '在等待答复', failed: '执行失败', completed: '已完成', disconnected: '控制进程离线' };

/* ---------- 本机偏好（失败时使用默认值） ---------- */
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`pi-dash:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`pi-dash:${key}`, JSON.stringify(value)); } catch {} },
};
// Old token links still open the ordinary page. Authentication now stays in an HttpOnly cookie.
if (location.hash) history.replaceState(null, '', location.pathname);
try { sessionStorage.removeItem('pi-dashboard-token'); } catch {}

const state = {
  agents: [], selected: store.get('selected', ''), filter: store.get('filter', 'all'), collapsed: new Set(store.get('collapsed', ['closed'])),
  tab: store.get('tab', 'messages'), hideTools: store.get('hideTools', false), paused: false, fetching: false,
  detail: null, recordsKey: '', previous: new Map(), notify: store.get('notify', false), refreshedAt: null,
};

/* ---------- 小工具 ---------- */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
}
function svg(tag, attrs = {}) { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v); return node; }
const ms = value => value ? Date.parse(value) : NaN;
const clock = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const fullDate = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const modelName = agent => agent.model ? `${agent.model.provider || '未知服务'} / ${agent.model.model || '未知模型'}` : '未知模型';
function duration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const s = Math.floor(milliseconds / 1000); const h = Math.floor(s / 3600); const m = Math.floor(s % 3600 / 60); const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function shortDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60000)}m${Math.round(milliseconds % 60000 / 1000)}s`;
}
function ago(value) {
  const diff = Date.now() - ms(value); if (!Number.isFinite(diff)) return '—';
  if (diff < 10000) return '刚刚'; if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`; if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function tokens(n = 0) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); }
const cost = n => n ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : '$0';
function elapsedOf(agent) { const end = working.has(agent.status) ? Date.now() : ms(agent.updatedAt); return end - ms(agent.createdAt); }
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 1800); }
function showError(message) { $('#error').textContent = message; $('#error').hidden = !message; }

async function api(path) {
  const read = () => fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
  let response = await read();
  if (response.status === 401) {
    // Recover a viewer cookie after the independent dashboard service restarts; agent ownership is untouched.
    const bootstrap = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (bootstrap.ok) response = await read();
  }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `读取失败：${response.status}`); return result;
}

/* ---------- 顶栏：分布与合计 ---------- */
function renderOverview() {
  const counts = new Map(); for (const a of state.agents) counts.set(a.status, (counts.get(a.status) || 0) + 1);
  const dist = $('#dist'); dist.replaceChildren(); const legend = $('#legend'); legend.replaceChildren();
  for (const status of order) {
    const n = counts.get(status); if (!n) continue;
    const bar = el('i', { title: `${labels[status]} ${n}` }); bar.style.flexGrow = n; bar.style.background = `var(${colors[status]})`; dist.append(bar);
    const swatch = el('span', { class: 'swatch' }); swatch.style.background = `var(${colors[status]})`;
    legend.append(el('button', { type: 'button', 'aria-pressed': String(state.statusFilter === status), onclick: () => { state.statusFilter = state.statusFilter === status ? null : status; renderList(); renderOverview(); } }, swatch, labels[status], el('b', { text: n })));
  }
  if (!state.agents.length) legend.append(el('span', { text: '暂无会话' }));
  const sum = key => state.agents.reduce((total, a) => total + (a.usage?.[key] || 0), 0);
  $('#totals').replaceChildren(
    el('span', {}, '运行', el('b', { text: state.agents.filter(a => working.has(a.status)).length })),
    el('span', { title: '全部会话输入 + 输出 token' }, 'Token', el('b', { text: tokens(sum('input') + sum('output')) })),
    el('span', { title: '模型服务上报的费用，不是真实扣费记录' }, '上报费用', el('b', { text: cost(sum('reportedCost')) })));
  const waiting = counts.get('waiting') || 0;
  document.title = waiting ? `(${waiting} 待答复) Pi 调度台` : 'Pi 调度台';
}

/* ---------- 左侧会话列表 ---------- */
function sparkline(buckets = []) {
  const box = svg('svg', { class: 'spark', viewBox: '0 0 60 18', 'aria-hidden': 'true' });
  const max = Math.max(3, ...buckets);
  buckets.forEach((n, i) => { const h = n ? Math.max(2, n / max * 17) : 1; box.append(svg('rect', { x: i * 2, y: 18 - h, width: 1.4, height: h, rx: .5, class: n ? '' : 'zero' })); });
  return box;
}
function rowSubline(a) {
  if (a.questions.length) return el('span', { class: 'asking', text: `${a.questions.length} 个问题待答复` });
  if (a.currentTools.length) return el('span', { class: 'doing', text: `正在执行 ${a.currentTools.join('、')}` });
  return el('span', { text: modelName(a) });
}
function visibleAgents() {
  const query = $('#search').value.trim().toLowerCase();
  const filter = filters.find(f => f.key === state.filter) || filters[0];
  return state.agents.filter(a => filter.match(a.status) && (!state.statusFilter || a.status === state.statusFilter) &&
    (!query || `${a.name} ${modelName(a)} ${a.cwd} ${a.sourceCwd} ${a.id}`.toLowerCase().includes(query)));
}
function renderChips() {
  const chips = $('#chips'); chips.replaceChildren();
  for (const f of filters) chips.append(el('button', { type: 'button', 'aria-pressed': String(state.filter === f.key), onclick: () => { state.filter = f.key; store.set('filter', f.key); renderChips(); renderList(); } },
    f.title, el('span', { text: state.agents.filter(a => f.match(a.status)).length })));
}
function renderList() {
  const focused = document.activeElement?.dataset?.agent;
  const list = $('#list'); const scroll = list.scrollTop; list.replaceChildren();
  const visible = visibleAgents();
  const searching = $('#search').value.trim() || state.filter !== 'all' || state.statusFilter;
  for (const group of groups) {
    const members = visible.filter(a => group.match(a.status)); if (!members.length) continue;
    const open = searching || !state.collapsed.has(group.key);
    list.append(el('button', { type: 'button', class: 'group-head', 'aria-expanded': String(open), onclick: () => {
      state.collapsed.has(group.key) ? state.collapsed.delete(group.key) : state.collapsed.add(group.key); store.set('collapsed', [...state.collapsed]); renderList();
    } }, el('b', { text: `${group.title} · ${members.length}` }), el('span', { class: 'caret', text: '▾' })));
    if (!open) continue;
    for (const a of members) {
      const row = el('button', { type: 'button', class: 'row', 'data-agent': a.id, 'aria-current': String(a.id === state.selected), title: a.name,
        onclick: () => select(a.id) },
        el('span', { class: `dot ${a.status}` }), el('span', { class: 'name', text: a.name || a.id.slice(0, 8) }),
        el('span', { class: 'ago', 'data-ago': a.updatedAt, text: ago(a.updatedAt) }),
        el('span', { class: 'sub' }, rowSubline(a)), sparkline(a.activity?.buckets));
      list.append(row);
      if (focused === a.id) row.focus({ preventScroll: true });
    }
  }
  list.scrollTop = scroll;
  const empty = $('#empty'); empty.hidden = visible.length > 0;
  empty.textContent = state.agents.length ? '没有符合条件的会话，换个关键词或筛选试试。' : '还没有会话。通过 pi-subagents 创建子代理后会自动出现在这里。';
}
function select(id) {
  if (state.selected === id) return;
  state.selected = id; store.set('selected', id); state.recordsKey = ''; state.detail = null;
  renderList(); refreshDetail().catch(error => showError(error.message));
}
function moveSelection(step) {
  const rows = [...document.querySelectorAll('.row')]; if (!rows.length) return;
  const index = rows.findIndex(r => r.dataset.agent === state.selected);
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))]; select(next.dataset.agent); next.focus(); next.scrollIntoView({ block: 'nearest' });
}

/* ---------- 工具调用配对 ---------- */
function pairTools(events) {
  const open = new Map(); const calls = [];
  for (const e of events) {
    if (e.type === 'tool_execution_start') { const call = { id: e.toolCallId, name: e.toolName, start: ms(e.time), end: null, isError: false }; open.set(e.toolCallId, call); calls.push(call); }
    if (e.type === 'tool_execution_end') {
      const call = open.get(e.toolCallId);
      if (call) { call.end = ms(e.time); call.isError = !!e.isError; open.delete(e.toolCallId); }
      else calls.push({ id: e.toolCallId, name: e.toolName, start: ms(e.time), end: ms(e.time), isError: !!e.isError });
    }
  }
  return { calls, open: [...open.values()] };
}

/* ---------- 进度轨道 ---------- */
function renderLane(agent, tools) {
  const lane = $('#lane'); lane.replaceChildren();
  const width = Math.max(320, $('#lane-wrap').clientWidth); const height = 92; const left = 56;
  lane.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const events = agent.events || [];
  const start = Math.min(ms(agent.createdAt) || Infinity, ms(events[0]?.time) || Infinity);
  const live = working.has(agent.status);
  const end = Math.max(live ? Date.now() : 0, ms(agent.updatedAt) || 0, ms(events.at(-1)?.time) || 0, start + 1000);
  const x = t => left + (Math.min(Math.max(t, start), end) - start) / (end - start) * (width - left - 4);
  const rows = [['工具', 10], ['通信', 42], ['阶段', 68]];
  for (const [label, y] of rows) {
    lane.append(svg('rect', { x: left, y, width: width - left - 4, height: label === '工具' ? 22 : 14, rx: 4, class: 'lane-bg' }));
    const text = svg('text', { x: 0, y: y + (label === '工具' ? 15 : 11), class: 'lane-label' }); text.textContent = label; lane.append(text);
  }
  for (let i = 1; i < 4; i++) { const gx = left + (width - left - 4) * i / 4; lane.append(svg('line', { x1: gx, x2: gx, y1: 6, y2: height - 4, class: 'grid' })); }
  const tip = (node, text) => { node.setAttribute('data-tip', text); return node; };
  for (const call of tools.calls) {
    const x1 = x(call.start); const x2 = call.end == null ? x(end) : x(call.end);
    const cls = call.end == null ? 'seg open' : call.isError ? 'seg err' : 'seg';
    lane.append(tip(svg('rect', { x: x1, y: 12, width: Math.max(2, x2 - x1), height: 18, rx: 1.5, class: cls }),
      `${call.name}${call.isError ? ' · 失败' : ''}\n${clock(call.start)} · ${call.end == null ? `进行中 ${shortDuration(Date.now() - call.start)}` : shortDuration(call.end - call.start)}`));
  }
  for (const e of events) {
    const text = (e.question || e.message || e.text || e.error || '').slice(0, 140);
    if (commTypes.has(e.type)) lane.append(tip(svg('circle', { cx: x(ms(e.time)), cy: 49, r: 4.5, class: `comm ${e.type === 'question' ? 'question' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    else if (lifeTypes.has(e.type)) { const cx = x(ms(e.time)); lane.append(tip(svg('path', { d: `M${cx} 69 l4.5 6 l-4.5 6 l-4.5 -6 z`, class: `life ${badTypes.has(e.type) ? 'bad' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`)); }
  }
  if (live) lane.append(svg('line', { x1: x(end) - 1, x2: x(end) - 1, y1: 4, y2: height - 2, class: 'nowline' }));
  $('#axis-start').textContent = clock(start); $('#axis-mid').textContent = `跨度 ${duration(end - start)}`; $('#axis-end').textContent = live ? '现在' : clock(end);
}
function bindLaneTips() {
  const wrap = $('#lane-wrap'); const box = $('#tip');
  wrap.addEventListener('pointermove', event => {
    const target = event.target.closest?.('[data-tip]'); if (!target) { box.hidden = true; return; }
    const rect = wrap.getBoundingClientRect(); box.textContent = target.getAttribute('data-tip'); box.hidden = false;
    box.style.left = `${Math.min(rect.width - 150, Math.max(150, event.clientX - rect.left))}px`; box.style.top = `${event.clientY - rect.top}px`;
  });
  wrap.addEventListener('pointerleave', () => { box.hidden = true; });
}

/* ---------- 详情头部、数据与提醒 ---------- */
function renderHead(agent, tools) {
  const status = $('#d-status'); status.className = `status ${agent.status}`; status.replaceChildren(el('span', { class: `dot ${agent.status}` }), labels[agent.status] || agent.status);
  $('#d-name').textContent = agent.name || agent.id;
  const sub = [modelName(agent), `思考 ${agent.thinking || '默认'}`, agent.workspaceMode === 'worktree' ? '独立工作目录' : agent.workspaceMode === 'shared' ? '共享目录' : null].filter(Boolean).join(' · ');
  $('#d-model').textContent = agent.temporaryModel ? `${sub} · 临时模型，结束后恢复 ${modelName({ model: agent.temporaryModel.model || agent.temporaryModel })}` : sub;
  $('#d-elapsed').textContent = duration(elapsedOf(agent));
  const now = $('#d-now'); now.replaceChildren();
  if (tools.open.length && working.has(agent.status)) {
    const call = tools.open.at(-1);
    now.append('正在执行', el('span', { class: 'tool-chip', text: call.name }), el('span', { class: 'since', 'data-since': call.start, text: shortDuration(Date.now() - call.start) }), el('span', { class: 'bar' }));
  } else if (agent.status === 'waiting') now.append('暂停在提问上，等所属聊天用 reply_question 答复');
  else if (working.has(agent.status)) now.append('模型正在思考或生成回复', el('span', { class: 'bar' }));
  else {
    const last = agent.activity?.lastEvent;
    now.append(last ? `最后动作：${eventTypes[last.type] || last.type}${last.toolName ? ` ${last.toolName}` : ''} · ${ago(last.time)}` : '暂无动作');
  }
  const u = agent.usage || {}; const errors = tools.calls.filter(c => c.isError).length; const cacheBase = (u.input || 0) + (u.cacheRead || 0);
  const figures = [
    ['工具调用', tools.calls.length, errors ? `${errors} 失败` : null, errors > 0],
    ['输入 Token', tokens(u.input)], ['输出 Token', tokens(u.output)],
    ['缓存命中', tokens(u.cacheRead), cacheBase ? `${Math.round((u.cacheRead || 0) / cacheBase * 100)}%` : null],
    ['上报费用', cost(u.reportedCost)], ['事件序号', `#${agent.sequence ?? 0}`],
  ];
  $('#d-figures').replaceChildren(...figures.map(([name, value, extra, bad]) => el('div', {}, el('dt', { text: name }), el('dd', { class: bad ? 'bad' : '' }, String(value), extra ? el('small', { text: extra }) : null))));
  const alerts = $('#d-alerts'); alerts.replaceChildren();
  for (const q of agent.questions) alerts.append(el('div', { class: 'alert' }, el('strong', { text: `正在等待父代理答复 · ${ago(q.time)}` }), el('p', { text: q.question }), el('small', { text: `问题身份 ${q.questionId}` })));
  if (agent.error) alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '错误' }), el('p', { text: agent.error })));
  if (agent.status === 'disconnected') alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '控制进程已离线' }), el('p', { text: '记录停在运行状态，但管理进程已经不在。在所属聊天中用 list_agents(includeSaved=true) 和 resume_agent 恢复。' })));
  const report = $('#d-report'); report.hidden = !agent.recentMessage;
  if (report.querySelector('p').textContent !== (agent.recentMessage || '')) { report.querySelector('p').textContent = agent.recentMessage || ''; report.classList.remove('expanded'); }
}

/* ---------- 记录区 ---------- */
const roles = { user: '任务 / 指导', assistant: '模型回复', toolResult: '工具结果' };
function preview(argumentsText) {
  try { const args = JSON.parse(argumentsText); const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.message ?? Object.values(args).find(v => typeof v === 'string'); return typeof pick === 'string' ? pick.replace(/\s+/g, ' ') : argumentsText; }
  catch { return argumentsText; }
}
function prettyArgs(argumentsText) { try { return JSON.stringify(JSON.parse(argumentsText), null, 2); } catch { return argumentsText; } }
function collapsible(key, open, summary, body) { const d = el('details', { 'data-key': key }, el('summary', {}, ...summary), body); d.open = open; return d; }
function renderMessages(data, expanded) {
  const thread = el('div', { class: 'thread' });
  for (const m of [...data.messages].reverse()) {
    const isTool = m.role === 'toolResult';
    const item = el('article', { class: `msg ${m.role} ${m.isError ? 'error' : ''}` },
      el('div', { class: 'msg-head' }, el('strong', { text: roles[m.role] || m.role }), m.toolName ? el('span', { class: 'tool', text: m.toolName }) : null,
        m.isError ? el('span', { class: 'err', text: '失败' }) : null, el('time', { title: fullDate(m.time), text: clock(m.time) })));
    if (m.text) {
      if (isTool) { const key = `${data.agent.id}:${m.id}:text`; item.append(collapsible(key, expanded.get(key) ?? false, [el('span', { class: 'label', text: '查看输出' }), el('span', { class: 'preview', text: m.text.slice(0, 120).replace(/\s+/g, ' ') })], el('pre', { text: m.text }))); }
      else item.append(el('div', { class: 'text', text: m.text }));
    }
    m.calls.forEach((call, index) => {
      const key = `${data.agent.id}:${m.id}:call:${index}`;
      item.append(collapsible(key, expanded.get(key) ?? false, [el('span', { class: 'call-name', text: call.name }), el('span', { class: 'preview', text: preview(call.arguments) })], el('pre', { text: prettyArgs(call.arguments) })));
    });
    thread.append(item);
  }
  return [thread, data.transcriptError ? `会话内容暂时无法读取：${data.transcriptError}` : '最近 50 条已保存内容，最新在前。模型尚未保存的逐字输出不在这里显示。'];
}
function renderTools(tools) {
  const stats = new Map();
  for (const c of tools.calls) {
    const s = stats.get(c.name) || { name: c.name, count: 0, errors: 0, time: 0, timed: 0 }; s.count++; if (c.isError) s.errors++;
    if (c.end != null) { s.time += c.end - c.start; s.timed++; } stats.set(c.name, s);
  }
  const rows = [...stats.values()].sort((a, b) => b.count - a.count); const max = Math.max(1, ...rows.map(r => r.count));
  const meter = n => { const bar = el('i'); bar.style.width = `${n / max * 100}%`; return el('div', { class: 'meter' }, bar); };
  const summary = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '工具' }), el('th', { text: '次数' }), el('th', { class: 'num', text: '调用' }), el('th', { class: 'num', text: '失败' }), el('th', { class: 'num', text: '平均耗时' }), el('th', { class: 'num', text: '合计' }))),
    el('tbody', {}, rows.map(r => el('tr', {}, el('td', {}, el('code', { text: r.name })), el('td', {}, meter(r.count)), el('td', { class: 'num', text: r.count }), el('td', { class: `num ${r.errors ? 'bad' : ''}`, text: r.errors }), el('td', { class: 'num', text: r.timed ? shortDuration(r.time / r.timed) : '—' }), el('td', { class: 'num', text: r.timed ? shortDuration(r.time) : '—' })))));
  const recent = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '开始' }), el('th', { text: '工具' }), el('th', { text: '结果' }), el('th', { class: 'num', text: '耗时' }))),
    el('tbody', {}, tools.calls.slice(-40).reverse().map(c => el('tr', { class: c.isError ? 'err' : '' }, el('td', { class: 'mono', text: clock(c.start) }), el('td', {}, el('code', { text: c.name })),
      el('td', { class: c.isError ? 'bad' : '', text: c.end == null ? '进行中' : c.isError ? '失败' : '成功' }), c.end == null ? el('td', { class: 'num', 'data-since': c.start, text: shortDuration(Date.now() - c.start) }) : el('td', { class: 'num', text: shortDuration(c.end - c.start) })))));
  if (!rows.length) return [el('p', { class: 'records-empty', text: '还没有工具调用。' }), ''];
  return [[summary, el('p', { class: 'section-title', text: '最近 40 次调用' }), recent], '根据最近 500 条事件统计；耗时从工具开始到结束事件计算。'];
}
function renderEvents(agent) {
  const toggle = el('input', { type: 'checkbox', onchange: event => { state.hideTools = event.target.checked; store.set('hideTools', state.hideTools); state.recordsKey = ''; renderRecords(); } }); toggle.checked = state.hideTools;
  const events = agent.events.filter(e => !state.hideTools || !e.type.startsWith('tool_execution')).slice(-200).reverse();
  const list = el('ul', { class: 'events', onclick: event => event.target.closest('li')?.classList.toggle('open') }, events.map(e => {
    const cls = e.type === 'question' ? 'question' : commTypes.has(e.type) ? 'comm' : badTypes.has(e.type) || e.isError ? 'bad' : e.type.startsWith('tool_') ? 'tool' : '';
    const text = e.question || e.message || e.error || e.text || '';
    return el('li', {}, el('time', { title: fullDate(e.time), text: clock(e.time) }), el('span', { class: `type ${cls}`, text: eventTypes[e.type] || e.type }),
      el('div', { class: 'body' }, el('span', { class: 'seq', text: `#${e.sequence}` }), e.toolName ? el('code', { text: e.toolName }) : null, e.isError ? ' 失败' : null, text ? `${e.toolName ? ' · ' : ''}${text}` : null));
  }));
  return [[el('div', { class: 'subbar' }, el('label', {}, toggle, '隐藏工具事件')), events.length ? list : el('p', { class: 'records-empty', text: '暂时没有事件。' })], '最近 200 条状态与通信记录，最新在前。'];
}
function renderResult(agent) {
  const copy = el('button', { type: 'button', class: 'pill-btn', onclick: () => copyText(agent.lastText || '', '已复制结果'), disabled: !agent.lastText });
  copy.textContent = '复制结果';
  return [[el('div', { class: 'subbar' }, copy), el('pre', { class: 'plain', text: agent.lastText || '暂时没有模型结果。' })], '模型最近保存的回复。是否满足要求，仍需检查实际改动和测试。'];
}
function renderInfo(agent) {
  const code = text => el('code', { text: text || '—' });
  const rows = [['身份', code(agent.id)], ['状态记录', `${labels[agent.recordedStatus] || agent.recordedStatus} · 控制进程${agent.controllerAlive ? '在线' : '不在线'}`],
    ['工作目录', code(agent.cwd)], ['来源目录', code(agent.sourceCwd)], ['目录模式', agent.workspaceMode === 'worktree' ? '独立 Git 工作目录' : agent.workspaceMode || '—'],
    ['文件范围', agent.ownedPaths?.length ? el('ul', { class: 'paths' }, agent.ownedPaths.map(p => el('li', { text: p }))) : '未限定'],
    ['开始时间', fullDate(agent.createdAt)], ['更新时间', fullDate(agent.updatedAt)], ['模型', `${modelName(agent)} · 思考 ${agent.thinking || '默认'}`],
    ['用量明细', `输入 ${agent.usage?.input || 0} · 输出 ${agent.usage?.output || 0} · 缓存读 ${agent.usage?.cacheRead || 0} · 缓存写 ${agent.usage?.cacheWrite || 0}`]];
  return [el('dl', { class: 'info' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)])), '上报费用来自模型服务的返回值，不等于真实扣费记录。'];
}
function renderRecords() {
  const data = state.detail; if (!data) return;
  const records = $('#records');
  const key = JSON.stringify([state.tab, state.hideTools, data.agent.sequence, data.agent.status, data.messages.length, data.messages.at(-1)?.id, data.transcriptError, data.agent.lastText?.length]);
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  if (key === state.recordsKey) return; state.recordsKey = key;
  const expanded = new Map([...records.querySelectorAll('details')].map(node => [node.dataset.key, node.open]));
  const pane = $('#detail-pane'); const scroll = pane.scrollTop; const tools = pairTools(data.agent.events);
  const [content, note] = state.tab === 'messages' ? renderMessages(data, expanded) : state.tab === 'tools' ? renderTools(tools) : state.tab === 'events' ? renderEvents(data.agent) : state.tab === 'result' ? renderResult(data.agent) : renderInfo(data.agent);
  records.replaceChildren(...[content].flat());
  if (state.tab === 'messages' && !data.messages.length) records.replaceChildren(el('p', { class: 'records-empty', text: '暂时没有已保存的执行记录。' }));
  $('#record-note').textContent = note; pane.scrollTop = scroll;
}

/* ---------- 刷新 ---------- */
async function refreshDetail() {
  if (!state.selected) return;
  const requested = state.selected; const data = await api(`/api/agents/${requested}`); if (state.selected !== requested) return;
  state.detail = data; const tools = pairTools(data.agent.events);
  $('#placeholder').hidden = true; $('#detail').hidden = false;
  renderHead(data.agent, tools); renderLane(data.agent, tools); renderRecords();
}
function notifyChanges() {
  for (const a of state.agents) {
    const before = state.previous.get(a.id);
    if (state.notify && before && before !== a.status && notifyOn[a.status] && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${a.name || a.id.slice(0, 8)} ${notifyOn[a.status]}`, { body: modelName(a), tag: `${a.id}:${a.status}` });
      n.onclick = () => { window.focus(); select(a.id); };
    }
    state.previous.set(a.id, a.status);
  }
}
async function refresh() {
  if (state.fetching || state.paused) return; state.fetching = true;
  try {
    const result = await api('/api/agents'); state.agents = result.agents; state.refreshedAt = result.refreshedAt;
    if (!state.agents.some(a => a.id === state.selected)) {
      const pick = state.agents.find(a => a.status === 'waiting') || state.agents.find(a => working.has(a.status)) || state.agents.find(a => a.status !== 'closed') || state.agents[0];
      state.selected = pick?.id || ''; state.recordsKey = '';
    }
    notifyChanges(); renderOverview(); renderChips(); renderList();
    if (state.selected) await refreshDetail();
    else { $('#detail').hidden = true; $('#placeholder').hidden = false; $('#placeholder-text').textContent = '还没有会话。创建子代理后，这里会实时显示它的进度。'; }
    $('#live').className = 'live'; $('#connection').textContent = `已更新 ${clock(result.refreshedAt)}`;
    showError(result.errors.length ? `${result.errors.length} 个会话读取失败：${result.errors.map(e => `${e.id.slice(0, 8)} ${e.error}`).join('；')}` : '');
  } catch (error) { $('#live').className = 'live failed'; $('#connection').textContent = '更新失败 · 保留上次数据'; showError(error.message); }
  finally { state.fetching = false; }
}
function tick() {
  for (const node of document.querySelectorAll('[data-ago]')) node.textContent = ago(node.dataset.ago);
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = shortDuration(Date.now() - Number(node.dataset.since));
  const agent = state.detail?.agent; if (agent && working.has(agent.status)) $('#d-elapsed').textContent = duration(elapsedOf(agent));
}

/* ---------- 交互 ---------- */
async function copyText(text, message) { try { await navigator.clipboard.writeText(text); toast(message); } catch { toast('复制失败，请手动选择'); } }
function setPaused(value) {
  state.paused = value; const button = $('#pause'); button.textContent = value ? '继续' : '暂停'; button.classList.toggle('active', value);
  if (value) { $('#live').className = 'live paused'; $('#connection').textContent = '已暂停'; } else refresh();
}
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  if (!theme && matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
}
function syncNotifyButton() { $('#notify').setAttribute('aria-pressed', String(state.notify)); $('#notify').title = state.notify ? '状态提醒已开启' : '状态变化时提醒'; }

applyTheme(store.get('theme', null));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', null)));
$('#theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', next); applyTheme(next); if (state.detail) renderLane(state.detail.agent, pairTools(state.detail.agent.events)); });
$('#notify').addEventListener('click', async () => {
  if (!state.notify && 'Notification' in window && Notification.permission !== 'granted') {
    if (await Notification.requestPermission() !== 'granted') { toast('浏览器没有允许通知'); return; }
  }
  if (!('Notification' in window)) { toast('当前浏览器不支持通知'); return; }
  state.notify = !state.notify; store.set('notify', state.notify); syncNotifyButton(); toast(state.notify ? '会话等待、完成或失败时会提醒你' : '已关闭提醒');
});
$('#d-report').addEventListener('click', () => $('#d-report').classList.toggle('expanded'));
$('#pause').addEventListener('click', () => setPaused(!state.paused));
$('#search').addEventListener('input', renderList);
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { state.tab = button.dataset.tab; store.set('tab', state.tab); state.recordsKey = ''; renderRecords(); });
for (const button of document.querySelectorAll('[data-copy]')) button.addEventListener('click', () => {
  const agent = state.detail?.agent; if (!agent) return;
  button.dataset.copy === 'id' ? copyText(agent.id, '已复制会话身份') : copyText(agent.cwd || '', '已复制工作目录');
});
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape' && event.target.id === 'search') { event.target.value = ''; event.target.blur(); renderList(); return; }
  if (typing) return;
  if (event.key === '/') { event.preventDefault(); $('#search').focus(); }
  else if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
  else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
  else if (event.key === 'p') setPaused(!state.paused);
});
new ResizeObserver(() => { if (state.detail) renderLane(state.detail.agent, pairTools(state.detail.agent.events)); }).observe($('#lane-wrap'));
window.addEventListener('hashchange', () => { history.replaceState(null, '', location.pathname); setPaused(false); });
bindLaneTips(); syncNotifyButton();
refresh(); setInterval(refresh, 2000); setInterval(tick, 1000);
