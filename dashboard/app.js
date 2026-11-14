import {
  el, statusLabel, agentHost, hostMeta, showToast, copyText,
} from './dom.js';
import { renderThread } from './conversation.js';
import {
  renderStatusPanel, renderSpeedPanel, renderContextPanel,
  renderLanePanel, renderChangesPanel,
} from './panels.js';
import {
  renderDock, renderSystemDialog, openAgentMenu,
  openGroupMenu, openRenameDialog, openMoveDialog,
} from './dialogs.js';
import {
  visibleAgents, renderHeaderAndChips, renderSidebarList,
} from './sidebar.js';

const dom = {
  app: document.getElementById('app'),
  sideToggle: document.getElementById('side-toggle'),
  panelToggle: document.getElementById('panel-toggle'),
  search: document.getElementById('search'),
  hostChips: document.getElementById('host-chips'),
  chips: document.getElementById('chips'),
  list: document.getElementById('list'),
  dist: document.getElementById('dist'),
  totals: document.getElementById('totals'),
  connection: document.getElementById('connection'),
  notify: document.getElementById('notify'),
  sysBtn: document.getElementById('sys-btn'),
  helpBtn: document.getElementById('help-btn'),
  theme: document.getElementById('theme'),
  pause: document.getElementById('pause'),
  alerts: document.getElementById('d-alerts'),
  now: document.getElementById('d-now'),
  views: document.getElementById('views'),
  threadSearch: document.getElementById('thread-search'),
  records: document.getElementById('records'),
  ptabs: document.getElementById('ptabs'),
  pStatus: document.getElementById('p-status'),
  pSpeed: document.getElementById('p-speed'),
  lane: document.getElementById('lane'),
  pContext: document.getElementById('p-context'),
  pChanges: document.getElementById('p-changes'),
  tip: document.getElementById('chart-tip'),
  menu: document.getElementById('menu'),
  dialog: document.getElementById('dialog'),
  sysDialog: document.getElementById('sys-dialog'),
  helpDialog: document.getElementById('help-dialog'),
};

const state = {
  agents: [],
  groupNames: {},
  errors: [],
  selectedId: null,
  detail: null,
  detailStamp: '',
  filterStatus: 'all',
  filterHost: 'all',
  search: '',
  threadSearch: '',
  tab: 'status',
  paused: false,
  changesCache: {},
  liveSpeed: null,
  lastQuestions: new Set(),
};

let eventsSource = null;
let speedSource = null;
let pollTimer = null;

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method === 'POST') {
    headers.set('content-type', 'application/json');
    headers.set('x-pi-dashboard', '1');
  }
  const res = await fetch(url, { ...options, headers });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function setConn(text, kind) {
  dom.connection.textContent = text;
  dom.connection.className = `conn-pill conn-${kind}`;
}

const markAgent = async (id, status) => {
  await apiFetch(`/api/agents/${id}/mark`, { method: 'POST', body: JSON.stringify({ status }) });
  await refreshNow();
};

const moveAgent = async (id, group) => {
  await apiFetch(`/api/agents/${id}/move`, { method: 'POST', body: JSON.stringify({ group }) });
  await refreshNow();
};

const renameGroup = async (key, name) => {
  await apiFetch('/api/groups', { method: 'POST', body: JSON.stringify({ key, name }) });
  await refreshNow();
};

function notifyQuestions() {
  const activeQuestions = new Map();
  for (const a of state.agents) {
    for (const q of a.questions || []) activeQuestions.set(q.questionId, { agent: a, q });
  }
  for (const [qid, item] of activeQuestions) {
    if (!state.lastQuestions.has(qid) && document.hidden && Notification?.permission === 'granted') {
      new Notification(`子代理 ${item.agent.name || item.agent.id.slice(0, 8)} 正在等答复`, { body: item.q.question });
    }
  }
  state.lastQuestions = new Set(activeQuestions.keys());
}

function renderMainHeader() {
  const agent = state.detail?.agent || state.agents.find(a => a.id === state.selectedId);
  if (!agent) {
    dom.views.replaceChildren(el('span', { className: 'muted' }, '未选择子代理'));
    return;
  }
  const host = hostMeta(agentHost(agent));
  const sid = agent.parentInfo?.sessionId || agent.callback?.antigravitySessionId;
  dom.views.replaceChildren(
    el('span', { className: `badge status-${agent.status}` }, statusLabel(agent.status)),
    el('strong', { className: 'view-title' }, agent.name || agent.id.slice(0, 8)),
    el('span', { className: `badge ${host.cls}` }, host.label),
    sid ? el('button', {
      type: 'button',
      className: 'btn btn-xs',
      onclick: () => copyText(sid, '已复制会话编号'),
    }, `会话 ${sid.slice(0, 10)}`) : null,
    agent.watcherActive ? el('span', { className: 'badge badge-watch' }, '监听活跃') : null,
  );
}

