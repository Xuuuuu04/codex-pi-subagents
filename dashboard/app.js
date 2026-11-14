import {
  el, statusLabel, agentHost, hostMeta, showToast, copyText, isWorking, agentSessionId, apiFetch,
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
import { openSettingsDialog } from './settings.js';

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
  settingsBtn: document.getElementById('settings-btn'),
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
  settingsDialog: document.getElementById('settings-dialog'),
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
let speedAgentId = null;
let pollTimer = null;

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
  const sid = agentSessionId(agent);
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
    renderChangesPanel(dom.pChanges, detail?.agent?.id || state.selectedId, state.changesCache, apiFetch, () => state.selectedId);
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
      try {
        for (const item of items) await apiFetch(`/api/agents/${item.id}/mark`, { method: 'POST', body: JSON.stringify({ status }) });
      } catch (error) {
        showToast(error?.message || '批量标记失败');
      } finally {
        await refreshNow();
      }
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
  const targetId = state.selectedId;
  if (!targetId) {
    state.detail = null;
    return;
  }
  const snap = state.agents.find(a => a.id === targetId);
  const stamp = snap ? `${snap.id}:${snap.sequence}:${snap.status}:${snap.updatedAt}:${snap.marked}:${snap.movedTo}:${snap.contextWindow || ''}` : targetId;
  const working = snap && isWorking(snap.status);
  if (!force && state.detailStamp === stamp && !working) return;
  try {
    const detail = await apiFetch(`/api/agents/${targetId}`);
    if (state.selectedId !== targetId) return;
    state.detail = detail;
    state.detailStamp = stamp;
  } catch (error) {
    if (state.selectedId !== targetId) return;
    state.detail = snap
      ? { agent: snap, messages: [], speeds: [], context: null, pullRequests: [], transcriptError: error.message }
      : null;
  }
}

function syncSpeedStream() {
  const agent = state.agents.find(a => a.id === state.selectedId);
  if (!agent || !isWorking(agent.status) || state.paused) {
    if (speedSource) { speedSource.close(); speedSource = null; }
    speedAgentId = null;
    state.liveSpeed = null;
    return;
  }
  if (speedSource && speedAgentId === agent.id && speedSource.readyState !== EventSource.CLOSED) return;
  if (speedSource) { speedSource.close(); speedSource = null; }
  speedAgentId = agent.id;
  state.liveSpeed = null;
  speedSource = new EventSource(`/api/agents/${agent.id}/speed`);
  speedSource.onmessage = event => {
    try {
      state.liveSpeed = JSON.parse(event.data);
      if (state.tab === 'speed') renderSpeedPanel(dom.pSpeed, state.detail, state.liveSpeed, dom.tip);
    } catch (error) {
      state.liveSpeed = null;
      console.error(error?.message || String(error));
    }
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
  speedAgentId = null;
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
    catch (error) {
      setConn('解析异常', 'err');
      console.error(error?.message || String(error));
    }
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

function setupButtons() {
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

  dom.settingsBtn.addEventListener('click', () => openSettingsDialog(dom.settingsDialog, apiFetch, () => refreshNow()));
  dom.sysBtn.addEventListener('click', () => renderSystemDialog(dom.sysDialog, apiFetch, false));
  dom.helpBtn.addEventListener('click', () => dom.helpDialog.showModal());
  dom.helpDialog.querySelector('[data-close]')?.addEventListener('click', () => dom.helpDialog.close());
  for (const dlg of [dom.dialog, dom.sysDialog, dom.settingsDialog, dom.helpDialog]) {
    dlg?.addEventListener('click', event => { if (event.target === dlg) dlg.close(); });
  }
  dom.sideToggle?.addEventListener('click', () => {
    if (window.innerWidth <= 760) {
      dom.app.classList.remove('panel-open');
      dom.app.classList.toggle('side-open');
    } else {
      dom.app.classList.toggle('side-hidden');
    }
  });
  dom.panelToggle?.addEventListener('click', () => {
    if (window.innerWidth <= 1180) {
      dom.app.classList.remove('side-open');
      dom.app.classList.toggle('panel-open');
    } else {
      dom.app.classList.toggle('panel-hidden');
    }
  });

  dom.search.addEventListener('input', () => { state.search = dom.search.value; renderSidebarList(dom, state, sidebarHandlers); });
  dom.threadSearch.addEventListener('input', () => { state.threadSearch = dom.threadSearch.value; renderThread(dom.records, state.detail, state.threadSearch); });

  for (const btn of dom.ptabs.querySelectorAll('button')) {
    btn.addEventListener('click', () => { state.tab = btn.dataset.tab; renderActiveInspector(); });
  }
  document.addEventListener('click', event => {
    if (!dom.menu.hidden && !dom.menu.contains(event.target)) dom.menu.hidden = true;
    const t = event.target;
    if (dom.app.classList.contains('side-open') && !t.closest('.side') && t !== dom.sideToggle) dom.app.classList.remove('side-open');
    if (dom.app.classList.contains('panel-open') && !t.closest('.panel') && t !== dom.panelToggle) dom.app.classList.remove('panel-open');
  });
}

function setupKeyboard() {
  const tabs = ['status', 'speed', 'lane', 'context', 'changes'];
  document.addEventListener('keydown', event => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === 'Escape') {
      dom.menu.hidden = true;
      dom.app.classList.remove('side-open', 'panel-open');
      if (typing && document.activeElement.value) {
        document.activeElement.value = '';
        document.activeElement.dispatchEvent(new Event('input'));
      }
      return;
    }
    const modalOpen = dom.dialog.open || dom.sysDialog.open || dom.settingsDialog.open || dom.helpDialog.open;
    if (typing || modalOpen || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); dom.search.focus(); }
    else if (event.key === ',') { event.preventDefault(); dom.settingsBtn.click(); }
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

function setupControls() {
  setupButtons();
  setupKeyboard();
}

setupResizers();
setupControls();
refreshNow().then(() => startLiveStreams());
