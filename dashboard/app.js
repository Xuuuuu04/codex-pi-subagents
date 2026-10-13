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
  detail: null, recordsKey: '', previous: new Map(), notify: store.get('notify', false), refreshedAt: null, panel: store.get('panel', null),
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
function elapsedOf(agent) { const end = working.has(agent.status) ? Date.now() : ms(agent.activity?.lastWorkAt || agent.updatedAt); return end - ms(agent.createdAt); }
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

/* ---------- 左下角：分布与合计 ---------- */
function combinedSpeed() {
  const recent = state.agents.filter(a => working.has(a.status) && a.speed && Date.now() - ms(a.speed.at) < 180000);
  return recent.length ? `${Math.round(recent.reduce((sum, a) => sum + a.speed.tps, 0))}/s` : '—';
}
function renderOverview() {
  const counts = new Map(); for (const a of state.agents) counts.set(a.status, (counts.get(a.status) || 0) + 1);
  const dist = $('#dist'); dist.replaceChildren();
  for (const status of order) {
    const n = counts.get(status); if (!n) continue;
    const bar = el('i', { title: `${labels[status]} ${n}` }); bar.style.flexGrow = n; bar.style.background = `var(${colors[status]})`; dist.append(bar);
  }
  const sum = key => state.agents.reduce((total, a) => total + (a.usage?.[key] || 0), 0);
  $('#totals').replaceChildren(
    el('span', {}, '运行', el('b', { text: state.agents.filter(a => working.has(a.status)).length })),
    el('span', { title: '全部会话输入 + 输出 token' }, 'Token', el('b', { text: tokens(sum('input') + sum('output')) })),
    el('span', { title: '模型服务上报的费用，不是真实扣费记录' }, '上报', el('b', { text: cost(sum('reportedCost')) })),
    el('span', { title: '工作中会话最近一次请求的输出速度之和' }, '速度', el('b', { text: combinedSpeed() })));
  const waiting = counts.get('waiting') || 0;
  document.title = waiting ? `(${waiting} 待答复) Pi 调度台` : 'Pi 调度台';
}

