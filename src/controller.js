import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { Manager, defaultMaxAgents } from './manager.js';
import { processAlive } from './storage.js';
import { FileTaskStore } from './task-store.js';

const root = path.resolve(process.env.PI_SUBAGENTS_STATE_DIR);
const lock = path.join(root, 'controller.lock');
if (fs.existsSync(lock)) {
  let old;
  try { old = JSON.parse(fs.readFileSync(lock, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError && Date.now() - fs.statSync(lock).mtimeMs < 5000) process.exit(0); throw new Error('Controller lock is damaged; verify its process has stopped before removing it.'); }
  if (processAlive(old.pid)) process.exit(0);
  fs.unlinkSync(lock);
}
try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error; }
const manager = await new Manager({ root, executable: process.env.PI_EXECUTABLE || 'pi', maxAgents: Number(process.env.PI_SUBAGENTS_MAX_AGENTS || defaultMaxAgents) }).start();
const parents = new Map();
const tasks = new FileTaskStore(root, manager);
const cleanup = setInterval(() => { try { tasks.prune(); } catch (error) { process.stderr.write(`Task cleanup failed: ${error.message}\n`); } }, 60000); cleanup.unref();
const operations = path.join(root, 'operations'); fs.mkdirSync(operations, { recursive: true, mode: 0o700 });
const token = randomUUID();
// macOS limits Unix socket paths; its dedicated directory is private even when the state root is long.
const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-controller-')); fs.chmodSync(socketDirectory, 0o700);
const socket = path.join(socketDirectory, 'rpc.sock');
function own(parentId, agentId) {
  const agent = manager.get(agentId);
  if (agent.record.parentId !== parentId) throw new Error('Agent belongs to another parent; explicitly resume only after its parent detaches.');
  return agent;
}
const writes = new Map();
async function once(parentId, key, values, operation) {
  if (!key) return operation();
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid requestId');
  const file = path.join(operations, key + '.json');
  const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  if (writes.has(key)) await writes.get(key);
  if (fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.parentId !== parentId || old.fingerprint !== fingerprint) throw new Error('requestId already belongs to different content or parent');
    if (old.state === 'completed') return { ...old.result, duplicate: true };
    if (old.state === 'failed') throw new Error(old.error);
    throw new Error('Operation outcome is uncertain after a controller failure; inspect saved agents before dispatching new work.');
  }
  const record = { parentId, fingerprint, state: 'attempted' };
  const save = () => { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temp, file); };
  save();
  const pending = (async () => {
    try { record.result = await operation(); record.state = 'completed'; save(); return record.result; }
    catch (error) { record.state = 'failed'; record.error = error.message; save(); throw error; }
  })();
  writes.set(key, pending);
  try { return await pending; } finally { writes.delete(key); }
}
async function dispatch(parentId, method, v) {
  if (method === 'health') return { service: 'pi-controller', pid: process.pid };
  if (method === 'attach') { parents.set(parentId, { connected: true, pid: v.pid, lastSeen: Date.now() }); return { parentId }; }
  if (method === 'detach') { parents.set(parentId, { connected: false, lastSeen: Date.now() }); return { detached: true }; }
  const parent = parents.get(parentId); if (!parent?.connected) throw new Error('Parent is not attached'); parent.lastSeen = Date.now();
  const owned = () => [...manager.agents.values()].filter(value => value.record.parentId === parentId);
  if (method === 'task') {
    const allowed = ['createTask', 'getTask', 'storeTaskResult', 'getTaskResult', 'updateTaskStatus', 'listTasks', 'notificationStates'];
    if (!allowed.includes(v.operation)) throw new Error('Invalid task operation');
    if (v.operation === 'createTask' && v.args[0]?.context?.agentId) own(parentId, v.args[0].context.agentId);
    return tasks[v.operation](...v.args, parentId);
  }
  if (method === 'adoptTask') {
    const value = await tasks.adopt(v.taskId, parentId, id => parents.get(id)?.connected && processAlive(parents.get(id).pid));
    const agent = manager.agents.get(value.agentId);
    if (agent) { agent.record.parentId = parentId; manager.storage.save(agent.record); }
    return value;
  }
  if (method === 'models') return manager.models(v.provider);
  if (method === 'spawn') return once(parentId, v.requestId, { method, ...v }, async () => {
    const result = await manager.spawn({ ...v, parentId }); return result;
  });
  if (method === 'list') {
    const all = manager.list(v.includeSaved);
    return all.filter(value => manager.agents.get(value.id)?.record.parentId === parentId || v.includeSaved).map(value => ({ ...value, owned: manager.agents.get(value.id)?.record.parentId === parentId }));
  }
  if (method === 'resume') {
    const current = manager.agents.get(v.agentId);
    if (current && current.record.parentId !== parentId && parents.get(current.record.parentId)?.connected && processAlive(parents.get(current.record.parentId).pid)) throw new Error('Agent belongs to an attached parent');
    if (current?.rpc && !current.rpc.exited) { current.record.parentId = parentId; manager.storage.save(current.record); return { ...manager.summary(current), reattached: true }; }
    const result = await manager.resume(v.agentId); const agent = manager.get(v.agentId); agent.record.parentId = parentId; manager.storage.save(agent.record); return result;
  }
  if (method === 'poll') {
    const ids = owned().map(value => value.record.id);
    if (!ids.length) return { events: [] };
    const result = await manager.wait(ids, v.after || {}, 20000);
    return { events: result.results.flatMap(value => value.events) };
  }
  if (method === 'reply') {
    const question = manager.channel.questions.get(v.questionId);
    const agent = question ? manager.get(question.agentId) : owned().find(value => manager.messages.all(value.record.id).some(message => message.messageId === v.questionId));
    if (!agent) throw new Error('Question does not belong to this parent'); own(parentId, agent.record.id); return manager.channel.reply(v.questionId, v.message);
  }
  if (method === 'wait') { v.agentIds.forEach(id => own(parentId, id)); return manager.wait(v.agentIds, v.after, v.timeoutMs); }
  if (method === 'readMessages') { own(parentId, v.agentId); return manager.messages.read(v.agentId, v); }
  if (method === 'ackMessages') { own(parentId, v.agentId); return manager.messages.acknowledge(v.agentId, v.messageIds); }
  const agent = own(parentId, v.agentId);
  if (method === 'read') return manager.read(v.agentId, v.afterSequence, v.limit);
  if (method === 'transcript') { if (!agent.rpc || agent.rpc.exited) throw new Error('Resume the saved session first'); return agent.rpc.command('get_messages'); }
  if (method === 'send') return manager.send(v.agentId, v.message, v.mode, v.messageId);
  if (method === 'updatePolicy') return manager.updatePolicy(v.agentId, v.policy, v.authorizationReference);
  if (method === 'setModel') return manager.setModel(v.agentId, v);
  if (method === 'interrupt') return manager.interrupt(v.agentId);
  if (method === 'closeAgent') return manager.closeAgent(v.agentId);
  throw new Error('Unsupported controller method');
}
const server = http.createServer(async (request, response) => {
  const reply = data => { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); } };
  try {
    const authorization = Buffer.from(request.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/rpc' || authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) throw new Error('Unauthorized controller request');
    let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 128000) throw new Error('Request too large'); }
    const { parentId, method, values } = JSON.parse(body);
    if (!/^[0-9a-f-]{36}$/.test(parentId)) throw new Error('Invalid parent ID');
    reply({ result: await dispatch(parentId, method, values || {}) });
  } catch (error) { reply({ error: error.message }); }
});
await new Promise(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600);
const metadata = path.join(root, 'controller.json');
fs.writeFileSync(metadata + '.tmp', JSON.stringify({ pid: process.pid, socket, token }), { mode: 0o600 }); fs.renameSync(metadata + '.tmp', metadata);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await manager.close(); server.closeAllConnections(); server.close();
  fs.rmSync(socketDirectory, { recursive: true, force: true }); fs.rmSync(lock, { force: true }); process.exit(0);
}
process.on('SIGTERM', close); process.on('SIGINT', close);
