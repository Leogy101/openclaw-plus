'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CliTransport, classifyFailure } = require('../desktop/src/gateway-cli.cjs');
const { validateRequest: validatePrivateRequest } = require('../desktop/src/composer-rpc.cjs');
const target = { url: 'ws://127.0.0.1:19999', configPath: '/fixture/openclaw.json' };
test('only closed read methods, fixed binary and structured params reach the CLI', async () => {
  let invocation;
  const cli = new CliTransport({ home: '/fixture', target, execute(node, args, options, done) {
    invocation = { node, args, options }; queueMicrotask(() => done(null, '{"sessions":[]}')); return { kill() {} };
  }});
  await assert.rejects(cli.request('chat.send', {}), { code: 'DENIED' }); assert.equal(invocation, undefined);
  const query = '$(touch /tmp/nope); `echo no`';
  await cli.request('sessions.list', { search: query });
  assert.equal(invocation.node, '/opt/homebrew/bin/node');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(JSON.parse(invocation.args[invocation.args.indexOf('--params') + 1]), { search: query });
  assert.equal(invocation.args[invocation.args.indexOf('--expect-url') + 1], target.url);
  assert.equal(invocation.args.includes('--token'), false);
  assert.equal(invocation.options.env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
  assert.equal(invocation.options.env.OPENCLAW_CONFIG_PATH, target.configPath);
  cli.close();
});
test('CLI failure text and credentials never cross the error boundary', () => {
  for (const raw of ['secret-token=do-not-copy', '{"error":{"code":"UNAUTHORIZED","message":"password=private"}}']) {
    const error = classifyFailure(raw, false);
    assert.doesNotMatch(error.message, /private|do-not-copy|password|secret-token/);
  }
  assert.equal(classifyFailure('', true).code, 'TIMEOUT');
});
test('concurrency is bounded, close rejects waiting reads and kills only owned children', async () => {
  const callbacks = [], children = [];
  const cli = new CliTransport({ home: '/fixture', target, execute(_n, _a, _o, done) {
    callbacks.push(done); const child = { killed: false, kill() { this.killed = true; queueMicrotask(() => done({ killed: true }, '')); } }; children.push(child); return child;
  }});
  const calls = Array.from({ length: 4 }, () => cli.request('agents.list', {}).catch(e => e.code));
  assert.equal(callbacks.length, 2); cli.close();
  assert.deepEqual(await Promise.all(calls), ['CLOSED','CLOSED','CLOSED','CLOSED']);
  assert.ok(children.every(c => c.killed));
});

test('writes use a separate fixed lane and retain agent execution attribution', async () => {
 const seen=[];const old=process.env.OPENCLAW_SHELL;process.env.OPENCLAW_SHELL='exec';
 try {
  const cli=new CliTransport({home:'/fixture',target,execute(node,args,options,done){seen.push({args,options});return {kill(){},stdin:{on(){},end(){queueMicrotask(()=>done(null,'{"runId":"submission","status":"started"}'));}}};}});
  await assert.rejects(cli.write('config.set',{}),{code:'DENIED'});
  await assert.rejects(cli.write('agents.list',{}),{code:'DENIED'});
  await cli.write('chat.send',{sessionKey:'agent:main:main',message:'literal $(echo nope)',idempotencyKey:'submission'});
  assert.equal(seen.length,1);assert.equal(seen[0].options.env.OPENCLAW_SHELL,'exec');assert.equal(seen[0].options.shell,false);
  assert.equal(seen[0].args[2],target.url);assert.match(seen[0].args[0],/composer-rpc\.cjs$/);cli.close();
 } finally {if(old===undefined)delete process.env.OPENCLAW_SHELL;else process.env.OPENCLAW_SHELL=old;}
});
test('lost write acknowledgements are uncertain and never automatically retried', async () => {
 let count=0;const cli=new CliTransport({home:'/fixture',target,execute(n,a,o,done){count++;return {kill(){},stdin:{on(){},end(){queueMicrotask(()=>done({killed:true},'private failure details'));}}};}});
 await assert.rejects(cli.write('chat.send',{idempotencyKey:'one'}),{code:'UNCERTAIN'});assert.equal(count,1);cli.close();
 assert.equal(classifyFailure(JSON.stringify({error:{code:'INVALID_REQUEST',reason:'active-leaf-changed'}}),false,true).code,'CONFLICT');
});
test('approval requests use only the public scoped helper with a pinned endpoint', async () => {
 let invocation;const cli=new CliTransport({home:'/fixture',target,execute(n,args,options,done){invocation={args,options};queueMicrotask(()=>done(null,'[]'));return {kill(){}};}});
 await cli.request('exec.approval.list',{});
 assert.match(invocation.args[0],/approval-rpc\.cjs$/);assert.deepEqual(invocation.args.slice(1),['exec.approval.list',target.url,'{}']);
 assert.equal(invocation.options.shell,false);assert.equal(invocation.options.env.OPENCLAW_GATEWAY_TOKEN,undefined);cli.close();
});

test('media and session model changes use a fixed endpoint-pinned stdin helper, never base64 argv',async()=>{
 const seen=[];
 const cli=new CliTransport({home:'/fixture',target,execute(node,args,options,done){
   const call={node,args,options};seen.push(call);
   return {kill(){},stdin:{on(){},end(input){call.input=input;queueMicrotask(()=>done(null,'{"ok":true}'));}}};
 }});
 const media={sessionKey:'agent:main:main',agentId:'main',sessionId:'physical',message:'',idempotencyKey:'send-1',expectedLeafEntryId:null,
   attachments:[{type:'image',mimeType:'image/png',content:'PRIVATE_FIXTURE_BASE64'}]};
 await cli.write('chat.send',media);
 await cli.write('sessions.patch',{key:'agent:main:main',agentId:'main',expectedSessionId:'physical',model:'fixture/model'});
 assert.equal(seen.length,2);
 for(const call of seen){assert.match(call.args[0],/composer-rpc\.cjs$/);assert.equal(call.args[2],target.url);assert.equal(call.args.length,3);assert.equal(call.options.shell,false);assert.equal(call.options.env.OPENCLAW_GATEWAY_TOKEN,undefined);}
 assert.deepEqual(JSON.parse(seen[0].input),media);assert.equal(seen[0].args.join(' ').includes('PRIVATE_FIXTURE'),false);
 assert.equal(JSON.parse(seen[1].input).expectedSessionId,'physical'); cli.close();
});

test('oversized stdin requests fail before spawning and helper failures retain safe conflict/access categories',async()=>{
 let writes=0;const cli=new CliTransport({home:'/fixture',target,execute(){writes++;throw Error('Unexpected execution');}});
 await assert.rejects(cli.write('chat.send',{attachments:[{content:'x'.repeat(18*1024*1024)}]}),{code:'INVALID'});
 assert.equal(writes,0);cli.close();
 assert.equal(classifyFailure('{"ok":false,"error":{"code":"INVALID_REQUEST","reason":"session-settings-changed"}}',false,true).code,'CONFLICT');
 assert.equal(classifyFailure('{"ok":false,"error":{"code":"FORBIDDEN"}}',false,true).code,'ACCESS');
});

test('text-only prompts and configuration deltas never appear in process arguments or environment',async()=>{
 const seen=[];
 const cli=new CliTransport({home:'/fixture',target,execute(node,args,options,done){
  const call={node,args,options};seen.push(call);
  return {kill(){},stdin:{on(){},end(input){call.input=input;queueMicrotask(()=>done(null,'{"ok":true}'));}}};
 }});
 const requests=[['chat.send',{sessionKey:'agent:main:main',message:'PRIVATE_PROMPT_FIXTURE',idempotencyKey:'text-only'}],
  ['config.patch',{baseHash:'fixture-hash',raw:'{"ui":{"name":"PRIVATE_CONFIG_FIXTURE"}}',response:'summary'}]];
 for(const [method,params]of requests)await cli.write(method,params);
 assert.equal(seen.length,2);
 for(const [i,call]of seen.entries()){
  assert.match(call.args[0],/composer-rpc\.cjs$/);
  assert.deepEqual(call.args.slice(1),[requests[i][0],target.url]);
  assert.doesNotMatch(JSON.stringify({args:call.args,env:call.options.env}),/PRIVATE_PROMPT_FIXTURE|PRIVATE_CONFIG_FIXTURE/);
  assert.deepEqual(JSON.parse(call.input),requests[i][1]);
 }
 cli.close();
});

test('private-input helper exposes only fixed fields and keeps admin scope off composer changes',()=>{
 assert.deepEqual(validatePrivateRequest('chat.send',{message:'fixture'}),['operator.read','operator.write']);
 assert.deepEqual(validatePrivateRequest('sessions.patch',{key:'fixture',model:'fixture/model'}),['operator.read','operator.write']);
 assert.deepEqual(validatePrivateRequest('config.patch',{baseHash:'fixture',raw:'{}',response:'summary',replacePaths:[]}),['operator.admin']);
 for(const [method,params]of [['config.set',{}],['config.patch',{file:'/fixture/other'}],['sessions.patch',{scopes:['operator.admin']}],['chat.send',{url:'ws://elsewhere'}]])
  assert.throws(()=>validatePrivateRequest(method,params));
});

test('Full permission requests alone use admin scope and cannot carry model or unrelated changes',()=>{
 const pinned={key:'agent:main:main',agentId:'main',expectedSessionId:'physical',expectedLifecycleRevision:'revision',expectedPermissionMode:null,permissionMode:'full'};
 assert.deepEqual(validatePrivateRequest('sessions.patch',pinned),['operator.admin']);
 assert.deepEqual(validatePrivateRequest('sessions.patch',{...pinned,permissionMode:'guarded'}),['operator.write']);
 assert.deepEqual(validatePrivateRequest('sessions.patch',{...pinned,permissionMode:null}),['operator.write']);
 const {expectedLifecycleRevision,...legacy}=pinned;
 assert.deepEqual(validatePrivateRequest('sessions.patch',legacy),['operator.admin']);
 for(const invalid of [{...pinned,model:'provider/model'},{...pinned,thinkingLevel:'high'},{...pinned,expectedPermissionMode:undefined},{...pinned,permissionMode:'skip'},{...pinned,expectedLifecycleRevision:''},{...pinned,expectedLifecycleRevision:null},{...legacy,expectedSessionId:undefined}])assert.throws(()=>validatePrivateRequest('sessions.patch',invalid));
});
