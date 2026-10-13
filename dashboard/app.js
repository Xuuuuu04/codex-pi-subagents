// Pi 调度台：查看本机会话。代理操作仍由所属聊天通过 MCP 完成；面板只整理自己的显示（标记、分组、改名）。
const $ = selector => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';

/* ---------- 文案与分类 ---------- */
const labels = { starting: '正在启动', running: '运行中', waiting: '等待答复', finishing: '正在结束', idle: '空闲', completed: '已完成', failed: '失败', interrupted: '已中断', closed: '已关闭', disconnected: '控制进程离线' };
const order = ['running', 'starting', 'finishing', 'waiting', 'idle', 'completed', 'interrupted', 'failed', 'disconnected', 'closed'];
const colors = { running: '--run', starting: '--run', finishing: '--run', waiting: '--wait', idle: '--idle', completed: '--done', interrupted: '--idle', failed: '--fail', disconnected: '--off', closed: '--closed' };
const working = new Set(['starting', 'running', 'waiting', 'finishing']);
const busyStatuses = new Set(['starting', 'running', 'finishing']);
const attention = new Set(['waiting', 'failed', 'disconnected']);
const filters = [
  { key: 'all', title: '全部', match: () => true },
  { key: 'working', title: '工作中', match: s => working.has(s) },
  { key: 'waiting', title: '待答复', match: s => s === 'waiting' },
  { key: 'completed', title: '已完成', match: s => s === 'completed' },
  { key: 'problem', title: '异常', match: s => s === 'failed' || s === 'disconnected' },
  { key: 'closed', title: '已关闭', match: s => s === 'closed' },
];
const eventTypes = { ready: '准备就绪', started: '开始执行', instruction: '收到任务', message_consumed: '消息已读入', question: '向父代理提问', answer: '父代理答复', message: '向父代理报告', tool_execution_start: '开始工具', tool_execution_end: '工具结束', settled: '本次执行结束', model_changed: '模型已更换', model_restored: '原模型已恢复', resumed: '会话已恢复', interrupted: '执行已中断', closed: '会话已关闭', process_failed: '进程失败', control_failed: '控制命令失败', extension_error: '扩展失败', question_cancelled: '问题已取消', instruction_failed: '任务发送失败', policy_changed: '策略已更新', budget_limit: '达到用量上限' };
const commTypes = new Set(['instruction', 'message', 'question', 'answer', 'question_cancelled']);
const badTypes = new Set(['process_failed', 'control_failed', 'extension_error', 'instruction_failed', 'interrupted', 'budget_limit']);
const lifeTypes = new Set(['ready', 'started', 'settled', 'resumed', 'interrupted', 'closed', 'model_changed', 'model_restored', 'process_failed', 'control_failed', 'extension_error', 'instruction_failed', 'budget_limit']);
const notifyOn = { waiting: '在等待答复', failed: '执行失败', completed: '已完成', disconnected: '控制进程离线' };
const kindNames = { claude: 'Claude', codex: 'Codex' };

