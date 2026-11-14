import {
  el, morph, statusLabel, statusGroup, agentHost, hostMeta,
  copyText, compactNumber, totalUsageTokens, agentSessionId,
} from './dom.js';
import { renderDistBar } from './charts.js';

export function groupFor(agent) {
  if (agent.movedTo) {
    const isCustomKey = agent.movedTo.startsWith('custom:');
    const key = isCustomKey ? agent.movedTo : `group:${agent.movedTo}`;
    const title = isCustomKey ? (agent.movedTo.slice(7) || agent.movedTo) : agent.movedTo;
    return { key, rawMovedTo: agent.movedTo, title, host: agentHost(agent), sessionId: null };
  }
  const host = agentHost(agent);
  const sid = agentSessionId(agent);
  if (sid) {
    const dir = (agent.parentInfo?.cwd || agent.sourceCwd || agent.cwd || '').split('/').filter(Boolean).pop() || '会话';
    return { key: `session:${host}:${sid}`, title: `${dir} · ${sid.slice(0, 8)}`, host, sessionId: sid };
  }
  if (agent.parentId) {
    return { key: `parent:${agent.parentId}`, title: `父连接 ${agent.parentId.slice(0, 8)}`, host, sessionId: null };
  }
  const dir = (agent.sourceCwd || agent.cwd || '独立运行').split('/').filter(Boolean).pop() || '独立运行';
  return { key: `cwd:${agent.sourceCwd || agent.cwd || 'standalone'}`, title: dir, host, sessionId: null };
}

export function visibleAgents(state) {
  const q = state.search.trim().toLowerCase();
  return state.agents.filter(agent => {
    if (state.filterHost !== 'all' && agentHost(agent) !== state.filterHost) return false;
    if (state.filterStatus !== 'all' && statusGroup(agent.status) !== state.filterStatus) return false;
    if (!q) return true;
    const hay = [
      agent.name, agent.id, agent.model?.model, agent.cwd,
      agent.parentInfo?.sessionId, agent.lastText, agent.error,
    ].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  });
}

function renderChipBar(container, defs, activeId, onPick) {
  morph(container, defs, d => d[0],
    ([id, label, count]) => el('button', {
      type: 'button',
      className: `chip ${activeId === id ? 'active' : ''}`,
      onclick: () => onPick(id),
    }, `${label} ${count}`),
    (node, [id, label, count]) => {
      node.className = `chip ${activeId === id ? 'active' : ''}`;
      node.textContent = `${label} ${count}`;
    },
  );
}

export function renderHeaderAndChips(dom, state, onRender) {
  const counts = { all: state.agents.length, working: 0, waiting: 0, done: 0, issue: 0 };
  const hostCounts = { all: state.agents.length, antigravity: 0, codex: 0, claude: 0 };
  for (const a of state.agents) {
    const sg = statusGroup(a.status);
    if (counts[sg] !== undefined) counts[sg]++;
    const h = agentHost(a);
    if (hostCounts[h] !== undefined) hostCounts[h]++;
  }
  dom.totals.textContent = `共 ${counts.all} · 工作中 ${counts.working} · 等答复 ${counts.waiting}`;
  renderDistBar(dom.dist, counts);

  renderChipBar(dom.hostChips, [
    ['all', '全部宿主', hostCounts.all],
    ['antigravity', 'Antigravity', hostCounts.antigravity],
    ['codex', 'Codex', hostCounts.codex],
    ['claude', 'Claude', hostCounts.claude],
  ], state.filterHost, id => { state.filterHost = id; onRender(); });

  renderChipBar(dom.chips, [
    ['all', '全部', counts.all],
    ['working', '工作中', counts.working],
    ['waiting', '等答复', counts.waiting],
    ['done', '已完成', counts.done],
    ['issue', '异常', counts.issue],
  ], state.filterStatus, id => { state.filterStatus = id; onRender(); });
}