/* ---------- 左侧会话列表 ---------- */
function indicator(a) {
  if (working.has(a.status) && a.status !== 'waiting') return el('span', { class: 'spin', title: labels[a.status] });
  if (a.status === 'waiting') return el('span', { class: 'dot waiting', title: '等待答复' });
  if (a.status === 'failed' || a.status === 'disconnected') return el('span', { class: 'bang', text: '!', title: labels[a.status] });
  if (a.status === 'completed') { const box = svg('svg', { class: 'check', viewBox: '0 0 16 16' }); box.append(svg('path', { d: 'M3 8.5l3 3 7-7' })); return box; }
  return null;
}
function visibleAgents() {
  const query = $('#search').value.trim().toLowerCase();
  const filter = filters.find(f => f.key === state.filter) || filters[0];
  return state.agents.filter(a => filter.match(a.status) && (!query || `${a.name} ${modelName(a)} ${a.cwd} ${a.sourceCwd} ${a.id}`.toLowerCase().includes(query)));
}
function renderChips() {
  const chips = $('#chips'); chips.replaceChildren();
  for (const f of filters) chips.append(el('button', { type: 'button', 'aria-pressed': String(state.filter === f.key), onclick: () => { state.filter = f.key; store.set('filter', f.key); renderChips(); renderList(); } },
    f.title, el('span', { text: state.agents.filter(a => f.match(a.status)).length })));
}
function renderList() {
  const focused = document.activeElement?.dataset?.agent;
  const list = $('#list'); const scroll = list.scrollTop; list.replaceChildren();
  const visible = visibleAgents(); const searching = $('#search').value.trim() || state.filter !== 'all';
  for (const group of groups) {
    const members = visible.filter(a => group.match(a.status)); if (!members.length) continue;
    const open = searching || !state.collapsed.has(group.key);
    list.append(el('button', { type: 'button', class: 'group-head', 'aria-expanded': String(open), onclick: () => {
      state.collapsed.has(group.key) ? state.collapsed.delete(group.key) : state.collapsed.add(group.key); store.set('collapsed', [...state.collapsed]); renderList();
    } }, el('span', { class: 'caret', text: '▾' }), `${group.title}`, el('span', { text: members.length })));
    if (!open) continue;
    for (const a of members) {
      const row = el('button', { type: 'button', class: `row ${a.status === 'closed' ? 'closed' : ''}`, 'data-agent': a.id, 'aria-current': String(a.id === state.selected),
        title: `${a.name}\n${modelName(a)} · ${labels[a.status] || a.status}`, onclick: () => select(a.id) },
        el('span', { class: 'name', text: a.name || a.id.slice(0, 8) }), el('span', { class: 'ago', 'data-ago': a.updatedAt, text: ago(a.updatedAt) }), el('span', { class: 'ind' }, indicator(a)));
      list.append(row);
      if (focused === a.id) row.focus({ preventScroll: true });
    }
  }
  list.scrollTop = scroll;
  const empty = $('#empty'); empty.hidden = visible.length > 0;
  empty.textContent = state.agents.length ? '没有符合条件的会话' : '还没有会话。创建子代理后会出现在这里。';
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
  const width = Math.max(200, $('#lane-wrap').clientWidth); const height = 70; const left = 0;
  lane.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const events = agent.events || [];
  const start = Math.min(ms(agent.createdAt) || Infinity, ms(events[0]?.time) || Infinity);
  const live = working.has(agent.status);
  const end = Math.max(live ? Date.now() : 0, ms(agent.activity?.lastWorkAt || agent.updatedAt) || 0, start + 1000);
  const x = t => left + (Math.min(Math.max(t, start), end) - start) / (end - start) * (width - left - 4);
  for (const [y, h] of [[4, 22], [32, 14], [52, 14]]) lane.append(svg('rect', { x: left, y, width: width - left - 4, height: h, rx: 4, class: 'lane-bg' }));
  for (let i = 1; i < 4; i++) { const gx = left + (width - left - 4) * i / 4; lane.append(svg('line', { x1: gx, x2: gx, y1: 2, y2: height - 2, class: 'grid' })); }
  const tip = (node, text) => { node.setAttribute('data-tip', text); return node; };
  for (const call of tools.calls) {
    const x1 = x(call.start); const x2 = call.end == null ? x(end) : x(call.end);
    const cls = call.end == null ? 'seg open' : call.isError ? 'seg err' : 'seg';
    lane.append(tip(svg('rect', { x: x1, y: 6, width: Math.max(2, x2 - x1), height: 18, rx: 1.5, class: cls }),
      `${call.name}${call.isError ? ' · 失败' : ''}\n${clock(call.start)} · ${call.end == null ? `进行中 ${shortDuration(Date.now() - call.start)}` : shortDuration(call.end - call.start)}`));
  }
  for (const e of events) {
    const text = (e.question || e.message || e.text || e.error || '').slice(0, 140);
    if (commTypes.has(e.type)) lane.append(tip(svg('circle', { cx: x(ms(e.time)), cy: 39, r: 4, class: `comm ${e.type === 'question' ? 'question' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    else if (lifeTypes.has(e.type)) { const cx = x(ms(e.time)); lane.append(tip(svg('path', { d: `M${cx} 53 l4.5 6 l-4.5 6 l-4.5 -6 z`, class: `life ${badTypes.has(e.type) ? 'bad' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`)); }
  }
  if (live) lane.append(svg('line', { x1: x(end) - 1, x2: x(end) - 1, y1: 4, y2: height - 2, class: 'nowline' }));
  $('#axis-start').textContent = clock(start); $('#axis-mid').textContent = `跨度 ${duration(end - start)}`; $('#axis-end').textContent = live ? '现在' : clock(end);
}
function bindLaneTips() {
  const wrap = $('#lane-wrap'); const box = $('#tip');
  wrap.addEventListener('pointermove', event => {
    const target = event.target.closest?.('[data-tip]'); if (!target) { box.hidden = true; return; }
    const rect = wrap.getBoundingClientRect(); box.textContent = target.getAttribute('data-tip'); box.hidden = false;
    box.style.left = `${Math.min(rect.width - 110, Math.max(110, event.clientX - rect.left))}px`; box.style.top = `${event.clientY - rect.top}px`;
  });
  wrap.addEventListener('pointerleave', () => { box.hidden = true; });
}

/* ---------- 标题、右侧面板与底部状态条 ---------- */
function changedFiles(data) {
  const results = new Map(data.messages.filter(m => m.role === 'toolResult').map(m => [m.toolCallId, m])); const files = new Map();
  for (const m of data.messages) for (const call of m.calls || []) {
    const result = results.get(call.id); if (!result || result.isError || !['edit', 'write'].includes(call.name)) continue;
    const stats = result.diff ? diffStats(result.diff) : { add: String(call.arguments?.content || '').split('\n').length, del: 0 };
    const name = call.arguments?.path || call.arguments?.file_path || '?'; const total = files.get(name) || { add: 0, del: 0 };
    files.set(name, { add: total.add + stats.add, del: total.del + stats.del });
  }
  return files;
}
function renderHead(data, tools) {
  const agent = data.agent;
  $('#d-dot').className = `dot ${agent.status}`; $('#d-name').textContent = agent.name || agent.id; $('#d-model').textContent = modelName(agent);
  // Status block
  const sub = [`思考 ${agent.thinking || '默认'}`, agent.workspaceMode === 'worktree' ? '独立工作目录' : agent.workspaceMode === 'shared' ? '共享目录' : null,
    agent.temporaryModel ? `临时模型，结束后恢复 ${modelName({ model: agent.temporaryModel.model || agent.temporaryModel })}` : null].filter(Boolean).join(' · ');
  $('#p-status').replaceChildren(el('div', { class: 'line' }, el('span', { class: `dot ${agent.status}` }), labels[agent.status] || agent.status, el('span', { class: 'muted', text: `· ${ago(agent.updatedAt)}` })),
    el('div', { class: 'big', id: 'p-elapsed', text: duration(elapsedOf(agent)) }), el('div', { class: 'sub', text: `${modelName(agent)} · ${sub}` }));
  // Usage
  const u = agent.usage || {}; const errors = tools.calls.filter(c => c.isError).length; const cacheBase = (u.input || 0) + (u.cacheRead || 0);
  const figures = [['工具调用', tools.calls.length, errors ? `${errors} 失败` : null, errors > 0], ['上报费用', cost(u.reportedCost)],
    ['输入', tokens(u.input)], ['输出', tokens(u.output)], ['缓存命中', tokens(u.cacheRead), cacheBase ? `${Math.round((u.cacheRead || 0) / cacheBase * 100)}%` : null], ['事件', `#${agent.sequence ?? 0}`]];
  $('#d-figures').replaceChildren(...figures.map(([name, value, extra, bad]) => el('div', {}, el('dt', { text: name }), el('dd', { class: bad ? 'bad' : '' }, String(value), extra ? el('small', { text: extra }) : null))));
  // Changed files
  const files = changedFiles(data); $('#p-files-wrap').hidden = !files.size;
  $('#p-files').replaceChildren(...[...files].map(([name, f]) => el('li', { title: name }, el('span', { text: name.split('/').slice(-2).join('/') }), el('b', { class: 'plus', text: `+${f.add}` }), el('b', { class: 'minus', text: `-${f.del}` }))));
  const report = $('#d-report'); report.hidden = !agent.recentMessage; const reportText = report.querySelector('p');
  if (reportText.textContent !== (agent.recentMessage || '')) { reportText.textContent = agent.recentMessage || ''; reportText.classList.remove('expanded'); }
  // Dock: alerts and the one-line live status
  const alerts = $('#d-alerts'); alerts.replaceChildren();
  for (const q of agent.questions) alerts.append(el('div', { class: 'alert' }, el('strong', { text: `等待父代理答复 · ${ago(q.time)}` }), el('p', { text: q.question }), el('small', { text: `问题身份 ${q.questionId}` })));
  if (agent.error) alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '错误' }), el('p', { text: agent.error })));
  if (agent.status === 'disconnected') alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '控制进程已离线' }), el('p', { text: '在所属聊天中用 list_agents(includeSaved=true) 和 resume_agent 恢复。' })));
  const bar = $('#d-now'); bar.className = `dock-bar ${['failed', 'disconnected'].includes(agent.status) ? 'bad' : ''}`; bar.replaceChildren();
  const clockNode = el('span', { class: 'clock' }, el('small', { text: working.has(agent.status) ? '已用时' : '总用时' }), el('span', { id: 'd-elapsed', text: duration(elapsedOf(agent)) }));
  if (tools.open.length && working.has(agent.status)) {
    const call = tools.open.at(-1);
    bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow' }, '正在执行 ', el('code', { text: call.name }), ' ', el('span', { class: 'muted', 'data-since': call.start, text: shortDuration(Date.now() - call.start) })), clockNode);
  } else if (agent.status === 'waiting') bar.append(el('span', { class: 'dot waiting' }), el('span', { class: 'grow', text: '暂停在提问上，等所属聊天答复' }), clockNode);
  else if (working.has(agent.status)) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow shimmer', text: data.live?.message?.blocks?.some(b => b?.type === 'text') ? '正在回复' : '正在思考' }), clockNode);
  else {
    const last = agent.activity?.lastEvent;
    bar.append(el('span', { class: `dot ${agent.status}` }), el('span', { class: 'grow', text: `${labels[agent.status] || agent.status}${last ? ` · 最后动作 ${eventTypes[last.type] || last.type}${last.toolName ? ` ${last.toolName}` : ''} · ${ago(last.time)}` : ''}` }), clockNode);
  }
  $('#dock').hidden = false;
}

