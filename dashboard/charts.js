import { el, svg, compactNumber, shortDuration, clock } from './dom.js';

export function renderDistBar(container, counts) {
  container.replaceChildren();
  const segments = [
    { key: 'working', label: '工作中', color: 'var(--run)', count: counts.working || 0 },
    { key: 'waiting', label: '等待答复', color: 'var(--wait)', count: counts.waiting || 0 },
    { key: 'done', label: '已完成/停止', color: 'var(--brand)', count: counts.done || 0 },
    { key: 'issue', label: '失败/断开', color: 'var(--fail)', count: counts.issue || 0 },
  ];
  const total = segments.reduce((sum, s) => sum + s.count, 0);
  if (!total) {
    container.append(el('div', { className: 'dist-empty' }, '暂无会话'));
    return;
  }
  const bar = el('div', { className: 'dist-track' });
  const legend = el('div', { className: 'dist-legend' });
  for (const seg of segments) {
    if (!seg.count) continue;
    const pct = (seg.count / total) * 100;
    bar.append(el('div', {
      className: 'dist-seg',
      style: { width: `${pct}%`, background: seg.color },
      title: `${seg.label}: ${seg.count}`,
    }));
    legend.append(el('span', { className: 'dist-item' },
      el('span', { className: 'dot', style: { background: seg.color } }),
      `${seg.label} ${seg.count}`,
    ));
  }
  container.append(bar, legend);
}

function bindTip(node, tipEl, getText) {
  if (!tipEl) return;
  node.addEventListener('mouseenter', () => {
    tipEl.textContent = getText();
    tipEl.hidden = false;
  });
  node.addEventListener('mousemove', event => {
    const pad = 12;
    tipEl.style.left = `${Math.min(window.innerWidth - tipEl.offsetWidth - pad, event.clientX + 14)}px`;
    tipEl.style.top = `${Math.max(pad, event.clientY - tipEl.offsetHeight - 10)}px`;
  });
  node.addEventListener('mouseleave', () => {
    tipEl.hidden = true;
  });
}

export function renderSpeedChart(container, speeds = [], live = null, tipEl = null) {
  container.replaceChildren();
  const points = (speeds || []).slice(-24).map((item, idx) => ({
    label: item.at ? clock(item.at) : `#${idx + 1}`,
    tps: Number(item.tps) || 0,
    tokens: item.output || 0,
    ms: (item.seconds || 0) * 1000,
    live: false,
  }));
  if (live && (Number.isFinite(live.rate) || live.request)) {
    const req = live.request;
    const elapsedMs = req?.startedAt ? Math.max(0, Date.now() - Date.parse(req.startedAt)) : 0;
    points.push({
      label: '实时',
      tps: Number(live.rate) || 0,
      tokens: req?.tokens || 0,
      ms: elapsedMs,
      live: true,
    });
  }
  if (!points.length) {
    container.append(el('div', { className: 'empty-mini' }, '暂无输出速度采样'));
    return;
  }

  const width = 420;
  const height = 148;
  const padL = 36;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const maxTps = Math.max(10, ...points.map(p => p.tps));
  const step = innerW / points.length;
  const barW = Math.max(6, Math.min(22, step * 0.62));

  const gridLines = [0, 0.5, 1].map(ratio => {
    const y = padT + innerH * (1 - ratio);
    return [
      svg('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'chart-grid' }),
      svg('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-axis' }, Math.round(maxTps * ratio)),
    ];
  });

  const coords = [];
  const bars = points.map((p, i) => {
    const h = Math.max(2, (p.tps / maxTps) * innerH);
    const x = padL + i * step + (step - barW) / 2;
    const y = padT + innerH - h;
    coords.push(`${(x + barW / 2).toFixed(1)},${y.toFixed(1)}`);
    const rect = svg('rect', {
      x: x.toFixed(1),
      y: y.toFixed(1),
      width: barW.toFixed(1),
      height: h.toFixed(1),
      rx: 3,
      class: p.live ? 'chart-bar live' : 'chart-bar',
    });
    bindTip(rect, tipEl, () => `${p.label} · ${p.tps.toFixed(1)} tok/s · ${compactNumber(p.tokens)} tok · ${shortDuration(p.ms)}`);
    return rect;
  });

  const line = coords.length > 1
    ? svg('polyline', { points: coords.join(' '), fill: 'none', class: 'chart-line' })
    : null;
  const labels = [points[0], points[Math.floor(points.length / 2)], points.at(-1)]
    .filter((p, idx, arr) => p && arr.indexOf(p) === idx)
    .map(p => {
      const idx = points.indexOf(p);
      const x = padL + idx * step + step / 2;
      return svg('text', { x: x.toFixed(1), y: height - 6, 'text-anchor': 'middle', class: 'chart-axis' }, p.label);
    });

  container.append(svg('svg', { viewBox: `0 0 ${width} ${height}`, className: 'chart-svg' }, gridLines, bars, line, labels));
}

