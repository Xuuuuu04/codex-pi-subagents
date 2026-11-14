import {
  $, el, glyph, paths, busyStatuses, clock, fullDate, copyText, showToast, agentSessionId, mount,
} from './dom.js';
import { buildGroups, currentAgentGroupKey } from './sidebar.js';

export function closeMenu() {
  const menu = $('#menu');
  if (!menu) return;
  menu.hidden = true;
  menu.replaceChildren();
}

function menuItems(items) {
  return items.filter(Boolean).map(item => {
    if (item === '-') return el('hr');
    if (item.header) return el('div', { class: 'menu-label', text: item.header });
    const button = el('button', {
      type: 'button',
      role: 'menuitem',
      class: item.danger ? 'danger' : '',
      disabled: item.disabled || false,
      onclick: item.sub ? null : () => {
        closeMenu();
        Promise.resolve(item.run()).catch(error => showToast(error?.message || '操作失败'));
      },
    },
    item.icon ? glyph(item.icon) : glyph(''),
    el('span', { text: item.label }),
    item.sub ? glyph(paths.chevron, 'sc') : item.sc ? el('span', { class: 'sc', text: item.sc }) : null);
    if (!item.sub) return button;
    return el('div', { class: `sub ${item.left ? 'left' : ''}` }, button, el('div', { class: 'menu', role: 'menu' }, menuItems(item.sub)));
  });
}

export function openMenu(items, x, y) {
  const menu = $('#menu');
  menu.replaceChildren(...menuItems(items));
  menu.hidden = false;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(x, innerWidth - w - 8);
  const top = Math.min(y, innerHeight - h - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.transformOrigin = `${x > left ? 'right' : 'left'} ${y > top ? 'bottom' : 'top'}`;
  for (const sub of menu.querySelectorAll('.sub')) {
    if (left + w * 2 + 12 > innerWidth) sub.classList.add('left');
  }
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

export function promptDialog(title, value, hint) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-hint').textContent = hint || '';
  const input = $('#dialog-input');
  input.value = value || '';
  return new Promise(resolve => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    dialog.returnValue = '';
    dialog.showModal();
    input.select();
  });
}

export function agentMenu(a, x, y, state, actions) {
  const busy = busyStatuses.has(a.status);
  const groups = [...buildGroups(state.agents, state).values()].filter(g => g.agents.length || g.info.custom);
  const current = currentAgentGroupKey(a, state.agents);
  const sid = agentSessionId(a);
  openMenu([
    { label: '打开', icon: paths.open, sc: '↵', run: () => actions.onSelect(a.id) },
    { label: '复制会话身份', icon: paths.copy, run: () => copyText(a.id, '已复制会话身份') },
    sid ? { label: '复制父会话编号', icon: paths.copy, run: () => copyText(sid, '已复制父会话编号') } : null,
    { label: '复制工作目录', icon: paths.copy, disabled: !a.cwd, run: () => copyText(a.cwd, '已复制工作目录') },
    '-',
    { label: '标记为已结束', icon: paths.check, disabled: (busy && !a.marked) || a.status === 'completed', run: () => actions.onMark(a.id, 'completed') },
    { label: '关闭会话', icon: paths.close, disabled: (busy && !a.marked) || a.status === 'closed', run: () => actions.onMark(a.id, 'closed') },
    a.marked ? { label: '取消手动标记', icon: paths.undo, run: () => actions.onMark(a.id, null) } : null,
    '-',
    {
      label: '移动到',
      icon: paths.move,
      sub: [
        ...groups.filter(g => g.key !== current).slice(0, 30).map(g => ({ label: g.name, icon: paths.folder, run: () => actions.onMove(a.id, g.key) })),
        groups.length > 1 ? '-' : null,
        {
          label: '新建分组…',
          icon: paths.plus,
          run: async () => {
            const name = await promptDialog('新建分组', '', '会话会移到这个分组；只改变面板里的显示。');
            if (name) await actions.onMove(a.id, `custom:${name}`);
          },
        },
        a.movedTo ? { label: '移回原分组', icon: paths.undo, run: () => actions.onMove(a.id, null) } : null,
      ],
    },
  ], x, y);
}

export function groupMenu(g, x, y, state, actions) {
  const closable = g.agents.filter(a => !busyStatuses.has(a.status) && a.status !== 'closed');
  openMenu([
    { header: g.info.cwd || g.name },
    { label: state.collapsed.has(g.key) ? '展开' : '折叠', icon: paths.fold, run: () => actions.onToggleGroup(g.key) },
    {
      label: '重命名分组…',
      icon: paths.pen,
      run: async () => {
        const name = await promptDialog('重命名分组', g.name, '只改变面板里的显示名称。');
        if (name) await actions.onRenameGroup(g.key, name);
      },
    },
    state.groupNames[g.key] ? { label: '恢复默认名称', icon: paths.undo, run: () => actions.onRenameGroup(g.key, null) } : null,
    g.info.sessionId ? { label: '复制父会话编号', icon: paths.copy, run: () => copyText(g.info.sessionId, '已复制父会话编号') } : null,
    { label: '复制目录', icon: paths.copy, disabled: !g.info.cwd, run: () => copyText(g.info.cwd, '已复制目录') },
    '-',
    {
      label: `关闭本组不在工作的会话（${closable.length}）`,
      icon: paths.close,
      danger: true,
      disabled: !closable.length,
      run: () => actions.onBatchClose(closable),
    },
  ], x, y);
}

