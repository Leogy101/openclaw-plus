'use strict';
const crypto = require('node:crypto');
const { ReadError } = require('./gateway-cli.cjs');
const { readOffice } = require('./office-observation.cjs');
const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
const finite = value => Number.isFinite(value) ? value : undefined;
const array = value => Array.isArray(value) ? value : [];
const LIMIT = 60;
const nativeId=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\x00-\x1f\x7f]/u.test(value);
const DASHBOARD_KEY = /^agent:[a-z0-9][a-z0-9_-]{0,63}:dashboard:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

// Only bounded native transcript evidence crosses to the portable question projection.
// Identity, provenance and a recorded reply link are distinct from assistant prose.
function normalizeNativeMessage(message) {
  const meta=message.__openclaw;
  if(!nativeId(meta?.id)||!Number.isSafeInteger(meta?.seq)||meta.seq<=0)return undefined;
  const native={id:meta.id,sequence:meta.seq};
  if(['importedFrom','cliSessionId','externalId'].some(field=>typeof meta[field]==='string'&&meta[field].trim()))native.imported=true;
  const provenance=message.provenance;
  if(provenance?.kind!=null)native.provenance=['external_user','internal_system','inter_session'].includes(provenance.kind)?provenance.kind:'other';
  else if(provenance!=null&&(typeof provenance!=='object'||Array.isArray(provenance)))native.provenance='other';
  if(nativeId(meta.replyToId))native.replyToId=meta.replyToId;
  if(nativeId(meta.runId))native.runId=meta.runId;
  if(native.provenance==='internal_system'&&provenance.sourceTool==='main_session_restart_recovery')native.restartRecovery=true;
  // Codex commentary and a question's own completed turn never imply a later answer.
  // Retire reminders only from explicit native terminal markers; incomplete metadata stays pending.
  if(!native.imported&&message.role==='assistant'&&!message.openclawAsyncDelivery&&meta.runTerminal===true&&native.provenance!=='inter_session') {
    const stop=typeof message.stopReason==='string'?message.stopReason.toLowerCase():'';
    const channel=typeof message.channel==='string'?message.channel.toLowerCase():'';
    const failed=message.openclawAbort?.aborted===true||message.isError===true||typeof message.errorMessage==='string'&&message.errorMessage.trim()||
      ['aborted','cancelled','canceled','timeout','timed_out','error','failed'].includes(stop);
    const completed=['stop','end_turn'].includes(stop)||channel==='final_answer';
    native.terminal=!completed||failed||channel==='commentary'||stop==='tooluse'||array(message.content).some(block=>['toolCall','tool_use','function_call'].includes(block?.type))?'settled':'successful';
  }
  return native;
}

function validate(operation, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ReadError('INVALID', 'Invalid view request.');
  const operations = { overview: ['query','offset','agentId','activeOnly'], history: ['key','agentId','sessionId','offset','foreground'],
    slashCommandCatalog: ['key','agentId','sessionId'],
    work: ['key','agentId','sessionId'], office: [], automations: ['offset'], reconnect: [], original: [] };
  const fields = typeof operation === 'string' && Object.hasOwn(operations,operation) ? operations[operation] : undefined;
  if (!fields || Object.keys(input).some(key => !fields.includes(key))) throw new ReadError('INVALID', 'Unsupported view request.');
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'activeOnly' || key === 'foreground') { if (typeof value !== 'boolean') throw new ReadError('INVALID', 'Invalid view option.'); }
    else if (key === 'offset') { if (!Number.isInteger(value) || value < 0 || value > 10000000) throw new ReadError('INVALID', 'Invalid page offset.'); }
    else if (typeof value !== 'string' || value.length > (key === 'query' ? 512 : 1024) || (key !== 'query' && !value.trim())) {
      throw new ReadError('INVALID', 'Invalid session selection.');
    }
  }
  if (['history','work'].includes(operation) && !input.key) throw new ReadError('INVALID', 'Select a session first.');
  return input;
}

