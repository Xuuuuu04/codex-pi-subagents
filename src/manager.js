import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PiProcess } from './rpc-client.js';
import { Storage, processAlive } from './storage.js';
import { MessageChannel } from './messages.js';
import { createWorkspace, validateOwnedPaths, pathsOverlap } from './workspace.js';

const extension = fileURLToPath(new URL('../extensions/communication.ts', import.meta.url));
const activeStatuses = new Set(['starting', 'running', 'waiting', 'finishing']);
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/** Own Pi processes, durable sessions, model changes and events for one MCP connection. */
export class Manager extends EventEmitter {
  constructor({ root, executable = 'pi', maxAgents = 8, processFactory = options => new PiProcess(options) }) {
    super();
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 32) throw new Error('maxAgents must be an integer from 1 to 32');
    this.storage = new Storage(root);
    this.executable = executable;
    this.maxAgents = maxAgents;
    this.processFactory = processFactory;
    this.owner = randomUUID();
    this.agents = new Map();
    this.channel = new MessageChannel(this);
    this.closed = false;
    this.catalog = null;
  }
  async start() { await this.channel.start(); return this; }
  get(id) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent is not owned by this connection. Use resume_agent to claim a saved session.');
    return agent;
  }
  summary(agent) {
    const r = agent.record;
    return { id: r.id, name: r.name, status: r.status, model: r.model, thinking: r.thinking, workspace: r.workspace,
      sequence: r.sequence, questionIds: r.questionIds, lastText: r.lastText?.slice(-12000), error: r.error,
      temporaryModel: r.restoreModel, usage: r.usage, sessionFile: r.sessionFile, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  event(agent, type, data = {}) {
    const r = agent.record;
    const event = { agentId: r.id, sequence: ++r.sequence, time: new Date().toISOString(), type, ...data };
    r.updatedAt = event.time;
    agent.events.push(event);
    if (agent.events.length > 500) agent.events.shift();
    this.storage.append(r.id, event);
    this.storage.save(r);
    this.emit('event', event);
    return event;
  }
  serial(agent, operation) {
    const result = agent.control.then(operation);
    agent.control = result.catch(() => undefined);
    return result;
  }
  requireIdle(agent) {
    if (activeStatuses.has(agent.record.status)) throw new Error('Agent is busy. Wait for completion or explicitly interrupt it first.');
    if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is closed; resume it first.');
  }
  capacity() {
    if (this.closed) throw new Error('Controller is shutting down');
    if ([...this.agents.values()].filter(a => a.rpc && !a.rpc.exited).length >= this.maxAgents) throw new Error(`Agent limit reached (${this.maxAgents}). Close an idle agent first.`);
  }
  async models(provider) {
    if (!this.catalog) {
      this.catalog = (async () => {
        const rpc = this.processFactory({ executable: this.executable, args: ['--mode', 'rpc', '--no-session', '--offline', '--no-extensions'], cwd: this.storage.root });
        try { return (await rpc.command('get_available_models')).models; }
        finally { await rpc.close(); }
      })().catch(error => { this.catalog = null; throw error; });
    }
    const all = await this.catalog;
    return all.filter(m => !provider || m.provider === provider).map(m => ({ provider: m.provider, model: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, cost: m.cost }));
  }
  async validateModel(model) {
    if (!(await this.models(model.provider)).some(m => m.model === model.model)) throw new Error(`Model is unavailable: ${model.provider}/${model.model}`);
  }
  claim(record) {
    const lock = path.join(this.storage.directory(record.id), 'owner.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    if (fs.existsSync(lock)) {
      const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (processAlive(previous.pid)) throw new Error('Saved agent is already controlled by a live process');
      fs.unlinkSync(lock);
    }
    const fd = fs.openSync(lock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: this.owner })); fs.closeSync(fd);
    record.owner = this.owner; record.ownerPid = process.pid;
    return lock;
  }
  async spawn({ cwd, prompt, provider, model, name, ownedPaths, workspaceMode = 'auto', baseRef, thinking = 'high', context = '' }) {
    if (!path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
    this.capacity(); await this.validateModel({ provider, model }); this.capacity();
    const paths = validateOwnedPaths(ownedPaths);
    const original = fs.realpathSync(cwd);
    if (workspaceMode === 'shared' || workspaceMode === 'auto') {
      for (const a of this.agents.values()) {
        if (a.record.workspace?.mode === 'shared' && a.rpc && !a.rpc.exited && pathsOverlap(paths.map(p => path.resolve(original, p)), a.record.ownedPaths.map(p => path.resolve(a.record.workspace.sourceCwd, p)))) throw new Error('Owned paths overlap another live agent in the shared directory');
      }
    }
    const id = randomUUID();
    const record = { id, name: name || id.slice(0, 8), model: { provider, model }, thinking, ownedPaths: paths, context,
      status: 'starting', sequence: 0, questionIds: [], createdAt: new Date().toISOString(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reportedCost: 0 } };
    const lock = this.claim(record);
    try {
      record.workspace = createWorkspace({ cwd, id, mode: workspaceMode, baseRef, directory: this.storage.directory(id) });
      this.storage.save(record);
      const agent = { record, lock, events: [], control: Promise.resolve() };
      this.agents.set(id, agent);
      await this.launch(agent);
      await this.send(id, prompt, 'steer');
      return this.summary(agent);
    } catch (error) {
      record.status = 'failed'; record.error = error.message; this.storage.save(record);
      const a = this.agents.get(id); if (a?.rpc) await a.rpc.close();
      this.release(lock); throw error;
    }
  }
  release(lock) {
    if (!fs.existsSync(lock)) return;
    const value = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (value.owner === this.owner) fs.unlinkSync(lock);
  }
  async launch(agent) {
    const r = agent.record;
    agent.messageToken = randomUUID();
    const instructions = `You are an external Pi subagent controlled by parent Codex. Your ID: ${r.id}.\nOwned paths: ${r.ownedPaths.join(', ')}. Do not edit siblings' files or revert others' changes. Your directory is ${r.workspace.cwd}. Ownership is a coordination rule, not a sandbox.\nUse agent_message(recipient="parent", message=...) for important progress. Use ask_parent for unresolved blocking decisions; its tool result is the parent's answer. Finish with changed files, checks actually run, remaining issues. Never claim tests passed without running them. Do not deploy or send external messages without explicit parent authorization.\nProvided context:\n${r.context}`;
    const args = ['--mode', 'rpc', '--offline', '--provider', r.model.provider, '--model', r.model.model, '--thinking', r.thinking,
      '--extension', extension, '--append-system-prompt', instructions, '--session-dir', path.join(this.storage.directory(r.id), 'sessions')];
    if (r.sessionFile) args.push('--session', r.sessionFile);
    agent.rpc = this.processFactory({ executable: this.executable, args, cwd: r.workspace.cwd, env: {
      PI_SUBAGENT_ID: r.id, PI_SUBAGENT_ENDPOINT: this.channel.endpoint, PI_SUBAGENT_TOKEN: agent.messageToken,
    } });
    agent.rpc.on('event', event => this.onPiEvent(agent, event));
    agent.rpc.on('stopped', error => {
      if (agent.closing) return;
      r.status = 'failed'; r.error = error.message;
      this.channel.cancelAgent(r.id); this.event(agent, 'process_failed', { error: error.message }); this.release(agent.lock);
    });
    const state = await agent.rpc.command('get_state');
    r.sessionFile = state.sessionFile;
    r.status = 'idle'; r.questionIds = []; r.error = undefined;
    this.event(agent, 'ready');
  }
  onPiEvent(agent, event) {
    const r = agent.record;
    if (event.type === 'agent_start') { r.status = r.questionIds.length ? 'waiting' : 'running'; this.event(agent, 'started'); }
    else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      const text = textOf(message); if (text) r.lastText = text.slice(-24000);
      r.stopReason = message.stopReason;
      r.error = message.stopReason === 'error' ? message.errorMessage || 'Model request failed' : undefined;
      if (message.usage) {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) r.usage[key] += message.usage[key] || 0;
        r.usage.reportedCost += message.usage.cost?.total || 0;
      }
      this.storage.save(r);
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      this.event(agent, event.type, { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
    } else if (event.type === 'agent_settled') {
      r.status = 'finishing';
      this.serial(agent, async () => {
        if (r.restoreModel) await this.restoreModel(agent);
        r.status = r.stopReason === 'error' ? 'failed' : r.stopReason === 'aborted' || agent.interrupting ? 'interrupted' : 'completed';
        this.event(agent, 'settled', { status: r.status, text: r.lastText, error: r.error });
      }).catch(error => { r.status = 'failed'; r.error = error.message; this.event(agent, 'control_failed', { error: error.message }); });
    } else if (event.type === 'extension_error') this.event(agent, 'extension_error', { error: event.error || event.message });
  }
  async send(id, message, mode = 'steer') {
    const agent = this.get(id);
    return this.serial(agent, async () => {
      if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is closed; resume it first');
      const busy = activeStatuses.has(agent.record.status);
      if (!busy) {
        agent.record.status = 'running'; agent.record.error = undefined; agent.record.stopReason = undefined;
      }
      try {
        const result = await agent.rpc.command('prompt', { message, ...(busy ? { streamingBehavior: mode === 'follow_up' ? 'followUp' : 'steer' } : {}) });
        this.event(agent, 'instruction', { mode, disposition: result?.disposition });
        if (result?.disposition === 'handled' && !busy) { agent.record.status = 'idle'; this.storage.save(agent.record); }
        return { accepted: true, disposition: result?.disposition, agent: this.summary(agent) };
      } catch (error) { if (!busy) { agent.record.status = 'failed'; agent.record.error = error.message; this.event(agent, 'instruction_failed', { error: error.message }); } throw error; }
    });
  }
  async restoreModel(agent) {
    const previous = agent.record.restoreModel;
    await agent.rpc.command('set_model', { provider: previous.model.provider, modelId: previous.model.model });
    await agent.rpc.command('set_thinking_level', { level: previous.thinking });
    agent.record.model = previous.model; agent.record.thinking = previous.thinking;
    delete agent.record.restoreModel;
    this.event(agent, 'model_restored', { model: agent.record.model });
  }
  async setModel(id, { provider, model, thinking, scope = 'session' }) {
    const agent = this.get(id);
    await this.validateModel({ provider, model });
    return this.serial(agent, async () => {
      this.requireIdle(agent);
      if (agent.record.restoreModel) throw new Error('A temporary model change is already pending. Complete a run or restore it before changing again.');
      const old = { model: agent.record.model, thinking: agent.record.thinking };
      await agent.rpc.command('set_model', { provider, modelId: model });
      agent.record.model = { provider, model };
      if (scope === 'next_run') agent.record.restoreModel = old;
      this.storage.save(agent.record);
      if (thinking) await agent.rpc.command('set_thinking_level', { level: thinking });
      const state = await agent.rpc.command('get_state'); agent.record.thinking = state.thinkingLevel;
      this.event(agent, 'model_changed', { model: agent.record.model, scope });
      return this.summary(agent);
    });
  }
  async interrupt(id) {
    const agent = this.get(id);
    return this.serial(agent, async () => {
      if (!agent.rpc || agent.rpc.exited) throw new Error('Agent process is not running');
      agent.interrupting = true;
      try {
        const cleared = await agent.rpc.command('clear_queue');
        this.channel.cancelAgent(id);
        await agent.rpc.command('abort');
        agent.record.status = 'interrupted'; this.event(agent, 'interrupted', { cleared });
        return this.summary(agent);
      } finally { agent.interrupting = false; }
    });
  }
  async closeAgent(id) {
    const agent = this.get(id);
    let shutdownError;
    if (activeStatuses.has(agent.record.status)) {
      try { await this.interrupt(id); }
      catch (error) { shutdownError = error.message; }
    }
    return this.serial(agent, async () => {
      agent.closing = true; this.channel.cancelAgent(id); await agent.rpc?.close();
      agent.record.status = 'closed'; this.event(agent, 'closed'); this.release(agent.lock);
      return { ...this.summary(agent), ...(shutdownError ? { shutdownError } : {}) };
    });
  }
  async resume(id) {
    this.capacity();
    const existing = this.agents.get(id);
    if (existing?.rpc && !existing.rpc.exited) throw new Error('Agent already has a live process');
    const record = this.storage.load(id);
    if (!record.sessionFile || !fs.existsSync(record.sessionFile)) throw new Error('No saved Pi session is available');
    await this.validateModel(record.model); this.capacity();
    const lock = this.claim(record);
    const agent = { record, lock, events: this.storage.events(id), control: Promise.resolve() };
    this.agents.set(id, agent);
    try { await this.launch(agent); this.event(agent, 'resumed'); return this.summary(agent); }
    catch (error) { record.status = 'failed'; record.error = error.message; this.storage.save(record); if (agent.rpc) await agent.rpc.close(); this.release(lock); throw error; }
  }
  list(includeSaved = false) {
    const current = [...this.agents.values()].map(a => this.summary(a));
    if (!includeSaved) return current;
    return [...current, ...this.storage.all().filter(r => !this.agents.has(r.id)).map(r => ({ ...this.summary({ record: r }), owned: false, controllerAlive: fs.existsSync(path.join(this.storage.directory(r.id), 'owner.lock')) && processAlive(r.ownerPid) }))];
  }
  read(id, afterSequence = 0, limit = 50) {
    const agent = this.get(id);
    const events = agent.events.filter(e => e.sequence > afterSequence).slice(0, limit);
    return { agent: this.summary(agent), events, nextSequence: events.at(-1)?.sequence ?? Math.min(afterSequence, agent.record.sequence),
      truncated: agent.events.length > 0 && afterSequence < agent.events[0].sequence - 1 };
  }
  async wait(ids, after = {}, timeoutMs = 25000, signal) {
    ids.forEach(id => this.get(id));
    const snapshot = () => ids.map(id => this.read(id, after[id] || 0)).filter(value => value.events.length);
    const immediate = snapshot(); if (immediate.length) return { reason: 'event', results: immediate };
    if (!timeoutMs) return { reason: 'snapshot', results: ids.map(id => this.read(id, after[id] || 0)) };
    return new Promise(resolve => {
      let settled = false;
      const finish = reason => {
        if (settled) return; settled = true; clearTimeout(timer); this.off('event', onEvent); signal?.removeEventListener('abort', onAbort);
        resolve({ reason, results: ids.map(id => this.read(id, after[id] || 0)) });
      };
      const onEvent = event => { if (ids.includes(event.agentId) && event.sequence > (after[event.agentId] || 0)) finish('event'); };
      const onAbort = () => finish('cancelled');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      this.on('event', onEvent); signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) finish('cancelled');
      else if (snapshot().length) finish('event');
    });
  }
  async close() {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.agents.keys()].map(id => this.closeAgent(id)));
    await this.channel.close();
  }
}
