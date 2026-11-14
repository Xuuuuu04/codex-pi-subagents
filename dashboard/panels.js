import {
  el, clock, fullDate, compactNumber,
  statusLabel, agentHost, hostMeta, copyText, replyPayload,
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

export function renderStatusPanel(container, detail, handlers) {
  container.replaceChildren();
  if (!detail?.agent) {
    container.append(el('div', { className: 'empty-mini' }, '选择一个子代理以查看详情'));
    return;
  }
  const a = detail.agent;
  const host = hostMeta(agentHost(a));
  const sessionId = a.parentInfo?.sessionId || a.callback?.antigravitySessionId || a.callback?.claudeSessionId || a.callback?.codexThreadId || null;
  const isBusy = ['starting', 'running', 'finishing'].includes(a.status);
  const canMark = !isBusy || a.marked;

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
  const metaList = el('div', { className: 'kv-list' },
    kvRow('代理编号', el('code', {}, a.id)),
    kvRow('父会话编号', sessionNode),
    kvRow('回调与唤醒', cbText),
    kvRow('模型与思考', `${a.model?.provider || '-'}/${a.model?.model || '-'} · ${a.thinking || '-'}`),
    a.temporaryModel ? kvRow('临时升级原模型', `${a.temporaryModel.model?.provider}/${a.temporaryModel.model?.model} (待恢复)`) : null,
    kvRow('工作区模式', `${a.workspaceMode || '-'}${a.ownedPaths?.length ? ` · 范围: ${a.ownedPaths.join(', ')}` : ''}`),
    kvRow('工作目录', el('code', { className: 'wrap-code' }, a.cwd || '-')),
    kvRow('Token 用量', `总 ${compactNumber(usage.totalTokens || 0)} · 输入 ${compactNumber(usage.input || 0)} · 输出 ${compactNumber(usage.output || 0)} · 缓存读 ${compactNumber(usage.cacheRead || 0)}`),
    kvRow('序号 / 更新', `seq ${a.sequence || 0} · ${fullDate(a.updatedAt || a.createdAt)}`),
  );

  const actWrap = el('div', { className: 'panel-sec' },
    el('div', { className: 'sec-title' }, `工具活动（累计 ${a.activity?.toolCalls || 0} 次，报错 ${a.activity?.toolErrors || 0} 次）`),
  );
  const sparkBox = el('div', {});
  renderActivitySpark(sparkBox, a.activity);
  actWrap.append(sparkBox);

  const actions = el('div', { className: 'panel-actions' },
    el('div', { className: 'sec-title' }, '面板整理（只影响本页面显示）'),
    el('div', { className: 'btn-row' },
      el('button', { type: 'button', className: 'btn btn-xs', disabled: !canMark, onclick: () => handlers.onMark(a.id, 'completed') }, '标为已完成'),
      el('button', { type: 'button', className: 'btn btn-xs', disabled: !canMark, onclick: () => handlers.onMark(a.id, 'closed') }, '标为已关闭'),
      a.marked ? el('button', { type: 'button', className: 'btn btn-xs', onclick: () => handlers.onMark(a.id, null) }, '取消标记') : null,
      el('button', { type: 'button', className: 'btn btn-xs', onclick: () => handlers.onMoveDialog(a) }, '移动分组'),
    ),
    !canMark ? el('div', { className: 'muted' }, '正在工作的会话不允许手动标记。') : null,
  );

  container.append(head, questionsBox, errorBox, metaList, actWrap, actions);
}

export function renderSpeedPanel(container, detail, liveSpeed, tipEl) {
  container.replaceChildren();
  const speeds = detail?.speeds || [];
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
  container.append(grid, chartBox);
}

export function renderContextPanel(container, detail) {
  container.replaceChildren();
  const chartBox = el('div', { className: 'panel-sec' });
  renderContextChart(chartBox, detail?.context);
  container.append(chartBox);

  const sections = detail?.context?.sections || [];
  if (Array.isArray(sections) && sections.length) {
    container.append(el('div', { className: 'panel-sec' },
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
    container.append(el('div', { className: 'panel-sec' },
      el('div', { className: 'sec-title' }, '内容来源估算'),
      labels.map(([k, title]) => el('div', { className: 'sec-row' },
        el('span', {}, title),
        el('span', { className: 'muted' }, `${compactNumber(parts[k] || 0)} tok`),
      )),
    ));
  }
}

export function renderLanePanel(container, detail) {
  renderToolLane(container, detail?.agent?.events || []);
}

export async function renderChangesPanel(container, agentId, cache, apiFetch) {
  container.replaceChildren(
    el('div', { className: 'btn-row' },
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        onclick: async () => {
          delete cache[agentId];
          await renderChangesPanel(container, agentId, cache, apiFetch);
        },
      }, '刷新 Git 改动'),
    ),
  );
  if (!agentId) return;
  let data = cache[agentId];
  if (!data) {
    const loading = el('div', { className: 'empty-mini' }, '正在读取只读 Git 差异…');
    container.append(loading);
    try {
      data = await apiFetch(`/api/agents/${agentId}/changes`);
      cache[agentId] = data;
      loading.remove();
    } catch (error) {
      loading.textContent = `无法获取改动：${error.message}`;
      return;
    }
  }
  const files = data.files || data.changedFiles || [];
  container.append(
    el('div', { className: 'muted' }, `工作目录: ${data.cwd || '-'} · 改动文件 ${files.length} 个`),
    files.length
      ? el('ul', { className: 'file-list' }, files.slice(0, 80).map(f =>
          el('li', {}, `${f.status || ''} ${f.path || f}`),
        ))
      : el('div', { className: 'empty-mini' }, '当前工作目录干净，无未提交改动'),
    data.diff ? el('pre', { className: 'code-block diff-block' }, data.diff) : null,
  );
}
