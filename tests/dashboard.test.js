import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setup, spawn, settled } from './helpers/setup.js';
import { DashboardData, readTail } from '../src/dashboard-data.js';
import { startDashboard } from '../src/dashboard.js';

test('dashboard reads live agents and identifies disconnected controllers without changing ownership', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const root = manager.storage.root; const data = new DashboardData(root);
  assert.equal(data.list().agents[0].controllerAlive, true);
  assert.equal(data.list().agents[0].status, 'completed');
  const lock = fs.readFileSync(path.join(root, a.id, 'owner.lock'), 'utf8');
  const detail = data.detail(a.id); assert.ok(detail.agent.events.length);
  assert.equal(fs.readFileSync(path.join(root, a.id, 'owner.lock'), 'utf8'), lock);
  const owned = manager.get(a.id); owned.record.status = 'waiting'; owned.record.questionIds = ['sample-question'];
  manager.event(owned, 'question', { questionId: 'sample-question', question: 'Choose a page size' });
  manager.event(owned, 'tool_execution_start', { toolCallId: 'sample-tool', toolName: 'ask_parent' });
  assert.equal(data.list().agents[0].questions[0].question, 'Choose a page size');
  assert.deepEqual(data.list().agents[0].currentTools, ['ask_parent']);
  const record = manager.storage.load(a.id); record.status = 'running'; manager.storage.save(record);
  manager.release(manager.get(a.id).lock);
  assert.equal(data.list().agents[0].status, 'disconnected');
  const bad = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; fs.mkdirSync(path.join(root, bad)); fs.writeFileSync(path.join(root, bad, 'agent.json'), '{');
  assert.equal(data.list().agents.length, 1); assert.equal(data.list().errors.length, 1);
});

test('private read-only HTTP rejects missing token, other hosts and mutation requests', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const dashboard = await startDashboard({ root: manager.storage.root, port: 0, token: 'test-secret' });
  t.after(() => dashboard.close());
  const origin = new URL(dashboard.url).origin; const headers = { authorization: 'Bearer test-secret' };
  assert.equal((await fetch(origin + '/api/agents')).status, 401);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.get(origin + '/api/agents', { headers: { ...headers, host: 'example.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(origin + '/api/agents', { method: 'POST', headers })).status, 405);
  const result = await (await fetch(origin + '/api/agents', { headers })).json(); assert.equal(result.agents[0].id, a.id);
  const detail = await (await fetch(origin + '/api/agents/' + a.id, { headers })).json(); assert.equal(detail.agent.status, 'completed');
  assert.equal((await fetch(origin + '/api/agents/not-an-id', { headers })).status, 400);
  assert.equal((await fetch(origin + '/', { headers })).status, 200);
  const page = await fetch(origin + '/');
  const cookie = page.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const fromPlainAddress = await fetch(origin + '/api/agents', { headers: { cookie: cookie.split(';')[0], 'sec-fetch-site': 'same-origin' } });
  assert.equal(fromPlainAddress.status, 200);
  assert.equal((await fromPlainAddress.json()).agents[0].id, a.id);
  assert.equal((await fetch(origin + '/api/agents', { headers: { cookie: cookie.split(';')[0], 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(origin + '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(manager.read(a.id).agent.status, 'completed');
});

test('saved session rendering omits hidden reasoning, bounds text and rejects arbitrary session paths', async t => {
  const { manager, cwd } = await setup(t);
  const a = await spawn(manager, cwd); await settled(manager, a.id);
  const directory = manager.storage.directory(a.id); const sessions = path.join(directory, 'sessions'); fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'test.jsonl');
  const entry = { type: 'message', timestamp: '2026-10-06', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'text', text: '<script>sample</script>' }, { type: 'toolCall', name: 'bash', arguments: { command: 'test' } }] } };
  fs.writeFileSync(file, JSON.stringify(entry) + '\n' + '{"unfinished":');
  assert.equal(readTail(file).length, 1);
  const record = manager.storage.load(a.id); record.sessionFile = file; manager.storage.save(record);
  const data = new DashboardData(manager.storage.root); const detail = data.detail(a.id);
  assert.equal(detail.messages[0].text, '<script>sample</script>'); assert.ok(!JSON.stringify(detail).includes('HIDDEN'));
  record.sessionFile = path.join(cwd, 'outside.jsonl'); fs.writeFileSync(record.sessionFile, JSON.stringify(entry) + '\n'); manager.storage.save(record);
  assert.match(data.detail(a.id).transcriptError, /outside/);
});
