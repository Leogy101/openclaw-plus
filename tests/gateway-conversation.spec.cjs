'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationActions } = require('../desktop/src/gateway-conversation.cjs');
const { ReadError } = require('../desktop/src/gateway-cli.cjs');
const { AttachmentStore } = require('../desktop/src/attachments.cjs');

const selected = { key: 'agent:main:main', agentId: 'main', sessionId: 'physical-1' };
const send = { ...selected, message: 'Fixture message', requestId: 'fixture-send-1' };
const card = { sessionKey: selected.key, revision: 3, updatedAt: 1000, markdown: 'Checking.', steps: [
  { step: 'Inspect', status: 'completed' }, { step: 'Verify', status: 'in_progress' }, { step: 'Report', status: 'pending' },
] };
function fixture({ read, write } = {}) {
  const calls = [];
  const base = {
    generation: 0,
    assertCurrent(generation) { if (generation !== this.generation) throw new ReadError('STALE', 'Changed.'); },
    invalidate() { this.generation++; },
    async read(method, params, ttl) {
      calls.push({ kind: 'read', method, params, ttl });
      if (read) return read(method, params);
      return { 'sessions.describe': { session: { ...selected, lifecycleRevision: 'life-1', activeRunIds: ['run-1'] } },
        'chat.history': { sessionId: selected.sessionId, sessionInfo: { activeLeafEntryId: 'leaf-1' } },
        'progressCard.get': { card } }[method];
    },
    transport: { async write(method, params) {
      calls.push({ kind: 'write', method, params });
      if (write) return write(method, params);
      return method === 'chat.send' ? { runId: params.idempotencyKey, status: 'started' } : { ok: true, aborted: true, runIds: [params.runId] };
    } },
  };
  return { base, calls, actions: new ConversationActions(base) };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

const creation = { agentId: 'builder', requestId: 'new-fixture-chat' };
const roster = { agents: [{ id: creation.agentId }] };

test('creating an empty conversation opens the exact native receipt and coalesces the same request', async () => {
  const ready = deferred();
  const { actions, calls } = fixture({
    read: () => roster,
    async write(_method, { key }) {
      await ready.promise;
      return { ok: true, key, sessionId: 'new-physical', entry: { sessionId: 'new-physical' }, runStarted: false };
    },
  });
  const first = actions.handle('createConversation', creation);
  const repeated = actions.handle('createConversation', creation);
  ready.resolve();
  const row = await first;
  assert.deepEqual(await repeated, row);
  assert.deepEqual(await actions.handle('createConversation', creation), row);
  assert.equal(row.agentId, 'builder');
  assert.equal(row.sessionId, 'new-physical');
  assert.equal(row.title, 'New conversation');
  assert.match(row.key, /^agent:builder:dashboard:[a-f0-9-]{36}$/);
  assert.deepEqual(calls.map(call => [call.method, call.params]), [
    ['agents.list', {}], ['sessions.create', { key: row.key, agentId: 'builder' }],
  ]);
  await assert.rejects(actions.handle('createConversation', { ...creation, agentId: 'main' }), { code: 'INVALID' });
});

test('conversation creation rejects caller session keys, initial turns and unavailable agents before any write', async () => {
  const { actions, calls } = fixture({ read: () => ({ agents: [] }) });
  for (const extra of [{ key: selected.key }, { message: 'Fixture work' }, { parentSessionKey: selected.key }, { agentId: 'builder:main' }]) {
    await assert.rejects(actions.handle('createConversation', { ...creation, ...extra }), { code: 'INVALID' });
  }
  assert.equal(calls.length, 0);
  await assert.rejects(actions.handle('createConversation', creation), { code: 'ACCESS', preflight: true });
  assert.equal(calls.some(call => call.kind === 'write'), false);
});

test('checking unconfirmed creation only reads the generated key even if the session is initially missing', async () => {
  let committed, visible = false;
  const { actions, calls } = fixture({
    read(method) { return method === 'agents.list' ? roster : { session: visible ? committed : null }; },
    write(_method, params) {
      committed = { ...params, sessionId: 'new-physical', displayName: 'Native title' };
      throw new ReadError('UNCERTAIN', 'Fixture lost receipt.');
    },
  });
  await assert.rejects(actions.handle('createConversation', creation), { code: 'UNCERTAIN', uncertain: true });
  await assert.rejects(actions.handle('createConversation', creation), { code: 'UNCERTAIN', uncertain: true });
  visible = true;
  const row = await actions.handle('createConversation', creation);
  assert.equal(row.sessionId, committed.sessionId);
  assert.equal(row.title, committed.displayName);
  assert.deepEqual(calls.filter(call => call.kind === 'write').map(call => call.method), ['sessions.create']);
  assert.deepEqual(calls.filter(call => call.method === 'sessions.describe').map(call => call.params),
    [1, 2].map(() => ({ key: committed.key, agentId: committed.agentId })));
});

test('definitive preflight and gateway rejections do not exhaust send admission', async () => {
  for (const rejection of ['preflight','gateway']) {
    let rejecting=true;
    const {actions,calls}=fixture({
      read:()=>{
        if(rejecting&&rejection==='preflight')throw new ReadError('SESSION_CHANGED','Fixture session was replaced.');
        return {session:{...selected,lifecycleRevision:'life-1'}};
      },
      write:(_method,params)=>{
        if(rejecting)throw new ReadError('CONFLICT','Fixture branch changed.');
        return {runId:params.idempotencyKey,status:'started'};
      },
    });
    for(let i=0;i<130;i++)await assert.rejects(actions.handle('send',{
      ...send,requestId:`rejected-${i}`,expectedLeafEntryId:null,
    }),{code:rejection==='preflight'?'SESSION_CHANGED':'CONFLICT'});
    assert.equal(actions.submissions.size,0);
    if(rejection==='preflight')assert.equal(calls.some(call=>call.kind==='write'),false);
    rejecting=false;
    const request={...send,requestId:'accepted-after-rejections',expectedLeafEntryId:null};
    assert.deepEqual(await actions.handle('send',request),{runId:request.requestId,status:'started'});
    const writes=calls.filter(call=>call.kind==='write').length;
    await actions.handle('send',request);
    assert.equal(calls.filter(call=>call.kind==='write').length,writes);
  }
});

test('send and stop promote every required fresh preflight while keeping leaf and run validation',async()=>{
  const f=fixture(),promoted=[];
  f.base.transport.prioritize=(method,params)=>promoted.push({method,params});
  await f.actions.handle('send',send);
  assert.deepEqual(promoted.map(call=>call.method),['sessions.describe','chat.history','sessions.describe']);
  assert.deepEqual(promoted[1].params,{sessionKey:selected.key,agentId:selected.agentId,limit:1,maxBytes:32768,toolResultMaxChars:1});
  assert.equal(f.calls.find(call=>call.kind==='write').params.expectedLeafEntryId,'leaf-1');
  assert.ok(f.calls.filter(call=>call.kind==='read').every(call=>call.ttl===0));
  promoted.length=0;
  await f.actions.handle('abort',{...selected,runId:'run-1'});
  assert.deepEqual(promoted,[{method:'sessions.describe',params:{key:selected.key,agentId:selected.agentId}}]);
  promoted.length=0;
  await f.actions.handle('plan',selected);assert.deepEqual(promoted,[],'background progress retains normal priority');
  const replaced=fixture({read:()=>({session:{...selected,sessionId:'replacement'}})});
  replaced.base.transport.prioritize=()=>true;
  await assert.rejects(replaced.actions.handle('send',{...send,expectedLeafEntryId:'fixture-leaf'}),{code:'SESSION_CHANGED'});
  assert.equal(replaced.calls.some(call=>call.kind==='write'),false);
});

function attached(fixtureOptions) {
  const value = fixture(fixtureOptions), store = new AttachmentStore();
  store.items.set('file-1', { id:'file-1',context:JSON.stringify(selected),name:'fixture.txt',mimeType:'text/plain',sizeBytes:5,content:Buffer.from('hello').toString('base64') });
  store.retainedBytes = 5;
  value.actions.attachments = store;
  return {...value,store,request:{...send,message:'',attachmentIds:['file-1'],expectedLeafEntryId:'leaf-1'}};
}

test('attachment-only send uses immutable main-process bytes and releases them on confirmed receipt', async () => {
  const {actions,calls,store,request}=attached();
  assert.deepEqual(await actions.handle('send',request),{runId:request.requestId,status:'started'});
  const params=calls.find(call=>call.kind==='write').params;
  assert.equal(params.message,''); assert.equal(params.attachments[0].content,Buffer.from('hello').toString('base64'));
  assert.equal(params.attachments[0].origin,'file'); assert.equal(params.attachments[0].fileName,'fixture.txt');
  assert.equal(store.retainedBytes,0); assert.equal(store.items.size,0);
  assert.equal(actions.submissions.get(request.requestId).params,undefined);
  await actions.handle('send',request);
  assert.equal(calls.filter(call=>call.kind==='write').length,1);
});

test('unconfirmed media retry retains exact payload, branch and tokens despite later preflight failure', async () => {
  let writes=0,failRead=false;
  const {actions,calls,store,request}=attached({
    read:()=>{if(failRead)throw new ReadError('CONNECTION','Fixture read failure.'); return {session:{...selected,lifecycleRevision:'life-1'}};},
    write:(_method,params)=>{if(++writes===1)throw new ReadError('UNCERTAIN','Lost receipt.'); return {runId:params.idempotencyKey,status:'started'};},
  });
  await assert.rejects(actions.handle('send',request),{code:'UNCERTAIN'});
  const original=structuredClone(calls.find(call=>call.kind==='write').params);
  assert.equal(actions.hasPendingFor(selected),true); assert.equal(store.retainedBytes,5);
  assert.throws(()=>store.remove(selected,'file-1'),{code:'BUSY'});
  await assert.rejects(actions.handle('send',{...request,attachmentIds:[]}),{code:'INVALID'});
  failRead=true;
  await assert.rejects(actions.handle('send',request),{code:'UNCERTAIN'});
  assert.equal(writes,1); assert.equal(store.items.get('file-1').lock,request.requestId);
  assert.deepEqual(actions.submissions.get(request.requestId).params,original);
  failRead=false;
  await actions.handle('send',request);
  assert.deepEqual(calls.filter(call=>call.kind==='write')[1].params,original);
  assert.equal(store.retainedBytes,0); assert.equal(actions.hasPendingFor(selected),false);
});

test('unavailable or cross-session attachment tokens never write and definitive rejection unlocks the draft', async () => {
  for(const kind of ['missing','cross-session']) {
    const {actions,calls,store,request}=attached();
    if(kind==='missing')store.items.clear(); else store.items.get('file-1').context=JSON.stringify({...selected,sessionId:'another'});
    await assert.rejects(actions.handle('send',request),{code:'INVALID'});
    assert.equal(calls.some(call=>call.kind==='write'),false);
  }
  const {actions,store,request}=attached({write:()=>{throw new ReadError('CONFLICT','Branch changed.');}});
  await assert.rejects(actions.handle('send',request),{code:'CONFLICT'});
  assert.equal(actions.hasPendingFor(selected),false);
  assert.equal(actions.submissions.has(request.requestId),false);
  store.remove(selected,'file-1'); assert.equal(store.retainedBytes,0);
});

test('plan reads exact identity before and after and exposes only authored bounded fields', async () => {
  const { actions, calls } = fixture();
  const result = await actions.handle('plan', selected);
  assert.deepEqual(result, { card: { source: 'progress-card', revision: 3, updatedAt: 1000, markdown: 'Checking.', steps: card.steps } });
  assert.deepEqual(calls.map(x => x.method), ['sessions.describe', 'progressCard.get', 'sessions.describe']);
  assert.ok(calls.every(x => x.kind === 'read' && x.ttl === 0));
});

test('plan null and note-only cards stay optional; malformed status never becomes progress', async () => {
  for (const value of [null, { revision: 1, updatedAt: 1, markdown: 'Paused for approval.' }]) {
    const { actions } = fixture({ read: method => method === 'sessions.describe' ? { session: selected } :
      method === 'chat.history' ? { sessionId: selected.sessionId, messages: [{ content: '1. This prose is not a checklist.' }] } : { card: value } });
    assert.deepEqual(await actions.handle('plan', selected), { card: value === null ? null : { source: 'progress-card', ...value } });
  }
  for (const value of [{ ...card, steps: [{ step: 'Unknown', status: 'done' }] },
    { ...card, steps: [{ step: 'A', status: 'in_progress' }, { step: 'B', status: 'in_progress' }] },
    { ...card, markdown: 'x'.repeat(8193) }, { ...card, steps: Array(51).fill(card.steps[0]) }]) {
    const { actions } = fixture({ read: method => method === 'sessions.describe' ? { session: selected } : { card: value } });
    await assert.rejects(actions.handle('plan', selected), { code: 'UNAVAILABLE' });
  }
});

test('replacement or lifecycle change while reading a card rejects stale progress', async () => {
  for (const replacement of [{ ...selected, sessionId: 'physical-2' }, { ...selected, lifecycleRevision: 'life-2' }]) {
    let descriptions = 0;
    const { actions } = fixture({ read: method => method === 'progressCard.get' ? { card } :
      { session: ++descriptions === 1 ? { ...selected, lifecycleRevision: 'life-1' } : replacement } });
    await assert.rejects(actions.handle('plan', selected), { code: 'SESSION_CHANGED' });
  }
});

test('all client operations validate exact targets, fields and sizes before transport', async () => {
  const { actions, calls } = fixture();
  for (const [operation, params] of [['constructor', {}], ['chat.send', send], ['send', { ...send, method: 'agent' }],
    ['send', { ...send, message: ' ' }], ['send', { ...send, message: 'x'.repeat(16385) }],
    ['send', { ...send, requestId: 'bad id' }], ['send', { ...send, expectedLeafEntryId: 1 }],
    ['plan', { ...selected, sessionId: undefined }], ['abort', selected], ['abort', { ...selected, runId: '' }]]) {
    await assert.rejects(actions.handle(operation, params), { code: 'INVALID' });
  }
  assert.equal(calls.length, 0);
});

test('send binds exact session and authoritative history leaf, retains receipt on duplicate', async () => {
  const { actions, calls } = fixture();
  assert.deepEqual(await actions.handle('send', send), { runId: send.requestId, status: 'started' });
  assert.deepEqual(calls.find(x => x.kind === 'write'), { kind: 'write', method: 'chat.send', params: {
    sessionKey: selected.key, agentId: selected.agentId, sessionId: selected.sessionId,
    message: send.message, idempotencyKey: send.requestId, expectedLeafEntryId: 'leaf-1',
  } });
  await actions.handle('send', send);
  assert.equal(calls.filter(x => x.kind === 'write').length, 1);
  await assert.rejects(actions.handle('send', { ...send, message: 'Different' }), { code: 'INVALID' });
});

test('explicit null branch is preserved while unavailable branch and wrong session prevent sends', async () => {
  const good = fixture();
  await good.actions.handle('send', { ...send, expectedLeafEntryId: null });
  assert.equal(good.calls.find(x => x.kind === 'write').params.expectedLeafEntryId, null);
  assert.equal(good.calls.some(x => x.method === 'chat.history'), false);
  for (const history of [{ sessionId: selected.sessionId, messages: [] }, { sessionId: 'physical-2', sessionInfo: { activeLeafEntryId: 'leaf' } }]) {
    const { actions, calls } = fixture({ read: method => method === 'sessions.describe' ? { session: selected } : history });
    await assert.rejects(actions.handle('send', send), { code: history.sessionId === selected.sessionId ? 'BRANCH_UNKNOWN' : 'SESSION_CHANGED' });
    assert.equal(calls.some(x => x.kind === 'write'), false);
  }
});

test('unknown send delivery preserves same payload and request ID through an explicit retry', async () => {
  let attempts = 0;
  const { actions, calls } = fixture({ write: (method, params) => {
    if (++attempts === 1) throw new ReadError('TIMEOUT', 'Fixture timeout.');
    return { runId: params.idempotencyKey, status: 'in_flight' };
  } });
  await assert.rejects(actions.handle('send', send), error => error.code === 'UNCERTAIN' && error.requestId === send.requestId);
  const result = await actions.handle('send', send);
  assert.equal(result.status, 'in_flight');
  const writes = calls.filter(x => x.kind === 'write');
  assert.deepEqual(writes[0].params, writes[1].params);
  assert.equal(calls.filter(x => x.method === 'chat.history').length, 1);
});

test('question replies retain their source target across an uncertain retry and reject target substitution', async () => {
  let attempts=0;
  const {actions,calls}=fixture({write:(_method,params)=>{
    if(++attempts===1)throw new ReadError('TIMEOUT','Fixture timeout.');
    return {runId:params.idempotencyKey,status:'in_flight'};
  }});
  const request={...send,replyToId:'native-question-source'};
  await assert.rejects(actions.handle('send',request),{code:'UNCERTAIN'});
  for(const replacement of ['another-question',undefined])await assert.rejects(actions.handle('send',{...request,replyToId:replacement}),{code:'INVALID'});
  await actions.handle('send',request);
  const writes=calls.filter(item=>item.kind==='write');
  assert.equal(writes.length,2);assert.deepEqual(writes[0].params,writes[1].params);
  assert.equal(writes[0].params.replyToId,'native-question-source');
  assert.equal(writes[0].params.sessionId,selected.sessionId);
  assert.equal(writes[0].params.agentId,selected.agentId);
  await actions.handle('send',request);assert.equal(calls.filter(item=>item.kind==='write').length,2);
});

test('malformed reply targets and replaced sessions cannot issue a question answer', async () => {
  const {actions,calls}=fixture();
  for(const replyToId of [null,'',' ',' padded','x'.repeat(513),'line\nbreak',123,{}])await assert.rejects(actions.handle('send',{...send,replyToId}),{code:'INVALID'});
  assert.equal(calls.length,0);
  const changed=fixture({read:()=>({session:{...selected,sessionId:'replacement'}})});
  await assert.rejects(changed.actions.handle('send',{...send,replyToId:'native-question-source'}),{code:'SESSION_CHANGED'});
  assert.equal(changed.calls.some(item=>item.kind==='write'),false);
});

test('concurrent duplicate sends share one write and malformed acknowledgment stays uncertain', async () => {
  const wait = deferred();
  const { actions, calls } = fixture({ write: () => wait.promise });
  const first = actions.handle('send', { ...send, expectedLeafEntryId: 'leaf' });
  const second = actions.handle('send', { ...send, expectedLeafEntryId: 'leaf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(x => x.kind === 'write').length, 1);
  wait.resolve({ runId: send.requestId, status: 'started' });
  assert.deepEqual(await first, await second);
  const bad = fixture({ write: () => ({ runId: 'another-run', status: 'started' }) });
  await assert.rejects(bad.actions.handle('send', send), { code: 'UNCERTAIN' });
});

test('stop uses exact observed active run, never broad session cancellation', async () => {
  const { actions, calls } = fixture();
  assert.deepEqual(await actions.handle('abort', { ...selected, runId: 'run-1' }), { ok: true, aborted: true, runIds: ['run-1'] });
  assert.deepEqual(calls.find(x => x.kind === 'write').params, { sessionKey: selected.key, agentId: selected.agentId, runId: 'run-1' });
  for (const row of [{ ...selected, activeRunIds: [] }, { ...selected, activeRunIds: ['other'] }, { ...selected, hasActiveRun: false }]) {
    const f = fixture({ read: () => ({ session: row }) });
    await assert.rejects(f.actions.handle('abort', { ...selected, runId: 'run-1' }), { code: 'RUN_CHANGED' });
    assert.equal(f.calls.some(x => x.kind === 'write'), false);
  }
});

test('unknown exact set permits only named stop; timeout and disconnect retain uncertainty', async () => {
  const unknown = fixture({ read: () => ({ session: { ...selected, hasActiveRun: true } }) });
  await unknown.actions.handle('abort', { ...selected, runId: 'run-1' });
  assert.equal(unknown.calls.find(x => x.kind === 'write').params.runId, 'run-1');
  const timed = fixture({ write: () => { throw new ReadError('TIMEOUT', 'Fixture timeout.'); } });
  await assert.rejects(timed.actions.handle('abort', { ...selected, runId: 'run-1' }), { code: 'UNCERTAIN' });
  const wait = deferred();
  const stale = fixture({ write: () => wait.promise });
  const pending = stale.actions.handle('send', { ...send, expectedLeafEntryId: 'leaf' });
  await new Promise(resolve => setImmediate(resolve));
  stale.base.invalidate();
  wait.resolve({ runId: send.requestId, status: 'started' });
  await assert.rejects(pending, { code: 'UNCERTAIN' });
});

test('typed Stop reports the actual stop outcome without inventing a sent-message run', async () => {
  for (const reply of [{ ok: true, aborted: true, runIds: ['stopped-run'], warning: 'A partial reply could not be saved.' },
    { ok: true, aborted: false, runIds: [] }]) {
    const { actions, calls } = fixture({ write: () => reply });
    const request = { ...send, message: '/stop' };
    const result = await actions.handle('send', request);
    assert.deepEqual(result, { status: 'stopped', aborted: reply.aborted, runIds: reply.runIds,
      ...(reply.warning ? { warning: reply.warning } : {}) });
    assert.equal(Object.hasOwn(result, 'runId'), false);
    result.runIds.push('caller-mutation');
    assert.deepEqual((await actions.handle('send', request)).runIds, reply.runIds);
    assert.equal(calls.filter(call => call.kind === 'write').length, 1);
  }
});

test('accepted control receipts preserve only a returned valid run identity', async () => {
  for (const reply of [{ status: 'accepted' }, { status: 'accepted', runId: send.requestId },
    { status: 'accepted', runId: 'actual-control-run' }]) {
    const { actions } = fixture({ write: () => reply });
    assert.deepEqual(await actions.handle('send', send), reply);
  }
});

test('malformed stop, accepted and unknown receipts remain uncertain', async () => {
  for (const reply of [{ ok: true, aborted: 'true', runIds: [] }, { ok: true, aborted: true, runIds: [null] },
    { ok: true, aborted: true }, { status: 'accepted', runId: null }, { status: 'accepted', runId: '' },
    { status: 'accepted', runId: 'bad\nidentity' }, { status: 'queued', runId: send.requestId }, { ok: true }]) {
    const { actions } = fixture({ write: () => reply });
    await assert.rejects(actions.handle('send', send), { code: 'UNCERTAIN' });
  }
});

test('definitive server conflicts survive send and stop without an uncertain-delivery claim', async () => {
  for (const [operation, input] of [['send', send], ['abort', { ...selected, runId: 'run-1' }]]) {
    const rejection = new ReadError('CONFLICT', 'The displayed branch changed before admission.');
    const { actions } = fixture({ write: () => { throw rejection; } });
    await assert.rejects(actions.handle(operation, input), error => error === rejection && error.code === 'CONFLICT');
  }
});

test('empty durable card falls back only to explicit exact-session active-run plan metadata', async () => {
  for (const updatedAt of [undefined, 1234]) {
    const plan = { steps: card.steps, explanation: 'Structured harness progress.', ...(updatedAt === undefined ? {} : { updatedAt }) };
    const { actions, calls } = fixture({ read: method => ({
      'sessions.describe': { session: { ...selected, lifecycleRevision: 'life-1', activeRunIds: ['actual-run'] } },
      'progressCard.get': { card: null },
      'chat.history': { sessionId: selected.sessionId, sessionInfo: { lifecycleRevision: 'life-1' },
        inFlightRun: { runId: 'actual-run', startedAt: 987, plan } },
    })[method] });
    const result = await actions.handle('plan', selected);
    assert.deepEqual(result, { card: { source: 'active-run', runId: 'actual-run', steps: card.steps,
      markdown: plan.explanation, ...(updatedAt === undefined ? {} : { updatedAt }) } });
    assert.equal(Object.hasOwn(result.card, 'revision'), false);
    assert.equal(Object.hasOwn(result.card, 'updatedAt'), updatedAt !== undefined);
    assert.deepEqual(calls.map(call => call.method), ['sessions.describe', 'progressCard.get', 'chat.history', 'sessions.describe']);
    assert.deepEqual(calls.find(call => call.method === 'chat.history').params,
      { sessionKey: selected.key, agentId: selected.agentId, limit: 1, maxBytes: 32768, toolResultMaxChars: 1 });
    assert.ok(calls.every(call => call.kind === 'read' && call.ttl === 0));
  }
});

test('active plan fallback rejects wrong physical session and changed lifecycle', async () => {
  for (const change of ['physical', 'history-life', 'final-life']) {
    let descriptions = 0;
    const { actions } = fixture({ read: method => {
      if (method === 'sessions.describe') return { session: { ...selected,
        lifecycleRevision: ++descriptions > 1 && change === 'final-life' ? 'life-2' : 'life-1' } };
      if (method === 'progressCard.get') return { card: null };
      return { sessionId: change === 'physical' ? 'physical-2' : selected.sessionId,
        sessionInfo: { lifecycleRevision: change === 'history-life' ? 'life-2' : 'life-1' },
        inFlightRun: { runId: 'actual-run', plan: { steps: card.steps } } };
    } });
    await assert.rejects(actions.handle('plan', selected), { code: 'SESSION_CHANGED' });
  }
});

test('fallback does not preserve a run proven inactive or fabricate malformed checklist fields', async () => {
  for (const session of [{ ...selected, hasActiveRun: false }, { ...selected, activeRunIds: ['different-run'] }]) {
    const { actions } = fixture({ read: method => method === 'sessions.describe' ? { session } :
      method === 'progressCard.get' ? { card: null } : { sessionId: selected.sessionId,
        inFlightRun: { runId: 'actual-run', plan: { steps: card.steps } } } });
    assert.deepEqual(await actions.handle('plan', selected), { card: null });
  }
  for (const run of [{ plan: { steps: card.steps } }, { runId: 'actual-run', plan: { explanation: 'Prose without structured steps' } },
    { runId: 'actual-run', plan: { steps: Array(51).fill(card.steps[0]) } },
    { runId: 'actual-run', plan: { steps: [{ step: 'Unknown', status: 'done' }] } }]) {
    const { actions } = fixture({ read: method => method === 'sessions.describe' ? { session: selected } :
      method === 'progressCard.get' ? { card: null } : { sessionId: selected.sessionId, inFlightRun: run } });
    await assert.rejects(actions.handle('plan', selected), { code: 'UNAVAILABLE' });
  }
});