function renderQuotaCard(item) {
  if (item.status === 'error') {
    return el('div', { class: 'quota-card err' },
      el('div', { class: 'quota-head' }, el('strong', { class: 'mono', text: item.provider }), el('span', { class: 'badge badge-fail', text: '查询失败' })),
      el('div', { class: 'muted', text: item.error || '未知错误' }),
    );
  }
  const q = item.quota || {};
  const lines = [];
  for (const w of q.windows || []) {
    const rem = Number.isFinite(w.remainingPercent) ? `${w.remainingPercent.toFixed(1)}% 剩余` : '剩余未知';
    const reset = w.resetsAt ? ` · 重置 ${fullDate(w.resetsAt)}` : '';
    lines.push(el('div', { class: 'quota-line', text: `${w.kind}${w.service ? ` (${w.service})` : ''}: ${rem}${reset}` }));
  }
  for (const b of q.balances || []) {
    lines.push(el('div', { class: 'quota-line', text: `余额 ${b.total} ${b.currency} (充 ${b.toppedUp} / 赠 ${b.granted})` }));
  }
  for (const w of q.warnings || []) {
    lines.push(el('div', { class: 'quota-warn', text: w }));
  }
  return el('div', { class: 'quota-card' },
    el('div', { class: 'quota-head' },
      el('strong', { class: 'mono', text: item.provider }),
      q.plan ? el('span', { class: 'badge badge-dim', text: q.plan }) : null,
    ),
    lines.length ? lines : el('div', { class: 'muted', text: '暂无窗口明细' }),
  );
}

export async function renderSystemDialog(dialogEl, apiFetch, forceQuota = false) {
  mount(dialogEl, el('div', { class: 'dialog-box dialog-wide' },
    el('div', { class: 'dialog-head' },
      el('strong', { text: '运行状态与账号额度' }),
      el('div', { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn small', onclick: () => renderSystemDialog(dialogEl, apiFetch, true) }, glyph(paths.refresh), '刷新额度'),
        el('button', { type: 'button', class: 'btn small', onclick: () => dialogEl.close() }, '关闭'),
      ),
    ),
    el('div', { class: 'dialog-body' }, el('p', { class: 'muted', text: '正在读取本机服务状态与额度…' })),
  ));
  if (!dialogEl.open) dialogEl.showModal();
  const body = dialogEl.querySelector('.dialog-body');
  try {
    const [sys, quota] = await Promise.all([
      apiFetch('/api/system'),
      apiFetch(`/api/quota${forceQuota ? '?refresh=1' : ''}`),
    ]);
    const ctrl = sys.controller;
    const cText = ctrl ? `${ctrl.alive ? '在线' : '已停止'} · PID ${ctrl.pid || '—'} · 版本 ${ctrl.version || '—'}` : '未启动控制进程';
    mount(body,
      el('section', { class: 'settings-card' },
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: '独立控制进程' }), el('span', { class: 'kv-v mono', text: cText })),
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: 'Web 面板进程' }), el('span', { class: 'kv-v mono', text: `PID ${sys.dashboardPid} · 模型目录 ${sys.modelCount} 个` })),
        el('div', { class: 'kv-row' }, el('span', { class: 'kv-k', text: '子代理统计' }), el('span', { class: 'kv-v', text: `共 ${sys.counts.total} · 工作中 ${sys.counts.working} · 待答复 ${sys.counts.waiting} · 已完成 ${sys.counts.completed}${sys.counts.interrupted ? ` · 已中断 ${sys.counts.interrupted}` : ''} · 异常 ${sys.counts.failed + sys.counts.disconnected}` })),
      ),
      el('div', { class: 'sec-title', text: `活跃事件监听器 (${sys.watchers.length})` }),
      sys.watchers.length
        ? el('div', { class: 'watcher-list' }, sys.watchers.map(w =>
            el('div', { class: 'watcher-row', text: `PID ${w.pid} · 会话 ${w.sessionId || '—'} · 启动于 ${clock(w.startedAt)}` }),
          ))
        : el('div', { class: 'muted', text: '当前没有运行中的后台 wait-events 监听进程' }),
      el('div', { class: 'sec-title', text: `模型额度（查询于 ${clock(quota.queriedAt)}${quota.cached ? ' · 60秒缓存' : ''}）` }),
      quota.error
        ? el('div', { class: 'err-card', text: quota.error })
        : quota.results?.length
          ? el('div', { class: 'quota-grid' }, quota.results.map(renderQuotaCard))
          : el('div', { class: 'muted', text: '未检测到已配置的支持查询的服务商凭据' }),
    );
  } catch (error) {
    body.textContent = `读取失败：${error.message}`;
  }
}
