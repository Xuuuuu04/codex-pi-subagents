const svgNs = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value != null && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function morph(container, items, keyOf, createNode, updateNode) {
  const existing = new Map();
  for (const child of [...container.children]) {
    if (child.dataset?.k) existing.set(child.dataset.k, child);
  }
  const desired = [];
  for (const item of items) {
    const key = String(keyOf(item));
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
      if (updateNode) updateNode(node, item);
    } else {
      node = createNode(item);
      node.dataset.k = key;
    }
    desired.push(node);
  }
  for (const leftover of existing.values()) leftover.remove();
  desired.forEach((node, index) => {
    const current = container.children[index];
    if (current !== node) container.insertBefore(node, current || null);
  });
}

export function clock(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fullDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function compactNumber(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return String(Math.round(value));
}

export function safeHref(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (error) {
    if (error) return null;
    return null;
  }
}

const statusLabels = {
  starting: '启动中',
  running: '运行中',
  waiting: '等待答复',
  finishing: '收尾中',
  idle: '空闲',
  completed: '已完成',
  failed: '已失败',
  closed: '已关闭',
  stopped: '已停止',
  disconnected: '控制断开',
};

export const statusLabel = status => statusLabels[status] || status || '未知';

export function statusGroup(status) {
  if (['starting', 'running', 'finishing'].includes(status)) return 'working';
  if (status === 'waiting') return 'waiting';
  if (['completed', 'closed', 'idle', 'stopped'].includes(status)) return 'done';
  if (['failed', 'disconnected'].includes(status)) return 'issue';
  return 'other';
}

export function agentHost(agent) {
  const kind = (agent.parentInfo?.kind || agent.callback?.host || '').toLowerCase();
  if (kind.includes('antigravity') || agent.callback?.antigravitySessionId) return 'antigravity';
  if (kind.includes('claude') || agent.callback?.claudeSessionId) return 'claude';
  if (kind.includes('codex') || agent.callback?.codexThreadId) return 'codex';
  return 'other';
}

export function hostMeta(host) {
  if (host === 'antigravity') return { id: 'antigravity', label: 'Antigravity', short: 'AGY', cls: 'host-agy' };
  if (host === 'claude') return { id: 'claude', label: 'Claude Code', short: 'Claude', cls: 'host-claude' };
  if (host === 'codex') return { id: 'codex', label: 'Codex', short: 'Codex', cls: 'host-codex' };
  return { id: 'other', label: '其他会话', short: '本地', cls: 'host-other' };
}

let toastTimer = null;
export function showToast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

export async function copyText(text, label = '已复制') {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(String(text));
    showToast(`${label}：${String(text).slice(0, 36)}${String(text).length > 36 ? '…' : ''}`);
    return true;
  } catch (error) {
    if (error) showToast('剪贴板写入被浏览器拒绝');
    return false;
  }
}

export function replyPayload(questionId, answer = '<填写答复内容>') {
  return JSON.stringify({ questionId, answer }, null, 2);
}
