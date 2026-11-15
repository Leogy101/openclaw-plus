import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {helperTasksFromMessages} from '../desktop/shared/helper-tasks.mjs';
const {normalizeMessage}=createRequire(import.meta.url)('../desktop/src/gateway-service.cjs');

function dispatch(id='dispatch-1',name='review_ui') {
  return [
    normalizeMessage({role:'assistant',timestamp:1000,__openclaw:{id:'call-'+id},content:[
      {type:'toolCall',id,name:'spawn_agent',arguments:{arguments:JSON.stringify({task_name:name,message:'Review a sample change.'})}},
    ]}),
    normalizeMessage({role:'toolResult',toolCallId:id,toolName:'spawn_agent',isError:false,timestamp:2000,
      __openclaw:{id:'receipt-'+id},content:[{type:'text',text:JSON.stringify({task_name:'/root/'+name})}]}),
  ];
}

test('native wrapped dispatch and exact successful receipt produce a parent-only task reference',()=>{
  const messages=dispatch(),[task]=helperTasksFromMessages(messages);
  assert.deepEqual(task,{id:'helper:dispatch-1',taskName:'/root/review_ui',requestedAt:1000,recordedAt:2000,
    callMessageId:messages[0].id,receiptMessageId:messages[1].id,state:'recorded'});
  for(const key of ['status','agentId','threadId','sessionId','sessionKey','working','completed'])assert.equal(Object.hasOwn(task,key),false);
  assert.deepEqual(helperTasksFromMessages(JSON.parse(JSON.stringify(messages))),[task],'projection needs no desktop APIs or runtime state');
});

test('unwrapped arguments remain supported and timestamps are optional source facts',()=>{
  const messages=dispatch();
  messages[0].blocks[0].text=JSON.stringify({task_name:'review_ui'});
  messages[0].timestamp='2026-01-01T10:00:00Z';delete messages[1].timestamp;
  const [task]=helperTasksFromMessages(messages);
  assert.equal(task.requestedAt,Date.parse('2026-01-01T10:00:00Z'));assert.equal(Object.hasOwn(task,'recordedAt'),false);
  messages[0].timestamp='unknown';messages[1].timestamp=-1;
  assert.equal(Object.hasOwn(helperTasksFromMessages(messages)[0],'requestedAt'),false);
  assert.equal(Object.hasOwn(helperTasksFromMessages(messages)[0],'recordedAt'),false);
});

test('unacknowledged requests, missing IDs and error receipts never become task cards',()=>{
  const [call,receipt]=dispatch();
  for(const messages of [[call],[receipt],[],null,{},[call,{...receipt,isError:true}],
    [call,{...receipt,isError:undefined}],[call,{...receipt,isError:'false'}],
    [call,{...receipt,toolCallId:'another-call'}],[call,{...receipt,toolCallId:undefined}],
    [call,{...receipt,toolName:'exec'}],[call,{...receipt,id:undefined}],
    [{...call,id:undefined},receipt],[{...call,role:'user'},receipt],
    [call,{...receipt,role:'assistant'}],[{...call,truncated:true},receipt],
    [call,{...receipt,truncated:true}],
    [{...call,blocks:call.blocks.map(block=>({...block,toolCallId:undefined}))},receipt],
    [{...call,blocks:call.blocks.map(block=>({...block,name:'sessions_spawn'}))},receipt],
  ])assert.deepEqual(helperTasksFromMessages(messages),[]);
});

test('ambiguous duplicate calls or receipts fail closed, including conflicting results',()=>{
  const [call,receipt]=dispatch();
  for(const messages of [[call,call,receipt],[call,receipt,receipt],
    [call,receipt,{...receipt,isError:true}],
    [call,{...call,id:'another-call-message'},receipt],
    [call,{...call,blocks:call.blocks.map(block=>({...block,name:'exec'}))},receipt],
  ])assert.deepEqual(helperTasksFromMessages(messages),[]);
});

