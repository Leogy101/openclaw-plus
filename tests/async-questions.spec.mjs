import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {projectAsyncQuestions} from '../desktop/shared/async-questions.mjs';
const {normalizeMessage}=createRequire(import.meta.url)('../desktop/src/gateway-service.cjs');
const titles=[{title:'Choose a review scope',options:['Focused review','Full review']}];
const rawQuestion=(id='question-1',questions=titles,extra={})=>({role:'assistant',content:[],
  openclawAsyncDelivery:{itemId:id,questions},__openclaw:{id:'source-'+id,seq:2,runId:'origin'},...extra});
const rawUser=(text,extra={})=>({role:'user',content:text,__openclaw:{id:'user-answer',seq:5,runId:'later'},...extra});
const rawFinal=(id,extra={})=>({role:'assistant',content:'Completed example.',stopReason:'stop',
  __openclaw:{id:'final-'+id,seq:7,runId:id,runTerminal:true},...extra});
const project=messages=>projectAsyncQuestions(messages.map(normalizeMessage));
const quoted='> Choose a review scope\n\nFocused review';

test('structured unanswered questions project into the dock without inventing pending gateway records',()=>{
  const raw=rawQuestion(),normalized=normalizeMessage(raw),result=project([raw]);
  assert.deepEqual(result,{pending:[{messageId:normalized.id,id:'question-1',sourceMessageId:'source-question-1',questions:titles}],
    statuses:[{id:'question-1',state:'pending',messageId:normalized.id}]});
  assert.deepEqual(projectAsyncQuestions(null),{pending:[],statuses:[]});
});

test('a saved external-user replyToId resolves its exact earlier question after reload',()=>{
  const raw=rawUser('A custom answer',{__openclaw:{id:'saved-answer',seq:5,replyToId:'source-question-1'}});
  const result=project([rawQuestion(),raw]);
  assert.deepEqual(result.pending,[]);assert.equal(result.statuses[0].state,'answered');
  assert.equal(result.statuses[0].answerMessageId,normalizeMessage(raw).id);
  assert.deepEqual(projectAsyncQuestions(JSON.parse(JSON.stringify([rawQuestion(),raw].map(normalizeMessage)))),result);
});

test('one uniquely matching canonical quoted reply resolves without replyToId',()=>{
  assert.equal(project([rawQuestion(),rawUser(quoted)]).statuses[0].state,'answered');
  const questions=[...titles,{title:'Anything else?'}];
  assert.equal(project([rawQuestion('multi',questions),rawUser(quoted+'\n\n> Anything else?\n\nKeep the tests.')]).statuses[0].state,'answered');
});

test('ambiguous same-heading questions stay unanswered unless an exact native link selects one',()=>{
  const history=[rawQuestion('first'),rawQuestion('second')];
  assert.deepEqual(project([...history,rawUser(quoted)]).statuses.map(item=>item.state),['pending','pending']);
  const linked=rawUser(quoted,{__openclaw:{id:'user-answer',seq:5,replyToId:'source-second'}});
  assert.deepEqual(project([...history,linked]).statuses.map(item=>item.state),['pending','answered']);
  const unrelated=rawUser(quoted,{__openclaw:{id:'user-answer',seq:5,replyToId:'source-unrelated'}});
  assert.deepEqual(project([...history,unrelated]).statuses.map(item=>item.state),['pending','pending']);
});

test('ordinary user messages, assistant claims and untrusted source rows do not answer questions',()=>{
  for(const answer of [rawUser('Continue'),rawUser('The assistant said this is answered.'),
    rawUser(quoted,{role:'assistant'}),rawUser(quoted,{__openclaw:{id:'unanchored'}}),
    rawUser(quoted,{__openclaw:{id:'imported',seq:5,importedFrom:'fixture'}}),
    rawUser(quoted,{provenance:{kind:'internal_system'}}),rawUser(quoted,{provenance:{kind:'inter_session'}}),
    rawUser(quoted,{provenance:{kind:'unexpected'}}),rawUser(quoted,{truncated:true})]) {
    assert.equal(project([rawQuestion(),answer]).statuses[0].state,'pending');
  }
  assert.equal(project([rawUser(quoted),rawQuestion()]).statuses[0].state,'pending','an earlier answer cannot resolve a later question');
});

test('quoted answers require complete unambiguous framing, including exact bounded Unicode headings',()=>{
  const questions=[...titles,{title:'Extra context?'}];
  for(const text of [quoted,quoted+'\n\n> Extra context?\n\n',
    quoted+'\n\n> Extra context?\n\nFirst\n\n> Extra context?\n\nSecond',
    'Prefix\n'+quoted+'\n\n> Extra context?\n\nAnswer'])assert.equal(project([rawQuestion('multi',questions),rawUser(text)]).statuses[0].state,'pending');
  const longTitle='界'.repeat(180)+'\nchoose';
  const short='界'.repeat(170);
  assert.equal(project([rawQuestion('unicode',[{title:longTitle}]),rawUser('> '+short+'\n\nA considered answer.')]).statuses[0].state,'answered');
});

