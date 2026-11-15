// Portable view of questions in an already bounded, chronological session history.
// No clock, persistence, gateway access or inferred answer from assistant claims.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const identity=value=>bounded(value,512)&&value.trim()===value&&!/[\x00-\x1f\x7f]/u.test(value);
const nativeEvidence=message=>object(message?.native)&&identity(message.native.id)&&Number.isSafeInteger(message.native.sequence)&&message.native.sequence>0&&!message.native.imported?message.native:undefined;
const external=native=>native&&(native.provenance===undefined||native.provenance==='external_user');

function questionFrom(message) {
  const item=message?.asyncQuestion;
  if(message?.role!=='assistant'||!bounded(message.id,1024)||!object(item)||!bounded(item.id,256)||
    !Array.isArray(item.questions)||item.questions.length<1||item.questions.length>12)return;
  const questions=[];
  for(const question of item.questions) {
    if(!object(question)||!bounded(question.title,4096)||question.options!==undefined&&
      (!Array.isArray(question.options)||question.options.length<1||question.options.length>4||question.options.some(option=>!bounded(option,256))))return;
    questions.push({title:question.title,...(question.options?{options:[...question.options]}:{})});
  }
  return {messageId:message.id,id:item.id,...(identity(item.sourceMessageId)?{sourceMessageId:item.sourceMessageId}:{}),questions};
}

function heading(title) {
  const encoder=new TextEncoder();let shortened='',bytes=0;
  for(const character of title){const size=encoder.encode(character).length;if(bytes+size>512)break;shortened+=character;bytes+=size;}
  return '> '+shortened.replace(/[\r\n]/gu,' ');
}

function matchesQuotedAnswer(question,text) {
  if(typeof text!=='string'||text.length>60000||!text.startsWith('> '))return false;
  let offset=0;
  for(let index=0;index<question.questions.length;index++) {
    const prefix=heading(question.questions[index].title)+'\n\n';
    if(!text.startsWith(prefix,offset))return false;
    offset+=prefix.length;
    const next=question.questions[index+1],separator=next?'\n\n'+heading(next.title)+'\n\n':undefined;
    const end=separator?text.indexOf(separator,offset):text.length;
    if(end<offset||separator&&text.includes(separator,end+separator.length)||!text.slice(offset,end).trim())return false;
    offset=end+(separator?2:0);
  }
  return offset===text.length;
}

export function projectAsyncQuestions(messages) {
  if(!Array.isArray(messages))return {pending:[],statuses:[]};
  const questions=new Map(),answered=new Map(),runs=new Map(),replies=new Set(),successes=[];
  let previousExternalRun;
  for(const [index,message] of messages.slice(-2000).entries()) {
    if(!object(message))continue;
    const native=nativeEvidence(message),runId=identity(native?.runId)?native.runId:undefined;
    if(runId){
      const run=runs.get(runId)||{first:index,last:index,firstSequence:native.sequence,lastSequence:native.sequence};
      run.last=index;run.firstSequence=Math.min(run.firstSequence,native.sequence);run.lastSequence=Math.max(run.lastSequence,native.sequence);
      if(native.terminal){run.settled=index;run.settledSequence=Math.max(run.settledSequence||0,native.sequence);}
      runs.set(runId,run);
    }
    if(message.role==='user'&&external(native)&&runId)previousExternalRun=runId;
    const question=questionFrom(message);
    if(question) {
      const previous=questions.get(question.id),signature=JSON.stringify(question.questions);
      if(previous&&previous.signature!==signature)answered.delete(question.id);
      questions.set(question.id,{question,signature,index,sequence:native?.sequence,originRunId:runId||previousExternalRun});
    }
    if(message.role==='user'&&external(native)&&!message.truncated&&bounded(message.text,60000)) {
      const evidenceId=JSON.stringify([native.id,native.sequence]);
      if(!replies.has(evidenceId)) {
        replies.add(evidenceId);
        const replyToId=identity(native.replyToId)?native.replyToId:undefined;
        const candidates=[...questions.values()].filter(({question,sequence})=>!answered.has(question.id)&&
          (sequence!==undefined&&native.sequence>sequence)&&
          (!replyToId||question.sourceMessageId===replyToId)&&
          (replyToId||matchesQuotedAnswer(question,message.text)));
        if(candidates.length===1)answered.set(candidates[0].question.id,message.id);
      }
    }
    if(message.role==='assistant'&&runId&&native.terminal==='successful'&&!message.truncated)successes.push({runId,index});
  }
  const pending=[],statuses=[];
  for(const {question,index,sequence,originRunId} of questions.values()) {
    const answerMessageId=answered.get(question.id),origin=originRunId&&runs.get(originRunId);
    // The origin must have settled after asking; a distinct later run must have
    // begun after all observed origin work. Overlapping runs cannot retire it.
    const archived=!answerMessageId&&origin&&sequence!==undefined&&origin.settled>index&&origin.settledSequence>sequence&&successes.some(success=>
      success.runId!==originRunId&&runs.get(success.runId)?.first>origin.last&&runs.get(success.runId)?.firstSequence>origin.lastSequence);
    const state=answerMessageId?'answered':archived?'archived':'pending';
    statuses.push({id:question.id,state,messageId:question.messageId,...(answerMessageId?{answerMessageId}:{})});
    if(state==='pending')pending.push(question);
  }
  return {pending,statuses};
}
