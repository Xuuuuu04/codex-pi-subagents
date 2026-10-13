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
    const status = !controllerAlive && active.has(record.status) ? 'disconnected' : record.status;
    const questionIds = new Set(record.questionIds || []);
    const activity = summarizeActivity(events);
    return { id, name: record.name, status, recordedStatus: record.status, controllerAlive,
      model: record.model, thinking: record.thinking, temporaryModel: record.restoreModel,
      cwd: record.workspace?.cwd, sourceCwd: record.workspace?.sourceCwd, workspaceMode: record.workspace?.mode,
      ownedPaths: record.ownedPaths, createdAt: record.createdAt, updatedAt: record.updatedAt,
      sequence: record.sequence, usage: record.usage, lastText: record.lastText?.slice(-12000), error: record.error,
      currentTools: active.has(status) ? [...pending.values()] : [],
      questions: events.filter(e => e.type === 'question' && questionIds.has(e.questionId)).map(e => ({ questionId: e.questionId, question: e.question, time: e.time })),
      recentMessage: events.findLast(e => e.type === 'message')?.message?.slice(-2000), activity, events };
  }
  list() {
    if (!fs.existsSync(this.root)) return { agents: [], errors: [], refreshedAt: new Date().toISOString() };
    const agents = []; const errors = [];
    for (const id of fs.readdirSync(this.root).filter(isAgentId)) {
      try { const { events, ...agent } = this.snapshot(id); agents.push(agent); }
      catch (error) { errors.push({ id, error: error.message }); }
    }
    agents.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    return { agents, errors, refreshedAt: new Date().toISOString() };
  }
  detail(id) {
    const agent = this.snapshot(id);
    const directory = this.directory(id);
    const record = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
    const messages = [];
    let transcriptError;
    if (record.sessionFile) {
      try {
        const file = fs.realpathSync(record.sessionFile);
        const allowed = fs.realpathSync(path.join(directory, 'sessions'));
        if (!file.startsWith(allowed + path.sep)) throw new Error('Session file is outside its private session directory');
        for (const entry of readTail(file, 500)) {
          const message = transcriptMessage(entry, messages.length);
          if (message) messages.push(message);
        }
      } catch (error) { transcriptError = error.message; }
    }
    return { agent, messages: messages.slice(-160), live: working.has(agent.status) ? this.live(directory) : null, transcriptError, refreshedAt: new Date().toISOString() };
  }
  /** Streaming mirror written by newer managers; stale files from a stopped run are ignored. */
  live(directory) {
    try {
      const live = JSON.parse(fs.readFileSync(path.join(directory, 'live.json'), 'utf8'));
      return Date.now() - Date.parse(live.updatedAt) < 10 * 60 * 1000 ? live : null;
    } catch { return null; }
  }
}
