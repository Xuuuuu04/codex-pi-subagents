import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { fileOperation, runSandboxed, sandboxMode } from '../src/tool-sandbox.js';
test('development mode writes the whole workspace, runs local tools and still hides credentials and controller state', async t => {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-dev-test-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  for(const name of ['src','other','state','tmp']) fs.mkdirSync(path.join(cwd,name));
  fs.writeFileSync(cwd+'/state/private','controller token');
  const policy={cwd,ownedPaths:['src'],tempDir:cwd+'/tmp',stateRoot:cwd+'/state',allowNetwork:false,sandboxMode:'dev'};
  assert.equal(sandboxMode(policy),'dev');assert.equal(sandboxMode({}),sandboxMode({sandboxMode:undefined}));
  await fileOperation(policy,'write','other/a','allowed');assert.equal(String(await fileOperation(policy,'read','other/a')),'allowed');
  await assert.rejects(fileOperation(policy,'read','state/private'),/controller state/);
  await assert.rejects(fileOperation(policy,'read',path.join(os.homedir(),'.ssh','config')),/credentials|scope/);
  let output='';const run=await runSandboxed(policy,'/bin/bash',['-c','git init -q . && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m ok && git log --oneline | wc -l; cat state/private; ls ~/.pi >/dev/null 2>&1 && echo LEAK; echo $HOME'],{onData:v=>output+=v});
  assert.equal(run.exitCode,0);assert.match(output,/^\s*1/m);assert.ok(!output.includes('controller token'));assert.ok(!output.includes('LEAK'));assert.ok(output.includes(os.homedir()));
});