/* ---------- 本机偏好（失败时使用默认值） ---------- */
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`pi-dash:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`pi-dash:${key}`, JSON.stringify(value)); } catch {} },
};
if (location.hash) history.replaceState(null, '', location.pathname);
try { sessionStorage.removeItem('pi-dashboard-token'); } catch {}

const state = {
  agents: [], groupNames: {}, selected: store.get('selected', ''), filter: store.get('filter', 'all'),
  collapsed: new Set(store.get('collapsed2', [])), showClosed: new Set(store.get('showClosed', [])),
  tab: store.get('tab', 'messages'), ptab: store.get('ptab', 'overview'), hideTools: store.get('hideTools', false), paused: false, fetching: false,
  detail: null, recordsKey: '', previous: new Map(), notify: store.get('notify', false), refreshedAt: null,
  sideHidden: store.get('sideHidden', null), panelHidden: store.get('panelHidden', null), listRendered: false, changes: new Map(),
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
/** 把新生成的节点合并进已有 DOM：只改变化的部分，已有节点（以及它们的转圈、闪光、滚动位置）原样保留，避免整块重建造成闪烁。 */
function morph(parent, next) {
  const old = [...parent.childNodes];
  next.forEach((node, i) => old[i] ? patchNode(old[i], node) : parent.append(node));
  for (const node of old.slice(next.length)) node.remove();
}
function patchNode(old, next) {
  // 按钮带着只属于旧节点闭包的点击处理，直接换新的。
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName || old.nodeName === 'BUTTON') { old.replaceWith(next); return; }
  if (next.nodeType !== 1) { if (old.data !== next.data) old.data = next.data; return; }
  for (const { name } of [...old.attributes]) if (!next.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  morph(old, [...next.childNodes]);
}
function svg(tag, attrs = {}) { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v); return node; }
function glyph(d, cls = '') { const box = svg('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }); for (const part of [d].flat()) box.append(svg('path', { d: part })); return box; }
const paths = {
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2h7.8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z', more: 'M6 12h.01M12 12h.01M18 12h.01',
  open: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4', copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7', close: 'M6 6l12 12M18 6 6 18', undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3', move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  plus: 'M12 5v14M5 12h14', pen: 'M4 20h4L19 9l-4-4L4 16z', fold: 'M7 10l5 5 5-5', chevron: 'M9 6l6 6-6 6', branch: 'M6 4v12M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 5-6 4-12 8',
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 12h6M15 12h6', pr: 'M6 4v16M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01M18 18V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2',
  merge: 'M6 4v16M6 8c0 6 12 4 12 10M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01', refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4',
  repo: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12', empty: 'M4 7h16v13H4zM9 11h6M8 3h8l4 4H4z',
};
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
  if (diff < 10000) return '刚刚'; if (diff < 60000) return `${Math.floor(diff / 1000)} 秒`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟`; if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时`;
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function tokens(n = 0) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)); }
const cost = n => n ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : '$0';
function elapsedOf(agent) { const end = working.has(agent.status) ? Date.now() : ms(agent.activity?.lastWorkAt || agent.updatedAt); return end - ms(agent.createdAt); }
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 1900); }
function showError(message) { $('#error').textContent = message; $('#error').hidden = !message; }
const narrow = () => innerWidth <= 760; const compact = () => innerWidth <= 1180;

async function api(path, options) {
  const read = () => fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(options ? 8000 : 15000), ...options });
  let response = await read();
  if (response.status === 401) {
    // 面板服务重启后重新领取查看 cookie；不涉及代理归属。
    const bootstrap = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (bootstrap.ok) response = await read();
  }
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `读取失败：${response.status}`); return result;
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-dashboard': '1' }, body: JSON.stringify(body) });

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
    el('span', {}, '运行', el('b', { text: state.agents.filter(a => busyStatuses.has(a.status)).length })),
    el('span', { title: '全部会话输入 + 输出 token' }, 'Token', el('b', { text: tokens(sum('input') + sum('output')) })),
    el('span', { title: '模型服务上报的费用，不是真实扣费记录' }, '上报', el('b', { text: cost(sum('reportedCost')) })),
    el('span', { title: '工作中会话最近一次请求的输出速度之和' }, '速度', el('b', { text: combinedSpeed() })));
  const waiting = counts.get('waiting') || 0;
  document.title = waiting ? `(${waiting} 待答复) Pi 调度台` : 'Pi 调度台';
}

/* ---------- 分组：父会话为默认，手动挪动和改名优先 ---------- */
const commonDir = list => {
  const parts = list.map(p => p.split('/')); let n = parts[0].length;
  for (const p of parts) { let i = 0; while (i < n && i < p.length && p[i] === parts[0][i]) i++; n = i; }
  return parts[0].slice(0, n).join('/') || '/';
};
/** Claude Code 的临时工作目录形如 /private/tmp/claude-501/<项目>/<会话>/scratchpad/...，目录名没有意义，改显示会话编号。 */
function directoryName(path) {
  const scratch = /^\/private\/tmp\/claude-\d+\/[^/]+\/([0-9a-f]{8})[0-9a-f-]*(\/|$)/.exec(path);
  return scratch ? `Claude 会话 ${scratch[1]}` : path.replace(/\/+$/, '').split('/').pop() || '/';
}
/** 父会话分组：新代理记录了真实身份（客户端、会话编号、所在目录）；旧代理没有，按 parentId 分开并用工作目录推断目录。 */
function parentGroups(agents) {
  const byParent = new Map();
  for (const a of agents) { const id = a.parentId || ''; (byParent.get(id) || byParent.set(id, []).get(id)).push(a); }
  return new Map([...byParent].map(([id, list]) => {
    const known = list.find(a => a.parentInfo)?.parentInfo; const dirs = list.map(a => a.sourceCwd || a.cwd).filter(Boolean);
    if (known?.sessionId) return [id, { key: `s:${known.sessionId}`, cwd: known.cwd, tag: `${kindNames[known.kind] || '会话'} ${known.sessionId.slice(0, 8)}`, detail: `${kindNames[known.kind] || '父'}会话 ${known.sessionId}` }];
    return [id, { key: `p:${id || '未知'}`, cwd: known?.cwd || (dirs.length ? commonDir(dirs) : ''), inferred: !known?.cwd, tag: id ? `旧代理 ${id.slice(0, 6)}` : '', detail: '旧代理没有记录父会话身份，目录根据代理工作目录推断' }];
  }));
}
function buildGroups(agents) {
  const parents = parentGroups(state.agents); const groups = new Map();
  const info = key => groups.get(key)?.info;
  for (const [, p] of parents) if (!groups.has(p.key)) groups.set(p.key, { key: p.key, info: p, agents: [] });
  for (const a of agents) {
    const own = parents.get(a.parentId || ''); let key = a.movedTo || own.key;
    if (!groups.has(key)) groups.set(key, { key, info: { key, custom: true, detail: '手动建立的分组', tag: '' }, agents: [] });
    groups.get(key).agents.push(a);
  }
  for (const g of groups.values()) g.name = state.groupNames[g.key] || (g.info.custom ? g.key.replace(/^custom:/, '') : g.info.cwd && g.info.cwd !== '/' ? directoryName(g.info.cwd) : '未归类会话');
  void info; return groups;
}
const rank = a => attention.has(a.status) ? 0 : busyStatuses.has(a.status) ? 1 : a.status === 'closed' ? 3 : 2;

/* ---------- 左侧会话列表 ---------- */
function indicator(a) {
  if (busyStatuses.has(a.status)) return el('span', { class: 'spin', title: labels[a.status] });
  if (a.status === 'waiting') return el('span', { class: 'dot waiting', title: '等待答复' });
  if (a.status === 'failed' || a.status === 'disconnected') return el('span', { class: 'bang', title: labels[a.status] });
  if (a.status === 'completed') return glyph(paths.check, 'check');
  if (a.status === 'closed') return null;
  return el('span', { class: 'ring-off', title: labels[a.status] });
}
function visibleAgents() {
  const query = $('#search').value.trim().toLowerCase();
  const filter = filters.find(f => f.key === state.filter) || filters[0];
  return state.agents.filter(a => filter.match(a.status) && (!query || `${a.name} ${modelName(a)} ${a.cwd} ${a.sourceCwd} ${a.id} ${a.parentInfo?.cwd || ''}`.toLowerCase().includes(query)));
}
function renderChips() {
  const chips = $('#chips'); chips.replaceChildren();
  for (const f of filters) chips.append(el('button', { type: 'button', 'aria-pressed': String(state.filter === f.key), onclick: () => { state.filter = f.key; store.set('filter', f.key); renderChips(); renderList(); } },
    f.title, el('span', { text: state.agents.filter(a => f.match(a.status)).length })));
}
function row(a) {
  const node = el('button', { type: 'button', class: `row ${a.status === 'closed' ? 'closed' : ''}`, 'data-agent': a.id, 'aria-current': String(a.id === state.selected), draggable: 'true',
    title: `${a.name}\n${modelName(a)} · ${labels[a.status] || a.status}${a.marked ? ' · 手动标记' : ''}`, onclick: () => select(a.id),
    oncontextmenu: event => { event.preventDefault(); select(a.id); agentMenu(a, event.clientX, event.clientY); },
    ondragstart: event => { event.dataTransfer.setData('text/agent', a.id); event.dataTransfer.effectAllowed = 'move'; } },
    el('span', { class: 'ind' }, indicator(a)), el('span', { class: 'name', text: a.name || a.id.slice(0, 8) }),
    a.movedTo ? glyph(paths.move, 'moved') : null, el('span', { class: 'ago', 'data-ago': a.updatedAt, text: ago(a.updatedAt) }),
    el('span', { class: 'row-more', role: 'button', title: '更多操作', onclick: event => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); agentMenu(a, box.right - 6, box.bottom + 4); } }, glyph(paths.more)));
  return node;
}
function listKey() {
  return JSON.stringify([state.filter, $('#search').value, [...state.collapsed], [...state.showClosed], state.groupNames, state.selected,
    state.agents.map(a => [a.id, a.status, a.name, a.movedTo, a.marked, a.parentId, a.parentInfo?.sessionId])]);
}
function renderList(force) {
  const key = listKey(); if (!force && key === state.listKey) return; state.listKey = key;
  const focused = document.activeElement?.dataset?.agent;
  const list = $('#list'); const scroll = list.scrollTop; list.replaceChildren();
  list.classList.toggle('no-anim', state.listRendered);
  const visible = visibleAgents(); const searching = $('#search').value.trim() || state.filter !== 'all';
  const groups = [...buildGroups(visible).values()].filter(g => g.agents.length);
  const latest = g => Math.max(...g.agents.map(a => (rank(a) < 3 ? 1e13 : 0) + (ms(a.updatedAt) || 0)));
  groups.sort((x, y) => latest(y) - latest(x));
  for (const g of groups) {
    const open = searching || !state.collapsed.has(g.key);
    const fail = g.agents.filter(a => a.status === 'failed' || a.status === 'disconnected').length, wait = g.agents.filter(a => a.status === 'waiting').length, busy = g.agents.filter(a => busyStatuses.has(a.status)).length;
    const head = el('button', { type: 'button', class: 'proj-head', 'aria-expanded': String(open), 'data-group': g.key,
      title: `${g.info.detail || ''}${g.info.cwd ? `\n目录：${g.info.cwd}${g.info.inferred ? '（推断）' : ''}` : ''}`,
      onclick: () => toggleGroup(g.key), oncontextmenu: event => { event.preventDefault(); groupMenu(g, event.clientX, event.clientY); },
      ondragover: event => { if (event.dataTransfer.types.includes('text/agent')) { event.preventDefault(); head.classList.add('dragover'); } },
      ondragleave: () => head.classList.remove('dragover'),
      ondrop: event => { event.preventDefault(); head.classList.remove('dragover'); const id = event.dataTransfer.getData('text/agent'); if (id) moveAgent(id, g.key); } },
      glyph(paths.folder, 'folder'), el('span', { class: 'proj-name', text: g.name }), el('span', { class: 'proj-tag', text: g.info.tag || '' }),
      el('span', { class: 'proj-flags' }, fail ? el('span', { class: 'flag fail', title: '异常', text: fail }) : null, wait ? el('span', { class: 'flag wait', title: '待答复', text: wait }) : null,
        busy ? el('span', { class: 'flag run', title: '正在工作' }, el('i'), String(busy)) : null),
      el('span', { class: 'proj-more', role: 'button', title: '分组操作', onclick: event => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); groupMenu(g, box.right - 6, box.bottom + 4); } }, glyph(paths.more)));
    const inner = el('div');
    const members = g.agents.slice().sort((a, b) => rank(a) - rank(b) || (ms(b.updatedAt) || 0) - (ms(a.updatedAt) || 0));
    const live = members.filter(a => a.status !== 'closed'); const closed = members.filter(a => a.status === 'closed');
    for (const a of live) inner.append(row(a));
    if (closed.length) {
      const auto = searching || state.filter === 'closed' || !live.length && closed.length <= 3;
      const showAll = auto || state.showClosed.has(g.key);
      if (!auto) inner.append(el('button', { type: 'button', class: 'fold-row', 'aria-expanded': String(showAll), onclick: () => { state.showClosed.has(g.key) ? state.showClosed.delete(g.key) : state.showClosed.add(g.key); store.set('showClosed', [...state.showClosed]); renderList(); } },
        glyph(paths.chevron), showAll ? `收起已关闭 ${closed.length}` : `已关闭 ${closed.length}`));
      if (showAll) for (const a of closed) inner.append(row(a));
    }
    list.append(el('section', { class: `proj ${open ? '' : 'collapsed'}` }, head, el('div', { class: 'proj-body' }, inner)));
  }
  list.scrollTop = scroll; state.listRendered = true;
  for (const node of list.querySelectorAll('.row')) if (node.dataset.agent === focused) node.focus({ preventScroll: true });
  const empty = $('#empty'); empty.hidden = visible.length > 0;
  empty.textContent = state.agents.length ? '没有符合条件的会话' : '还没有会话。创建子代理后会出现在这里。';
}
function toggleGroup(key) {
  state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key); store.set('collapsed2', [...state.collapsed]);
  const section = document.querySelector(`.proj-head[data-group="${CSS.escape(key)}"]`)?.parentElement;
  if (section) { section.classList.toggle('collapsed', state.collapsed.has(key)); section.querySelector('.proj-head').setAttribute('aria-expanded', String(!state.collapsed.has(key))); } else renderList();
}
function select(id) {
  if (narrow()) setSide(false);
  if (state.selected === id) return;
  state.selected = id; store.set('selected', id); state.recordsKey = ''; state.detail = null;
  for (const node of document.querySelectorAll('.row')) node.setAttribute('aria-current', String(node.dataset.agent === id));
  refreshDetail().catch(error => showError(error.message));
}
function moveSelection(step) {
  const rows = [...document.querySelectorAll('.row')]; if (!rows.length) return;
  const index = rows.findIndex(r => r.dataset.agent === state.selected);
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))]; select(next.dataset.agent); next.focus(); next.scrollIntoView({ block: 'nearest' });
}

/* ---------- 面板自己的整理操作 ---------- */
async function markAgent(id, status) { try { await post(`/api/agents/${id}/mark`, { status }); toast(status === 'closed' ? '已标记为已关闭' : status === 'completed' ? '已标记为已结束' : '已取消标记'); await refresh(true); } catch (error) { toast(error.message); } }
async function moveAgent(id, group) { try { await post(`/api/agents/${id}/move`, { group }); toast(group ? '已移动' : '已移回原分组'); await refresh(true); } catch (error) { toast(error.message); } }
async function renameGroup(key, name) { try { await post('/api/groups', { key, name }); toast(name ? '已重命名' : '已恢复默认名称'); await refresh(true); } catch (error) { toast(error.message); } }
async function newGroupFor(id) {
  const name = await promptDialog('新建分组', '', '会话会移到这个分组；只改变面板里的显示。'); if (!name) return;
  moveAgent(id, `custom:${name}`);
}
function promptDialog(title, value, hint) {
  const dialog = $('#dialog'); $('#dialog-title').textContent = title; $('#dialog-hint').textContent = hint || '';
  const input = $('#dialog-input'); input.value = value || '';
  return new Promise(resolve => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    dialog.returnValue = ''; dialog.showModal(); input.select();
  });
}

/* ---------- 右键菜单 ---------- */
function closeMenu() { const menu = $('#menu'); menu.hidden = true; menu.replaceChildren(); }
function menuItems(items) {
  return items.filter(Boolean).map(item => {
    if (item === '-') return el('hr');
    if (item.header) return el('div', { class: 'menu-label', text: item.header });
    const button = el('button', { type: 'button', role: 'menuitem', class: item.danger ? 'danger' : '', disabled: item.disabled || false,
      onclick: item.sub ? null : () => { closeMenu(); item.run(); } }, item.icon ? glyph(item.icon) : glyph(''), el('span', { text: item.label }), item.sub ? glyph(paths.chevron, 'sc') : item.sc ? el('span', { class: 'sc', text: item.sc }) : null);
    if (!item.sub) return button;
    return el('div', { class: `sub ${item.left ? 'left' : ''}` }, button, el('div', { class: 'menu', role: 'menu' }, menuItems(item.sub)));
  });
}
function openMenu(items, x, y) {
  const menu = $('#menu'); menu.replaceChildren(...menuItems(items)); menu.hidden = false;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const left = Math.min(x, innerWidth - w - 8); const top = Math.min(y, innerHeight - h - 8);
  menu.style.left = `${Math.max(8, left)}px`; menu.style.top = `${Math.max(8, top)}px`;
  menu.style.transformOrigin = `${x > left ? 'right' : 'left'} ${y > top ? 'bottom' : 'top'}`;
  for (const sub of menu.querySelectorAll('.sub')) if (left + w * 2 + 12 > innerWidth) sub.classList.add('left');
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
function agentMenu(a, x, y) {
  const busy = busyStatuses.has(a.status);
  const groups = [...buildGroups(state.agents).values()].filter(g => g.agents.length || g.info.custom);
  const current = a.movedTo || parentGroups(state.agents).get(a.parentId || '')?.key;
  openMenu([
    { label: '打开', icon: paths.open, sc: '↵', run: () => select(a.id) },
    { label: '复制会话身份', icon: paths.copy, run: () => copyText(a.id, '已复制会话身份') },
    { label: '复制工作目录', icon: paths.copy, disabled: !a.cwd, run: () => copyText(a.cwd, '已复制工作目录') },
    '-',
    { label: '标记为已结束', icon: paths.check, disabled: busy || a.status === 'completed', run: () => markAgent(a.id, 'completed') },
    { label: '关闭会话', icon: paths.close, disabled: busy || a.status === 'closed', run: () => markAgent(a.id, 'closed') },
    a.marked ? { label: '取消手动标记', icon: paths.undo, run: () => markAgent(a.id, null) } : null,
    '-',
    { label: '移动到', icon: paths.move, sub: [
      ...groups.filter(g => g.key !== current).slice(0, 30).map(g => ({ label: g.name, icon: paths.folder, run: () => moveAgent(a.id, g.key) })),
      groups.length > 1 ? '-' : null,
      { label: '新建分组…', icon: paths.plus, run: () => newGroupFor(a.id) },
      a.movedTo ? { label: '移回原分组', icon: paths.undo, run: () => moveAgent(a.id, null) } : null] },
  ], x, y);
}
function groupMenu(g, x, y) {
  const closable = g.agents.filter(a => !busyStatuses.has(a.status) && a.status !== 'closed');
  openMenu([
    { header: g.info.cwd || g.name },
    { label: state.collapsed.has(g.key) ? '展开' : '折叠', icon: paths.fold, run: () => toggleGroup(g.key) },
    { label: '重命名分组…', icon: paths.pen, run: async () => { const name = await promptDialog('重命名分组', g.name, '只改变面板里的显示名称。'); if (name) renameGroup(g.key, name); } },
    state.groupNames[g.key] ? { label: '恢复默认名称', icon: paths.undo, run: () => renameGroup(g.key, null) } : null,
    { label: '复制目录', icon: paths.copy, disabled: !g.info.cwd, run: () => copyText(g.info.cwd, '已复制目录') },
    '-',
    { label: `关闭本组不在工作的会话（${closable.length}）`, icon: paths.close, danger: true, disabled: !closable.length,
      run: async () => { for (const a of closable) await post(`/api/agents/${a.id}/mark`, { status: 'closed' }).catch(() => {}); toast(`已关闭 ${closable.length} 个会话`); refresh(true); } },
  ], x, y);
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

/* ---------- 时间线 ---------- */
function renderLane(agent, tools) {
  const lane = $('#lane'); lane.replaceChildren();
  const width = Math.max(200, $('#lane-wrap').clientWidth); const height = 66;
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
    const x1 = x(call.start); const x2 = call.end == null ? x(end) : x(call.end);
    const cls = call.end == null ? 'seg open' : call.isError ? 'seg err' : 'seg';
    lane.append(tip(svg('rect', { x: x1, y: 5, width: Math.max(2, x2 - x1), height: 18, rx: 2, class: cls }),
      `${call.name}${call.isError ? ' · 失败' : ''}\n${clock(call.start)} · ${call.end == null ? `进行中 ${shortDuration(Date.now() - call.start)}` : shortDuration(call.end - call.start)}`));
  }
  for (const e of events) {
    const text = (e.question || e.message || e.text || e.error || e.reason || '').slice(0, 140);
    if (commTypes.has(e.type)) lane.append(tip(svg('circle', { cx: x(ms(e.time)), cy: 39, r: 4, class: `comm ${e.type === 'question' ? 'question' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`));
    else if (lifeTypes.has(e.type)) { const cx = x(ms(e.time)); lane.append(tip(svg('path', { d: `M${cx} 51 l4.5 6 l-4.5 6 l-4.5 -6 z`, class: `life ${badTypes.has(e.type) ? 'bad' : ''}` }), `${eventTypes[e.type] || e.type} · ${clock(e.time)}${text ? `\n${text}` : ''}`)); }
  }
  if (live) lane.append(svg('line', { x1: x(end) - 1, x2: x(end) - 1, y1: 0, y2: height, class: 'nowline' }));
  $('#axis-start').textContent = clock(start); $('#axis-mid').textContent = `跨度 ${duration(end - start)}`; $('#axis-end').textContent = live ? '现在' : clock(end);
}

/* ---------- 概况：状态、用量、报告与底部状态条 ---------- */
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
  // 状态卡
  const chips = [['模型', agent.model?.model || '未知'], ['思考', agent.thinking || '默认'], agent.workspaceMode && ['目录', agent.workspaceMode === 'worktree' ? '独立工作树' : agent.workspaceMode === 'shared' ? '共享目录' : agent.workspaceMode],
    agent.ownedPaths?.length && ['范围', `${agent.ownedPaths.length} 项`], agent.temporaryModel && ['临时模型', '结束后恢复'], agent.marked && ['标记', '手动']].filter(Boolean);
  const card = $('#p-status'); const cardKey = JSON.stringify([agent.id, agent.status, chips, agent.cwd]);
  if (card.dataset.key !== cardKey) { card.dataset.key = cardKey; card.replaceChildren(
    el('div', { class: 'status-top' }, el('span', { class: `pill ${agent.status}` }, el('span', { class: `dot ${agent.status}` }), labels[agent.status] || agent.status), el('span', { class: 'ago', 'data-ago': agent.updatedAt, text: ago(agent.updatedAt) })),
    el('div', { class: 'big-clock' }, el('span', { id: 'p-elapsed', text: duration(elapsedOf(agent)) }), el('small', { text: working.has(agent.status) ? '已用时' : '总用时' })),
    el('div', { class: 'meta-chips' }, chips.map(([k, v]) => el('span', { title: k }, el('span', { class: 'muted', text: k }), el('code', { text: v })))),
    el('div', { class: 'status-actions' }, el('button', { type: 'button', class: 'btn small', onclick: () => copyText(agent.id, '已复制会话身份') }, glyph(paths.copy), '会话身份'),
      el('button', { type: 'button', class: 'btn small', disabled: !agent.cwd, onclick: () => copyText(agent.cwd || '', '已复制工作目录') }, glyph(paths.copy), '工作目录'))); }
  // 用量
  const u = agent.usage || {}; const errors = tools.calls.filter(c => c.isError).length; const cacheBase = (u.input || 0) + (u.cacheRead || 0);
  const figures = [['工具调用', tools.calls.length, errors ? `${errors} 失败` : null, errors > 0], ['上报费用', cost(u.reportedCost)],
    ['输入', tokens(u.input)], ['输出', tokens(u.output)], ['缓存命中', tokens(u.cacheRead), cacheBase ? `${Math.round((u.cacheRead || 0) / cacheBase * 100)}%` : null], ['事件', `#${agent.sequence ?? 0}`]];
  $('#d-figures').replaceChildren(...figures.map(([name, value, extra, bad]) => el('div', {}, el('dt', { text: name }), el('dd', { class: bad ? 'bad' : '' }, String(value), extra ? el('small', { text: extra }) : null))));
  const report = $('#d-report'); report.hidden = !agent.recentMessage; const body = report.querySelector('.p-report');
  if (body.dataset.text !== (agent.recentMessage || '')) { body.dataset.text = agent.recentMessage || ''; body.replaceChildren(markdown(agent.recentMessage || '')); body.classList.remove('expanded'); }
  const files = changedFiles(data); const badge = $('#changes-badge'); const loaded = state.changes.get(agent.id); const count = loaded?.result && loaded.result.git !== false ? loaded.files.length : files.size;
  badge.hidden = !count; badge.textContent = count;
  // 底部：提醒与一行实时状态
  // 只有内容变化才重建：每 0.8 秒整块重画会让淡入动画和转圈反复重播，看起来一直在闪。
  const alerts = $('#d-alerts'); const alertKey = JSON.stringify([agent.id, agent.questions.map(q => q.questionId), agent.error, agent.status === 'disconnected']);
  if (alerts.dataset.key !== alertKey) { alerts.dataset.key = alertKey; alerts.replaceChildren();
  for (const q of agent.questions) alerts.append(el('div', { class: 'alert clamp', title: '点击展开或收起', onclick: event => event.currentTarget.classList.toggle('clamp') }, el('strong', { text: `等待父代理答复 · ${ago(q.time)}前` }), el('p', { text: q.question }), el('small', { text: `问题身份 ${q.questionId}` })));
  if (agent.error) alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '错误' }), el('p', { text: agent.error })));
  if (agent.status === 'disconnected') alerts.append(el('div', { class: 'alert error' }, el('strong', { text: '控制进程已离线' }), el('p', { text: '在所属聊天中用 list_agents(includeSaved=true) 和 resume_agent 恢复。' })));
  }
  const bar = $('#d-now'); const openCall = busyStatuses.has(agent.status) ? tools.open.at(-1) : null; const last = agent.activity?.lastEvent;
  const barKey = JSON.stringify([agent.id, agent.status, openCall?.id, data.live?.message?.blocks?.some(b => b?.type === 'text'), last?.type, last?.time]);
  $('#dock').hidden = false;
  if (bar.dataset.key === barKey) return; bar.dataset.key = barKey;
  bar.className = `dock-bar ${['failed', 'disconnected'].includes(agent.status) ? 'bad' : ''}`; bar.replaceChildren();
  const clockNode = el('span', { class: 'clock' }, el('small', { text: working.has(agent.status) ? '已用时' : '总用时' }), el('span', { id: 'd-elapsed', text: duration(elapsedOf(agent)) }));
  if (openCall) {
    const call = openCall;
    bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow' }, '正在执行 ', el('code', { text: call.name }), ' ', el('span', { class: 'muted', 'data-since': call.start, text: shortDuration(Date.now() - call.start) })), clockNode);
  } else if (agent.status === 'waiting') bar.append(el('span', { class: 'dot waiting' }), el('span', { class: 'grow', text: '暂停在提问上，等所属聊天答复' }), clockNode);
  else if (working.has(agent.status)) bar.append(el('span', { class: 'spin' }), el('span', { class: 'grow shimmer', text: data.live?.message?.blocks?.some(b => b?.type === 'text') ? '正在回复' : '正在思考' }), clockNode);
  else {
    bar.append(el('span', { class: `dot ${agent.status}` }), el('span', { class: 'grow', text: `${labels[agent.status] || agent.status}${last ? ` · 最后动作 ${eventTypes[last.type] || last.type}${last.toolName ? ` ${last.toolName}` : ''} · ${ago(last.time)}前` : ''}` }), clockNode);
  }
}