function createAgentRow(agent, handlers) {
  const row = el('button', {
    type: 'button',
    className: 'agent-row',
    onclick: () => handlers.onSelect(agent.id),
    oncontextmenu: event => {
      event.preventDefault();
      handlers.onAgentMenu(agent, event.clientX, event.clientY);
    },
  });
  return row;
}

function updateAgentRow(row, agent, selectedId) {
  const selected = agent.id === selectedId;
  const tokens = totalUsageTokens(agent.usage);
  const digest = JSON.stringify([agent.status, agent.name, agent.sequence, agent.watcherActive, agent.marked, agent.questions?.length || 0, selected, agent.speed?.tps, tokens, agent.model?.model]);
  if (row.dataset.digest === digest) return;
  row.dataset.digest = digest;
  row.className = `agent-row status-border-${agent.status}${selected ? ' selected' : ''}`;
  const host = hostMeta(agentHost(agent));
  const title = agent.name || agent.id.slice(0, 8);
  const right = Number.isFinite(agent.speed?.tps)
    ? `${agent.speed.tps.toFixed(1)} tok/s`
    : compactNumber(tokens);
  row.replaceChildren(
    el('div', { className: 'agent-top' },
      el('span', { className: `dot dot-${agent.status}` }),
      el('span', { className: 'agent-name' }, title),
      agent.watcherActive ? el('span', { className: 'watch-dot', title: '正在监听回调事件' }) : null,
      el('span', { className: `mini-host ${host.cls}` }, host.short),
    ),
    el('div', { className: 'agent-sub' },
      el('span', { className: `st-text st-${agent.status}` }, statusLabel(agent.status)),
      el('span', { className: 'muted' }, agent.model?.model || '-'),
      el('span', { className: 'muted' }, right),
    ),
  );
}

export function renderSidebarList(dom, state, handlers) {
  const list = visibleAgents(state);
  if (!list.length) {
    dom.list.replaceChildren(el('div', { className: 'empty-mini' }, state.agents.length ? '无匹配的筛选结果' : '当前没有子代理记录'));
    return;
  }
  const groups = new Map();
  for (const agent of list) {
    const g = groupFor(agent);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, agents: [] });
    groups.get(g.key).agents.push(agent);
  }
  const groupList = [...groups.values()];
  morph(
    dom.list,
    groupList,
    g => g.key,
    () => el('section', { className: 'group-box' }, el('div', { className: 'group-head' }), el('div', { className: 'group-items' })),
    null,
  );
  for (const g of groupList) {
    const node = [...dom.list.children].find(c => c.dataset.k === g.key);
    if (!node) continue;
    const label = state.groupNames[g.key] || (g.rawMovedTo && state.groupNames[g.rawMovedTo]) || g.title;
    const host = hostMeta(g.host);
    const headDigest = JSON.stringify([label, g.host, g.sessionId, g.agents.length]);
    const head = node.firstElementChild;
    if (head.dataset.digest !== headDigest) {
      head.dataset.digest = headDigest;
      head.replaceChildren(
        el('div', { className: 'group-title' },
          el('span', { className: `mini-host ${host.cls}` }, host.short),
          el('span', { className: 'group-name', title: g.sessionId || g.key }, label),
          el('span', { className: 'group-cnt' }, String(g.agents.length)),
        ),
        el('div', { className: 'group-ops' },
          g.sessionId ? el('button', {
            type: 'button',
            className: 'icon-btn',
            title: '复制父会话编号',
            onclick: () => copyText(g.sessionId, '已复制会话编号'),
          }, '复制') : null,
          el('button', {
            type: 'button',
            className: 'icon-btn',
            title: '分组操作',
            onclick: event => handlers.onGroupMenu(g, event.currentTarget.getBoundingClientRect()),
          }, '…'),
        ),
      );
    }
    morph(
      node.lastElementChild,
      g.agents,
      a => a.id,
      a => {
        const row = createAgentRow(a, handlers);
        updateAgentRow(row, a, state.selectedId);
        return row;
      },
      (row, a) => updateAgentRow(row, a, state.selectedId),
    );
  }
}
