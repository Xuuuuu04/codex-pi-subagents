import fs from 'node:fs';
import path from 'node:path';
import { processAlive } from './storage.js';

const active = new Set(['starting', 'running', 'waiting', 'finishing', 'idle']);
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
    return { id, name: record.name, status, recordedStatus: record.status, controllerAlive,
      model: record.model, thinking: record.thinking, temporaryModel: record.restoreModel,
      cwd: record.workspace?.cwd, sourceCwd: record.workspace?.sourceCwd, workspaceMode: record.workspace?.mode,
      ownedPaths: record.ownedPaths, createdAt: record.createdAt, updatedAt: record.updatedAt,
      sequence: record.sequence, usage: record.usage, lastText: record.lastText?.slice(-12000), error: record.error,
      currentTools: active.has(status) ? [...pending.values()] : [],
      questions: events.filter(e => e.type === 'question' && questionIds.has(e.questionId)).map(e => ({ questionId: e.questionId, question: e.question, time: e.time })),
      recentMessage: events.findLast(e => e.type === 'message')?.message?.slice(-2000), events };
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
        for (const entry of readTail(file, 150)) {
          if (entry.type !== 'message' || !entry.message) continue;
          const m = entry.message;
          const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').slice(-12000);
          const calls = blocks.filter(b => b.type === 'toolCall').map(b => ({ name: b.name, arguments: JSON.stringify(b.arguments || {}).slice(0, 4000) }));
          if (text || calls.length) messages.push({ id: entry.id || `${entry.timestamp}-${messages.length}`, role: m.role, time: entry.timestamp, toolName: m.toolName, text, calls, isError: m.isError });
        }
      } catch (error) { transcriptError = error.message; }
    }
    return { agent, messages: messages.slice(-50), transcriptError, refreshedAt: new Date().toISOString() };
  }
}