test('a receipt before its correlated call cannot establish a dispatch in this history',()=>{
  const [call,receipt]=dispatch();
  assert.deepEqual(helperTasksFromMessages([receipt,call]),[]);
  assert.deepEqual(helperTasksFromMessages([{...receipt,timestamp:3000},{...call,timestamp:1000}]),[],
    'timestamps cannot override contradictory transcript order');
  assert.equal(helperTasksFromMessages([call,receipt]).length,1);
});

test('structured failure fields contradict an otherwise successful outer receipt',()=>{
  const [call,receipt]=dispatch();
  for(const failure of [{error:'Dispatch refused'},{error:{code:'DENIED'}},{error:true},{error:1},
    {errors:['Dispatch refused']},{errors:{code:'DENIED'}},{errored:true},{isError:true},{ok:false},{success:false},
    ...['error','errored','failed','failure','denied','rejected','cancelled','canceled','blocked',' FAILED '].map(status=>({status}))]) {
    const contradictory={...receipt,text:JSON.stringify({task_name:'/root/review_ui',...failure})};
    assert.deepEqual(helperTasksFromMessages([call,contradictory]),[]);
  }
  for(const empty of [null,false,0,'','  ',[],{}]) {
    const emptyErrors={...receipt,text:JSON.stringify({task_name:'/root/review_ui',error:empty,errors:empty})};
    assert.equal(helperTasksFromMessages([call,emptyErrors]).length,1,'empty optional errors are not failure evidence');
  }
});

test('malformed names, argument wrappers and receipt claims cannot fabricate a dispatch',()=>{
  const [call,receipt]=dispatch();
  for(const text of ['', 'not json','[]','null',JSON.stringify({task_name:'another_task'}),
    JSON.stringify({task_name:'/root/review_ui\nWORKING'}),JSON.stringify({task_name:'../review_ui'}),
    JSON.stringify({task_name:'x'.repeat(513)}),JSON.stringify({status:'working',message:'Dispatch succeeded'}),
    ' '.repeat(30001)+JSON.stringify({task_name:'/root/review_ui'})]) {
    assert.deepEqual(helperTasksFromMessages([call,{...receipt,text}]),[]);
  }
  for(const text of ['[]','null','bad',JSON.stringify({arguments:{task_name:'review_ui'}}),
    JSON.stringify({arguments:JSON.stringify({arguments:JSON.stringify({task_name:'review_ui'})})}),
    JSON.stringify({task_name:'review_ui',arguments:'invalid'}),JSON.stringify({task_name:'../review_ui'}),
    ' '.repeat(30001)+JSON.stringify({task_name:'review_ui'})]) {
    assert.deepEqual(helperTasksFromMessages([{...call,blocks:call.blocks.map(block=>({...block,text}))},receipt]),[]);
  }
  const claimed={...receipt,text:JSON.stringify({task_name:'/root/review_ui',status:'completed',agentId:'reviewer',sessionKey:'fake-route'})};
  assert.deepEqual(helperTasksFromMessages([call,claimed]),helperTasksFromMessages([call,receipt]),'arbitrary result claims are never projected');
});

test('same task names across different successful calls remain separate dispatch receipts',()=>{
  const first=dispatch('first'),second=dispatch('second');
  const tasks=helperTasksFromMessages([...first,...second]);
  assert.deepEqual(tasks.map(task=>task.id),['helper:second','helper:first']);
  assert.equal(tasks[0].taskName,tasks[1].taskName);
});

test('bounded history never scans older requests or creates cards from prose',()=>{
  const [call,receipt]=dispatch();
  const prose={role:'assistant',text:'The helper is working and has completed a review.',blocks:[]};
  assert.deepEqual(helperTasksFromMessages([call,...Array(1000).fill(prose),receipt]),[]);
  assert.deepEqual(helperTasksFromMessages([prose]),[]);
  const many=Array.from({length:220},(_,index)=>dispatch('call-'+index)).flat();
  const tasks=helperTasksFromMessages(many);
  assert.equal(tasks.length,200);assert.equal(tasks[0].id,'helper:call-219');
});