export function renderActivitySpark(container, activity) {
  container.replaceChildren();
  const buckets = activity?.buckets || [];
  if (!Array.isArray(buckets) || !buckets.length) {
    container.append(el('div', { className: 'empty-mini' }, '暂无近期工具频率数据'));
    return;
  }
  const vals = buckets.slice(-20);
  const max = Math.max(1, ...vals);
  const w = 260;
  const h = 44;
  const step = w / vals.length;
  const bars = vals.map((v, i) => {
    const bh = Math.max(2, (v / max) * (h - 8));
    return svg('rect', {
      x: (i * step + 1.5).toFixed(1),
      y: (h - bh - 2).toFixed(1),
      width: Math.max(3, step - 3).toFixed(1),
      height: bh.toFixed(1),
      rx: 2,
      class: v ? 'spark-bar active' : 'spark-bar',
    });
  });
  container.append(svg('svg', { viewBox: `0 0 ${w} ${h}`, className: 'spark-svg' }, bars));
}

export function renderContextChart(container, context) {
  container.replaceChildren();
  if (!context) {
    container.append(el('div', { className: 'empty-mini' }, '暂无上下文估算数据'));
    return;
  }
  const windowSize = context.contextWindow || 0;
  const totalUsed = context.used || 0;
  const cached = Math.min(totalUsed, context.cached || 0);
  const systemTokens = (context.sections || []).reduce((sum, s) => sum + (s.tokens || 0), 0);
  const uncached = Math.max(0, totalUsed - cached);
  const effectiveTotal = totalUsed || systemTokens + Object.values(context.parts || {}).reduce((a, b) => a + b, 0);
  const cap = windowSize || Math.max(effectiveTotal, 1);
  const pct = Math.min(100, Math.round((effectiveTotal / cap) * 100));

  const segs = totalUsed
    ? [
        { label: '缓存命中 (cacheRead)', value: cached, color: 'var(--brand)' },
        { label: '未缓存输入', value: uncached, color: 'var(--run)' },
      ]
    : [
        { label: '系统提示', value: systemTokens, color: '#6366f1' },
        { label: '对话与工具', value: Math.max(0, effectiveTotal - systemTokens), color: 'var(--run)' },
      ];

  const track = el('div', { className: 'ctx-track' },
    segs.filter(s => s.value > 0).map(s => el('div', {
      className: 'ctx-seg',
      style: { width: `${Math.min(100, (s.value / cap) * 100)}%`, background: s.color },
      title: `${s.label}: ${compactNumber(s.value)} tokens`,
    })),
  );

  const summary = el('div', { className: 'ctx-meta' },
    el('span', {}, `当前上下文 ${compactNumber(effectiveTotal)}${windowSize ? ` / ${compactNumber(windowSize)}` : ''} tokens · 峰值 ${compactNumber(context.peak || 0)}`),
    el('span', { className: pct >= 85 ? 'bad' : '' }, windowSize ? `${pct}%` : '窗口未知'),
  );
  const stats = el('div', { className: 'ctx-sub muted' },
    `请求 ${context.requests || 0} 次 · 缓存命中 ${compactNumber(cached)} · 压缩 ${context.compactions || 0} 次`,
  );
  container.append(summary, track, stats);
}

export function renderToolLane(container, events = []) {
  const lastEv = events.at(-1);
  const digest = JSON.stringify([events.length, lastEv?.sequence, lastEv?.type, lastEv?.toolCallId, lastEv?.isError]);
  if (container.dataset.digest === digest && container.childElementCount > 0) return;
  container.dataset.digest = digest;
  container.replaceChildren();
  const runs = [];
  const byId = new Map();
  for (const ev of events) {
    if (ev.type === 'tool_execution_start') {
      const item = {
        id: ev.toolCallId || `${ev.sequence}`,
        name: ev.toolName || 'tool',
        start: ev.time ? Date.parse(ev.time) : null,
        end: null,
        status: 'running',
      };
      byId.set(item.id, item);
      runs.push(item);
    } else if (ev.type === 'tool_execution_end') {
      const existing = byId.get(ev.toolCallId);
      const end = ev.time ? Date.parse(ev.time) : null;
      if (existing) {
        existing.end = end;
        existing.status = ev.isError ? 'error' : 'ok';
      } else {
        runs.push({ id: ev.toolCallId || `${ev.sequence}`, name: ev.toolName || 'tool', start: end, end, status: ev.isError ? 'error' : 'ok' });
      }
    }
  }
  const recent = runs.slice(-40).reverse();
  if (!recent.length) {
    container.append(el('div', { className: 'empty-mini' }, '暂无工具调用记录'));
    return;
  }
  for (const run of recent) {
    const dur = Number.isFinite(run.start) && Number.isFinite(run.end) ? shortDuration(Math.max(0, run.end - run.start)) : run.status === 'running' ? '执行中' : '-';
    const badge = run.status === 'running' ? '执行中' : run.status === 'error' ? '报错' : '完成';
    container.append(el('div', { className: `lane-row lane-${run.status}` },
      el('span', { className: 'lane-name' }, run.name),
      el('span', { className: 'lane-time' }, run.start ? clock(new Date(run.start).toISOString()) : '-'),
      el('span', { className: 'lane-dur' }, dur),
      el('span', { className: `pill pill-${run.status}` }, badge),
    ));
  }
}
