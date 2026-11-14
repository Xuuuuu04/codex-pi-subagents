import {
  el, clock, fullDate, compactNumber, isWorking, totalUsageTokens, agentSessionId,
  statusLabel, agentHost, hostMeta, showToast, copyText, replyPayload,
} from './dom.js';
import {
  renderSpeedChart, renderContextChart, renderActivitySpark, renderToolLane,
} from './charts.js';

export function kvRow(label, value, extra = null) {
  return el('div', { className: 'kv-row' },
    el('span', { className: 'kv-k' }, label),
    el('span', { className: 'kv-v' }, value, extra),
  );
}

function buildStatusMeta(a, sessionId) {
  const sessionNode = sessionId
    ? el('span', { className: 'inline-copy' },
        el('code', {}, sessionId),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          onclick: () => copyText(sessionId, '已复制会话编号'),
        }, '复制'),
      )
    : el('span', { className: 'muted' }, '未绑定');
  const cbText = a.callback
    ? `${a.callback.enabled ? '已开启' : '未开启'} · 已投递 seq ${a.callback.antigravityDeliveredSeq || 0}${a.callback.lastObservedBy ? ` (${a.callback.lastObservedBy})` : ''}`
    : '无回调记录';
  const usage = a.usage || {};
  const usageText = `总 ${compactNumber(totalUsageTokens(usage))} · 输入 ${compactNumber(usage.input || 0)} · 输出 ${compactNumber(usage.output || 0)} · 缓存读 ${compactNumber(usage.cacheRead || 0)}${usage.cacheWrite ? ` · 缓存写 ${compactNumber(usage.cacheWrite)}` : ''}`;
  return el('div', { className: 'kv-list' },
    kvRow('代理编号', el('code', {}, a.id)),
    kvRow('父会话编号', sessionNode),
    kvRow('回调与唤醒', cbText),
    kvRow('模型与思考', `${a.model?.provider || '-'}/${a.model?.model || '-'} · ${a.thinking || '-'}`),
    a.temporaryModel ? kvRow('临时升级原模型', `${a.temporaryModel.model?.provider}/${a.temporaryModel.model?.model} (待恢复)`) : null,
    kvRow('工作区模式', `${a.workspaceMode || '-'}${a.ownedPaths?.length ? ` · 范围: ${a.ownedPaths.join(', ')}` : ''}`),
    kvRow('工作目录', el('code', { className: 'wrap-code' }, a.cwd || '-')),
    kvRow('Token 用量', usageText),
    kvRow('序号 / 更新', `seq ${a.sequence || 0} · ${fullDate(a.updatedAt || a.createdAt)}`),
  );
}

function buildStatusActions(a, canMark, handlers) {
  const safeMark = status => Promise.resolve(handlers.onMark(a.id, status)).catch(error => showToast(error?.message || '操作失败'));
  return el('div', { className: 'panel-actions' },
    el('div', { className: 'sec-title' }, '面板整理（只影响本页面显示）'),
    el('div', { className: 'btn-row' },
      el('button', { type: 'button', className: 'btn btn-xs', disabled: !canMark, onclick: () => safeMark('completed') }, '标为已完成'),
      el('button', { type: 'button', className: 'btn btn-xs', disabled: !canMark, onclick: () => safeMark('closed') }, '标为已关闭'),
      a.marked ? el('button', { type: 'button', className: 'btn btn-xs', onclick: () => safeMark(null) }, '取消标记') : null,
      el('button', { type: 'button', className: 'btn btn-xs', onclick: () => handlers.onMoveDialog(a) }, '移动分组'),
    ),
    !canMark ? el('div', { className: 'muted' }, '正在工作的会话不允许手动标记。') : null,
  );
}

