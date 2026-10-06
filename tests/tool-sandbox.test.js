import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { fileOperation, runSandboxed } from '../src/tool-sandbox.js';
test('file and shell tools allow owned writes and reject sibling writes, symlinks, state reads and network', async t => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-policy-test-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  for(const name of ['src','other','state','tmp']) fs.mkdirSync(path.join(cwd,name));
  fs.writeFileSync(cwd+'/state/private','controller token');fs.symlinkSync(cwd+'/other',cwd+'/src/link');
  const policy={cwd,ownedPaths:['src'],tempDir:cwd+'/tmp',stateRoot:cwd+'/state',allowNetwork:false};
  await fileOperation(policy,'write','src/a','allowed');assert.equal(String(await fileOperation(policy,'read','src/a')),'allowed');
  await assert.rejects(fileOperation(policy,'write','other/a','bad'),/scope/);
  await assert.rejects(fileOperation(policy,'write','src/link/a','bad'),/scope/);
  await assert.rejects(fileOperation(policy,'read','state/private'),/controller state/);
  let output='';const run=await runSandboxed(policy,'/bin/bash',['-c','echo yes > src/b; echo bad > other/b; echo bad > state/private; cat state/private; curl --max-time 1 http://127.0.0.1:4317'],{onData:v=>output+=v});
  assert.notEqual(run.exitCode,0);assert.ok(fs.existsSync(cwd+'/src/b'));assert.ok(!fs.existsSync(cwd+'/other/b'));assert.ok(!output.includes('controller token'));assert.equal(fs.readFileSync(cwd+'/state/private','utf8'),'controller token');
  process.env.PI_SUBAGENT_TOKEN='test-secret';let environment='';await runSandboxed(policy,'/usr/bin/env',[],{onData:v=>environment+=v});assert.ok(!environment.includes('test-secret'));delete process.env.PI_SUBAGENT_TOKEN;
});
test('sandbox cancellation terminates the shell and descendants',async t=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-cancel-test-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));fs.mkdirSync(cwd+'/state');fs.mkdirSync(cwd+'/tmp');
 const abort=new AbortController();setTimeout(()=>abort.abort(),100);const result=await runSandboxed({cwd,ownedPaths:['.'],tempDir:cwd+'/tmp',stateRoot:cwd+'/state',allowNetwork:false},'/bin/bash',['-c','sleep 1; echo bad > escaped'],{signal:abort.signal});assert.equal(result.exitCode,137);await new Promise(r=>setTimeout(r,1050));assert.ok(!fs.existsSync(cwd+'/escaped'));
});
