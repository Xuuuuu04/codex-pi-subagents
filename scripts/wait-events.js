#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Storage, atomicWriteJson } from '../src/storage.js';
import { callbackEvents, callbackText } from '../src/callbacks.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string', multiple: true },
    session: { type: 'string' },
    after: { type: 'string', multiple: true },
    events: { type: 'string', default: 'settled,question,process_failed,budget_limit,control_failed' },
    timeout: { type: 'string', default: '3600' },
    follow: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

if (!values.agent?.length && !values.session) {
  console.error('Usage: wait-events.js (--agent <id> | --session <sessionId>) [--after <id>=<sequence>] [--events settled,question] [--timeout seconds] [--follow] [--json]');
  process.exit(64);
}
const events = values.events.split(',').filter(Boolean);
if (!events.length || events.some(type => !callbackEvents.includes(type))) {
  console.error(`Events must be from: ${callbackEvents.join(', ')}`);
  process.exit(64);
}

const root = path.resolve(process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime', import.meta.url)));
const storage = new Storage(root);
const callbacksDir = path.join(root, 'callbacks');
const watchersDir = path.join(root, 'watchers');
const explicitOverrides = new Map();
for (const item of values.after || []) {
  const [id, sequence] = item.split('=');
  if (id && Number.isFinite(Number(sequence))) explicitOverrides.set(id, Number(sequence));
}

function readCallback(id) {
  const file = path.join(callbacksDir, `${id}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function advanceDelivered(id, sequence) {
  const file = path.join(callbacksDir, `${id}.json`);
  const existing = readCallback(id);
  if (!existing && !values.session) return;
  const next = Math.max(existing?.antigravityDeliveredSeq || 0, sequence);
  if (existing && next <= (existing.antigravityDeliveredSeq || 0)) return;
  const updated = existing
    ? { ...existing, antigravityDeliveredSeq: next, lastObservedBy: 'wait-events', updatedAt: new Date().toISOString() }
    : {
        agentId: id,
        enabled: true,
        events: ['settled', 'question', 'process_failed', 'budget_limit', 'control_failed'],
        host: 'antigravity',
        antigravitySessionId: values.session,
        antigravityCliResume: false,
        since: 0,
        antigravityDeliveredSeq: next,
        lastObservedBy: 'wait-events',
        updatedAt: new Date().toISOString(),
      };
  atomicWriteJson(file, updated);
}

function sessionAgents() {
  const found = new Set(values.agent || []);
  if (!values.session) return [...found];
  for (const record of storage.all()) {
    if (record.parentInfo?.sessionId === values.session) found.add(record.id);
  }
  if (fs.existsSync(callbacksDir)) {
    for (const file of fs.readdirSync(callbacksDir).filter(name => name.endsWith('.json'))) {
      const id = file.slice(0, -5);
      const cb = readCallback(id);
      if (cb?.antigravitySessionId === values.session && fs.existsSync(path.join(root, id, 'agent.json'))) {
        found.add(id);
      }
    }
  }
  return [...found];
}

const after = {};
for (const id of values.agent || []) {
  after[id] = explicitOverrides.has(id) ? explicitOverrides.get(id) : storage.load(id).sequence;
}

const key = String(values.session || values.agent?.[0] || 'watch').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
const watcherFile = path.join(watchersDir, `${key}-${process.pid}.json`);
let watcherHandle = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (watcherHandle) {
    try { watcherHandle.close(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    watcherHandle = null;
  }
  try { fs.unlinkSync(watcherFile); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

fs.mkdirSync(watchersDir, { recursive: true, mode: 0o700 });
atomicWriteJson(watcherFile, {
  pid: process.pid,
  sessionId: values.session || null,
  agentIds: values.agent || [],
  startedAt: new Date().toISOString(),
});
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

let dirty = false;
let wake = null;
const onFsChange = () => {
  dirty = true;
  if (wake) {
    const fn = wake;
    wake = null;
    fn();
  }
};
if (fs.existsSync(root)) {
  try { watcherHandle = fs.watch(root, { recursive: true }, onFsChange); }
  catch (error) {
    if (error?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw error;
    watcherHandle = fs.watch(root, onFsChange);
  }
}

const deadline = Date.now() + Number(values.timeout) * 1000;
for (;;) {
  const targets = sessionAgents();
  let matched = 0;
  for (const id of targets) {
    if (after[id] === undefined) {
      if (explicitOverrides.has(id)) after[id] = explicitOverrides.get(id);
      else after[id] = readCallback(id)?.antigravityDeliveredSeq || 0;
    }
    let lastDelivered = 0;
    for (const event of storage.events(id, after[id], 100)) {
      after[id] = event.sequence;
      if (!events.includes(event.type) || (event.type === 'message' && event.recipient !== 'parent')) continue;
      console.log(values.json ? JSON.stringify(event) : `${callbackText(event)}\n`);
      lastDelivered = event.sequence;
      matched++;
    }
    if (lastDelivered) advanceDelivered(id, lastDelivered);
  }
  if (matched && !values.follow) {
    cleanup();
    process.exit(0);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const label = values.session ? `session ${values.session}` : values.agent.join(', ');
    console.log(`No callback event within ${values.timeout}s for ${label}. Cursor: ${JSON.stringify(after)} (state ${path.basename(root)})`);
    cleanup();
    process.exit(values.follow ? 0 : 2);
  }
  if (!dirty) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(250, Math.max(20, remaining)));
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
  dirty = false;
}