function sessionRow(row) {
  return { key: text(row.key,1024), sessionId: text(row.sessionId,1024) || undefined,
    agentId: text(row.agentId,1024), title: text(row.displayName || row.derivedTitle || row.label || (DASHBOARD_KEY.test(row.key) ? 'New conversation' : row.key),512),
    updatedAt: finite(row.updatedAt), kind: text(row.kind,80), archived: row.archived === true,
    hasActiveRun: typeof row.hasActiveRun === 'boolean' ? row.hasActiveRun : undefined,
    hasActiveSubagentRun: typeof row.hasActiveSubagentRun === 'boolean' ? row.hasActiveSubagentRun : undefined,
    activeRunIds: Array.isArray(row.activeRunIds) ? row.activeRunIds.filter(x => typeof x === 'string').slice(0,100) : undefined,
    parentKey: text(row.parentSessionKey || row.spawnedBy || row.controlOwnerSessionKey,1024) || undefined,
    summary: text(row.activitySummary?.text,1000) || undefined,
    subagentRunState: text(row.subagentRunState,80) || undefined };
}

function commandName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/^\//u,'').toLowerCase() : '';
  return /^[a-z0-9][a-z0-9_-]{0,199}$/u.test(name) ? name : '';
}

function normalizeCommands(value) {
  if (!Array.isArray(value?.commands)) throw new ReadError('UNAVAILABLE','OpenClaw did not return a command list.');
  const commands = new Map();
  const labelText = (value, limit) => text(value,limit).replace(/[\x00-\x1f\x7f]/gu,' ').trim();
  for (const entry of value.commands.slice(0,500)) {
    const name = commandName(entry?.name);
    if (!name || commands.has(name) || entry.scope === 'native') continue;
    const aliases = [...new Set(array(entry.textAliases).slice(0,20).map(commandName))].filter(alias=>alias&&alias!==name);
    const kind = ['native','plugin','skill'].includes(entry.source) ? entry.source : undefined;
    const label = kind === 'skill' ? labelText(entry.skillDisplayName,200) : '';
    commands.set(name,{name,description:labelText(entry.description,300),aliases,acceptsArgs:entry.acceptsArgs===true,
      ...(kind ? {kind} : {}), ...(label ? {label} : {})});
  }
  return [...commands.values()];
}

function sessionContextUsage(history, selected) {
  const row = history.sessionInfo;
  if (!row || typeof row !== 'object' || Array.isArray(row) || !nativeId(selected.sessionId) ||
      history.sessionId !== selected.sessionId ||
      (history.sessionKey !== undefined && history.sessionKey !== selected.key) ||
      (row.sessionId !== undefined && row.sessionId !== selected.sessionId) ||
      (row.key !== undefined && row.key !== selected.key) ||
      (selected.agentId !== undefined && row.agentId !== undefined && row.agentId !== selected.agentId)) return;

  const { totalTokens, contextTokens, modelProvider, model, contextBudgetStatus } = row;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0 ||
      !Number.isSafeInteger(contextTokens) || contextTokens <= 0) return;

  const hasModel = nativeId(modelProvider) && nativeId(model);
  // The gateway's last prompt budget belongs to a specific model and window.
  const prompt = contextBudgetStatus;
  const matchingPrompt = hasModel && prompt?.schemaVersion === 1 && prompt.source === 'pre-prompt-estimate' &&
    prompt.sessionId === selected.sessionId && prompt.contextTokenBudget === contextTokens &&
    nativeId(prompt.provider) && prompt.provider.toLowerCase() === modelProvider.toLowerCase() &&
    nativeId(prompt.model) && prompt.model.toLowerCase() === model.toLowerCase() &&
    Number.isSafeInteger(prompt.promptBudgetBeforeReserve) && prompt.promptBudgetBeforeReserve > 0 &&
    prompt.promptBudgetBeforeReserve <= contextTokens;

  return {
    usedTokens: totalTokens,
    capacityTokens: matchingPrompt ? prompt.promptBudgetBeforeReserve : contextTokens,
    budget: matchingPrompt ? 'prompt' : 'window',
    fresh: row.totalTokensFresh === true,
    ...(hasModel ? { modelRef: `${modelProvider}/${model}` } : {}),
  };
}

