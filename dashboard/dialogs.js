import { el, morph, clock, fullDate, statusLabel, isWorking, showToast, copyText, replyPayload } from './dom.js';
import { kvRow } from './panels.js';

export function renderDock(alertsEl, nowEl, agents, onSelect) {
  const waiting = agents.flatMap(a => (a.questions || []).map(q => ({ agent: a, q })));
  if (waiting.length) {
    alertsEl.hidden = false;
    morph(alertsEl, waiting, item => item.q.questionId,
      ({ agent, q }) => el('div', { className: 'alert-banner' },
        el('div', { className: 'alert-text' },
          el('strong', {}, `${agent.name || agent.id.slice(0, 8)} 等待答复：`),
          el('span', {}, q.question),
        ),
        el('div', { className: 'btn-row' },
          el('button', { type: 'button', className: 'btn btn-xs', onclick: () => onSelect(agent.id) }, '查看'),
          el('button', {
            type: 'button',
            className: 'btn btn-xs btn-warn',
            onclick: () => copyText(replyPayload(q.questionId), '已复制 reply_question 参数'),
          }, '复制答复参数'),
        ),
      ),
      () => {},
    );
  } else {
    alertsEl.hidden = true;
    alertsEl.replaceChildren();
  }

  const running = agents.filter(a => isWorking(a.status));
  if (!running.length) {
    nowEl.replaceChildren(el('span', { className: 'muted' }, '当前没有运行中的子代理'));
    return;
  }
  morph(nowEl, running.slice(0, 6), a => a.id,
    a => el('button', { type: 'button', className: 'now-pill', onclick: () => onSelect(a.id) }),
    (btn, a) => {
      const tool = a.currentTools?.at(-1);
      btn.textContent = `${a.name || a.id.slice(0, 8)} · ${tool ? `工具 ${tool}` : statusLabel(a.status)}`;
    },
  );
}

export function showMenu(menuEl, x, y, items) {
  menuEl.replaceChildren(...items.map(item =>
    el('button', {
      type: 'button',
      className: 'menu-item',
      disabled: !!item.disabled,
      onclick: async () => {
        menuEl.hidden = true;
        try { await item.onClick(); }
        catch (error) { showToast(error?.message || '操作失败'); }
      },
    }, item.label),
  ));
  menuEl.hidden = false;
  menuEl.style.left = `${Math.min(window.innerWidth - 188, Math.max(8, x))}px`;
  menuEl.style.top = `${Math.min(window.innerHeight - 200, Math.max(8, y))}px`;
}

export function openAgentMenu(menuEl, agent, x, y, actions) {
  const isBusy = isWorking(agent.status);
  showMenu(menuEl, x, y, [
    { label: '复制代理 ID', onClick: () => copyText(agent.id, '已复制代理 ID') },
    { label: '标为已完成', disabled: isBusy && !agent.marked, onClick: () => actions.onMark(agent.id, 'completed') },
    { label: '标为已关闭', disabled: isBusy && !agent.marked, onClick: () => actions.onMark(agent.id, 'closed') },
    { label: '取消手动标记', disabled: !agent.marked, onClick: () => actions.onMark(agent.id, null) },
    { label: '移动分组', onClick: () => actions.onMove(agent) },
  ]);
}

export function openGroupMenu(menuEl, group, rect, actions) {
  const markable = group.agents.filter(a => !isWorking(a.status) || a.marked);
  const markedAny = group.agents.some(a => a.marked);
  showMenu(menuEl, rect.left, rect.bottom + 4, [
    { label: '重命名分组', onClick: () => actions.onRename(group) },
    { label: `整组标为已完成 (${markable.length})`, disabled: !markable.length, onClick: () => actions.onBatchMark(markable, 'completed') },
    { label: '整组取消标记', disabled: !markedAny, onClick: () => actions.onBatchMark(group.agents.filter(a => a.marked), null) },
  ]);
}

export function openRenameDialog(dialogEl, group, currentName, onSubmit) {
  const input = el('input', { type: 'text', className: 'input', value: currentName || group.title, maxlength: 60 });
  const form = el('form', {
    className: 'dialog-box',
    onsubmit: async e => {
      e.preventDefault();
      try {
        await onSubmit(group.key, input.value.trim() || null);
        dialogEl.close();
      } catch (error) {
        showToast(error?.message || '重命名失败');
      }
    },
  },
  el('div', { className: 'dialog-head' }, el('strong', {}, '重命名分组')),
  el('div', { className: 'dialog-body' }, input),
  el('div', { className: 'dialog-foot' },
    el('button', { type: 'button', className: 'btn btn-xs', onclick: () => dialogEl.close() }, '取消'),
    el('button', { type: 'submit', className: 'btn btn-xs btn-primary' }, '保存'),
  ));
  dialogEl.replaceChildren(form);
  dialogEl.showModal();
  input.focus();
}