/* ---------- 上下文分析 ---------- */
const partNames = [['system', '系统提示', 'var(--c7)'], ['user', '任务与消息', 'var(--c2)'], ['assistant', '模型回复', 'var(--c1)'], ['thinking', '思考', 'var(--c3)'], ['toolCalls', '工具调用', 'var(--c4)'], ['toolResults', '工具结果', 'var(--c6)']];
function renderContext(data) {
  const ctx = data.context; const box = $('#p-context');
  const key = JSON.stringify([data.agent.id, ctx?.requests, ctx?.used, ctx?.contextWindow, state.ptab]);
  if (box.dataset.key === key) return; const animate = box.dataset.agent !== data.agent.id; box.dataset.key = key; box.dataset.agent = data.agent.id;
  if (!ctx || !ctx.requests) { box.replaceChildren(el('section', { class: 'card empty-card' }, glyph(paths.empty), data.transcriptError ? `会话记录无法读取：${data.transcriptError}` : '还没有完成的模型请求，暂时没有上下文数据。')); return; }
  const windowSize = ctx.contextWindow; const fraction = windowSize ? ctx.used / windowSize : null;
  const top = el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '上下文占用' }), el('span', { class: 'card-meta', text: `最近一次请求 · 共 ${ctx.requests} 次` })),
    el('div', { class: 'ctx-top' }, gauge(fraction ?? 0, fraction == null ? tokens(ctx.used) : `${Math.round(fraction * 100)}%`, fraction == null ? '窗口未知' : '已使用'),
      el('dl', { class: 'ctx-figs' }, [['当前', tokens(ctx.used)], ['窗口', windowSize ? tokens(windowSize) : '未知'], ['剩余', windowSize ? tokens(Math.max(0, windowSize - ctx.used)) : '—'], ['峰值', tokens(ctx.peak)],
        ['缓存命中', ctx.used ? `${Math.round(ctx.cached / ctx.used * 100)}%` : '—'], ['压缩', `${ctx.compactions} 次`]].map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }))))));
  // 构成（按文字估算的比例）
  const parts = { system: ctx.sections.reduce((s, x) => s + x.tokens, 0), ...ctx.parts }; const total = Object.values(parts).reduce((s, v) => s + v, 0) || 1;
  const stack = el('div', { class: 'stack' }); const list = el('ul', { class: 'breakdown' });
  for (const [k, name, color] of partNames) {
    const v = parts[k] || 0; if (!v) continue;
    const seg = el('i', { title: `${name} 约 ${tokens(v)}` }); seg.style.background = color; seg.style.flexGrow = animate ? 0 : v; stack.append(seg);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { seg.style.flexGrow = v; }));
    const dot = el('i'); dot.style.background = color;
    list.append(el('li', {}, dot, el('span', { text: name }), el('span', { class: 'v', text: tokens(v) }), el('span', { class: 'p', text: `${Math.round(v / total * 100)}%` })));
  }
  const compose = el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '构成' }), el('span', { class: 'card-meta', text: '按文字估算' })), stack, list,
    el('p', { class: 'ctx-note', text: '实际占用以模型上报为准；估算只用来看各部分的比例。最近的会话记录最多读取 500 条。' }));
  // 增长曲线
  const values = ctx.series.map((s, i) => ({ x: i, y: s.used })); const cached = ctx.series.map((s, i) => ({ x: i, y: s.cached }));
  const chart = areaChart({ width: 320, height: 110, animate, series: [{ values, color: 'var(--c2)', label: '占用' }, { values: cached, color: 'var(--c1)', opacity: .12, dot: false, label: '缓存' }],
    yMax: windowSize && ctx.peak > windowSize * .6 ? windowSize * 1.02 : undefined, refLines: windowSize && ctx.peak > windowSize * .6 ? [{ y: windowSize, cls: 'limit' }] : [],
    tooltip: i => { const s = ctx.series[i]; return [`第 ${i + 1} 次请求 · ${clock(s.at)}`, ['占用 ', { b: tokens(s.used) }, windowSize ? `（${Math.round(s.used / windowSize * 100)}%）` : ''], ['缓存 ', { b: tokens(s.cached) }, '  输出 ', { b: tokens(s.output) }], s.reasoning ? ['推理 ', { b: tokens(s.reasoning) }] : null].filter(Boolean); } });
  const growth = el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '增长' }), el('span', { class: 'card-meta', text: `最高 ${tokens(ctx.peak)}` })), chart,
    el('div', { class: 'legend' }, el('span', { style: '--c: var(--c2)', text: '每次请求的占用' }), el('span', { style: '--c: var(--c1)', text: '其中缓存' }), windowSize && ctx.peak > windowSize * .6 ? el('span', { style: '--c: var(--fail)', text: '窗口上限' }) : null));
  const cards = [top, compose, growth];
  if (ctx.sections.length) {
    const max = Math.max(...ctx.sections.map(s => s.tokens));
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '系统提示' }), el('span', { class: 'card-meta', text: `约 ${tokens(parts.system)}` })),
      el('ul', { class: 'bars' }, ctx.sections.slice().sort((a, b) => b.tokens - a.tokens).map((s, i) => { const bar = el('i'); bar.style.width = `${s.tokens / max * 100}%`; bar.style.animationDelay = `${i * 40}ms`; if (!animate) bar.style.animation = 'none'; return el('li', {}, el('span', { text: s.name }), el('span', { class: 'v', text: tokens(s.tokens) }), el('div', { class: 'meter' }, bar)); }))));
  }
  box.replaceChildren(...cards);
}