// Supported async question metadata is separate from ordinary transcript text.
function normalizeAsyncQuestion(message) {
  const raw=message.openclawAsyncDelivery;
  const bounded=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
  if(message.role!=='assistant'||!raw||typeof raw!=='object'||Array.isArray(raw)||
    !bounded(raw.itemId,256)||!Array.isArray(raw.questions)||raw.questions.length<1||raw.questions.length>12)return undefined;
  const questions=[];
  for(const question of raw.questions) {
    if(!question||typeof question!=='object'||!bounded(question.title,4096))return undefined;
    if(question.options!==undefined&&(!Array.isArray(question.options)||question.options.length<1||question.options.length>4||question.options.some(option=>!bounded(option,256))))return undefined;
    questions.push({title:question.title,...(question.options?{options:[...question.options]}:{})});
  }
  const meta=message.__openclaw;
  const stable=nativeId(meta?.id)&&Number.isSafeInteger(meta?.seq)&&meta.seq>0&&
    !['importedFrom','cliSessionId','externalId'].some(field=>typeof meta[field]==='string'&&meta[field].trim());
  return {id:raw.itemId,...(stable?{sourceMessageId:meta.id}:{}),questions};
}

function normalizeMessage(message) {
  const blocks = [], texts = [];
  const correlation=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\x00-\x1f\x7f]/u.test(value)?value:undefined;
  if (typeof message.content === 'string') texts.push(message.content);
  for (const block of array(message.content)) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (['thinking','reasoning'].includes(block.type)) blocks.push({ type:'thinking', text:text(block.thinking || block.text,30000) });
    else if (['toolCall','tool_use','function_call'].includes(block.type)) blocks.push({ type:'tool', name:text(block.name,200),
      ...(correlation(block.id)?{toolCallId:block.id}:{}),
      text:text(typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? block.input ?? {}),30000) });
    else if (['tool_result','toolResult'].includes(block.type)) blocks.push({ type:'tool', name:text(block.name || 'Tool result',200),
      text:text(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? block.output ?? ''),30000) });
    else if (block.type === 'image') blocks.push({ type:'image', text:text(block.alt || 'Image attachment — open the original interface to view.',500) });
    else blocks.push({ type:'file', name:text(block.name || block.type || 'Attachment',200), text:'Open the original OpenClaw interface for this content.' });
  }
  if (!texts.length && typeof message.text === 'string') texts.push(message.text);
  const asyncQuestion=normalizeAsyncQuestion(message);
  const native=normalizeNativeMessage(message);
  if(message.role==='assistant'&&message.openclawAsyncDelivery!==undefined&&!asyncQuestion)blocks.push({type:'file',name:'Question unavailable',text:'OpenClaw supplied an unsupported question format. Open the original interface to review it.'});
  const role = text(message.role || 'system',80);
  const content = text(texts.join('\n\n'),60000);
  const stamp = typeof message.timestamp === 'string' || Number.isFinite(message.timestamp) ? message.timestamp : undefined;
  // Correlate native dispatch acknowledgements without inventing child session identities.
  const receipt=role==='toolResult'?{
    ...(correlation(message.toolCallId)?{toolCallId:message.toolCallId}:{}),
    ...(correlation(message.toolName)&&message.toolName.length<=200?{toolName:message.toolName}:{}),
    ...(typeof message.isError==='boolean'?{isError:message.isError}:{}),
  }:{};
  // A transcript entry may project into several display rows. Include content identity as well as its entry ID.
  const signature = [role,content,blocks,stamp];
  if (asyncQuestion) signature.push(asyncQuestion);
  if(Object.keys(receipt).length)signature.push(receipt);
  const hash = crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0,16);
  const id = text(message.__openclaw?.id || message.id,512) || 'row';
  if (message.truncated) blocks.push({ type:'file', text:'OpenClaw returned a truncated message. Open the original interface for the full content.' });
  return { id:id+':'+hash, role, text:content, blocks, timestamp:stamp, ...receipt,
    ...(message.truncated?{truncated:true}:{}), ...(native?{native}:{}), ...(asyncQuestion?{asyncQuestion}:{}) };
}

