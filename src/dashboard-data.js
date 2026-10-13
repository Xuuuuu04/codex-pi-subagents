import fs from 'node:fs';
import path from 'node:path';
import { processAlive } from './storage.js';

const active = new Set(['starting', 'running', 'waiting', 'finishing', 'idle']);
const working = new Set(['starting', 'running', 'waiting', 'finishing']);
export const isAgentId = id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);

/** Read bounded, complete JSONL records while another process may still be appending. */
export function readTail(file, limit = 500) {
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 2 * 1024 * 1024);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    lines.pop(); // A writer may not have finished its last record.
    if (start) lines.shift();
    return lines.filter(Boolean).slice(-limit).map(line => JSON.parse(line));
  } finally { fs.closeSync(fd); }
}

/** Bound every string inside tool arguments so one huge write cannot flood the page. */
function clipValue(value, limit = 6000) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字）` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => clipValue(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, clipValue(item, limit)]));
  return value;
}
const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Project one saved session entry for display. Thinking text is shown; provider signatures and encrypted reasoning never are. */
export function transcriptMessage(entry, index = 0) {
  if (entry.type !== 'message' || !entry.message) return null;
  const m = entry.message;
  const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
  const base = { id: entry.id || `${entry.timestamp}-${index}`, role: m.role, time: entry.timestamp };
  if (m.role === 'toolResult') {
    const text = textOf(blocks);
    return { ...base, toolCallId: m.toolCallId, toolName: m.toolName, isError: !!m.isError, durationMs: m.durationMs,
      text: text.length > 6000 ? `…\n${text.slice(-6000)}` : text, diff: typeof m.details?.diff === 'string' ? m.details.diff.slice(0, 12000) : undefined,
      answer: typeof m.details?.answer === 'string' ? m.details.answer.slice(0, 6000) : undefined };
  }
  const thinkingBlocks = blocks.filter(b => b.type === 'thinking');
  const thinking = thinkingBlocks.map(b => b.thinking || '').filter(Boolean).join('\n\n');
  const calls = blocks.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, name: b.name, arguments: clipValue(b.arguments || {}) }));
  const text = textOf(blocks).slice(-12000);
  if (!text && !calls.length && !thinkingBlocks.length && m.role !== 'assistant') return null;
  return { ...base, text, calls, startedAt: typeof m.timestamp === 'number' ? new Date(m.timestamp).toISOString() : undefined,
    thinking: thinking.slice(-8000) || undefined, thinkingRedacted: thinkingBlocks.length > 0 && !thinking,
    stopReason: m.stopReason, error: m.stopReason === 'error' ? String(m.errorMessage || '').slice(0, 2000) : undefined };
}

/** Output speed of each finished model request: output tokens over request wall time, from the saved session. */
export function requestSpeeds(entries, limit = 40) {
  const speeds = [];
  for (const entry of entries) {
    const m = entry.message;
    if (entry.type !== 'message' || m?.role !== 'assistant' || !m.usage || typeof m.timestamp !== 'number') continue;
    const end = Date.parse(entry.timestamp); const seconds = (end - m.timestamp) / 1000;
    if (!(seconds > 0.2) || !m.usage.output) continue;
    speeds.push({ at: entry.timestamp, output: m.usage.output, seconds: Math.round(seconds * 100) / 100, tps: Math.round(m.usage.output / seconds * 10) / 10 });
  }
  return speeds.slice(-limit);
}

/** 粗略估算 token：中文约 1.3 字一个，其他约 3.8 个字符一个；只用来显示占比，不当作计费数字。 */
export function estimateTokens(text = '') {
  let cjk = 0; for (const ch of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return Math.round(cjk / 1.3 + (text.length - cjk) / 3.8);
}
const sectionNames = { preamble: '角色说明', tools: '工具说明', rules: '规则', docs: '文档', addendum: '附加说明', project_context: '项目说明', skills: '技能列表', cwd: '工作目录' };
/** 上下文分析：每次请求实际送进模型的 token（输入 + 缓存读写），以及按来源估算的构成。 */
export function contextAnalysis(head, entries, contextWindow) {
  const system = [...head, ...entries].find(e => e.type === 'message' && e.message?.role === 'system')?.message;
  const sections = Object.entries(system?.sections || {}).map(([key, value]) => ({ key, name: sectionNames[key] || key, tokens: estimateTokens(String(value)) })).filter(s => s.tokens > 0);
  const parts = { user: 0, assistant: 0, thinking: 0, toolCalls: 0, toolResults: 0 };
  const series = []; let compactions = 0;
  for (const entry of entries) {
    if (entry.type === 'compaction' || entry.type === 'compaction_summary') compactions++;
    const m = entry.message; if (entry.type !== 'message' || !m) continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const b of blocks) {
      const size = estimateTokens(b.type === 'thinking' ? b.thinking || '' : b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : b.text || '');
      if (m.role === 'user') parts.user += size; else if (m.role === 'toolResult') parts.toolResults += size;
      else if (m.role === 'assistant') parts[b.type === 'thinking' ? 'thinking' : b.type === 'toolCall' ? 'toolCalls' : 'assistant'] += size;
    }
    if (m.role === 'assistant' && m.usage) {
      const used = (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0);
      if (used) series.push({ at: entry.timestamp, used, cached: m.usage.cacheRead || 0, output: m.usage.output || 0, reasoning: m.usage.reasoning || 0 });
    }
  }
  const latest = series.at(-1);
  return { contextWindow: contextWindow || null, used: latest?.used || 0, cached: latest?.cached || 0, peak: Math.max(0, ...series.map(s => s.used)),
    series: series.slice(-120), sections, parts, compactions, requests: series.length };
}
/** 会话里出现过的 GitHub PR 链接（创建、查看或合并时的输出），按首次出现排序。 */
export function pullRequestLinks(entries) {
  const found = new Map(); const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
  for (const entry of entries) {
    const m = entry.message; if (entry.type !== 'message' || !m || m.role === 'system') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const text = blocks.map(b => b.text || (b.type === 'toolCall' ? JSON.stringify(b.arguments || {}) : '')).join('\n');
    for (const match of text.matchAll(pattern)) {
      const url = match[0]; const item = found.get(url) || { url, repo: match[1], number: Number(match[2]), firstAt: entry.timestamp, merged: false, created: false };
      if (/merged|已合并|gh pr merge/i.test(text)) item.merged = true;
      if (/gh pr create|Creating pull request|created pull request/i.test(text)) item.created = true;
      item.lastAt = entry.timestamp; found.set(url, item);
    }
  }
  return [...found.values()].slice(-30);
}

const minute = 60 * 1000;
/** Compact progress figures for the list: tool totals, last step and per-minute tool activity of the last 30 minutes. */
export function summarizeActivity(events, now = Date.now()) {
  const ends = events.filter(e => e.type === 'tool_execution_end');
  const buckets = Array(30).fill(0);
  for (const e of ends) {
    const age = Math.floor((now - Date.parse(e.time)) / minute);
    if (age >= 0 && age < 30) buckets[29 - age]++;
  }
  const last = events.at(-1);
  // Closing or resuming later must not stretch the time the agent actually worked.
  const lastWork = events.findLast(e => !['closed', 'resumed', 'ready'].includes(e.type));
  return { lastWorkAt: lastWork?.time, toolCalls: ends.length, toolErrors: ends.filter(e => e.isError).length, buckets,
    lastEvent: last && { type: last.type, time: last.time, toolName: last.toolName } };
}

/** Read-only projection of existing MCP records; never claim, resume or command an agent. */
export class DashboardData {
  constructor(root) { this.root = path.resolve(root); }
  directory(id) {
    if (!isAgentId(id)) throw new Error('Invalid agent ID');
    return path.join(this.root, id);
  }
  get marksFile() { return path.join(this.root, 'dashboard-marks.json'); }
  /** 面板自己的整理数据：每个会话的手动状态与所在分组，以及分组改名。旧版是 {id: {status, at}}，读取时兼容。 */
  marks() {
    try {
      const stat = fs.statSync(this.marksFile);
      if (this.marksCache?.mtime !== stat.mtimeMs) {
        const raw = JSON.parse(fs.readFileSync(this.marksFile, 'utf8'));
        const value = raw.agents || raw.groups ? { agents: raw.agents || {}, groups: raw.groups || {} } : { agents: raw, groups: {} };
        this.marksCache = { mtime: stat.mtimeMs, value };
      }
      return structuredClone(this.marksCache.value);
    } catch { return { agents: {}, groups: {} }; }
  }
  saveMarks(marks) {
    const temporary = `${this.marksFile}.tmp`; fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(marks), { mode: 0o600 }); fs.renameSync(temporary, this.marksFile);
  }
  /** 手动把会话在面板里标记为已结束或已关闭；status 为 null 时取消标记。只写面板自己的文件。 */
  mark(id, status) {
    this.directory(id);
    if (status !== null && !['completed', 'closed'].includes(status)) throw new Error('Mark must be completed, closed or null');
    const marks = this.marks(); const entry = marks.agents[id] || {};
    const current = this.snapshot(id).status;
    if (['starting', 'running', 'finishing'].includes(current) && !entry.status) throw new Error('正在工作的会话不能手动标记');
    if (status === null) { delete entry.status; delete entry.at; } else Object.assign(entry, { status, at: new Date().toISOString() });
    if (Object.keys(entry).length) marks.agents[id] = entry; else delete marks.agents[id];
    this.saveMarks(marks);
    return { id, status: this.snapshot(id).status, marked: status !== null };
  }
  /** 把会话挪到另一个分组（只影响面板）；group 为 null 时回到它的父会话分组。 */
  move(id, group) {
    this.directory(id);
    if (group !== null && (typeof group !== 'string' || !group.trim() || group.length > 300)) throw new Error('Invalid group');
    const marks = this.marks(); const entry = marks.agents[id] || {};
    if (group === null) delete entry.group; else entry.group = group.trim();
    if (Object.keys(entry).length) marks.agents[id] = entry; else delete marks.agents[id];
    this.saveMarks(marks);
    return { id, group };
  }
  /** 给分组起一个面板里显示的名字；name 为空时恢复默认名。 */
  renameGroup(key, name) {
    if (typeof key !== 'string' || !key || key.length > 300) throw new Error('Invalid group');
    if (name != null && (typeof name !== 'string' || name.length > 60)) throw new Error('Invalid name');
    const marks = this.marks();
    if (name?.trim()) marks.groups[key] = { ...marks.groups[key], name: name.trim() }; else delete marks.groups[key];
    this.saveMarks(marks);
    return { key, name: name?.trim() || null };
  }
  /** 模型目录由管理进程写入，用来显示上下文窗口。 */
  catalog() {
    try {
      const stat = fs.statSync(path.join(this.root, 'models-catalog.json'));
      if (this.catalogCache?.mtime !== stat.mtimeMs) this.catalogCache = { mtime: stat.mtimeMs, value: JSON.parse(fs.readFileSync(path.join(this.root, 'models-catalog.json'), 'utf8')) };
      return this.catalogCache.value;
    } catch { return []; }
  }
  snapshot(id) {
    const directory = this.directory(id);
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
    let controllerAlive = false;
    const lock = path.join(directory, 'owner.lock');
    if (fs.existsSync(lock)) {
      try { controllerAlive = processAlive(JSON.parse(fs.readFileSync(lock, 'utf8')).pid); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const events = readTail(path.join(directory, 'events.jsonl'));
    const pending = new Map();
    for (const event of events) {
      if (event.type === 'tool_execution_start') pending.set(event.toolCallId, event.toolName);
      if (event.type === 'tool_execution_end') pending.delete(event.toolCallId);
    }
    let status = !controllerAlive && active.has(record.status) ? 'disconnected' : record.status;
    // 手动标记只改变面板显示，不碰代理进程；正在跑的代理不允许标记。
    const mark = this.marks().agents[id] || {}; const marked = !!mark.status && (record.updatedAt || '') <= mark.at && !['starting', 'running', 'finishing'].includes(status);
    if (marked) status = mark.status;
    const questionIds = new Set(record.questionIds || []);
    const activity = summarizeActivity(events);
    return { id, name: record.name, status, recordedStatus: record.status, controllerAlive, marked, movedTo: mark.group, parentId: record.parentId, contextWindow: this.contextWindow(record.model), parentInfo: record.parentInfo,
      model: record.model, thinking: record.thinking, temporaryModel: record.restoreModel,
      cwd: record.workspace?.cwd, sourceCwd: record.workspace?.sourceCwd, workspaceMode: record.workspace?.mode,
      ownedPaths: record.ownedPaths, createdAt: record.createdAt, updatedAt: record.updatedAt,
      sequence: record.sequence, usage: record.usage, lastText: record.lastText?.slice(-12000), error: record.error,
      currentTools: active.has(status) ? [...pending.values()] : [],
      questions: events.filter(e => e.type === 'question' && questionIds.has(e.questionId)).map(e => ({ questionId: e.questionId, question: e.question, time: e.time })),
      recentMessage: events.findLast(e => e.type === 'message')?.message?.slice(-2000), activity, events };
  }
  /** Bounded entries of the agent's private session file; the path must stay inside its session directory. */
  sessionEntries(directory, record, limit = 500) {
    if (!record.sessionFile) return [];
    const file = fs.realpathSync(record.sessionFile);
    const allowed = fs.realpathSync(path.join(directory, 'sessions'));
    if (!file.startsWith(allowed + path.sep)) throw new Error('Session file is outside its private session directory');
    return readTail(file, limit);
  }
  /** 会话文件开头的若干条（系统提示在这里），尾部读取可能读不到它。 */
  sessionHead(directory, record, bytes = 256 * 1024) {
    if (!record.sessionFile) return [];
    const file = fs.realpathSync(record.sessionFile);
    if (!file.startsWith(fs.realpathSync(path.join(directory, 'sessions')) + path.sep)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(bytes, fs.fstatSync(fd).size)); fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lines = buffer.toString('utf8').split('\n'); if (buffer.length === bytes) lines.pop();
      return lines.filter(Boolean).slice(0, 20).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { fs.closeSync(fd); }
  }
  /** Latest finished request speed of a working agent, for the combined figure in the list. */
  latestSpeed(id) {
    try {
      const directory = this.directory(id);
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
      return requestSpeeds(this.sessionEntries(directory, record, 60), 1)[0] || null;
    } catch { return null; }
  }
  list() {
    if (!fs.existsSync(this.root)) return { agents: [], errors: [], refreshedAt: new Date().toISOString() };
    const agents = []; const errors = [];
    for (const id of fs.readdirSync(this.root).filter(isAgentId)) {
      try { const { events, ...agent } = this.snapshot(id); if (working.has(agent.status)) agent.speed = this.latestSpeed(id); agents.push(agent); }
      catch (error) { errors.push({ id, error: error.message }); }
    }
    agents.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    return { agents, errors, groupNames: Object.fromEntries(Object.entries(this.marks().groups).map(([key, value]) => [key, value.name])), refreshedAt: new Date().toISOString() };
  }
  contextWindow(model) { return this.catalog().find(m => m.provider === model?.provider && m.model === model?.model)?.contextWindow; }
  detail(id) {
    const agent = this.snapshot(id);
    const directory = this.directory(id);
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
    const messages = [];
    let transcriptError; let speeds = []; let context = null; let pullRequests = [];
    try {
      const entries = this.sessionEntries(directory, record);
      for (const entry of entries) {
        const message = transcriptMessage(entry, messages.length);
        if (message) messages.push(message);
      }
      speeds = requestSpeeds(entries);
      context = contextAnalysis(this.sessionHead(directory, record), entries, agent.contextWindow);
      pullRequests = pullRequestLinks(entries);
    } catch (error) { transcriptError = error.message; }
    return { agent, messages: messages.slice(-160), speeds, context, pullRequests, live: working.has(agent.status) ? this.live(directory) : null, transcriptError, refreshedAt: new Date().toISOString() };
  }
  /** Streaming mirror written by newer managers; stale files from a stopped run are ignored. */
  live(directory) {
    try {
      const live = JSON.parse(fs.readFileSync(path.join(directory, 'live.json'), 'utf8'));
      return Date.now() - Date.parse(live.updatedAt) < 10 * 60 * 1000 ? live : null;
    } catch { return null; }
  }
}