/* ---------- 改动：Git、PR 与 diff ---------- */
function parseDiff(diff = '') {
  const files = []; let file = null; let oldLine = 0, newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.*)$/.exec(line); file = { path: m ? m[1] : line.slice(11), status: 'M', add: 0, del: 0, lines: [] }; files.push(file); continue; }
    if (!file) continue;
    if (line.startsWith('new file')) file.status = 'A'; else if (line.startsWith('deleted file')) file.status = 'D';
    else if (line.startsWith('rename to ')) { file.path = line.slice(10); file.status = 'R'; }
    else if (line.startsWith('@@')) { const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line); oldLine = Number(m?.[1] || 0); newLine = Number(m?.[2] || 0); file.lines.push({ type: 'hunk', text: line }); }
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename from') || line.startsWith('old mode') || line.startsWith('new mode')) continue;
    else if (line.startsWith('+')) { file.add++; file.lines.push({ type: 'add', text: line.slice(1), n: newLine++ }); }
    else if (line.startsWith('-')) { file.del++; file.lines.push({ type: 'del', text: line.slice(1), o: oldLine++ }); }
    else if (line.startsWith(' ') || line === '') { if (file.lines.length) file.lines.push({ type: 'ctx', text: line.slice(1), o: oldLine++, n: newLine++ }); }
    else if (line.startsWith('Binary')) file.lines.push({ type: 'hunk', text: '二进制文件' });
  }
  return files;
}
function minibar(add, del) {
  const total = add + del; const box = el('span', { class: 'minibar' }); const a = total ? Math.round(add / total * 5) : 0; const d = total ? Math.min(5 - a, Math.round(del / total * 5)) : 0;
  for (let i = 0; i < 5; i++) box.append(el('i', { class: i < a ? 'a' : i < a + d ? 'd' : '' }));
  return box;
}
function diffTable(file) {
  const table = el('table', { class: 'dtable' }); const body = el('tbody'); table.append(body);
  const clip = text => text.length > 1000 ? `${text.slice(0, 1000)} …（本行还有 ${text.length - 1000} 字）` : text;
  for (const line of file.lines.slice(0, 1500)) {
    if (line.type === 'hunk') { body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: line.text }))); continue; }
    body.append(el('tr', { class: line.type }, el('td', { class: 'ln', text: line.o ?? '' }), el('td', { class: 'ln', text: line.n ?? '' }),
      el('td', { class: 'code' }, el('span', { class: 'mk', text: line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ' }), clip(line.text))));
  }
  if (file.lines.length > 1500) body.append(el('tr', { class: 'hunk' }, el('td', { colspan: 3, text: `还有 ${file.lines.length - 1500} 行未显示` })));
  return el('div', { class: 'dscroll' }, table);
}
async function loadChanges(id, force) {
  const cached = state.changes.get(id);
  if (!force && cached && (cached.loading || Date.now() - cached.at < 15000)) return;
  state.changes.set(id, { ...cached, loading: true }); if (state.ptab === 'changes') renderChanges(state.detail, true);
  try { const result = await api(`/api/agents/${id}/changes`); state.changes.set(id, { result, files: parseDiff(result.diff), at: Date.now() }); }
  catch (error) { state.changes.set(id, { error: error.message, at: Date.now() }); }
  if (state.detail?.agent.id === id) { renderChanges(state.detail, true); renderHead(state.detail, pairTools(state.detail.agent.events)); }
}
function renderChanges(data, force) {
  if (!data) return; const box = $('#p-changes'); const id = data.agent.id; const entry = state.changes.get(id);
  const key = JSON.stringify([id, entry?.at, entry?.loading, data.pullRequests?.length]);
  if (!force && box.dataset.key === key) return; box.dataset.key = key;
  if (!entry || (entry.loading && !entry.result)) { box.replaceChildren(el('section', { class: 'card' }, el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton w80' })), el('section', { class: 'card' }, el('div', { class: 'skeleton tall' }))); return; }
  const refresh = el('button', { type: 'button', class: `btn small ghost ${entry.loading ? 'spinning' : ''}`, title: '重新读取', onclick: () => loadChanges(id, true) }, glyph(paths.refresh), '刷新');
  const cards = [];
  const prs = data.pullRequests || [];
  const r = entry.result;
  if (entry.error) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)), el('p', { class: 'muted', text: `读取失败：${entry.error}` })));
  else if (r.git === false) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)), el('p', { class: 'muted', text: '工作目录不是 Git 仓库，下面是对话里记录的编辑。' })));
  else {
    const add = entry.files.reduce((s, f) => s + f.add, 0), del = entry.files.reduce((s, f) => s + f.del, 0);
    const sum = el('div', { class: 'sumbar' }); const a = el('i', { class: 'a' }); a.style.flexGrow = add || 0; const d = el('i', { class: 'd' }); d.style.flexGrow = del || 0; sum.append(a, d);
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'Git' }), el('span', { class: 'card-meta' }, refresh)),
      el('div', { class: 'git-line' }, glyph(paths.repo), el('code', { text: r.repository?.split('/').pop() || r.cwd }), el('span', { class: 'muted', text: r.mode === 'worktree' ? '独立工作树' : '共享目录' })),
      el('div', { class: 'git-line' }, glyph(paths.branch), el('code', { text: r.branch || '当前分支' }), el('span', { class: 'muted', text: `基于 ${String(r.base).slice(0, 8)}` })),
      el('div', { class: 'git-line' }, glyph(paths.commit), el('span', { text: `${entry.files.length} 个文件` }), el('span', { class: 'diffstat muted' }, el('span', { class: 'plus', text: `+${add}` }), el('span', { class: 'minus', text: `−${del}` }))),
      (add + del) ? sum : null, r.note ? el('p', { class: 'ctx-note', text: r.mode === 'worktree' ? '' : '共享目录：只看声明的文件范围，可能包含其他人的修改。' }) : null));
    if (r.commits?.length) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '提交' }), el('span', { class: 'card-meta', text: `${r.commits.length} 个` })),
      el('ul', { class: 'commits' }, r.commits.slice(0, 20).map(line => el('li', {}, el('i'), el('code', { text: line.slice(0, 7) }), el('span', { text: line.slice(8), title: line.slice(8) }))))));
  }
  if (prs.length) cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: 'PR 记录' }), el('span', { class: 'card-meta', text: `${prs.length} 个` })),
    el('ul', { class: 'prs' }, prs.slice().reverse().map(pr => el('li', {}, el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: `pr-ico ${pr.merged ? 'merged' : ''}` }, glyph(pr.merged ? paths.merge : paths.pr)),
      el('span', { style: 'min-width:0;display:grid' }, el('b', { text: `#${pr.number}` }), el('span', { class: 'repo', text: pr.repo })),
      el('span', { class: 'state', text: pr.merged ? '已合并' : pr.created ? '已创建' : '已引用' })))))));
  const files = r && r.git !== false ? entry.files : [...changedFiles(data)].map(([path, f]) => ({ path, status: 'M', add: f.add, del: f.del, lines: [] }));
  if (files.length) {
    const list = el('ul', { class: 'files' }, files.map((f, i) => { const slash = f.path.lastIndexOf('/'); return el('li', {}, el('button', { type: 'button', title: f.path, onclick: () => { const target = box.querySelector(`[data-file="${i}"]`); if (target) { target.open = true; target.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } },
      el('span', { class: `st ${f.status}`, text: f.status }), el('span', { class: 'fname' }, el('bdi', {}, el('span', { class: 'muted', text: f.path.slice(0, slash + 1) }), f.path.slice(slash + 1))),
      el('span', { class: 'diffstat' }, el('span', { class: 'plus', text: `+${f.add}` }), el('span', { class: 'minus', text: `−${f.del}` })), minibar(f.add, f.del))); }));
    cards.push(el('section', { class: 'card' }, el('header', { class: 'card-head' }, el('h3', { text: '文件' }), el('span', { class: 'card-meta', text: `${files.length} 个` })), list));
  }
  if (r && r.git !== false && entry.files.length) {
    const diffs = el('section', { class: 'card', style: 'padding:10px' }, el('header', { class: 'card-head', style: 'padding:4px 5px 0' }, el('h3', { text: '差异' }), el('span', { class: 'card-meta', text: r.diffTruncated ? '内容较多，只显示前一部分' : '' })),
      entry.files.map((f, i) => { const node = el('details', { class: 'dfile', 'data-file': i }, el('summary', {}, glyph(paths.chevron), el('span', { text: f.path }), el('span', { class: 'diffstat' }, el('span', { class: 'plus', text: `+${f.add}` }), el('span', { class: 'minus', text: `−${f.del}` })))); node.open = i < 3 && f.lines.length < 400; node.addEventListener('toggle', () => { if (node.open && !node.querySelector('.dscroll')) node.append(diffTable(f)); }, { once: false }); if (node.open) node.append(diffTable(f)); return node; }));
    cards.push(diffs);
  }
  if (!files.length && !prs.length && !entry.error) cards.push(el('section', { class: 'card empty-card' }, glyph(paths.empty), '没有发现改动。'));
  box.replaceChildren(...cards);
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
    const text = e.question || e.message || e.error || e.text || e.reason || '';
    return el('li', {}, el('time', { title: fullDate(e.time), text: clock(e.time) }), el('span', { class: `type ${cls}`, text: eventTypes[e.type] || e.type }),
      el('div', { class: 'body' }, el('span', { class: 'seq', text: `#${e.sequence}` }), e.toolName ? el('code', { text: e.toolName }) : null, e.isError ? ' 失败' : null, text ? `${e.toolName ? ' · ' : ''}${text}` : null));
  }));
  return [[el('div', { class: 'subbar' }, el('label', {}, toggle, '隐藏工具事件')), events.length ? list : el('p', { class: 'records-empty', text: '暂时没有事件。' })], '最近 200 条状态与通信记录，最新在前。'];
}
function renderResult(agent) {
  const copy = el('button', { type: 'button', class: 'btn small', onclick: () => copyText(agent.lastText || '', '已复制结果'), disabled: !agent.lastText }, glyph(paths.copy), '复制结果');
  return [[el('div', { class: 'subbar' }, copy), agent.lastText ? markdown(agent.lastText) : el('p', { class: 'records-empty', text: '暂时没有模型结果。' })], '模型最近保存的回复。是否满足要求，仍需检查实际改动和测试。'];
}
function renderInfo(agent) {
  const code = text => el('code', { text: text || '—' });
  const rows = [['身份', code(agent.id)], ['状态记录', `${labels[agent.recordedStatus] || agent.recordedStatus} · 控制进程${agent.controllerAlive ? '在线' : '不在线'}${agent.marked ? ' · 面板手动标记' : ''}`],
    ['父会话', agent.parentInfo ? `${kindNames[agent.parentInfo.kind] || '未知'} ${agent.parentInfo.sessionId || ''}` : '旧代理，未记录'], ['父会话目录', code(agent.parentInfo?.cwd)],
    ['工作目录', code(agent.cwd)], ['来源目录', code(agent.sourceCwd)], ['目录模式', agent.workspaceMode === 'worktree' ? '独立 Git 工作目录' : agent.workspaceMode || '—'],
    ['文件范围', agent.ownedPaths?.length ? el('ul', { class: 'paths' }, agent.ownedPaths.map(p => el('li', { text: p }))) : '未限定'],
    ['开始时间', fullDate(agent.createdAt)], ['更新时间', fullDate(agent.updatedAt)], ['模型', `${modelName(agent)} · 思考 ${agent.thinking || '默认'}${agent.contextWindow ? ` · 窗口 ${tokens(agent.contextWindow)}` : ''}`],
    ['用量明细', `输入 ${agent.usage?.input || 0} · 输出 ${agent.usage?.output || 0} · 缓存读 ${agent.usage?.cacheRead || 0} · 缓存写 ${agent.usage?.cacheWrite || 0}`]];
  return [el('dl', { class: 'info' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, v)])), '上报费用来自模型服务的返回值，不等于真实扣费记录。'];
}
function renderRecords() {
  const data = state.detail; if (!data) return;
  const records = $('#records'); const box = $('#scroller');
  const key = JSON.stringify([state.tab, state.hideTools, data.agent.sequence, data.agent.status, data.messages.length, data.messages.at(-1)?.id, data.live?.updatedAt, data.transcriptError, data.agent.lastText?.length]);
  syncSeg($('#views'), 'tab', state.tab);
  if (key === state.recordsKey) return; state.recordsKey = key;
  const expanded = new Map([...[...records.querySelectorAll('details')].map(node => [node.dataset.key, node.open]),
    ...[...records.querySelectorAll('.bubble[data-key]')].map(node => [node.dataset.key, !node.classList.contains('clamped')])]);
  const view = `${data.agent.id}:${state.tab}`; const fresh = state.renderedView !== view; state.renderedView = view;
  // 像聊天一样贴底：读者没有往上翻时跟随新输出。
  const follow = state.tab === 'messages' && (fresh || nearBottom(box)); const scroll = box.scrollTop;
  const tools = pairTools(data.agent.events);
  const [content, note] = state.tab === 'messages' ? conversationTab(data, expanded) : state.tab === 'tools' ? renderTools(tools) : state.tab === 'events' ? renderEvents(data.agent) : state.tab === 'result' ? renderResult(data.agent) : renderInfo(data.agent);
  records.classList.toggle('enter', fresh);
  if (fresh || state.tab !== 'messages') records.replaceChildren(...[content].flat()); else morph(records, [content].flat().map(node => typeof node === 'string' ? document.createTextNode(node) : node));
  // 正在流出的思考和命令输出始终显示最新的一段。
  for (const live of records.querySelectorAll('.think-text.streaming, .live-tail .term-body')) live.scrollTop = live.scrollHeight;
  if (note !== $('#record-note').textContent) $('#record-note').textContent = note;
  box.scrollTop = follow ? box.scrollHeight : fresh ? 0 : scroll;
  syncJump();
}