/* ---------- 中间内容区 ---------- */
function conversationTab(data, expanded) {
  const note = data.transcriptError ? `会话内容暂时无法读取：${data.transcriptError}` :
    data.live ? '正在逐字同步模型输出与工具输出' : `显示最近 ${data.messages.length} 条已保存内容`;
  return [renderConversation(data, expanded), note];
}
const nearBottom = box => box.scrollHeight - box.scrollTop - box.clientHeight < 120;
function syncJump() { const box = $('#scroller'); $('#jump').hidden = state.tab !== 'messages' || nearBottom(box); }
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
  const records = $('#records'); const box = $('#scroller');
  const key = JSON.stringify([state.tab, state.hideTools, data.agent.sequence, data.agent.status, data.messages.length, data.messages.at(-1)?.id, data.live?.updatedAt, data.transcriptError, data.agent.lastText?.length]);
  for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  if (key === state.recordsKey) return; state.recordsKey = key;
  const expanded = new Map([...[...records.querySelectorAll('details')].map(node => [node.dataset.key, node.open]),
    ...[...records.querySelectorAll('.bubble[data-key]')].map(node => [node.dataset.key, !node.classList.contains('clamped')])]);
  const view = `${data.agent.id}:${state.tab}`; const fresh = state.renderedView !== view; state.renderedView = view;
  // Stick to the bottom like a chat: follow new output unless the reader scrolled up to look at something.
  const follow = state.tab === 'messages' && (fresh || nearBottom(box)); const scroll = box.scrollTop;
  const tools = pairTools(data.agent.events);
  const [content, note] = state.tab === 'messages' ? conversationTab(data, expanded) : state.tab === 'tools' ? renderTools(tools) : state.tab === 'events' ? renderEvents(data.agent) : state.tab === 'result' ? renderResult(data.agent) : renderInfo(data.agent);
  records.replaceChildren(...[content].flat());
  $('#record-note').textContent = note;
  box.scrollTop = follow ? box.scrollHeight : fresh ? 0 : scroll;
  syncJump();
}