export function openMoveDialog(dialogEl, agent, onSubmit) {
  const input = el('input', { type: 'text', className: 'input', value: agent.movedTo || '', maxlength: 300, placeholder: '留空则回到原父会话分组' });
  const form = el('form', {
    className: 'dialog-box',
    onsubmit: async e => {
      e.preventDefault();
      try {
        await onSubmit(agent.id, input.value.trim() || null);
        dialogEl.close();
      } catch (error) {
        showToast(error?.message || '移动失败');
      }
    },
  },
  el('div', { className: 'dialog-head' }, el('strong', {}, '移动会话分组')),
  el('div', { className: 'dialog-body' }, input),
  el('div', { className: 'dialog-foot' },
    el('button', { type: 'button', className: 'btn btn-xs', onclick: () => dialogEl.close() }, '取消'),
    el('button', { type: 'submit', className: 'btn btn-xs btn-primary' }, '确定'),
  ));
  dialogEl.replaceChildren(form);
  dialogEl.showModal();
  input.focus();
}

function renderQuotaCard(item) {
  if (item.status === 'error') {
    return el('div', { className: 'quota-card err' },
      el('div', { className: 'quota-head' }, el('strong', {}, item.provider), el('span', { className: 'badge badge-fail' }, '查询失败')),
      el('div', { className: 'muted' }, item.error || '未知错误'),
    );
  }
  const q = item.quota || {};
  const lines = [];
  for (const w of q.windows || []) {
    const rem = Number.isFinite(w.remainingPercent) ? `${w.remainingPercent.toFixed(1)}% 剩余` : '剩余未知';
    const reset = w.resetsAt ? ` · 重置 ${fullDate(w.resetsAt)}` : '';
    lines.push(el('div', { className: 'quota-line' }, `${w.kind}${w.service ? ` (${w.service})` : ''}: ${rem}${reset}`));
  }
  for (const b of q.balances || []) {
    lines.push(el('div', { className: 'quota-line' }, `余额 ${b.total} ${b.currency} (充 ${b.toppedUp} / 赠 ${b.granted})`));
  }
  for (const w of q.warnings || []) {
    lines.push(el('div', { className: 'quota-warn' }, w));
  }
  return el('div', { className: 'quota-card' },
    el('div', { className: 'quota-head' },
      el('strong', {}, item.provider),
      q.plan ? el('span', { className: 'badge badge-dim' }, q.plan) : null,
    ),
    lines.length ? lines : el('div', { className: 'muted' }, '暂无窗口明细'),
  );
}

export async function renderSystemDialog(dialogEl, apiFetch, forceQuota = false) {
  dialogEl.replaceChildren(el('div', { className: 'dialog-box dialog-wide' },
    el('div', { className: 'dialog-head' },
      el('strong', {}, '运行状态与账号额度（只读）'),
      el('div', { className: 'btn-row' },
        el('button', { type: 'button', className: 'btn btn-xs', onclick: () => renderSystemDialog(dialogEl, apiFetch, true) }, '刷新额度'),
        el('button', { type: 'button', className: 'btn btn-xs', onclick: () => dialogEl.close() }, '关闭'),
      ),
    ),
    el('div', { className: 'dialog-body' }, '加载中…'),
  ));
  if (!dialogEl.open) dialogEl.showModal();
  const body = dialogEl.querySelector('.dialog-body');
  try {
    const [sys, quota] = await Promise.all([
      apiFetch('/api/system'),
      apiFetch(`/api/quota${forceQuota ? '?refresh=1' : ''}`),
    ]);
    const ctrl = sys.controller;
    const cText = ctrl ? `${ctrl.alive ? '在线' : '已停止'} · PID ${ctrl.pid || '-'} · 版本 ${ctrl.version || '-'}` : '未启动控制进程';
    body.replaceChildren(
      el('div', { className: 'sys-grid' },
        kvRow('独立控制进程', cText),
        kvRow('Web 面板进程', `PID ${sys.dashboardPid} · 模型目录 ${sys.modelCount} 个`),
        kvRow('子代理统计', `共 ${sys.counts.total} · 工作中 ${sys.counts.working} · 等答复 ${sys.counts.waiting} · 已完成 ${sys.counts.completed}${sys.counts.interrupted ? ` · 已中断 ${sys.counts.interrupted}` : ''} · 异常 ${sys.counts.failed + sys.counts.disconnected}`),
      ),
      el('div', { className: 'sec-title' }, `活跃事件监听器 (${sys.watchers.length})`),
      sys.watchers.length
        ? el('div', { className: 'watcher-list' }, sys.watchers.map(w =>
            el('div', { className: 'watcher-row' }, `PID ${w.pid} · 会话 ${w.sessionId || '-'} · 启动于 ${clock(w.startedAt)}`),
          ))
        : el('div', { className: 'muted' }, '当前没有运行中的后台 wait-events 监听进程'),
      el('div', { className: 'sec-title' }, `模型额度（查询于 ${clock(quota.queriedAt)}${quota.cached ? ' · 60秒缓存' : ''}）`),
      quota.error
        ? el('div', { className: 'err-card' }, quota.error)
        : quota.results?.length
          ? el('div', { className: 'quota-grid' }, quota.results.map(renderQuotaCard))
          : el('div', { className: 'muted' }, '未检测到已配置的支持查询的提供商凭据'),
    );
  } catch (error) {
    body.textContent = `加载失败：${error.message}`;
  }
}