function renderActiveInspector() {
  const detail = state.detail;
  dom.pStatus.hidden = state.tab !== 'status';
  dom.pSpeed.hidden = state.tab !== 'speed';
  dom.lane.hidden = state.tab !== 'lane';
  dom.pContext.hidden = state.tab !== 'context';
  dom.pChanges.hidden = state.tab !== 'changes';
  for (const btn of dom.ptabs.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  }
  if (state.tab === 'status') {
    renderStatusPanel(dom.pStatus, detail, {
      onMark: markAgent,
      onMoveDialog: agent => openMoveDialog(dom.dialog, agent, moveAgent),
    });
  } else if (state.tab === 'speed') {
    renderSpeedPanel(dom.pSpeed, detail, state.liveSpeed, dom.tip);
  } else if (state.tab === 'lane') {
    renderLanePanel(dom.lane, detail);
  } else if (state.tab === 'context') {
    renderContextPanel(dom.pContext, detail);
  } else if (state.tab === 'changes') {
    renderChangesPanel(dom.pChanges, detail?.agent?.id || state.selectedId, state.changesCache, apiFetch);
  }
}

const sidebarHandlers = {
  onSelect: id => selectAgent(id),
  onAgentMenu: (agent, x, y) => openAgentMenu(dom.menu, agent, x, y, {
    onMark: markAgent,
    onMove: target => openMoveDialog(dom.dialog, target, moveAgent),
  }),
  onGroupMenu: (group, rect) => openGroupMenu(dom.menu, group, rect, {
    onRename: g => openRenameDialog(dom.dialog, g, state.groupNames[g.key], renameGroup),
    onBatchMark: async (items, status) => {
      for (const item of items) await apiFetch(`/api/agents/${item.id}/mark`, { method: 'POST', body: JSON.stringify({ status }) });
      await refreshNow();
    },
  }),
};

function renderAll() {
  renderHeaderAndChips(dom, state, renderAll);
  renderSidebarList(dom, state, sidebarHandlers);
  renderDock(dom.alerts, dom.now, state.agents, selectAgent);
  renderMainHeader();
  renderThread(dom.records, state.detail, state.threadSearch);
  renderActiveInspector();
}

async function loadSelectedDetail(force = false) {
  if (!state.selectedId) {
    state.detail = null;
    return;
  }
  const snap = state.agents.find(a => a.id === state.selectedId);
  const stamp = snap ? `${snap.id}:${snap.sequence}:${snap.status}:${snap.updatedAt}:${snap.marked}:${snap.movedTo}` : state.selectedId;
  const working = snap && ['starting', 'running', 'finishing'].includes(snap.status);
  if (!force && state.detailStamp === stamp && !working) return;
  try {
    state.detail = await apiFetch(`/api/agents/${state.selectedId}`);
    state.detailStamp = stamp;
  } catch (error) {
    if (error) state.detail = null;
  }
}

function syncSpeedStream() {
  if (speedSource) { speedSource.close(); speedSource = null; }
  state.liveSpeed = null;
  const agent = state.agents.find(a => a.id === state.selectedId);
  if (!agent || !['starting', 'running', 'finishing'].includes(agent.status) || state.paused) return;
  speedSource = new EventSource(`/api/agents/${agent.id}/speed`);
  speedSource.onmessage = event => {
    try {
      state.liveSpeed = JSON.parse(event.data);
      if (state.tab === 'speed') renderSpeedPanel(dom.pSpeed, state.detail, state.liveSpeed, dom.tip);
    } catch (error) { if (error) state.liveSpeed = null; }
  };
}

async function selectAgent(id) {
  state.selectedId = id;
  if (window.innerWidth <= 760) dom.app.classList.remove('side-open');
  syncSpeedStream();
  await loadSelectedDetail(true);
  renderAll();
}

async function applyListPayload(payload) {
  state.agents = payload.agents || [];
  state.groupNames = payload.groupNames || {};
  state.errors = payload.errors || [];
  notifyQuestions();
  if (!state.selectedId && state.agents.length) state.selectedId = state.agents[0].id;
  else if (state.selectedId && !state.agents.some(a => a.id === state.selectedId)) {
    state.selectedId = state.agents[0]?.id || null;
  }
  await loadSelectedDetail();
  syncSpeedStream();
  renderAll();
}

async function refreshNow() {
  try {
    const payload = await apiFetch('/api/agents');
    await applyListPayload(payload);
    if (eventsSource?.readyState === EventSource.OPEN) setConn('实时推送', 'live');
    else setConn(state.paused ? '已暂停' : '轮询中', state.paused ? 'paused' : 'poll');
  } catch (error) {
    setConn('连接失败', 'err');
    showToast(`刷新失败：${error.message}`);
  }
}

function stopLiveStreams() {
  if (eventsSource) { eventsSource.close(); eventsSource = null; }
  if (speedSource) { speedSource.close(); speedSource = null; }
  clearInterval(pollTimer);
  pollTimer = null;
}

function startLiveStreams() {
  stopLiveStreams();
  if (state.paused) { setConn('已暂停', 'paused'); return; }
  setConn('连接中', 'poll');
  eventsSource = new EventSource('/api/events');
  eventsSource.onopen = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    setConn('实时推送', 'live');
  };
  eventsSource.onmessage = event => {
    try { applyListPayload(JSON.parse(event.data)); }
    catch (error) { if (error) setConn('解析异常', 'err'); }
  };
  eventsSource.onerror = () => {
    setConn('轮询中', 'poll');
    if (!pollTimer) pollTimer = setInterval(refreshNow, 2000);
  };
}

