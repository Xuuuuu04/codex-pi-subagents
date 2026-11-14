#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage, atomicWriteJson, processAlive } from '../src/storage.js';
import { callbackText } from '../src/callbacks.js';

const waitScript = fileURLToPath(new URL('./wait-events.js', import.meta.url));
const relevantEvents = new Set(['question', 'settled', 'process_failed', 'budget_limit', 'control_failed']);
const activeStatuses = new Set(['starting', 'running', 'finishing', 'waiting']);

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

let rawInput = '';
try {
  rawInput = fs.readFileSync(0, 'utf8');
} catch (error) {
  if (error?.code !== 'EAGAIN' && error?.code !== 'ENOENT') throw error;
}

let payload = {};
if (rawInput.trim()) {
  try { payload = JSON.parse(rawInput); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

const hookEvent = payload.hookEventName || '';
const conversationId = typeof payload.conversationId === 'string' && payload.conversationId.trim() ? payload.conversationId.trim() : '';
if (!conversationId) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

const root = path.resolve(process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime', import.meta.url)));
if (!fs.existsSync(root)) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

const storage = new Storage(root);
const callbacksDir = path.join(root, 'callbacks');
const watchersDir = path.join(root, 'watchers');

function readCallback(id) {
  const file = path.join(callbacksDir, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function saveDelivered(id, existing, sequence) {
  const file = path.join(callbacksDir, `${id}.json`);
  const next = Math.max(existing?.antigravityDeliveredSeq || 0, sequence);
  if (existing && next <= (existing.antigravityDeliveredSeq || 0)) return;
  const updated = existing
    ? { ...existing, antigravityDeliveredSeq: next, lastObservedBy: hookEvent || 'hook', updatedAt: new Date().toISOString() }
    : {
        agentId: id,
        enabled: true,
        events: ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed'],
        host: 'antigravity',
        antigravitySessionId: conversationId,
        antigravityCliResume: false,
        since: 0,
        antigravityDeliveredSeq: next,
        lastObservedBy: hookEvent || 'hook',
        updatedAt: new Date().toISOString(),
      };
  atomicWriteJson(file, updated);
}

function boundAgentIds() {
  const ids = new Set();
  if (fs.existsSync(callbacksDir)) {
    for (const file of fs.readdirSync(callbacksDir).filter(name => name.endsWith('.json'))) {
      const id = file.slice(0, -5);
      const cb = readCallback(id);
      if (cb?.antigravitySessionId === conversationId && cb.enabled !== false && fs.existsSync(path.join(root, id, 'agent.json'))) {
        ids.add(id);
      }
    }
  }
  for (const record of storage.all()) {
    if (record.parentInfo?.sessionId !== conversationId) continue;
    const cb = readCallback(record.id);
    if (cb?.enabled === false) continue;
    ids.add(record.id);
  }
  return [...ids];
}

function ownerLockAlive(id) {
  const lockFile = path.join(root, id, 'owner.lock');
  try {
    const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return processAlive(data.pid);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

function activeBoundIds(ids) {
  const active = [];
  for (const id of ids) {
    let record;
    try { record = storage.load(id); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (activeStatuses.has(record.status) && ownerLockAlive(id)) active.push(id);
  }
  return active;
}

function hasLiveWatcher(ids) {
  if (!fs.existsSync(watchersDir)) return false;
  for (const file of fs.readdirSync(watchersDir).filter(name => name.endsWith('.json'))) {
    const target = path.join(watchersDir, file);
    let watcher;
    try { watcher = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!processAlive(watcher.pid)) {
      try { fs.unlinkSync(target); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      continue;
    }
    if (watcher.sessionId === conversationId) return true;
    if (Array.isArray(watcher.agentIds) && watcher.agentIds.some(id => ids.includes(id))) return true;
  }
  return false;
}

function collectUndelivered(ids) {
  const blocks = [];
  for (const id of ids) {
    const cb = readCallback(id);
    const delivered = cb?.antigravityDeliveredSeq || 0;
    const events = storage.events(id, delivered, 100);
    const matched = events.filter(event => relevantEvents.has(event.type));
    if (!matched.length) continue;
    const maxSeq = events.at(-1)?.sequence || matched.at(-1).sequence;
    saveDelivered(id, cb, maxSeq);
    for (const event of matched) blocks.push(callbackText(event));
  }
  return blocks.join('\n\n');
}

const boundIds = boundAgentIds();
if (!boundIds.length) respond(hookEvent === 'Stop' ? { decision: 'allow' } : {});

if (hookEvent === 'PreInvocation') {
  const text = collectUndelivered(boundIds);
  if (!text) respond({});
  respond({
    injectSteps: [{ systemMessage: { systemMessage: text } }],
    terminationBehavior: '',
  });
}

if (hookEvent === 'Stop') {
  if ((payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') || payload.continuationActive === true) {
    respond({ decision: 'allow' });
  }
  const immediate = collectUndelivered(boundIds);
  if (immediate) respond({ decision: 'continue', reason: immediate });

  const initialActive = activeBoundIds(boundIds);
  if (!initialActive.length || hasLiveWatcher(initialActive) || payload.fullyIdle === false) {
    respond({ decision: 'allow' });
  }

  const waitMs = Math.max(0, Math.min(8000, Number(process.env.PI_HOOK_STOP_WAIT_MS ?? 3500)));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(20, deadline - Date.now()))));
    const arrived = collectUndelivered(boundIds);
    if (arrived) respond({ decision: 'continue', reason: arrived });
    const nowActive = activeBoundIds(boundIds);
    if (!nowActive.length || hasLiveWatcher(nowActive)) respond({ decision: 'allow' });
  }

  const remainingActive = activeBoundIds(boundIds);
  if (!remainingActive.length || hasLiveWatcher(remainingActive)) respond({ decision: 'allow' });
  respond({
    decision: 'continue',
    reason: `Active pi-subagents children (${remainingActive.join(', ')}) are still running for conversation ${conversationId} without a watcher. Call wait_agent or start background watcher: node "${waitScript}" --session ${conversationId}`,
  });
}

respond({});