/* ---------- 刷新 ---------- */
/* ---------- Token 速度 ---------- */
// 正在生成时用逐字镜像的增长估算，结束后用会话记录里的实测值；估算按中文约 1.3 字、其他约 3.8 字符一个 token。
const speedState = { agent: '', message: '', last: null, rate: 0, history: [] };
function estimateTokens(text) { let cjk = 0; for (const ch of text) if (/[　-鿿＀-￯]/.test(ch)) cjk++; return cjk / 1.3 + (text.length - cjk) / 3.8; }
function liveTokens(live) { return (live?.message?.blocks || []).reduce((sum, block) => sum + (block?.text ? estimateTokens(block.text) : 0), 0); }
function sampleLive(data) {
  const now = Date.now(); const id = data.agent.id; const message = data.live?.message?.startedAt || '';
  if (speedState.agent !== id) Object.assign(speedState, { agent: id, message: '', last: null, rate: 0, history: [] });
  if (!message) { speedState.message = ''; speedState.last = null; speedState.rate = 0; return null; }
  const total = liveTokens(data.live);
  if (speedState.message !== message || !speedState.last) { Object.assign(speedState, { message, last: { total, time: now }, rate: 0 }); return 0; }
  const seconds = (now - speedState.last.time) / 1000;
  if (seconds >= 0.5) {
    const instant = Math.max(0, (total - speedState.last.total) / seconds);
    speedState.rate = speedState.rate ? speedState.rate * 0.5 + instant * 0.5 : instant;
    speedState.last = { total, time: now };
    speedState.history.push({ time: now, rate: speedState.rate }); speedState.history = speedState.history.filter(item => now - item.time < 120000);
  }
  return speedState.rate;
}
function speedChart(speeds) {
  const width = 280, height = 64, chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'speed-chart', role: 'img', 'aria-label': '最近每次请求的输出速度' });
  if (!speeds.length) return chart;
  const top = Math.max(10, ...speeds.map(item => item.tps)) * 1.1; const gap = 2; const bar = Math.max(3, (width - gap * (speeds.length - 1)) / speeds.length);
  speeds.forEach((item, index) => {
    const h = Math.max(2, item.tps / top * (height - 4));
    const rect = svg('rect', { x: index * (bar + gap), y: height - h, width: bar, height: h, rx: 1.5, class: index === speeds.length - 1 ? 'last' : '' });
    const title = svg('title'); title.textContent = `${item.tps} tok/s · ${item.output} token · ${item.seconds} 秒 · ${ago(item.at)}`; rect.append(title); chart.append(rect);
  });
  const average = speeds.reduce((sum, item) => sum + item.tps, 0) / speeds.length;
  chart.append(svg('line', { x1: 0, x2: width, y1: height - average / top * (height - 4), y2: height - average / top * (height - 4), class: 'avg' }));
  return chart;
}
// 新启动的子代理带速度计：服务端在速度文件变化时立刻推送，这里逐帧重画；旧子代理继续用上面的估算。
const meterState = { id: '', source: null, data: null };
function subscribeSpeed(id) {
  if (meterState.id === id) return;
  meterState.source?.close(); Object.assign(meterState, { id, source: null, data: null });
  if (!id || typeof EventSource === 'undefined') return;
  const source = new EventSource(`/api/agents/${id}/speed`, { withCredentials: true });
  source.onmessage = event => { try { meterState.data = JSON.parse(event.data); if (state.detail?.agent.id === id) drawSpeed(); } catch {} };
  meterState.source = source;
}
function liveChart(series) {
  const width = 280, height = 46, chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'speed-live', role: 'img', 'aria-label': '最近一分钟的实时速度' });
  const now = Date.now(); const points = series.filter(([time]) => now - time <= 60000);
  if (points.length < 2) return chart;
  const top = Math.max(20, ...points.map(([, rate]) => rate)) * 1.15;
  const xy = points.map(([time, rate]) => `${(width - (now - time) / 60000 * width).toFixed(1)},${(height - rate / top * (height - 2)).toFixed(1)}`);
  chart.append(svg('polygon', { points: `${xy[0].split(',')[0]},${height} ${xy.join(' ')} ${xy.at(-1).split(',')[0]},${height}`, class: 'area' }), svg('polyline', { points: xy.join(' '), class: 'line' }));
  return chart;
}
function renderSpeed(data) { state.speedDetail = data; subscribeSpeed(data.agent.id); if (!meterState.data) sampleLive(data); drawSpeed(); }
function drawSpeed() {
  const data = state.speedDetail; if (!data) return;
  const meter = meterState.data && meterState.id === data.agent.id ? meterState.data : null;
  const request = working.has(data.agent.status) ? meter?.request : null;
  const history = meter?.history?.length ? meter.history : data.speeds || [];
  const latest = history.at(-1); let value, caption, live = false;
  if (request?.phase === 'output') { value = meter.rate; live = true; caption = `正在生成 · 本次已输出约 ${request.tokens} token`; }
  else if (request) { value = null; live = true; caption = `${request.phase === 'thinking' ? '正在思考（推理 token 不公开，结束后补上）' : '等待首个 token'} · ${shortDuration(Date.now() - ms(request.startedAt))}`; }
  else if (!meter && working.has(data.agent.status) && data.live?.message) { value = speedState.rate; live = true; caption = '正在生成 · 按可见文字估算（此会话启动早于实时速度计）'; }
  else { value = latest?.tps; caption = latest ? `最近一次 · ${latest.output} token / ${latest.seconds} 秒${latest.streamTps ? ` · 纯生成 ${latest.streamTps} tok/s` : ''}${latest.waitSeconds != null ? ` · 首字等待 ${latest.waitSeconds} 秒` : ''}` : '还没有完成的请求'; }
  const average = history.length ? history.reduce((sum, item) => sum + item.output, 0) / history.reduce((sum, item) => sum + item.seconds, 0) : 0;
  const peak = history.length ? Math.max(...history.map(item => item.tps)) : 0;
  $('#p-speed').replaceChildren(...[
    el('div', { class: `speed-now ${live ? 'streaming' : ''}` }, el('b', { text: value == null ? '—' : value >= 100 ? Math.round(value) : value.toFixed(1) }), el('span', { text: 'tok/s' }), live ? el('i', { class: 'pulse' }) : null),
    el('div', { class: 'sub', text: caption }),
    meter ? liveChart(meter.series || []) : null,
    speedChart(history.slice(-30)),
    el('dl', { class: 'speed-figures' },
      el('div', {}, el('dt', { text: '平均' }), el('dd', { text: history.length ? average.toFixed(1) : '—' })),
      el('div', {}, el('dt', { text: '最高' }), el('dd', { text: history.length ? String(peak) : '—' })),
      el('div', {}, el('dt', { text: '请求' }), el('dd', { text: String(history.length) }))),
    el('p', { class: 'speed-note', text: meter ? '上方曲线是最近一分钟的实时速度（每个流事件计数，变化时立即推送）；柱子是每次请求按模型上报 token 数算出的实测速度，横线是平均值。' : '柱子是最近每次请求的实测输出速度（含首字等待），横线是平均值。' })].filter(Boolean));
}
async function refreshDetail() {
  if (!state.selected || state.detailFetching) return; state.detailFetching = true;
  let data; const requested = state.selected;
  try { data = await api(`/api/agents/${requested}`); } finally { state.detailFetching = false; }
  if (state.selected !== requested) return;
  state.detail = data; const tools = pairTools(data.agent.events);
  $('#placeholder').hidden = true; applyPanel();
  renderHead(data, tools); renderSpeed(data); renderLane(data.agent, tools); renderRecords();
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
    if (state.selected) await refreshDetail().catch(error => showError(error.message));
    else { $('#placeholder').hidden = false; $('#records').replaceChildren(); $('#dock').hidden = true; $('#panel').hidden = true; $('#placeholder-text').textContent = '还没有会话。创建子代理后，这里会实时显示它的进度。'; }
    $('#live').className = 'live'; $('#connection').textContent = `已更新 ${clock(result.refreshedAt)}`;
    showError(result.errors.length ? `${result.errors.length} 个会话读取失败：${result.errors.map(e => `${e.id.slice(0, 8)} ${e.error}`).join('；')}` : '');
  } catch (error) { $('#live').className = 'live failed'; $('#connection').textContent = '更新失败 · 保留上次数据'; showError(error.message); }
  finally { state.fetching = false; }
}
function tick() {
  if (meterState.data?.request) drawSpeed();
  for (const node of document.querySelectorAll('[data-ago]')) node.textContent = ago(node.dataset.ago);
  for (const node of document.querySelectorAll('[data-since]')) node.textContent = shortDuration(Date.now() - Number(node.dataset.since));
  for (const node of document.querySelectorAll('[data-run-start]')) node.textContent = `正在工作 ${longDuration(Date.now() - Number(node.dataset.runStart))}`;
  const agent = state.detail?.agent;
  if (agent && working.has(agent.status)) for (const id of ['#d-elapsed', '#p-elapsed']) { const node = $(id); if (node) node.textContent = duration(elapsedOf(agent)); }
}

