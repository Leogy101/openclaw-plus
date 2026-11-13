'use strict';
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { ReadError } = require('./gateway-cli.cjs');

const OPERATIONS = new Set(['approvals','resolveApproval','settings','saveSettings']);
const KINDS = new Set(['exec','plugin','system-agent']);
const DECISIONS = new Map([['allow-once','Allow once'],['allow-always','Always allow here'],['deny','Deny']]);
const REDACTED = '__OPENCLAW_REDACTED__';
const MAX_RAW = 262144;
const MAX_APPROVALS = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code,message) => { throw new ReadError(code,message); };
const string = (value,max) => typeof value === 'string' && value.length > 0 && value.length <= max;

function validate(operation,input={}) {
  if (!OPERATIONS.has(operation) || !object(input)) fail('INVALID','Unsupported action request.');
  const fields = operation==='resolveApproval'?['id','kind','decision','reviewToken']:operation==='saveSettings'?['baseHash','raw']:[];
  if (Object.keys(input).some(key=>!fields.includes(key))) fail('INVALID','Unexpected action parameters.');
  if (operation==='resolveApproval' && (!string(input.id,2048) || !input.id.isWellFormed()
    || !KINDS.has(input.kind) || !DECISIONS.has(input.decision) || !string(input.reviewToken,128))) fail('INVALID','Invalid approval decision.');
  if (operation==='saveSettings' && (!string(input.baseHash,512) || !string(input.raw,MAX_RAW))) fail('INVALID','Invalid settings revision or document.');
  return input;
}

function normalizeApproval(approval,source={}) {
  const p=approval?.presentation;
  if (!object(approval) || !string(approval.id,2048) || !object(p) || !KINDS.has(p.kind)
    || !['pending','allowed','denied','expired','cancelled'].includes(approval.status)
    || !Number.isFinite(approval.expiresAtMs) || !Array.isArray(p.allowedDecisions)
    || !p.allowedDecisions.includes('deny') || p.allowedDecisions.length>3
    || new Set(p.allowedDecisions).size!==p.allowedDecisions.length || p.allowedDecisions.some(d=>!DECISIONS.has(d))) {
    fail('UNAVAILABLE','OpenClaw returned an unsupported approval. Review it in the original interface.');
  }
  const command=p.kind==='exec'?p.commandText:undefined;
  if (p.kind==='exec' && !string(command,65536)) fail('UNAVAILABLE','This command cannot be displayed completely here. Review it in the original interface.');
  if(p.kind!=='exec'&&(!string(p.title,80)||!string(p.description,512)
    ||(p.detail!==undefined&&!string(p.detail,16384)))) fail('UNAVAILABLE','This request cannot be displayed completely here. Review it in the original interface.');
  return {id:approval.id,kind:p.kind,status:approval.status,
    title:p.kind==='exec'?'Command execution':typeof p.title==='string'?p.title:'Approval',
    description:[p.description,p.detail,p.warningText].filter(x=>typeof x==='string'&&x).join('\n\n'),
    ...(command?{command}:{}),...(typeof p.agentId==='string'?{agentId:p.agentId}:{}),
    ...(typeof p.host==='string'?{host:p.host}:{}),...(typeof p.nodeId==='string'?{nodeId:p.nodeId}:{}),
    reviewDetails:structuredClone(p),
    ...(typeof (approval.sourceSessionKey || source.sessionKey)==='string'?{sessionKey:approval.sourceSessionKey || source.sessionKey}:{}),
    expiresAt:approval.expiresAtMs,
    allowedDecisions:approval.status==='pending'?p.allowedDecisions.map(id=>({id,label:DECISIONS.get(id)})):[],
    ...(approval.decision?{decision:approval.decision}:{}),...(approval.reason?{reason:approval.reason}:{}),
    ...(p.scope?{scope:p.scope}:{}),...(p.externalResolution?{externalResolution:p.externalResolution}:{})};
}

function reviewBinding(approval,source) {
  return structuredClone({id:approval.id,createdAtMs:approval.createdAtMs,expiresAtMs:approval.expiresAtMs,
    presentation:approval.presentation,sessionKey:approval.sourceSessionKey || source.sessionKey});
}

