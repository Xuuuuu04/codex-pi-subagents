// 图表：平滑面积图、柱状图、环形仪表、悬停提示与数字缓动。只生成 SVG，不依赖外部库；svg() 来自 app.js（调用时才读取）。

/* ---------- 悬停提示（全局唯一，跟随指针） ---------- */
function showTip(lines, x, y) {
  const tip = document.getElementById('chart-tip'); tip.replaceChildren();
  lines.forEach((line, index) => { if (index) tip.append('\n'); if (Array.isArray(line)) tip.append(...line.map(part => typeof part === 'string' ? part : Object.assign(document.createElement('b'), { textContent: part.b }))); else tip.append(line); });
  tip.hidden = false;
  const half = tip.offsetWidth / 2 + 8; tip.style.left = `${Math.min(innerWidth - half, Math.max(half, x))}px`; tip.style.top = `${Math.max(tip.offsetHeight + 16, y)}px`;
}
function hideTip() { document.getElementById('chart-tip').hidden = true; }
/** 给带 data-tip 的 SVG 元素统一挂提示：内容按 \n 分行。 */
function bindTips(root) {
  root.addEventListener('pointermove', event => { const target = event.target.closest?.('[data-tip]'); if (!target) { hideTip(); return; } showTip(target.getAttribute('data-tip').split('\n'), event.clientX, event.clientY); });
  root.addEventListener('pointerleave', hideTip);
}

/* ---------- 平滑曲线：单调三次插值，不会冲出数据范围 ---------- */
function smoothPath(points) {
  if (points.length < 2) return points.length ? `M${points[0][0]},${points[0][1]}` : '';
  const n = points.length; const dx = []; const slope = [];
  for (let i = 0; i < n - 1; i++) { dx.push(points[i + 1][0] - points[i][0]); slope.push(dx[i] ? (points[i + 1][1] - points[i][1]) / dx[i] : 0); }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (!slope[i]) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i]; const b = m[i + 1] / slope[i]; const h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * slope[i]; m[i + 1] = t * b * slope[i]; }
  }
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]; const [x1, y1] = points[i + 1]; const h = dx[i] / 3;
    d += ` C${(x0 + h).toFixed(1)},${(y0 + m[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - m[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
let gradientId = 0;
function gradient(chart, color, top = .32) {
  const id = `g${++gradientId}`; const defs = svg('defs'); const g = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': top }), svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
  defs.append(g); chart.append(defs); return `url(#${id})`;
}
const niceMax = value => { if (value <= 0) return 1; const p = 10 ** Math.floor(Math.log10(value)); const f = value / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };

/**
 * 面积图：series 每条为 { values: [{ x, y }], color, label }，x 为数字（时间或序号）。
 * tooltip(index) 返回提示行；refLines 为水平参考线 { y, cls }。悬停时显示十字线与各条数据点。
 */
function areaChart({ width = 300, height = 96, series, yMax, xMin, xMax, tooltip, refLines = [], animate = false, ticks = 3, format = v => v }) {
  const pad = { top: 6, right: 4, bottom: 4, left: 0 };
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' });
  chart.style.height = `${height}px`;
  const all = series.flatMap(s => s.values);
  if (!all.length) return chart;
  const x0 = xMin ?? Math.min(...all.map(p => p.x)); const x1 = Math.max(xMax ?? Math.max(...all.map(p => p.x)), x0 + 1);
  const top = yMax ?? niceMax(Math.max(...all.map(p => p.y), ...refLines.map(r => r.y)) * 1.08);
  const X = x => pad.left + (x - x0) / (x1 - x0) * (width - pad.left - pad.right);
  const Y = y => height - pad.bottom - Math.min(1, y / top) * (height - pad.top - pad.bottom);
  for (let i = 1; i <= ticks; i++) { const gy = Y(top * i / ticks); chart.append(svg('line', { x1: 0, x2: width, y1: gy, y2: gy, class: 'grid dash' })); }
  chart.append(svg('line', { x1: 0, x2: width, y1: height - pad.bottom, y2: height - pad.bottom, class: 'grid' }));
  for (const ref of refLines) chart.append(svg('line', { x1: 0, x2: width, y1: Y(ref.y), y2: Y(ref.y), class: ref.cls || 'avg' }));
  for (const s of series) {
    const points = s.values.map(p => [X(p.x), Y(p.y)]); if (!points.length) continue;
    const d = smoothPath(points);
    if (s.fill !== false) chart.append(svg('path', { d: `${d} L${points.at(-1)[0].toFixed(1)},${height - pad.bottom} L${points[0][0].toFixed(1)},${height - pad.bottom} Z`, fill: gradient(chart, s.color, s.opacity ?? .28), class: 'area' }));
    const line = svg('path', { d, stroke: s.color, class: `line ${animate ? 'draw' : ''}` }); chart.append(line);
    if (animate) requestAnimationFrame(() => { try { line.style.setProperty('--len', line.getTotalLength()); } catch {} });
    if (s.dot !== false) { const last = points.at(-1); chart.append(svg('circle', { cx: last[0], cy: last[1], r: 3, fill: s.color, class: 'pt' })); }
  }
  if (tooltip) {
    const base = series[0].values; const cross = svg('line', { y1: pad.top, y2: height - pad.bottom, class: 'cross', visibility: 'hidden' });
    const marks = series.map(s => svg('circle', { r: 3.5, fill: s.color, class: 'pt', visibility: 'hidden' }));
    const hit = svg('rect', { x: 0, y: 0, width, height, fill: 'transparent' });
    chart.append(cross, ...marks, hit);
    hit.addEventListener('pointermove', event => {
      const box = chart.getBoundingClientRect(); const px = (event.clientX - box.left) / box.width * width;
      let index = 0, best = Infinity; base.forEach((p, i) => { const dist = Math.abs(X(p.x) - px); if (dist < best) { best = dist; index = i; } });
      const cx = X(base[index].x); cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      series.forEach((s, i) => { const p = s.values[index]; if (!p) return; marks[i].setAttribute('cx', X(p.x)); marks[i].setAttribute('cy', Y(p.y)); marks[i].setAttribute('visibility', 'visible'); });
      showTip(tooltip(index), box.left + cx / width * box.width, box.top + Y(base[index].y) / height * box.height);
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); marks.forEach(m => m.setAttribute('visibility', 'hidden')); hideTip(); });
  }
  chart.dataset.max = format(top);
  return chart;
}

