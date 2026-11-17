'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {command,run}=require('../desktop/src/gcb-openclaw.cjs');
const env={HOME:'/fixture',OPENCLAW_CONFIG_PATH:'/fixture/.openclaw/openclaw.json',OPENCLAW_PLUS_GCB_EXPECT_URL:'ws://127.0.0.1:19999',OPENCLAW_GATEWAY_TOKEN:'secret',NODE_OPTIONS:'injected'};
const args=()=>['gateway','call','gcb.profile.complete','--json','--params','{"requestId":"fixture"}','--timeout','45000'];
test('GCB native dispatch binds the installed CLI and exact loopback endpoint without forwarding credentials',async()=>{
  let invocation;
  const result=run(args(),env,(node,argv,options,done)=>{invocation={node,argv,options};queueMicrotask(()=>done(null,'{"status":"completed"}'));return {kill(){}};});
  assert.deepEqual(await result.promise,{status:'completed'});
  assert.equal(invocation.node,'/opt/homebrew/bin/node');assert.equal(invocation.argv[0],'/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs');
  assert.deepEqual(invocation.argv.slice(-2),['--expect-url','ws://127.0.0.1:19999']);assert.equal(invocation.options.shell,false);
  assert.equal(invocation.options.env.OPENCLAW_GATEWAY_TOKEN,undefined);assert.equal(invocation.options.env.NODE_OPTIONS,undefined);
});
test('only complete/cancel with fixed flags and a bounded configured loopback endpoint are accepted',()=>{
  const cancel=args();cancel[2]='gcb.profile.cancel';assert.ok(command(cancel,env));
  for(const mutate of [a=>a[2]='config.patch',a=>a.push('--token','secret'),a=>a[3]='--url',a=>a[7]='70000',a=>a[5]='[]']){
    const a=args();mutate(a);assert.throws(()=>command(a,env));
  }
  for(const changed of [{OPENCLAW_PLUS_GCB_EXPECT_URL:'wss://remote.example:443'},{OPENCLAW_PLUS_GCB_EXPECT_URL:'ws://127.0.0.1:65536'},{OPENCLAW_CONFIG_PATH:'relative'},{OPENCLAW_SHELL:''}])assert.throws(()=>command(args(),{...env,...changed}));
});
test('transport failures redact native diagnostics and cancellation targets only its own child',async()=>{
  let signal;
  const task=run(args(),env,(_node,_args,_options,done)=>{queueMicrotask(()=>done(new Error('token=secret'),'password=private'));return {kill(value){signal=value;}};});
  task.cancel();assert.equal(signal,'SIGTERM');await assert.rejects(task.promise,error=>! /secret|private/.test(error.message));
});