export function renderStatusPanel(container, detail, handlers) {
  if (!detail?.agent) {
    if (container.dataset.digest === '__empty__' && container.childElementCount > 0) return;
    container.dataset.digest = '__empty__';
    container.replaceChildren(el('div', { className: 'empty-mini' }, '选择一个子代理以查看详情'));
    return;
  }
  const a = detail.agent;
  const sessionId = agentSessionId(a);
  const digest = JSON.stringify([a.id, a.status, a.controllerAlive, a.watcherActive, a.marked, a.movedTo, a.error, a.updatedAt, a.sequence, a.questions, a.usage, a.activity, a.callback, sessionId, a.temporaryModel, a.model, a.thinking, a.workspaceMode, a.ownedPaths, a.cwd]);
  if (container.dataset.digest === digest && container.childElementCount > 0) return;
  container.dataset.digest = digest;

  const host = hostMeta(agentHost(a));
  const canMark = !isWorking(a.status) || a.marked;
  const head = el('div', { className: 'inspector-badges' },
    el('span', { className: `badge status-${a.status}` }, statusLabel(a.status)),
    el('span', { className: `badge ${host.cls}` }, host.label),
    el('span', { className: `badge ${a.controllerAlive ? 'badge-ok' : 'badge-dim'}` }, a.controllerAlive ? '控制进程在线' : '控制进程离线'),
    a.watcherActive ? el('span', { className: 'badge badge-watch' }, '正在监听事件') : null,
    a.marked ? el('span', { className: 'badge badge-warn' }, '面板已手动标记') : null,
  );
  const questionsBox = a.questions?.length
    ? el('div', { className: 'alert-stack' }, a.questions.map(q =>
        el('div', { className: 'q-card' },
          el('div', { className: 'q-title' }, '等待父会话答复'),
          el('div', { className: 'q-body' }, q.question),
          el('div', { className: 'q-foot' },
            el('span', { className: 'muted' }, clock(q.time)),
            el('button', {
              type: 'button',
              className: 'btn btn-xs btn-warn',
              onclick: () => copyText(replyPayload(q.questionId), '已复制 reply_question 参数'),
            }, '复制答复参数'),
          ),
        ),
      ))
    : null;
  const errorBox = a.error ? el('div', { className: 'err-card' }, a.error) : null;
  const sparkBox = el('div', {});
  renderActivitySpark(sparkBox, a.activity);
  const actWrap = el('div', { className: 'panel-sec' },
    el('div', { className: 'sec-title' }, `工具活动（累计 ${a.activity?.toolCalls || 0} 次，报错 ${a.activity?.toolErrors || 0} 次）`),
    sparkBox,
  );
  container.replaceChildren(head, questionsBox, errorBox, buildStatusMeta(a, sessionId), actWrap, buildStatusActions(a, canMark, handlers));
}

export function renderSpeedPanel(container, detail, liveSpeed, tipEl) {
  const speeds = detail?.speeds || [];
  const lastSpeed = speeds.at(-1);
  const digest = JSON.stringify([detail?.agent?.id || null, speeds.length, lastSpeed?.at ?? null, lastSpeed?.tps ?? null, liveSpeed?.rate ?? null, liveSpeed?.request?.phase || null, liveSpeed?.updatedAt || null]);
  if (container.dataset.digest === digest && container.childElementCount > 0) return;
  container.dataset.digest = digest;

  const latestRate = Number.isFinite(liveSpeed?.rate) ? liveSpeed.rate : speeds.at(-1)?.tps;
  const rates = speeds.map(s => s.tps).filter(n => Number.isFinite(n) && n > 0);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  const grid = el('div', { className: 'metric-grid' },
    el('div', { className: 'metric-box' },
      el('div', { className: 'metric-k' }, liveSpeed ? `实时 (${liveSpeed.request?.phase || '输出'})` : '最近吞吐'),
      el('div', { className: 'metric-v' }, Number.isFinite(latestRate) ? `${latestRate.toFixed(1)} tok/s` : '-'),
    ),
    el('div', { className: 'metric-box' },
      el('div', { className: 'metric-k' }, '平均吞吐'),
      el('div', { className: 'metric-v' }, avg ? `${avg.toFixed(1)} tok/s` : '-'),
    ),
    el('div', { className: 'metric-box' },
      el('div', { className: 'metric-k' }, '采样次数'),
      el('div', { className: 'metric-v' }, String(speeds.length)),
    ),
  );
  const chartBox = el('div', { className: 'chart-wrap' });
  renderSpeedChart(chartBox, speeds, liveSpeed, tipEl);
  container.replaceChildren(grid, chartBox);
}