function safeDocument(value,depth=0,budget={nodes:0}) {
  if (++budget.nodes>20000 || depth>32) fail('INVALID','The settings document is too complex.');
  if (typeof value==='number' && !Number.isFinite(value)) fail('INVALID','Settings numbers must be finite.');
  if (object(value) || Array.isArray(value)) for (const [key,item] of Object.entries(value)) {
    if (['__proto__','prototype','constructor'].includes(key)) fail('INVALID','Unsupported settings key.');
    safeDocument(item,depth+1,budget);
  }
}
const sensitiveKey = key => /(?:api[_-]?key|password|passwd|secret|credential|private[_-]?key|(?:^|[_-])tokens?(?:$|[_-]))/i.test(key)
  || /Tokens?$/.test(key) || /^(?:bot|access|refresh|auth|bearer)token$/i.test(key);
const secretRef = value => object(value) && ['env','file','exec','store'].includes(value.source) && typeof value.id==='string';
function hasProtected(value,key='') {
  if (sensitiveKey(key) || secretRef(value) || value===REDACTED) return true;
  return (object(value)||Array.isArray(value)) && Object.entries(value).some(([k,v])=>hasProtected(v,k));
}
function newSecretString(value) {
  if (typeof value!=='string') return false;
  if (/-----BEGIN[^\n]*PRIVATE KEY-----/.test(value)) return true;
  try { const url=new URL(value); return !!(url.username||url.password); } catch { return false; }
}
function assertNoSecretEdits(before,after,key='') {
  if (isDeepStrictEqual(before,after)) return;
  if (sensitiveKey(key) || secretRef(before) || secretRef(after) || before===REDACTED || after===REDACTED || newSecretString(after)) {
    fail('PROTECTED','Credential and secret-reference changes remain in the original OpenClaw interface. Keep redacted values unchanged.');
  }
  if (object(before) && object(after)) {
    for (const child of new Set([...Object.keys(before),...Object.keys(after)])) assertNoSecretEdits(before[child],after[child],child);
  } else if (hasProtected(before) || hasProtected(after)) {
    fail('PROTECTED','This edit would replace or remove protected credentials. Keep that section unchanged.');
  } else if (object(after)||Array.isArray(after)) {
    for (const [child,value] of Object.entries(after)) assertNoSecretEdits(undefined,value,child);
  }
}
function arrayPath(parts) {
  if (!parts.length || parts.some(part=>/[.\[\]]/.test(part))) fail('UNAVAILABLE','Use the original interface to replace arrays at this settings path.');
  return parts.join('.');
}
function removedArrays(value,parts,replacePaths) {
  if (Array.isArray(value)) replacePaths.add(arrayPath(parts));
  else if (object(value)) for (const [key,item] of Object.entries(value)) removedArrays(item,[...parts,key],replacePaths);
}
function mergePatch(before,after,parts=[],replacePaths=new Set()) {
  if (isDeepStrictEqual(before,after)) return {patch:undefined,replacePaths};
  if (object(before)&&object(after)) {
    const patch={};
    for (const key of new Set([...Object.keys(before),...Object.keys(after)])) {
      const next=[...parts,key];
      if (!Object.hasOwn(after,key)) { patch[key]=null;removedArrays(before[key],next,replacePaths); }
      else { const result=mergePatch(before[key],after[key],next,replacePaths);if(result.patch!==undefined)patch[key]=result.patch; }
    }
    return {patch,replacePaths};
  }
  if (Array.isArray(before)||Array.isArray(after)) replacePaths.add(arrayPath(parts));
  else if (object(before)) removedArrays(before,parts,replacePaths);
  return {patch:after,replacePaths};
}