class GatewayService {
  constructor(transport, notify = () => {}) {
    this.transport = transport; this.notify = notify; this.cache = new Map(); this.pending = new Map(); this.generation = 0;
    this.connection = { status:'connecting', label:'Local OpenClaw', readOnly:false, mode:'local-cli',
      installedVersion:transport.version, message:'Connecting through the local OpenClaw CLI…' };
  }
  snapshot() { return { ...this.connection }; }
  office(input) {
    validate('office', input);
    return readOffice(this, normalizeNativeMessage);
  }
  assertCurrent(generation) {
    if (generation !== this.generation) throw new ReadError('STALE', 'The connection changed. Refresh this view.');
  }
  async read(method, params, ttl = 12000) {
    const key = JSON.stringify([method,params]), generation = this.generation;
    const cached = this.cache.get(key);
    if (cached && Date.now()-cached.time < ttl) return cached.data;
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this.transport.request(method,params).then(data => {
      this.assertCurrent(generation);
      if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,{data,time:Date.now()}); return data;
    }, error => {
      this.assertCurrent(generation); throw error;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key,promise); return promise;
  }
  async overview(input) {
    const p = validate('overview',input), offset = p.offset || 0, generation = this.generation;
    try {
      const [roster,result] = await Promise.all([
        this.read('agents.list',{},60000),
        this.read('sessions.list',{limit:LIMIT,offset,includeGlobal:false,includeUnknown:false,
          includeDerivedTitles:true,archived:'all', ...(p.query ? {search:p.query} : {}), ...(p.agentId ? {agentId:p.agentId} : {}),
          ...(p.activeOnly ? {activeOnly:true} : {})}),
      ]);
      this.assertCurrent(generation);
      this.connection = {...this.connection,status:'connected',updatedAt:Date.now(),message:'Connected · messages, approvals and settings'};
      return { connection:this.snapshot(), agents:array(roster.agents).map(a=>({id:text(a.id,1024),name:text(a.name || a.identity?.name || a.id,200)})),
        sessions:array(result.sessions).map(sessionRow),
        page:{total:finite(result.totalCount) ?? array(result.sessions).length,hasMore:result.hasMore===true,offset,
          limit:result.limitApplied || LIMIT,nextOffset:finite(result.nextOffset)},
        limitations:['Periodic snapshots; updates are not instant. Registered processes are observed per selected session. External scripts and custom task systems without a gateway read surface are not covered.'] };
    } catch (error) {
      this.assertCurrent(generation);
      if (error.code !== 'STALE') {
        this.connection = {...this.connection,status:'disconnected',message:error.message};
        this.notify({kind:'connection',connection:this.snapshot()});
      }
      throw error;
    }
  }
  async history(input) {
    const p = validate('history',input), offset=p.offset || 0, generation = this.generation;
    const observedAt=Date.now();
    // Tail reads cannot send sessionId without a messageId anchor. Verify the returned incarnation instead.
    const params={sessionKey:p.key,...(p.agentId?{agentId:p.agentId}:{}),
      offset,limit:100,maxBytes:400000,maxChars:60000,toolResultMaxChars:30000};
    const pending=this.read('chat.history',params,2500);
    if(p.foreground)this.transport.prioritize?.('chat.history',params);
    const result=await pending;
    this.assertCurrent(generation);
    if ((p.sessionId && p.sessionId !== result.sessionId) || result.windowReset) {
      throw new ReadError('SESSION_CHANGED','This session changed or its retained history is no longer available. Select it again from the refreshed list.');
    }
    if (!Array.isArray(result.messages)) throw new ReadError('UNAVAILABLE','OpenClaw did not return readable conversation history.');
    const {normalizeRunStatus}=await import('../shared/run-status.mjs');
    this.assertCurrent(generation);
    return {key:p.key,sessionId:result.sessionId,messages:result.messages.map(normalizeMessage),
      runStatus:normalizeRunStatus(result,{context:{key:p.key,agentId:p.agentId,sessionId:p.sessionId||result.sessionId},observedAt}),
      contextUsage:sessionContextUsage(result,p),
      total:finite(result.total) ?? finite(result.totalMessages) ?? result.messages.length,
      hasMore:result.hasMore===true,offset,nextOffset:finite(result.nextOffset),
      hasActiveRun:result.sessionInfo?.hasActiveRun,
      leafEntryId:typeof result.sessionInfo?.activeLeafEntryId==='string'||result.sessionInfo?.activeLeafEntryId===null?result.sessionInfo.activeLeafEntryId:undefined,
      activeRunIds:Array.isArray(result.sessionInfo?.activeRunIds)?result.sessionInfo.activeRunIds.filter(x=>typeof x==='string').slice(0,100):undefined,
      inFlight:result.inFlightRun ? {runId:text(result.inFlightRun.runId,512),text:text(result.inFlightRun.text,60000)} : undefined};
  }
  async slashCommandCatalog(input) {
    const p = validate('slashCommandCatalog',input), generation = this.generation;
    if (![p.key,p.agentId,p.sessionId].every(nativeId)) {
      throw new ReadError('INVALID','Select an exact conversation to list its slash commands.');
    }
    const verifySession = async () => {
      const {session} = await this.read('sessions.describe',{key:p.key,agentId:p.agentId},0) || {};
      this.assertCurrent(generation);
      if (session?.key !== p.key || session.agentId !== p.agentId || session.sessionId !== p.sessionId) {
        throw new ReadError('SESSION_CHANGED','This conversation changed. Select it again to see its commands.');
      }
      return session.lifecycleRevision;
    };
    const revision = await verifySession();
    const result = await this.read('commands.list',{sessionKey:p.key,agentId:p.agentId,scope:'text',includeArgs:false},0);
    this.assertCurrent(generation);
    if (revision !== await verifySession()) {
      throw new ReadError('SESSION_CHANGED','This conversation changed while its commands were loading. Open the menu again.');
    }
    return {commands:normalizeCommands(result)};
  }
  async work(input) {
    const p = validate('work',input), limitations = [], generation = this.generation;
    if (!p.agentId || !p.sessionId) throw new ReadError('INVALID','Select an exact conversation to inspect its delegated work.');
    const [processResult,childResult] = await Promise.allSettled([
      this.read('sessions.processes.list',{key:p.key,...(p.agentId?{agentId:p.agentId}:{})}),
      this.read('sessions.list',{spawnedBy:p.key,archived:'all',limit:100,includeDerivedTitles:true,includeGlobal:false,includeUnknown:false}),
    ]);
    this.assertCurrent(generation);
    let processes=[], subagents=[];
    if (processResult.status==='fulfilled') {
      const r=processResult.value;
      if (p.sessionId && r.sessionId !== p.sessionId) throw new ReadError('SESSION_CHANGED','The process owner changed. Select the session again from the refreshed list.');
      processes=array(r.processes).map(x=>({id:text(x.processId,512),instanceId:text(x.instanceId,512),title:text(x.name,200),
        status:text(x.status,80),tail:text(x.tail,2000),exitCode:x.exitCode,startedAt:finite(x.startedAt),endedAt:finite(x.endedAt),truncated:x.truncated===true}));
      if(r.truncated) limitations.push('OpenClaw returned a bounded process list; additional records may be omitted.');
    } else limitations.push('Processes unavailable: '+processResult.reason.message);
    if (childResult.status==='fulfilled') {
      subagents=array(childResult.value.sessions).filter(x=>x.key!==p.key).map(x=>{
        const r=sessionRow(x);
        return {sessionKey:r.key,sessionId:r.sessionId,agentId:r.agentId,title:r.title,parentKey:p.key,
          status:r.hasActiveRun===true?'Running':r.hasActiveSubagentRun===true?'Delegating':r.subagentRunState==='interrupted'?'Interrupted':r.hasActiveRun===false?'Idle':'Unknown'};
      });
      if(childResult.value.hasMore) limitations.push('Showing the first 100 related sessions. Use Conversations to find additional sessions.');
    } else limitations.push('Delegated sessions unavailable: '+childResult.reason.message);
    // A failed process read supplies no owner proof, and cached process/list
    // responses can straddle replacement. Verify the selected parent before
    // presenting either collection under its retained physical identity.
    const current = await this.read('sessions.describe',{key:p.key,agentId:p.agentId},0);
    this.assertCurrent(generation);
    const owner = current?.session;
    if (!owner || owner.sessionId !== p.sessionId || owner.key !== p.key || owner.agentId !== p.agentId) {
      throw new ReadError('SESSION_CHANGED','This conversation changed or is no longer accessible. Select it again from the refreshed list.');
    }
    limitations.push('Related sessions are linked by the parent conversation key; earlier children may remain after a reset.');
    limitations.push('Processes are OpenClaw-registered records for this session, not every script on the Mac. Finished process records may expire.');
    return {processes,subagents,updatedAt:Date.now(),limitations};
  }
  async automations(input) {
    const p=validate('automations',input),limitations=[],generation=this.generation;
    const [jobResult,runResult]=await Promise.allSettled([
      this.read('cron.list',{includeDisabled:true,limit:100,offset:p.offset||0,compact:true},30000),
      this.read('cron.runs',{scope:'all',limit:50,sortDir:'desc'},30000),
    ]);
    this.assertCurrent(generation);
    let jobs=[],runs=[];
    if(jobResult.status==='fulfilled') {
      jobs=array(jobResult.value.jobs).map(j=>({id:text(j.id,512),name:text(j.name || j.id,512),enabled:j.enabled===true,
        scheduleText:j.schedule?.kind==='cron'?text(j.schedule.expr,200)+(j.schedule.tz?' · '+text(j.schedule.tz,80):''):
          j.schedule?.kind==='every'?`Every ${Math.round(j.schedule.everyMs/60000)} minutes`:text(j.schedule?.at || j.schedule?.kind,200),
        state:{runningAtMs:finite(j.runningAtMs) ?? finite(j.state?.runningAtMs),lastRunAtMs:finite(j.lastRunAtMs) ?? finite(j.state?.lastRunAtMs),
          nextRunAtMs:finite(j.nextRunAtMs) ?? finite(j.state?.nextRunAtMs),lastStatus:text(j.lastRunStatus || j.lastStatus || j.state?.lastStatus || j.state?.lastRunStatus,80)}}));
      if(jobResult.value.hasMore) limitations.push('Showing the first 100 matching automations. Open the original interface for the complete schedule list.');
    } else limitations.push('Automations unavailable: '+jobResult.reason.message);
    if(runResult.status==='fulfilled') {
      runs=array(runResult.value.entries).map((r,i)=>({id:text(r.runId,512)||`${r.jobId}:${r.ts}:${i}`,jobId:text(r.jobId,512),
        title:text(r.jobName || jobs.find(j=>j.id===r.jobId)?.name || r.jobId,512),status:text(r.completionStatus || r.status || 'Unknown',80),
        timestamp:finite(r.runAtMs) || finite(r.ts),sessionKey:text(r.sessionKey,1024)||undefined,sessionId:text(r.sessionId,1024)||undefined,
        agentId:text(r.agentId,1024)||undefined,summary:text(r.summary || r.error,3000)}));
      if(runResult.value.hasMore) limitations.push('Showing the 50 most recent automation runs. Older executions remain available in the original interface.');
    } else limitations.push('Automation history unavailable: '+runResult.reason.message);
    return {jobs,runs,limitations};
  }
  invalidate() { this.generation++; this.cache.clear(); this.pending.clear(); }
  close() { this.invalidate(); this.transport.close(); }
}
module.exports = {GatewayService,validate,sessionRow,normalizeMessage};