export function renderContextPanel(container, detail) {
  const digest = JSON.stringify([detail?.agent?.id || null, detail?.context || null]);
  if (container.dataset.digest === digest && container.childElementCount > 0) return;
  container.dataset.digest = digest;

  const chartBox = el('div', { className: 'panel-sec' });
  renderContextChart(chartBox, detail?.context);
  const nodes = [chartBox];

  const sections = detail?.context?.sections || [];
  if (Array.isArray(sections) && sections.length) {
    nodes.push(el('div', { className: 'panel-sec' },
      el('div', { className: 'sec-title' }, '系统提示分段估算'),
      sections.map(sec => el('div', { className: 'sec-row' },
        el('span', {}, sec.name || sec.key || '分段'),
        el('span', { className: 'muted' }, `${compactNumber(sec.tokens || 0)} tok`),
      )),
    ));
  }

  const parts = detail?.context?.parts;
  if (parts) {
    const labels = [
      ['user', '任务输入'],
      ['assistant', '助手回复'],
      ['thinking', '思考内容'],
      ['toolCalls', '工具参数'],
      ['toolResults', '工具结果'],
    ];
    nodes.push(el('div', { className: 'panel-sec' },
      el('div', { className: 'sec-title' }, '内容来源估算'),
      labels.map(([k, title]) => el('div', { className: 'sec-row' },
        el('span', {}, title),
        el('span', { className: 'muted' }, `${compactNumber(parts[k] || 0)} tok`),
      )),
    ));
  }
  container.replaceChildren(...nodes);
}

export function renderLanePanel(container, detail) {
  renderToolLane(container, detail?.agent?.events || []);
}

export async function renderChangesPanel(container, agentId, cache, apiFetch, getSelectedId) {
  if (!agentId) {
    if (container.dataset.digest === '__empty__' && container.childElementCount > 0) return;
    container.dataset.digest = '__empty__';
    container.replaceChildren(el('div', { className: 'empty-mini' }, '选择一个子代理以查看目录改动'));
    return;
  }
  const existing = cache[agentId];
  const readyDigest = existing ? JSON.stringify([agentId, existing]) : '';
  if (readyDigest && container.dataset.digest === readyDigest && container.childElementCount > 0) return;

  const refreshRow = el('div', { className: 'btn-row' },
    el('button', {
      type: 'button',
      className: 'btn btn-xs',
      onclick: async () => {
        delete cache[agentId];
        delete container.dataset.digest;
        await renderChangesPanel(container, agentId, cache, apiFetch, getSelectedId);
      },
    }, '刷新 Git 改动'),
  );

  let data = existing;
  if (!data) {
    const loadingDigest = `loading:${agentId}`;
    if (container.dataset.digest === loadingDigest) return;
    container.dataset.digest = loadingDigest;
    const loading = el('div', { className: 'empty-mini' }, '正在读取只读 Git 差异…');
    container.replaceChildren(refreshRow, loading);
    try {
      data = await apiFetch(`/api/agents/${agentId}/changes`);
      if (getSelectedId && getSelectedId() !== agentId) return;
      cache[agentId] = data;
    } catch (error) {
      if (getSelectedId && getSelectedId() !== agentId) return;
      delete container.dataset.digest;
      loading.textContent = `无法获取改动：${error.message}`;
      return;
    }
  }

  container.dataset.digest = JSON.stringify([agentId, data]);
  const statusLines = Array.isArray(data.status)
    ? data.status.filter(Boolean)
    : typeof data.status === 'string' ? data.status.split('\n').filter(Boolean) : [];
  const commitsText = Array.isArray(data.commits)
    ? data.commits.filter(Boolean).join('\n')
    : typeof data.commits === 'string' ? data.commits : '';
  const summary = data.git === false
    ? `工作目录: ${data.cwd || '-'}（非 Git 仓库）`
    : `工作目录: ${data.cwd || '-'} · 分支 ${data.branch || '-'} · 基线 ${data.base || '-'} · 改动 ${statusLines.length} 项`;
  const emptyText = data.git === false
    ? (data.note || '当前目录不是 Git 仓库，无差异可显示')
    : '当前工作目录干净，无未提交改动';

  container.replaceChildren(
    refreshRow,
    el('div', { className: 'muted' }, summary),
    data.ownedPaths?.length ? el('div', { className: 'muted' }, `声明范围: ${data.ownedPaths.join(', ')}`) : null,
    data.note && data.git !== false ? el('div', { className: 'muted' }, data.note) : null,
    statusLines.length
      ? el('ul', { className: 'file-list' }, statusLines.slice(0, 80).map(line => el('li', {}, line)))
      : el('div', { className: 'empty-mini' }, emptyText),
    commitsText ? el('pre', { className: 'code-block' }, commitsText) : null,
    data.diffStat ? el('pre', { className: 'code-block' }, data.diffStat) : null,
    data.diff ? el('pre', { className: 'code-block diff-block' }, data.diff) : null,
    data.diffTruncated ? el('div', { className: 'muted' }, '差异内容已按大小限制截断') : null,
  );
}
