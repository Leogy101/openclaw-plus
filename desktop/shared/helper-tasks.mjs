// Portable, read-only projection of dispatch receipts already in the selected history.
// Acknowledgement proves dispatch only, never current execution, completion or a session route.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&value.trim()===value&&!/[\x00-\x1f\x7f]/u.test(value);
const callIdentity=value=>identity(value)&&value.length<=512;
const taskName=value=>typeof value==='string'&&value.length>0&&value.length<=512&&/^\/?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(value);
const parse=value=>{if(typeof value!=='string'||value.length>30000)return;try{const result=JSON.parse(value);return object(result)?result:undefined;}catch{return;}};
const meaningfulError=value=>value!==undefined&&value!==null&&value!==false&&value!==0&&
  (typeof value==='string'?value.trim().length>0:Array.isArray(value)?value.length>0:object(value)?Object.keys(value).length>0:true);
const failedReceipt=result=>result.ok===false||result.success===false||result.errored===true||result.isError===true||
  meaningfulError(result.error)||meaningfulError(result.errors)||
  typeof result.status==='string'&&['error','errored','failed','failure','denied','rejected','cancelled','canceled','blocked'].includes(result.status.trim().toLowerCase());
const time=value=>{
  const stamp=typeof value==='number'?value:typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/u.test(value)?Date.parse(value):NaN;
  return Number.isFinite(stamp)&&stamp>0&&stamp<=8640000000000000?stamp:undefined;
};

export function helperTasksFromMessages(messages) {
  if(!Array.isArray(messages))return [];
  const calls=new Map(),receipts=new Map();
  const add=(map,id,value)=>{const entries=map.get(id)||[];entries.push(value);map.set(id,entries);};
  for(const [index,message] of messages.slice(-1000).entries()) {
    if(!object(message))continue;
    if(message.role==='assistant')for(const block of (Array.isArray(message.blocks)?message.blocks:[]).slice(0,100)) {
      if(object(block)&&block.type==='tool'&&callIdentity(block.toolCallId))add(calls,block.toolCallId,{message,block,index});
    }
    if(message.role==='toolResult'&&callIdentity(message.toolCallId))add(receipts,message.toolCallId,{message,index});
  }
  const tasks=[];
  for(const [id,matchingCalls] of calls) {
    const matchingReceipts=receipts.get(id);
    // Repeated IDs or conflicting receipts cannot establish a unique dispatch.
    if(matchingCalls.length!==1||matchingReceipts?.length!==1)continue;
    const {message:call,block,index:callIndex}=matchingCalls[0],{message:receipt,index}=matchingReceipts[0];
    if(index<=callIndex||block.name!=='spawn_agent'||receipt.toolName!=='spawn_agent'||receipt.isError!==false||
      call.truncated||receipt.truncated||!identity(call.id)||!identity(receipt.id)||call.id===receipt.id)continue;
    let args=parse(block.text);
    // The native Code Mode projection wraps arguments in one JSON string.
    if(object(args)&&Object.hasOwn(args,'arguments'))args=parse(args.arguments);
    const result=parse(receipt.text);
    if(!taskName(args?.task_name)||!taskName(result?.task_name)||failedReceipt(result)||
      result.task_name!==args.task_name&&!result.task_name.endsWith('/'+args.task_name))continue;
    const requestedAt=time(call.timestamp),recordedAt=time(receipt.timestamp);
    tasks.push({index,id:'helper:'+id,taskName:result.task_name,
      ...(requestedAt!==undefined?{requestedAt}:{}),...(recordedAt!==undefined?{recordedAt}:{}),
      callMessageId:call.id,receiptMessageId:receipt.id,state:'recorded'});
  }
  return tasks.sort((a,b)=>b.index-a.index).slice(0,200).map(({index,...task})=>task);
}
