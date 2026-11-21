import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, spawn, settled } from './helpers/setup.js';
import { defaultMaxAgents, parseMaxAgents } from '../src/manager.js';

test('acceptance is distinct from completion and failures stay visible', async t => {
  const { manager, cwd } = await setup(t);
  const agent = await spawn(manager, cwd, 'FAIL');
  assert.equal(agent.status, 'running');
  const final = await settled(manager, agent.id);
  assert.equal(final.status, 'failed'); assert.equal(final.error, 'FAIL');
  await manager.send(agent.id, 'recovered');
  assert.equal((await settled(manager, agent.id)).lastText, 'recovered');
});
test('interrupt clears queued instructions and does not restart old work', async t => {
  const { manager, cwd } = await setup(t);
  const agent = await spawn(manager, cwd, 'HANG');
  await manager.send(agent.id, 'must not run', 'follow_up');
  await manager.interrupt(agent.id);
  const final = await settled(manager, agent.id);
  assert.equal(final.status, 'interrupted');
  assert.equal(final.lastText, 'stopped');
  const record = manager.read(agent.id);
  const interrupted = record.events.find(e => e.type === 'interrupted');
  assert.deepEqual(interrupted.cleared.steering, ['must not run']);
  await manager.send(agent.id, 'new task');
  assert.equal((await settled(manager, agent.id)).lastText, 'new task');
});
test('parallel shared ownership rejects overlap and respects capacity', async t => {
  const { manager, cwd } = await setup(t, { maxAgents: 2 });
  const a = await spawn(manager, cwd, 'HANG');
  await assert.rejects(spawn(manager, cwd, 'HANG', { ownedPaths: ['src/nested'] }), /overlap/);
  const b = await spawn(manager, cwd, 'HANG', { ownedPaths: ['other'] });
  await assert.rejects(spawn(manager, cwd, 'HANG', { ownedPaths: ['third'] }), /limit/);
  assert.notEqual(a.id, b.id);
});
test('settled agents do not consume concurrency capacity and default capacity is unlimited', async t => {
  assert.equal(defaultMaxAgents, 0);
  assert.equal(parseMaxAgents(undefined), 0);
  assert.equal(parseMaxAgents('0'), 0);
  assert.equal(parseMaxAgents('unlimited'), 0);
  assert.equal(parseMaxAgents('64'), 64);
  assert.throws(() => parseMaxAgents(-1), /non-negative integer/);
  const { manager, cwd } = await setup(t, { maxAgents: 1 });
  const first = await spawn(manager, cwd, 'done');
  assert.equal((await settled(manager, first.id)).status, 'completed');
  const second = await spawn(manager, cwd, 'HANG', { ownedPaths: ['other'] });
  await assert.rejects(spawn(manager, cwd, 'HANG', { ownedPaths: ['third'] }), /limit/);
  await assert.rejects(manager.send(first.id, 'more'), /limit/);
  assert.notEqual(first.id, second.id);
});