class InteractionService {
  constructor(baseGatewayService) { this.base=baseGatewayService;this.reviewed=new Map();this.settingsBase=null;this.writing=false; }
  async handle(operation,input={}) {
    const p=validate(operation,input);
    return this[operation](p);
  }
  async approvals() {
    const generation=this.base.generation,limitations=['Approval availability and permitted decisions are enforced by OpenClaw. Expired or already resolved requests cannot be newly approved.'];
    const methods=[['exec.approval.list','exec'],['plugin.approval.list','plugin'],['openclaw.approval.list','system-agent']];
    const results=await Promise.allSettled(methods.map(([method])=>this.base.read(method,{},0)));
    this.base.assertCurrent(generation);
    const pending=new Map();
    results.forEach((result,i)=>{
      if(result.status==='rejected'||!Array.isArray(result.value)) {limitations.push(`${methods[i][1]} approvals are unavailable.`);return;}
      for(const item of result.value) if(string(item?.id,2048))pending.set(item.id,{kind:methods[i][1],sessionKey:item.request?.sessionKey});
    });
    const entries=[...pending].slice(0,MAX_APPROVALS),items=[],reviewed=new Map();
    if(pending.size>MAX_APPROVALS)limitations.push(`Showing at most ${MAX_APPROVALS} approval details. Open the original interface for additional requests.`);
    for(let offset=0;offset<entries.length;offset+=2) {
      const batch=entries.slice(offset,offset+2);
      const details=await Promise.allSettled(batch.map(([id])=>this.base.read('approval.get',{id},0)));
      this.base.assertCurrent(generation);
      details.forEach((result,i)=>{
        const [id,source]=batch[i];
        if(result.status!=='fulfilled') {limitations.push('An approval expired or could not be read; refresh before deciding.');return;}
        try {
          const approval=result.value?.approval;
          if(approval?.id!==id || approval.presentation?.kind!==source.kind) throw new Error('Identity mismatch');
          const item=normalizeApproval(approval,source);
          if(item.status!=='pending'||item.expiresAt<=Date.now())return;
          const binding=reviewBinding(approval,source),previous=this.reviewed.get(id);
          const reviewToken=previous?.generation===generation&&isDeepStrictEqual(previous.binding,binding)?previous.reviewToken:randomUUID();
          items.push({...item,reviewToken});reviewed.set(id,{generation,binding,reviewToken,source});
        }catch {limitations.push('An approval could not be displayed completely. Review it in the original interface.');}
      });
    }
    this.base.assertCurrent(generation);this.reviewed=reviewed;
    return {items,limitations:[...new Set(limitations)]};
  }
  async resolveApproval(p) {
    if(this.writing)fail('BUSY','Another change is still in progress.');
    const reviewed=this.reviewed.get(p.id),generation=this.base.generation;
    if(!reviewed||reviewed.generation!==generation||reviewed.reviewToken!==p.reviewToken)fail('STALE','Refresh and review this approval before deciding.');
    this.writing=true;
    try {
      const current=(await this.base.read('approval.get',{id:p.id},0))?.approval;
      this.base.assertCurrent(generation);
      if(current?.id!==p.id||current.presentation?.kind!==p.kind)fail('STALE','The approval identity changed. Refresh before deciding.');
      const normalized=normalizeApproval(current,reviewed.source);
      if(current.status!=='pending') {this.reviewed.delete(p.id);return {applied:false,approval:normalized};}
      if(current.expiresAtMs<=Date.now())fail('EXPIRED','This approval has expired. Refresh the list.');
      if(!isDeepStrictEqual(reviewBinding(current,reviewed.source),reviewed.binding))fail('STALE','The approval details changed. Review the request again.');
      if(!current.presentation.allowedDecisions.includes(p.decision))fail('INVALID','That decision is not available for this approval.');
      this.base.assertCurrent(generation);
      if(this.reviewed.get(p.id)?.reviewToken!==p.reviewToken)fail('STALE','The approval view changed. Review the request again.');
      const result=await this.base.transport.write('approval.resolve',{id:p.id,kind:p.kind,decision:p.decision});
      try { this.base.assertCurrent(generation); }
      catch {
        this.reviewed.delete(p.id);
        fail('UNCERTAIN','The connection changed after the decision was submitted. Refresh this approval to check its recorded decision before trying again.');
      }
      if(typeof result?.applied!=='boolean'||result.approval?.id!==p.id||result.approval.presentation?.kind!==p.kind
        ||result.approval.status==='pending')fail('UNCERTAIN','Refresh this approval to see its recorded decision. Do not submit it again automatically.');
      this.reviewed.delete(p.id);
      return {applied:result.applied,approval:normalizeApproval(result.approval,reviewed.source)};
    } finally {this.writing=false;}
  }
  async settings() {
    const generation=this.base.generation,snapshot=await this.base.read('config.get',{},0);
    this.base.assertCurrent(generation);
    if(!object(snapshot?.config))fail('UNAVAILABLE','OpenClaw did not return editable settings.');
    const raw=JSON.stringify(snapshot.config,null,2);
    if(raw.length>MAX_RAW)fail('UNAVAILABLE','This configuration is too large for this editor. Use the original interface.');
    safeDocument(snapshot.config);
    const valid=snapshot.valid===true&&string(snapshot.hash,512)&&!snapshot.writeError;
    this.settingsBase=valid?{generation,hash:snapshot.hash,config:structuredClone(snapshot.config)}:null;
    return {baseHash:snapshot.hash||'',raw,valid:Boolean(valid),limitations:[
      'Credentials and secret references are protected here. Keep redacted values unchanged.',
      'Saving can reload integrations or restart the gateway. Review the complete edit before saving; a lost response does not prove the write failed.',
      ...(snapshot.configRevisionHash&&snapshot.appliedConfigHash!==snapshot.configRevisionHash?['Saved configuration and active runtime revisions differ.']:[]),
    ]};
  }
  async saveSettings(p) {
    if(this.writing)fail('BUSY','Another change is still in progress.');
    const baseline=this.settingsBase,generation=this.base.generation;
    if(!baseline||baseline.generation!==generation||baseline.hash!==p.baseHash)fail('CONFLICT','Reload settings before applying this edit.');
    let next;
    try {next=JSON.parse(p.raw);}catch {fail('INVALID','Settings must be valid JSON. Nothing was sent.');}
    if(!object(next))fail('INVALID','Settings must be a JSON object.');
    safeDocument(next);assertNoSecretEdits(baseline.config,next);
    const {patch,replacePaths}=mergePatch(baseline.config,next);
    if(patch===undefined)return {saved:false,message:'No settings changed.'};
    if(replacePaths.size>256)fail('INVALID','Too many array replacements. Apply a smaller edit.');
    const params={baseHash:p.baseHash,raw:JSON.stringify(patch),response:'summary',
      ...(replacePaths.size?{replacePaths:[...replacePaths]}:{})};
    if(JSON.stringify(params).length>131072)fail('INVALID','This edit is too large. Apply a smaller settings change.');
    this.writing=true;
    try {
      const latest=await this.base.read('config.get',{},0);
      this.base.assertCurrent(generation);
      if(latest?.hash!==p.baseHash||latest.valid!==true)fail('CONFLICT','Settings changed since they were loaded. Reload and reapply the edit.');
      this.base.assertCurrent(generation);
      let result;
      try {result=await this.base.transport.write('config.patch',params);}
      catch(error) {
        this.settingsBase=null;
        if(['INVALID','DENIED','ACCESS','CONFLICT'].includes(error.code))throw error;
        fail('UNCERTAIN','The settings write was not confirmed. Reload settings and check the active revision before trying again; it may already have been saved.');
      }
      this.settingsBase=null;
      try { this.base.assertCurrent(generation); }
      catch { fail('UNCERTAIN','The connection changed after settings were submitted. Reload settings to verify whether this edit was saved before trying again.'); }
      if(result?.ok!==true)fail('UNCERTAIN','Reload settings to verify whether this edit was saved.');
      this.base.invalidate();
      const restart=Boolean(result.restartPending||result.restart);
      return {saved:true,restart,message:restart?'Settings saved; the gateway reports restart work. Reconnect and verify the active configuration.':'Settings saved. Refresh to verify the active configuration.'};
    } finally {this.writing=false;}
  }
}
module.exports={InteractionService,OPERATIONS,validate};