// 逐字放出新到的文字：约 30 帧每秒，只重画正在输出的尾部；读者在底部时跟着滚。
let typingFrame = 0;
requestAnimationFrame(function pump(now) {
  requestAnimationFrame(pump);
  if (now - typingFrame < 32 || state.tab !== 'messages') return; typingFrame = now;
  const box = $('#scroller'); const follow = nearBottom(box);
  if (!refreshTail()) return;
  for (const live of $('#records').querySelectorAll('.think-text.streaming')) live.scrollTop = live.scrollHeight;
  if (follow) box.scrollTop = box.scrollHeight;
});

/* ---------- 实时速度 ---------- */
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
    speedState.history.push([now, speedState.rate]); speedState.history = speedState.history.filter(([time]) => now - time < 120000);
  }
  return speedState.rate;
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
function renderSpeed(data) { state.speedDetail = data; subscribeSpeed(data.agent.id); if (!meterState.data) sampleLive(data); drawSpeed(); }
function drawSpeed() {
  const data = state.speedDetail; if (!data) return;
  const meter = meterState.data && meterState.id === data.agent.id ? meterState.data : null;
  const request = working.has(data.agent.status) ? meter?.request : null;
  const history = meter?.history?.length ? meter.history : data.speeds || [];
  const latest = history.at(-1); let value, caption, live = false;
  if (request?.phase === 'output') { value = meter.rate; live = true; caption = `正在生成 · 本次约 ${request.tokens} token`; }
  else if (request) { value = null; live = true; caption = `${request.phase === 'thinking' ? '正在思考' : '等待首个 token'} · ${shortDuration(Date.now() - ms(request.startedAt))}`; }
  else if (!meter && working.has(data.agent.status) && data.live?.message) { value = speedState.rate; live = true; caption = '正在生成 · 按可见文字估算'; }
  else { value = latest?.tps; caption = latest ? `最近一次 · ${latest.output} token / ${latest.seconds} 秒${latest.waitSeconds != null ? ` · 首字 ${latest.waitSeconds} 秒` : ''}` : '还没有完成的请求'; }
  const average = history.length ? history.reduce((sum, item) => sum + item.output, 0) / history.reduce((sum, item) => sum + item.seconds, 0) : 0;
  const peak = history.length ? Math.max(...history.map(item => item.tps)) : 0;
  const box = $('#p-speed'); const animate = box.dataset.agent !== data.agent.id; box.dataset.agent = data.agent.id;
  let head = box.querySelector('.speed-now');
  if (!head || animate) { head = el('div', { class: 'speed-now' }, el('b', { text: '—' }), el('span', { text: 'tok/s' }), el('i', { class: 'pulse' })); }
  head.classList.toggle('streaming', live); head.querySelector('.pulse').hidden = !live;
  const number = head.querySelector('b');
  if (value == null) { number.textContent = '—'; number.dataset.value = ''; } else tweenNumber(number, value, v => v >= 100 ? String(Math.round(v)) : v.toFixed(1), 450);
  const series = (meter?.series || speedState.history).filter(([time]) => Date.now() - time <= 60000);
  const liveChart = live && series.length > 1 ? areaChart({ width: 320, height: 64, series: [{ values: series.map(([t, r]) => ({ x: t, y: r })), color: 'var(--brand)' }], xMin: Date.now() - 60000, xMax: Date.now(), ticks: 2,
    tooltip: i => [[{ b: `${series[i][1].toFixed(1)}` }, ' tok/s'], `${Math.round((Date.now() - series[i][0]) / 1000)} 秒前`] }) : null;
  const items = history.slice(-36).map(item => ({ v: item.tps, tip: `${item.tps} tok/s\n${item.output} token · ${item.seconds} 秒\n${clock(item.at)}` }));
  const bars = items.length ? barChart({ width: 320, height: 54, items, average, animate }) : null;
  $('#speed-meta').textContent = history.length ? `最近 ${Math.min(36, history.length)} 次请求` : '';
  box.replaceChildren(...[head, el('div', { class: 'speed-cap', text: caption }), liveChart || bars, liveChart && bars ? bars : null,
    el('dl', { class: 'speed-figures' },
      el('div', {}, el('dt', { text: '平均' }), el('dd', { text: history.length ? average.toFixed(1) : '—' })),
      el('div', {}, el('dt', { text: '最高' }), el('dd', { text: history.length ? String(peak) : '—' })),
      el('div', {}, el('dt', { text: '请求' }), el('dd', { text: String(history.length) })))].filter(Boolean));
}