/** 柱状图：items 为 { v, tip }，最后一根高亮；可画平均线。 */
function barChart({ width = 300, height = 56, items, color = 'var(--brand)', average, animate = false }) {
  const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' });
  chart.style.height = `${height}px`;
  if (!items.length) return chart;
  const top = niceMax(Math.max(...items.map(i => i.v), average || 0) * 1.1); const gap = items.length > 40 ? 1 : 2;
  const bar = Math.max(2, (width - gap * (items.length - 1)) / items.length);
  chart.append(svg('line', { x1: 0, x2: width, y1: height - .5, y2: height - .5, class: 'grid' }));
  items.forEach((item, index) => {
    const h = Math.max(2, item.v / top * (height - 2)); const x = index * (bar + gap);
    const rect = svg('rect', { x, y: height - h, width: bar, height: h, rx: Math.min(2.5, bar / 2), fill: color, opacity: index === items.length - 1 ? 1 : .42, class: `bar ${animate ? 'grow' : ''}`, 'data-tip': item.tip });
    if (animate) rect.style.animationDelay = `${index * 18}ms`;
    chart.append(rect);
  });
  if (average) chart.append(svg('line', { x1: 0, x2: width, y1: height - average / top * (height - 2), y2: height - average / top * (height - 2), class: 'avg' }));
  bindTips(chart);
  return chart;
}

/** 环形仪表：fraction 0–1，颜色随占用升高变化。 */
function gauge(fraction, label, sub) {
  const size = 112, r = 46, c = 2 * Math.PI * r; const f = Math.max(0, Math.min(1, fraction || 0));
  const color = f > .85 ? 'var(--fail)' : f > .65 ? 'var(--wait)' : 'var(--brand)';
  const box = svg('svg', { class: 'gauge', viewBox: `0 0 ${size} ${size}`, role: 'img' });
  const fill = svg('circle', { cx: size / 2, cy: size / 2, r, class: 'fill', stroke: color, 'stroke-dasharray': c, 'stroke-dashoffset': c });
  box.append(svg('circle', { cx: size / 2, cy: size / 2, r, class: 'track' }), fill);
  const t1 = svg('text', { x: '50%', y: '50%', 'text-anchor': 'middle', class: 'pct', dy: '2' }); t1.textContent = label;
  const t2 = svg('text', { x: '50%', y: '50%', 'text-anchor': 'middle', class: 'pct-sub', dy: '19' }); t2.textContent = sub;
  box.append(t1, t2);
  requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute('stroke-dashoffset', c * (1 - f))));
  return box;
}

/** 数字缓动：从节点上次显示的值平滑过渡到新值。 */
function tweenNumber(node, to, format, duration = 600) {
  const from = Number(node.dataset.value); node.dataset.value = to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = format(to); return; }
  const start = performance.now(); cancelAnimationFrame(node._tween);
  const step = now => { const t = Math.min(1, (now - start) / duration); const e = 1 - (1 - t) ** 3; node.textContent = format(from + (to - from) * e); if (t < 1) node._tween = requestAnimationFrame(step); };
  node._tween = requestAnimationFrame(step);
}