test('duplicate question occurrences have one status and keep their latest source row',()=>{
  const first=rawQuestion(),second={...first,__openclaw:{id:'new-source',seq:3,runId:'origin'}};
  const result=project([first,second]);
  assert.equal(result.pending.length,1);assert.equal(result.pending[0].messageId,normalizeMessage(second).id);
  assert.equal(result.pending[0].sourceMessageId,'new-source');
  const changed=rawQuestion('question-1',[{title:'A different decision'}]);
  assert.equal(project([first,rawUser(quoted),changed]).statuses[0].state,'pending','changed definitions cannot reuse old answer evidence');
});

test('duplicate user observations cannot answer a newly appearing identical question twice',()=>{
  const reply=rawUser(quoted);
  const result=project([rawQuestion('first'),reply,rawQuestion('second'),reply]);
  assert.deepEqual(result.statuses.map(item=>item.state),['answered','pending']);
});

test('merged history cannot make an older native user record answer a later question',()=>{
  const question=rawQuestion('later-question',titles,{__openclaw:{id:'source-later-question',seq:20,runId:'origin'}});
  for(const seq of [19,20]) {
    const reply=rawUser(quoted,{__openclaw:{id:'older-answer',seq,replyToId:'source-later-question'}});
    assert.equal(project([question,reply]).statuses[0].state,'pending');
  }
  const reply=rawUser(quoted,{__openclaw:{id:'newer-answer',seq:21,replyToId:'source-later-question'}});
  assert.equal(project([question,reply]).statuses[0].state,'answered');
});

test('a retained question without trusted sequence cannot resolve from reordered saved replies',()=>{
  for(const meta of [{id:'unanchored-source'},{id:'unanchored-source',seq:0},
    {id:'unanchored-source',seq:20,importedFrom:'fixture-import'}]) {
    const question=rawQuestion('unanchored',titles,{__openclaw:meta});
    const olderQuote=rawUser(quoted,{__openclaw:{id:'older-answer',seq:10}});
    assert.equal(project([question,olderQuote]).statuses[0].state,'pending');
    const claimedLink=rawUser('An answer',{__openclaw:{id:'linked-answer',seq:30,replyToId:'unanchored-source'}});
    assert.equal(project([question,claimedLink]).statuses[0].state,'pending');
  }
});

test('only a distinct later successfully completed run retires an unanswered reminder',()=>{
  const question=rawQuestion();
  assert.equal(project([question,rawFinal('origin')]).statuses[0].state,'pending','its own final does not dismiss it');
  const originFinal=rawFinal('origin',{__openclaw:{id:'origin-final',seq:3,runId:'origin',runTerminal:true}});
  const laterStart=rawUser('A different task');
  assert.equal(project([question,originFinal,laterStart,rawFinal('later')]).statuses[0].state,'archived');
  assert.equal(project([question,laterStart,rawFinal('origin'),rawFinal('later')]).statuses[0].state,'pending','overlap is not a later independent turn');
  assert.equal(project([question,laterStart,rawFinal('later')]).statuses[0].state,'pending','missing origin settlement is not evidence');
  for(const ending of [{stopReason:'error'},{channel:'commentary'},{__openclaw:{id:'final-later',seq:7,runId:'later'}}]) {
    assert.equal(project([question,originFinal,laterStart,rawFinal('later',ending)]).statuses[0].state,'pending');
  }
});

test('older loaded terminal evidence cannot archive a newer retained question',()=>{
  const question=rawQuestion('recent',titles,{__openclaw:{id:'recent-source',seq:20,runId:'origin'}});
  const olderOriginFinal=rawFinal('origin',{__openclaw:{id:'older-origin-final',seq:10,runId:'origin',runTerminal:true}});
  const olderOtherFinal=rawFinal('another',{__openclaw:{id:'older-other-final',seq:12,runId:'another',runTerminal:true}});
  assert.equal(project([question,olderOriginFinal,olderOtherFinal]).statuses[0].state,'pending');
  const currentOriginFinal=rawFinal('origin',{__openclaw:{id:'current-origin-final',seq:21,runId:'origin',runTerminal:true}});
  assert.equal(project([question,currentOriginFinal,olderOtherFinal]).statuses[0].state,'pending');
});

test('answered state takes precedence over later successful boundaries',()=>{
  const result=project([rawQuestion(),rawFinal('origin'),rawUser(quoted),rawFinal('later')]);
  assert.equal(result.statuses[0].state,'answered');assert.deepEqual(result.pending,[]);
});

test('malformed normalized questions and oversized source bodies do not fabricate answers',()=>{
  const question=normalizeMessage(rawQuestion());
  for(const item of [null,{}, {...question.asyncQuestion,questions:[]}, {...question.asyncQuestion,questions:[{title:''}]},
    {...question.asyncQuestion,questions:[{title:'Choose',options:[]}]}, {...question.asyncQuestion,id:'x'.repeat(257)}]) {
    assert.deepEqual(projectAsyncQuestions([{...question,asyncQuestion:item}]),{pending:[],statuses:[]});
  }
  const answer=normalizeMessage(rawUser(quoted));answer.text=quoted+'x'.repeat(60001);
  assert.equal(projectAsyncQuestions([question,answer]).statuses[0].state,'pending');
});
