import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {setup,spawn,settled} from './helpers/setup.js';import {reserveRequest} from '../src/agent-policy.js';
test('message receipts deduplicate instructions, reject conflicting content and acknowledge durably',async t=>{
 const {cwd,manager}=await setup(t);const agent=await spawn(manager,cwd);await settled(manager,agent.id);const id=randomUUID();await manager.send(agent.id,'one','steer',id);await settled(manager,agent.id);const twice=await manager.send(agent.id,'one','steer',id);assert.equal(twice.duplicate,true);assert.equal(twice.accepted,true);await assert.rejects(manager.send(agent.id,'two','steer',id),/different/);
 const transcript=await manager.get(agent.id).rpc.command('get_messages');assert.equal(transcript.messages.filter(v=>v.role==='user'&&v.content==='one').length,1);
 manager.messages.acknowledge(agent.id,[id]);assert.ok(manager.messages.all(agent.id).find(v=>v.messageId===id).acknowledgedAt);assert.ok(!manager.messages.read(agent.id,{unacknowledgedOnly:true}).messages.some(v=>v.messageId===id));
});
test('provider limit checks are preflight and wall time stops a hanging process',async t=>{
 const {cwd,manager}=await setup(t);const value=await spawn(manager,cwd,'HANG',{policy:{maxModelRequests:1,maxRuntimeMs:200}});const agent=manager.get(value.id);assert.equal(reserveRequest(agent,randomUUID(),manager.messages).allowed,true);assert.throws(()=>manager.reserveProviderRequest(value.id,randomUUID()),/request count/);const result=await settled(manager,value.id);assert.equal(result.status,'failed');assert.match(result.limitReason,/running time/);
 await manager.updatePolicy(value.id,{maxModelRequests:5},'test human instruction');assert.equal(manager.read(value.id).agent.status,'idle');
});