/* ---------- 交互 ---------- */
async function copyText(text, message) { try { await navigator.clipboard.writeText(text); toast(message); } catch { toast('复制失败，请手动选择'); } }
function setPaused(value) {
  state.paused = value; const button = $('#pause'); button.setAttribute('aria-pressed', String(value)); button.title = value ? '继续更新（P）' : '暂停更新（P）';
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
$('#d-report').addEventListener('click', () => $('#d-report p').classList.toggle('expanded'));
function applyPanel() { $('#panel').hidden = !state.selected || !(state.panel ?? innerWidth > 1180); $('#panel-toggle').setAttribute('aria-pressed', String(!$('#panel').hidden)); }
$('#panel-toggle').addEventListener('click', () => { state.panel = $('#panel').hidden; store.set('panel', state.panel); applyPanel(); if (state.detail) renderLane(state.detail.agent, pairTools(state.detail.agent.events)); });
$('#scroller').addEventListener('scroll', syncJump);
$('#jump').addEventListener('click', () => $('#scroller').scrollTo({ top: $('#scroller').scrollHeight, behavior: 'smooth' }));
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
// While the selected agent works, follow its live output more closely than the list.
setInterval(() => { if (!state.paused && working.has(state.detail?.agent.status)) refreshDetail().catch(error => showError(error.message)); }, 800);