function setupResizers() {
  const savedSide = localStorage.getItem('pi_side_w');
  const savedPanel = localStorage.getItem('pi_panel_w');
  if (savedSide) dom.app.style.setProperty('--side-w', savedSide);
  if (savedPanel) dom.app.style.setProperty('--panel-w', savedPanel);
  for (const handle of document.querySelectorAll('[data-resize]')) {
    const kind = handle.dataset.resize;
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      dom.app.classList.add('dragging');
      handle.classList.add('active');
      const onMove = move => {
        if (kind === 'side') {
          const w = `${Math.max(220, Math.min(440, move.clientX))}px`;
          dom.app.style.setProperty('--side-w', w);
          localStorage.setItem('pi_side_w', w);
        } else {
          const w = `${Math.max(280, Math.min(540, window.innerWidth - move.clientX))}px`;
          dom.app.style.setProperty('--panel-w', w);
          localStorage.setItem('pi_panel_w', w);
        }
      };
      const onUp = () => {
        dom.app.classList.remove('dragging');
        handle.classList.remove('active');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
}

function setupControls() {
  const savedTheme = localStorage.getItem('pi_dashboard_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = savedTheme;
  dom.theme.textContent = savedTheme === 'dark' ? '浅色' : '深色';

  dom.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('pi_dashboard_theme', next);
    dom.theme.textContent = next === 'dark' ? '浅色' : '深色';
  });

  dom.pause.addEventListener('click', () => {
    state.paused = !state.paused;
    dom.pause.textContent = state.paused ? '继续' : '暂停';
    if (state.paused) { stopLiveStreams(); setConn('已暂停', 'paused'); }
    else startLiveStreams();
  });

  dom.notify.addEventListener('click', async () => {
    if (!('Notification' in window)) return showToast('当前浏览器不支持桌面通知');
    const perm = await Notification.requestPermission();
    showToast(perm === 'granted' ? '已开启提问桌面通知' : '未获得通知权限');
  });

  dom.sysBtn.addEventListener('click', () => renderSystemDialog(dom.sysDialog, apiFetch, false));
  dom.helpBtn.addEventListener('click', () => dom.helpDialog.showModal());
  dom.helpDialog.querySelector('[data-close]')?.addEventListener('click', () => dom.helpDialog.close());
  for (const dlg of [dom.dialog, dom.sysDialog, dom.helpDialog]) {
    dlg?.addEventListener('click', event => { if (event.target === dlg) dlg.close(); });
  }
  dom.sideToggle?.addEventListener('click', () => {
    if (window.innerWidth <= 760) dom.app.classList.toggle('side-open');
    else dom.app.classList.toggle('side-hidden');
  });
  dom.panelToggle?.addEventListener('click', () => dom.app.classList.toggle('panel-hidden'));

  dom.search.addEventListener('input', () => { state.search = dom.search.value; renderSidebarList(dom, state, sidebarHandlers); });
  dom.threadSearch.addEventListener('input', () => { state.threadSearch = dom.threadSearch.value; renderThread(dom.records, state.detail, state.threadSearch); });

  for (const btn of dom.ptabs.querySelectorAll('button')) {
    btn.addEventListener('click', () => { state.tab = btn.dataset.tab; renderActiveInspector(); });
  }
  document.addEventListener('click', event => {
    if (!dom.menu.hidden && !dom.menu.contains(event.target)) dom.menu.hidden = true;
  });

  const tabs = ['status', 'speed', 'lane', 'context', 'changes'];
  document.addEventListener('keydown', event => {
    const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (event.key === 'Escape') {
      dom.menu.hidden = true;
      if (typing && document.activeElement.value) {
        document.activeElement.value = '';
        document.activeElement.dispatchEvent(new Event('input'));
      }
      return;
    }
    const modalOpen = dom.dialog.open || dom.sysDialog.open || dom.helpDialog.open;
    if (typing || modalOpen || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); dom.search.focus(); }
    else if (event.key === '?') { event.preventDefault(); dom.helpDialog.showModal(); }
    else if (event.key === 'p') dom.pause.click();
    else if (event.key === '[' || event.key === ']') {
      const idx = tabs.indexOf(state.tab);
      state.tab = tabs[(idx + (event.key === ']' ? 1 : tabs.length - 1)) % tabs.length];
      renderActiveInspector();
    } else if (event.key === 'j' || event.key === 'k') {
      const list = visibleAgents(state);
      if (!list.length) return;
      const idx = list.findIndex(a => a.id === state.selectedId);
      const nextIdx = idx === -1 ? 0 : Math.min(list.length - 1, Math.max(0, idx + (event.key === 'j' ? 1 : -1)));
      selectAgent(list[nextIdx].id);
    }
  });
}

setupResizers();
setupControls();
refreshNow().then(() => startLiveStreams());