/* ---------- 右侧面板 ---------- */
function renderPanel(data) {
  for (const view of document.querySelectorAll('[data-pview]')) view.hidden = view.dataset.pview !== state.ptab;
  syncSeg($('#ptabs'), 'ptab', state.ptab);
  if (state.ptab === 'context') renderContext(data);
  if (state.ptab === 'changes') { loadChanges(data.agent.id); renderChanges(data); }
}
/** 分段控件的滑块：移到选中项下面。 */
function syncSeg(nav, attr, value) {
  const buttons = [...nav.querySelectorAll(`[data-${attr}]`)]; const current = buttons.find(b => b.dataset[attr] === value) || buttons[0];
  for (const b of buttons) b.setAttribute('aria-selected', String(b === current));
  const thumb = nav.querySelector('.seg-thumb'); if (!thumb || !current || !current.offsetWidth) return;
  thumb.style.width = `${current.offsetWidth}px`; thumb.style.transform = `translateX(${current.offsetLeft}px)`;
}

async function refreshDetail() {
  if (!state.selected || state.detailFetching) return; state.detailFetching = true;
  let data; const requested = state.selected;
  try { data = await api(`/api/agents/${requested}`); } finally { state.detailFetching = false; }
  if (state.selected !== requested) return;
  state.detail = data; const tools = pairTools(data.agent.events);
  $('#placeholder').hidden = true;
  renderHead(data, tools); renderSpeed(data); renderLane(data.agent, tools); renderRecords(); renderPanel(data);
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
async function refresh(force) {
  if (state.fetching || (state.paused && !force)) return; state.fetching = true;
  try {
    const result = await api('/api/agents'); state.agents = result.agents; state.groupNames = result.groupNames || {}; state.refreshedAt = result.refreshedAt;
    if (!state.agents.some(a => a.id === state.selected)) {
      const pick = state.agents.find(a => a.status === 'waiting') || state.agents.find(a => working.has(a.status)) || state.agents.find(a => a.status !== 'closed') || state.agents[0];
      state.selected = pick?.id || ''; state.recordsKey = '';
    }
    notifyChanges(); renderOverview(); renderChips(); if (!$('#menu').hidden) { /* 菜单打开时不重画列表 */ } else renderList();
    if (state.selected) await refreshDetail().catch(error => showError(error.message));
    else { $('#placeholder').hidden = false; $('#records').replaceChildren(); $('#dock').hidden = true; $('#placeholder-text').textContent = '还没有会话。创建子代理后，这里会实时显示它的进度。'; }
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

/* ---------- 布局：收起、拖动宽度、自适应 ---------- */
function setSide(open) { state.sideHidden = !open; if (!narrow()) store.set('sideHidden', state.sideHidden); applyLayout(); }
function setPanel(open) { state.panelHidden = !open; if (!compact()) store.set('panelHidden', state.panelHidden); applyLayout(); if (open && state.detail) { renderPanel(state.detail); renderLane(state.detail.agent, pairTools(state.detail.agent.events)); } }
function applyLayout() {
  const app = $('#app');
  const sideHidden = narrow() ? state.sideHidden !== false : !!state.sideHidden;
  const panelHidden = !state.selected || (compact() ? state.panelHidden !== false : !!state.panelHidden);
  app.classList.toggle('side-hidden', sideHidden); app.classList.toggle('panel-hidden', panelHidden);
  $('#panel-toggle').setAttribute('aria-pressed', String(!panelHidden));
}
function bindResizers() {
  const app = $('#app'); const limits = { side: [220, 460, 280], panel: [300, 620, 360] };
  const setWidth = (which, value) => { const [min, max] = limits[which]; const w = Math.round(Math.min(max, Math.max(min, value))); app.style.setProperty(`--${which}-w`, `${w}px`); store.set(`${which}-w`, w); return w; };
  for (const which of ['side', 'panel']) { const saved = store.get(`${which}-w`, null); if (saved) setWidth(which, saved); }
  for (const handle of document.querySelectorAll('.resizer')) {
    const which = handle.dataset.resize;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault(); handle.setPointerCapture(event.pointerId); handle.classList.add('active'); app.classList.add('dragging');
      const move = e => setWidth(which, which === 'side' ? e.clientX : innerWidth - e.clientX);
      const up = () => { handle.classList.remove('active'); app.classList.remove('dragging'); handle.removeEventListener('pointermove', move); if (state.detail) renderLane(state.detail.agent, pairTools(state.detail.agent.events)); syncSeg($('#views'), 'tab', state.tab); syncSeg($('#ptabs'), 'ptab', state.ptab); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up, { once: true }); handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', () => { app.style.removeProperty(`--${which}-w`); store.set(`${which}-w`, null); });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault();
      const current = parseInt(getComputedStyle(app).getPropertyValue(`--${which}-w`)) || limits[which][2]; const step = (event.key === 'ArrowRight' ? 16 : -16) * (which === 'side' ? 1 : -1);
      setWidth(which, current + step);
    });
  }
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
function rerenderCharts() { if (!state.detail) return; $('#p-context').dataset.key = ''; renderLane(state.detail.agent, pairTools(state.detail.agent.events)); drawSpeed(); renderPanel(state.detail); }
function syncNotifyButton() { $('#notify').setAttribute('aria-pressed', String(state.notify)); $('#notify').title = state.notify ? '状态提醒已开启' : '状态变化时提醒'; }

applyTheme(store.get('theme', null));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', null)));
$('#theme').addEventListener('click', () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', next); applyTheme(next); rerenderCharts(); });
$('#notify').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('当前浏览器不支持通知'); return; }
  if (!state.notify && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') { toast('浏览器没有允许通知'); return; }
  state.notify = !state.notify; store.set('notify', state.notify); syncNotifyButton(); toast(state.notify ? '会话等待、完成或失败时会提醒你' : '已关闭提醒');
});
$('#d-report').addEventListener('click', () => $('#d-report .p-report').classList.toggle('expanded'));
$('#panel-toggle').addEventListener('click', () => setPanel($('#app').classList.contains('panel-hidden')));
$('#panel-close').addEventListener('click', () => setPanel(false));
$('#side-collapse').addEventListener('click', () => setSide(false));
$('#side-open').addEventListener('click', () => setSide(true));
$('#scroller').addEventListener('scroll', syncJump);
// 窄屏时侧栏和面板是浮层：点主区空白处收起。
$('.main').addEventListener('pointerdown', event => {
  const app = $('#app'); if (event.target.closest('.main-head')) return;
  if (narrow() && !app.classList.contains('side-hidden')) { event.preventDefault(); setSide(false); }
  else if (compact() && !app.classList.contains('panel-hidden')) { event.preventDefault(); setPanel(false); }
});
$('#jump').addEventListener('click', () => $('#scroller').scrollTo({ top: $('#scroller').scrollHeight, behavior: 'smooth' }));
$('#pause').addEventListener('click', () => setPaused(!state.paused));
$('#search').addEventListener('input', renderList);
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { state.tab = button.dataset.tab; store.set('tab', state.tab); state.recordsKey = ''; renderRecords(); });
for (const button of document.querySelectorAll('[data-ptab]')) button.addEventListener('click', () => { state.ptab = button.dataset.ptab; store.set('ptab', state.ptab); $('#panel-body').scrollTop = 0; if (state.detail) renderPanel(state.detail); else syncSeg($('#ptabs'), 'ptab', state.ptab); });
document.addEventListener('pointerdown', event => { if (!$('#menu').hidden && !event.target.closest('#menu')) closeMenu(); });
addEventListener('blur', closeMenu); $('#list').addEventListener('scroll', closeMenu);
document.addEventListener('keydown', event => {
  if (!$('#menu').hidden) {
    const items = [...$('#menu').querySelectorAll(':scope > button:not(:disabled), :scope > .sub > button')]; const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { closeMenu(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return; }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (event.key === 'Escape' && event.target.id === 'search') { event.target.value = ''; event.target.blur(); renderList(); return; }
  if (typing) return;
  if (event.key === '/') { event.preventDefault(); if (narrow()) setSide(true); $('#search').focus(); }
  else if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
  else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
  else if (event.key === 'p') setPaused(!state.paused);
  else if (event.key === '[') setSide($('#app').classList.contains('side-hidden'));
  else if (event.key === ']') setPanel($('#app').classList.contains('panel-hidden'));
  else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { const a = state.agents.find(x => x.id === state.selected); const node = document.querySelector('.row[aria-current="true"]'); if (a && node) { event.preventDefault(); const box = node.getBoundingClientRect(); agentMenu(a, box.left + 40, box.bottom); } }
});
let resizeTimer; addEventListener('resize', () => { applyLayout(); clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { syncSeg($('#views'), 'tab', state.tab); syncSeg($('#ptabs'), 'ptab', state.ptab); }, 60); });
new ResizeObserver(() => { if (state.detail && !$('#app').classList.contains('dragging')) renderLane(state.detail.agent, pairTools(state.detail.agent.events)); }).observe($('#lane-wrap'));
window.addEventListener('hashchange', () => { history.replaceState(null, '', location.pathname); setPaused(false); });
bindTips($('#lane-wrap')); bindResizers(); syncNotifyButton(); applyLayout();
requestAnimationFrame(() => { syncSeg($('#views'), 'tab', state.tab); syncSeg($('#ptabs'), 'ptab', state.ptab); });
refresh().then(applyLayout); setInterval(refresh, 2000); setInterval(tick, 1000);
// 选中的代理在工作时，比列表更频繁地跟随它的实时输出。
setInterval(() => { if (!state.paused && working.has(state.detail?.agent.status)) refreshDetail().catch(error => showError(error.message)); }, 800);
