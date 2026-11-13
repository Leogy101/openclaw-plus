import { linkedText, reportText, formatAsyncReply } from './content.mjs';
import { viewAtTime, mergeTimeline } from '../shared/activity-model.mjs';
import { viewRunStatus } from '../shared/run-status.mjs';
import { createTerminalView } from './terminal-view.mjs';
import { createReadAloud } from './read-aloud.mjs';
import { createVoiceController } from './voice-view.mjs';
import { createModelsView } from './models-view.mjs';
const icons={chat:'M4 4h16v12H8l-4 4V4Z',agents:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',folder:'M3 5h6l2 2h10v13H3V5Z',activity:'M3 12h4l3-8 4 16 3-8h4',clock:'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',plus:'M12 5v14 M5 12h14',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',sidebar:'M3 4h18v16H3V4Z M9 4v16',panel:'M3 4h18v16H3V4Z M15 4v16',chevron:'m9 5 7 7-7 7',down:'m6 9 6 6 6-6',arrow:'M5 12h14 m-5-5 5 5-5 5',back:'M19 12H5 m5-5-5 5 5 5',up:'M12 19V5 m-5 5 5-5 5 5',close:'m6 6 12 12 M18 6 6 18',check:'m5 12 4 4L19 6',terminal:'m4 6 6 6-6 6 M13 18h7',file:'M14 2H5v20h14V7l-5-5Z M14 2v6h5 M8 13h8 M8 17h6',shield:'m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z m-4 9 3 3 5-6',moon:'M20 14a9 9 0 0 1-10-12A10 10 0 1 0 22 14h-2Z',sun:'M12 2v2 M12 20v2 M2 12h2 M20 12h2 m-15-7 1 1 m12 12 1 1 M5 19l1-1 M18 6l1-1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',more:'M5 12h.01 M12 12h.01 M19 12h.01',link:'m10 13 4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',alert:'M12 3 2 21h20L12 3Z M12 9v5 M12 17h.01',globe:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M2 12h20 M12 2c6 6 6 14 0 20-6-6-6-14 0-20',bolt:'m13 2-9 12h7l-1 8 10-12h-7V2Z',copy:'M9 9h12v12H9V9Z M15 5V2H2v13h3',play:'m8 4 12 8-12 8V4Z'};
'use strict';
icons.speaker='m11 5-6 4H2v6h3l6 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14';
icons.stop='M6 6h12v12H6V6Z';
icons.mic='M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8';
// Live desktop renderer. Gateway state belongs to OpenClaw; this file owns presentation only.
const desktop = window.openclawPlusDesktop;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${icons[name] || icons.file}"/></svg>`;
const btn = (action, label, cls = 'button', attrs = '') => `<button class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
const identity = item => JSON.stringify([item?.agentId || '', item?.key || item?.sessionKey || '', item?.sessionId || '']);
const knownState = value => typeof value === 'string' ? value : value?.status || value?.label || 'Unknown';
const stamp = value => { if (!value) return 'Time unavailable'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Time unavailable' : date.toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}); };
const nameFor = id => state.agents.find(agent => agent.id === id)?.name || id || 'Agent';
const shortName = name => Array.from(name || '?').slice(0,1).join('').toUpperCase();
const avatar = agentId => `<span class="avatar">${esc(shortName(nameFor(agentId)))}</span>`;
const errorText = error => error?.message || String(error || 'The request could not be completed.');
const viewWidth = () => $('app').clientWidth;
const state = {
  view:'Conversations', connection:{status:'connecting',label:'Local OpenClaw'}, agents:[], sessions:[],
  page:{offset:0,limit:50,total:0,hasMore:false}, overviewReady:false, overviewLoading:false, overviewError:'', overviewStale:false, query:'', agentId:'',
  selected:null, history:null, historyLoading:false, historyError:'', historyExtended:false, historyStale:false, work:null, workLoading:false, workError:'',
  workContext:null, scope:'conversation', panel:viewWidth() >= 1280, panelTab:'work', processId:null,
  runningSessions:[], runningUpdatedAt:null, runningError:'', automations:null, automationLoading:false, automationError:'',
  limits:[], stack:[], theme:desktop?.initialTheme === 'light' ? 'light' : 'dark', navOpen:false, navHidden:false,
  modal:null, modalReturn:null, reconnecting:false, lastHistorySelection:'', restoreOrigin:null,
  plan:null, planLoading:false, planError:'', approvals:[], approvalsLoading:false, approvalsLoaded:false, approvalsError:'', approvalLimits:[],
  settings:{loaded:false,loading:false,saving:false,baseHash:null,raw:'',sourceRaw:'',dirty:false,error:'',uncertain:false,limits:[]}
};
const requests = {overview:0, history:0, work:0, automations:0, running:0, plan:0, approvals:0, settings:0};
const drafts=new Map();
const sends=new Map();
const composerRecords=new Map();
const asyncReplyDrafts=new Map();
const approvalMutations=new Map();
const planDisclosure=new Map();
const activityRecords=new Map();
let activityRoster=null;
let activityFreshnessTimer;
const pendingRegions = new Map();
const sessionCache = new Map();
const timers = new Map();
let toastTimer;
let searchTimer;
let navigationFocus = null;
let terminalView=null;
let readAloud=null;
let voiceView=null;
let modelsView=null;
let modelsTerminalWasVisible=false;
const motionPreference=matchMedia('(prefers-reduced-motion: reduce)');
let transcriptMotion=null;
let transcriptScrollPause=null;
function cancelTranscriptMotion() {
  if(transcriptMotion)cancelAnimationFrame(transcriptMotion.frame);
  transcriptMotion=null;
}
function followTranscript(el,{immediate=false}={}) {
  const target=Math.max(0,el.scrollHeight-el.clientHeight);
  if(immediate||motionPreference.matches||document.hidden){cancelTranscriptMotion();if(immediate)transcriptScrollPause=null;el.scrollTop=target;return;}
  if(transcriptMotion?.el===el&&Math.abs(transcriptMotion.target-target)<1)return;
  cancelTranscriptMotion();
  const from=el.scrollTop,distance=target-from;
  if(Math.abs(distance)<1)return;
  const motion={el,target,from,started:null,duration:Math.min(900,600+Math.abs(distance)*.18),frame:0,key:identity(state.selected)};
  transcriptMotion=motion;
  const tick=now=>{
    if(transcriptMotion!==motion)return;
    if(el!==$('transcript')||state.view!=='Conversations'||motion.key!==identity(state.selected)){cancelTranscriptMotion();return;}
    if(motionPreference.matches||document.hidden){el.scrollTop=motion.target;cancelTranscriptMotion();return;}
    motion.started??=now;
    const progress=Math.min(1,(now-motion.started)/motion.duration);
    const eased=progress<.5?4*progress**3:1-(-2*progress+2)**3/2;
    el.scrollTop=motion.from+(motion.target-motion.from)*eased;
    if(progress<1)motion.frame=requestAnimationFrame(tick);else transcriptMotion=null;
  };
  motion.frame=requestAnimationFrame(tick);
}
function softenNewMessages(previous,{initial=false,older=false}={}) {
  if(initial||older||motionPreference.matches||!previous.length||document.hidden)return;
  const messages=[...$('messages').querySelectorAll(':scope > [data-message-id]')];
  const anchor=messages.findIndex(node=>node.dataset.messageId===previous.at(-1));
  if(anchor<0)return; // Replaced history is not evidence of newly appended messages.
  const viewport=$('transcript').getBoundingClientRect();
  for(const node of messages.slice(anchor+1).filter(node=>['user','assistant'].includes(node.dataset.messageRole)).slice(-4)) {
    if(previous.includes(node.dataset.messageId)||transcriptMotion?.el!==$('transcript')&&node.getBoundingClientRect().top>viewport.bottom+80)continue;
    node.animate([
      {opacity:.25,transform:'translateY(12px)',offset:0,easing:'cubic-bezier(.22,.68,.2,1)'},
      {opacity:1,transform:'translateY(-1.5px)',offset:.76,easing:'ease-in-out'},
      {opacity:1,transform:'translateY(0)',offset:1}
    ],{duration:680,easing:'linear'});
  }
}
motionPreference.addEventListener('change',()=>{
  if(!motionPreference.matches)return;
  if(transcriptMotion)followTranscript(transcriptMotion.el,{immediate:true});
  for(const node of document.querySelectorAll('#messages > .message'))for(const animation of node.getAnimations())animation.cancel();
});
const online = () => state.connection.status === 'connected';
const isActive = session => session?.hasActiveRun === true || session?.hasActiveSubagentRun === true;
const rpc = async (operation,params={}) => {
  if(!desktop?.gateway)throw new Error('The desktop gateway bridge is unavailable. Open this interface from OpenClaw+.');
  const result=await desktop.gateway(operation,params);
  if(result?.ok!==true){const error=new Error(result?.error?.message||'The workspace request could not be completed.');error.code=result?.error?.code||'UNAVAILABLE';error.uncertain=result?.error?.uncertain===true;throw error;}
  return result.data;
};
const announce = message => { $('announcer').textContent = message; };
function toast(message) { $('toast').innerHTML = `<div class="toast">${esc(message)}</div>`; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').textContent='',5000); }
function actionKey(el) { return el?.id ? `#${el.id}` : el?.dataset.focus ? `[data-focus="${CSS.escape(el.dataset.focus)}"]` : null; }
function selectionInside(el) { const selection=getSelection(); return selection && !selection.isCollapsed && (el.contains(selection.anchorNode) || el.contains(selection.focusNode)); }
function replaceRegion(id, html, options={}) {
  const el=$(id); if (!el) return;
  if(el.innerHTML===html){pendingRegions.delete(id);return;}
  if (!options.force && selectionInside(el)) { pendingRegions.set(id,html); return; }
  pendingRegions.delete(id);
  const active=el.contains(document.activeElement) ? actionKey(document.activeElement) : null;
  const opens=[...el.querySelectorAll('details[open][data-detail]')].map(d=>d.dataset.detail);
  if(id==='messages') {
    const template=document.createElement('template');template.innerHTML=html;
    for(const key of opens)template.content.querySelector(`details[data-detail="${CSS.escape(key)}"]`)?.setAttribute('open','');
    const existing=new Map([...el.querySelectorAll(':scope > [data-message-id]')].map(node=>[node.dataset.messageId,node]));
    for(const node of [...template.content.children].filter(node=>node.matches('[data-message-id]'))) {
      const previous=existing.get(node.dataset.messageId);
      if(previous?.isEqualNode(node))node.replaceWith(previous);
    }
    el.replaceChildren(template.content);
  } else {
    el.innerHTML=html;
    for (const key of opens) el.querySelector(`details[data-detail="${CSS.escape(key)}"]`)?.setAttribute('open','');
  }
  if (active) el.querySelector(active)?.focus({preventScroll:true});
}
function cacheSession(item) { if(item?.key){const key=identity(item);sessionCache.delete(key);sessionCache.set(key,{...item});while(sessionCache.size>2000)sessionCache.delete(sessionCache.keys().next().value);} }
function findSession(key){return sessionCache.get(key)||state.sessions.find(item=>identity(item)===key)||state.runningSessions.find(item=>identity(item)===key);}
function sessionButton(item, cls='session-item', label=null, child=false) {
  cacheSession(item);
  return btn('session',label || `${avatar(item.agentId)}<span class="grow"><span class="session-title">${esc(item.title || 'Untitled conversation')}</span><span class="session-meta">${esc(nameFor(item.agentId))} · ${item.archived ? 'Archived · ' : ''}${isActive(item) ? activeSessionLabel(item) : stamp(item.updatedAt)}</span></span>`,cls,`data-identity="${esc(identity(item))}" data-child="${child}" data-focus="${esc(cls.split(' ')[0])}-${esc(identity(item))}" aria-label="Open ${esc(nameFor(item.agentId))}: ${esc(item.title || 'conversation')}"`);
}
function failure(title, message, retry) { return `<div class="error-note"><strong>${esc(title)}</strong>${esc(message)}${retry ? btn(retry,'Try again') : ''}</div>`; }
function limitsHTML(limits=[]) { return limits.filter(Boolean).map(item=>`<p class="limit-note">${linkedText(typeof item === 'string' ? item : item.message || item.reason || 'Some records are not available through this connection.')}</p>`).join(''); }
function setConnection(connection) { if(connection) state.connection={...state.connection,...connection}; if(!online()){readAloud?.stop();stopVoice();invalidatePermissionReview();}renderConnection();syncReadAloudButtons();renderPermissionDialog();renderVoiceStatus(); }
function renderConnection() {
  renderActivityIndicators();renderActivityCurrent();renderRunStatus();scheduleActivityFreshness();
  const label=state.connection.label || 'Local OpenClaw';
  const status=state.connection.status || 'unknown';
  $('title-connection').textContent=`${label} · ${status === 'connected' ? 'Connected' : status}`;
  $('connection-button').innerHTML=`<i class="dot"></i><span>${esc(label)} · ${esc(status === 'connected' ? 'Connected' : status)}</span>`;
  $('connection-button').classList.toggle('offline',!online());
  const message=state.connection.message || (status === 'connecting' ? 'Connecting to your existing OpenClaw gateway…' : status === 'connected' ? '' : 'Connection unavailable. Loaded content is from the last observation.');
  replaceRegion('connection-notice',message ? `<div class="notice ${online()?'connected':''}" role="status">${icon(online()?'globe':'alert')}<span class="grow">${esc(message)}${!online() && state.connection.updatedAt ? ` Last observed ${esc(stamp(state.connection.updatedAt))}.` : ''}</span>${status !== 'connecting' ? btn('reconnect',state.reconnecting?'Reconnecting…':'Reconnect','text-btn',state.reconnecting?'disabled':'') : ''}</div>` : '');
}
function renderNavigation() {
  const destinations=[['Conversations','chat'],['Agents','agents'],['Projects','folder'],['Activity','activity'],['Automations','clock'],['Approvals','shield'],['Models','bolt']];
  replaceRegion('primary-nav',destinations.map(([view,glyph])=>btn('view',icon(glyph)+`<span>${view}</span>${view==='Approvals'&&pendingApprovals().length?`<span class="nav-count">${pendingApprovals().length}</span>`:''}`,'nav-item '+(state.view===view?'active':''),`data-view="${view}" data-focus="nav-${view}" ${state.view===view?'aria-current="page"':''}`)).join(''));
  replaceRegion('agent-filter',state.agentId ? `<div class="filter-note">${esc(nameFor(state.agentId))} ${btn('clear-filter','Clear filter','text-btn')}</div>` : '');
  let content=state.overviewStale?'<p class="region-note">Loaded pages retained. '+btn('refresh-overview','Refresh list','text-btn')+' for the latest changes.</p>':'';content+=state.overviewError ? failure('Could not refresh conversations',state.overviewError,'refresh-overview') : '';
  if (!state.overviewReady && state.overviewLoading) content+='<p class="navigation-empty">Loading conversations…</p>';
  else if (!state.sessions.length) content+=`<p class="navigation-empty">${state.query || state.agentId ? 'No conversations match this search.' : 'No conversations were returned. This can reflect access or connection limits.'}</p>`;
  content+=state.sessions.map(session=>sessionButton(session,'session-item '+(identity(session)===identity(state.selected)?'active':''))).join('');
  if(state.page.hasMore) content+=btn('more-sessions',state.overviewLoading?'Loading…':'Load more conversations','session-load',state.overviewLoading?'disabled':'');
  if(state.overviewReady) content+=`<p class="region-note">${state.sessions.length} of ${Number.isFinite(state.page.total)?state.page.total:'available'} conversations</p>`;
  replaceRegion('session-list',content);
}
function heading() {
  const selected=state.selected;
  const title=state.view==='Conversations' ? selected?.title || 'Your conversations' : state.view;
  const origin=state.stack.at(-1);
  replaceRegion('page-heading',`<div class="breadcrumb">${origin?btn('back',icon('back')+` Back to ${esc(nameFor(origin.selected.agentId))}`,'back-inline'):''}<span>${esc(state.connection.label || 'Local OpenClaw')}</span><span>/</span><span class="breadcrumb-agent"><span class="breadcrumb-agent-name">${esc(state.view==='Conversations'&&selected ? nameFor(selected.agentId) : 'Personal workspace')}</span>${state.view==='Conversations'&&selected?`<span id="activity-header">${activityHeaderHTML()}</span>`:''}</span></div><h1 id="page-title" tabindex="-1">${linkedText(title)}</h1>`);
}
function mainShell() {
  const mode=state.view==='Conversations' ? 'conversation' : state.view;
  if($('main-region').dataset.mode === mode) return;
  cancelTranscriptMotion();
  if($('main-region').dataset.mode==='Models'){
    modelsView?.close();terminalView?.setContext(state.selected);
    if(modelsTerminalWasVisible)terminalView?.setVisible(true);modelsTerminalWasVisible=false;
  }
  if(mode==='Models'){
    modelsTerminalWasVisible=$('toggle-terminal').getAttribute('aria-expanded')==='true';
    terminalView?.setVisible(false);
  }
  $('main-region').dataset.mode=mode;
  pendingRegions.clear();
  if(mode==='conversation') $('main-region').innerHTML='<section class="main" aria-label="Conversation"><div class="transcript" id="transcript" tabindex="0" aria-label="Conversation history"><div class="chat-inner" id="messages"></div></div><div class="composer-wrap"><div id="plan-region"></div><div id="run-status" aria-label="Current response status" aria-live="off"></div><div class="composer"><label class="sr-only" for="composer-input">Message this agent in the selected conversation</label><textarea id="composer-input" rows="2" placeholder="Message your agent…" aria-describedby="composer-hint"></textarea><div id="composer-attachments" class="composer-attachments"></div><div id="composer-controls" class="composer-controls"></div><div id="voice-status"></div><div id="composer-options-error"></div></div><div id="composer-status" role="status"></div><p class="composer-foot" id="composer-hint">Enter to send · Shift + Enter for a new line</p></div></section>';
  else $('main-region').innerHTML='<section class="full-page" id="page-content"></section>';
}
// Async delivery questions remain transcript content; preparing a reply only edits the local message draft.
function asyncReplyRecord(message) {
  const item=message.asyncQuestion;if(!item||!Array.isArray(item.questions)||!item.questions.length)return null;
  const context=identity(state.selected),signature=JSON.stringify(item.questions),key=JSON.stringify([context,item.id||item.sourceMessageId||message.id,signature]);
  let record=asyncReplyDrafts.get(key);
  if(!record||record.signature!==signature){record={key,context,signature,questions:item.questions,choices:[],other:[],domId:crypto.randomUUID(),domIds:new Map()};asyncReplyDrafts.set(key,record);}
  while(asyncReplyDrafts.size>100){const inactive=[...asyncReplyDrafts].find(([id,entry])=>id!==key&&entry.context!==context)||[...asyncReplyDrafts].find(([id])=>id!==key);if(!inactive)break;asyncReplyDrafts.delete(inactive[0]);}
  return record;
}
function asyncQuestionHTML(message) {
  const record=asyncReplyRecord(message);if(!record)return '';
  const sourceId=String(message.id||message.asyncQuestion.sourceMessageId||'question');
  if(!record.domIds.has(sourceId))record.domIds.set(sourceId,crypto.randomUUID());
  const domId=record.domIds.get(sourceId);
  return `<section class="async-question-card" data-async-key="${esc(record.key)}"><h3>Question from ${esc(nameFor(state.selected?.agentId))}</h3>${record.questions.map((question,index)=>{
    const options=Array.isArray(question.options)?question.options:[],prefix=`async-${domId}-${index}`;
    return `<fieldset data-question-index="${index}"><legend>${esc(question.title)}</legend>${options.map((option,choice)=>`<label class="async-question-option"><input id="${prefix}-${choice}" type="radio" name="${prefix}" value="${choice}" data-async-choice data-question-index="${index}"><span>${esc(option)}</span></label>`).join('')}${options.length?`<label class="async-question-option"><input id="${prefix}-other" type="radio" name="${prefix}" value="other" data-async-choice data-question-index="${index}"><span>Other</span></label>`:''}<label class="async-answer-label" for="${prefix}-text">${options.length?'Other answer':'Your answer'}</label><textarea id="${prefix}-text" data-async-other data-question-index="${index}" rows="2" maxlength="4096" placeholder="Write your answer…"></textarea></fieldset>`;
  }).join('')}<div class="async-question-actions">${btn('prepare-async-reply','Prepare reply','button',`data-async-key="${esc(record.key)}" data-focus="prepare-${domId}"`)}<span>Prepare a reply, then send it from the message box.</span></div></section>`;
}
function syncAsyncReplyForms() {
  for(const card of document.querySelectorAll('#messages .async-question-card')){
    const record=asyncReplyDrafts.get(card.dataset.asyncKey);if(!record||record.context!==identity(state.selected))continue;
    for(const input of card.querySelectorAll('[data-async-choice]')){const checked=record.choices[Number(input.dataset.questionIndex)]===input.value;if(input.checked!==checked)input.checked=checked;}
    for(const input of card.querySelectorAll('[data-async-other]')){const value=record.other[Number(input.dataset.questionIndex)]||'';if(input.value!==value)input.value=value;}
  }
}
function updateAsyncReplyInput(input) {
  const card=input.closest('.async-question-card'),record=card&&asyncReplyDrafts.get(card.dataset.asyncKey);if(!record||record.context!==identity(state.selected))return;
  const index=Number(input.dataset.questionIndex);if(!Number.isInteger(index)||!record.questions[index])return;
  if(input.matches('[data-async-choice]'))record.choices[index]=input.value;
  else{record.other[index]=input.value;record.choices[index]='other';}
  syncAsyncReplyForms();
}
function prepareAsyncReply(key) {
  const record=asyncReplyDrafts.get(key);if(!record||record.context!==identity(state.selected)){toast('Open the original conversation before preparing this reply.');return;}
  try{
    const answers=record.questions.map((question,index)=>record.choices[index]==='other'||!question.options?.length?record.other[index]||'':question.options?.[Number(record.choices[index])]||'');
    const reply=formatAsyncReply(record.questions,answers),draft=draftFor();
    draft.text=draft.text?draft.text+'\n\n'+reply:reply;draft.revision++;
    if($('composer-input'))$('composer-input').value=draft.text;renderComposer();$('composer-input')?.focus({preventScroll:true});
    toast('Reply added to your draft. Review it and send when ready.');
  }catch(error){toast(errorText(error));}
}
function reportTextFor(message) {return [message.text,...(message.blocks || []).filter(block=>['text','markdown'].includes(block.type)&&block.text!==message.text).map(block=>block.text)].filter(Boolean).join('\n\n');}
const readAloudKey = id => JSON.stringify([identity(state.selected),String(id)]);
function readAloudAppearance(id) {
  const active=readAloud?.current?.key===readAloudKey(id),preparing=active&&readAloud.current.phase==='loading';
  return {active,preparing,label:active?(preparing?'Preparing…':'Stop reading'):'Read aloud',
    accessible:active?'Stop reading report':'Read report aloud',
    title:active?(preparing?'Stop waiting and skip remaining audio. An existing speech request may still finish.':'Stop reading this report'):'Read using your configured OpenClaw speech provider'};
}
function readAloudButton(id) {
  const view=readAloudAppearance(id);
  return btn('read-aloud',icon(view.active?'stop':'speaker')+' '+view.label,'text-btn read-aloud',`data-report-id="${esc(id)}" data-focus="read-${esc(id)}" aria-label="${view.accessible}" aria-busy="${view.preparing}" title="${view.title}" ${!online()&&!view.active?'disabled':''}`);
}
function syncReadAloudButtons() {
  for(const node of document.querySelectorAll('[data-action="read-aloud"]')) {
    const view=readAloudAppearance(node.dataset.reportId);
    node.innerHTML=icon(view.active?'stop':'speaker')+' '+view.label;
    node.setAttribute('aria-label',view.accessible);node.setAttribute('aria-busy',String(view.preparing));
    node.title=view.title;node.disabled=!online()&&!view.active;
  }
}
function retainReadAloudReport() {
  const current=readAloud?.current;if(!current||!state.history)return;
  const message=state.history.messages.find(item=>item.role==='assistant'&&readAloudKey(item.id)===current.key);
  if(!message||reportTextFor(message)!==current.text)readAloud.stop();
}
function messageHTML(message,index) {
  const role=message.role || 'unknown';
  const toolMessage=['tool','toolResult','function','function_result'].includes(role);
  const isUser=role==='user';
  const author=isUser?'You':role==='assistant'?nameFor(state.selected?.agentId):role==='tool'?'Tool output':role.charAt(0).toUpperCase()+role.slice(1);
  const blocks=(Array.isArray(message.blocks)?message.blocks:[]).map((block,i)=>{
    const type=block.type || 'unknown';
    if(['tool','tool_use','tool_call','tool_result','toolResult','toolCall','reasoning','thinking'].includes(type)) return `<details class="tool-group message-block" data-detail="${esc(message.id || index)}-${i}"><summary class="tool-summary">${icon('terminal')}<span class="grow">${esc(block.name || (type==='reasoning'||type==='thinking'?'Provided reasoning':'Tool activity'))}</span>${icon('down')}</summary><div class="tool-output">${linkedText(block.text || 'No readable output was supplied.')}</div></details>`;
    if(['text','markdown'].includes(type)) return block.text && block.text!==message.text ? `<div class="message-text message-block">${role==='assistant'?reportText(block.text):linkedText(block.text)}</div>` : '';
    return `<div class="media-placeholder message-block"><strong>${linkedText(block.name || type)}</strong>${linkedText(block.text || 'This item is preserved as a reference. Open the original interface to inspect its media or file content.')}</div>`;
  }).join('');
  const id=String(message.id || `${role}-${index}`);
  const report=reportTextFor(message);
  const question=role==='assistant'?asyncQuestionHTML(message):'';
  const footer=role==='assistant'&&report.trim()?`<footer class="message-actions">${btn('copy-report',icon('copy')+' Copy','text-btn copy-report',`data-copy-text="${esc(report)}" data-focus="copy-${esc(id)}" aria-label="Copy report" title="Copy report text"`)}${readAloudButton(id)}</footer>`:'';
  return `<article class="message ${isUser?'user':role==='system'?'message-system':''}" data-message-id="${esc(id)}" data-message-role="${esc(role)}"><div class="message-header">${!isUser&&role==='assistant'?avatar(state.selected?.agentId):''}<span class="message-role">${esc(author)}</span>${message.timestamp?`<time>${esc(stamp(message.timestamp))}</time>`:''}</div>${message.text?(toolMessage?`<details class="tool-group" data-detail="message-${esc(id)}"><summary class="tool-summary">${icon('terminal')}<span class="grow">Tool output</span>${icon('down')}</summary><div class="tool-output">${linkedText(message.text)}</div></details>`:`<div class="message-text">${role==='assistant'?reportText(message.text):linkedText(message.text)}</div>`):''}${blocks}${question}${!message.text&&!blocks&&!question?'<p class="small muted">No readable content was supplied.</p>':''}${footer}</article>`;
}
function transcriptSnapshot() {
  const el=$('transcript'); if(!el) return null;
  const candidates=[...el.querySelectorAll('[data-message-id]')];
  const first=candidates.find(item=>item.getBoundingClientRect().bottom>el.getBoundingClientRect().top);
  return {scroll:el.scrollTop,nearBottom:transcriptScrollPause?.el!==el&&(transcriptMotion?.el===el||el.scrollHeight-el.scrollTop-el.clientHeight<70),anchor:first?.dataset.messageId,anchorTop:first?first.getBoundingClientRect().top-el.getBoundingClientRect().top:0};
}
function renderHistory({initial=false, older=false, follow=false}={}) {
  if(state.view!=='Conversations') return;
  mainShell();
  const snapshot=transcriptSnapshot();
  const previous=[...$('messages').querySelectorAll(':scope > [data-message-id]')].map(node=>node.dataset.messageId);
  renderComposer();renderPlan();renderRunStatus();renderActivityIndicators();scheduleActivityFreshness();
  const selected=state.selected;
  let html='';
  if(!selected) html=`<div class="empty">${icon('chat')}<h2>Choose a conversation</h2><p>Open an existing session from the sidebar, or browse your agents. Your OpenClaw environment stays in place.</p>${state.overviewLoading?'<span class="loading-text">Reading the session catalog…</span>':''}</div>`;
  else {
    if(state.historyError) html+=failure('Conversation could not be refreshed',state.historyError,'refresh-history');
    if(state.historyLoading&&!state.history) html+='<div class="empty"><h2>Loading conversation…</h2><p>Reading this exact session from OpenClaw.</p></div>';
    if(state.history) {
      if(state.historyStale)html+='<div class="error-note">Earlier history is preserved while you read. '+btn('refresh-history','Refresh latest messages','text-btn')+' to resume current snapshots.</div>';
      if(state.history.hasMore) html+=`<div class="history-tools">${btn('older-history',state.historyLoading?'Loading earlier messages…':'Load earlier messages','button',state.historyLoading?'disabled':'')}</div>`;
      if(!state.history.messages.length) html+='<div class="empty"><h2>No readable messages</h2><p>This session has no returned message history. It may be empty or outside the current access scope.</p></div>';
      html+=state.history.messages.map(messageHTML).join('');
      if(state.history.inFlight?.text) html+=`<article class="message" data-message-id="live:${esc(state.history.inFlight.runId||'response')}" data-message-role="assistant"><div class="live-running"><i class="dot"></i>${online()?'Active response':'Last observed active response'}</div><div class="message-text">${reportText(state.history.inFlight.text)}</div></article>`;
      else if(state.history.hasActiveRun) html+=`<div class="live-running"><i class="dot"></i>${online()?'An active run is reported for this session.':'This session had an active run at the last observation.'}</div>`;
      html+='<div class="history-end">Media and file previews remain available in original OpenClaw</div>';
    }
  }
  replaceRegion('messages',html,{force:initial});
  if(pendingRegions.has('messages')) return;
  syncAsyncReplyForms();
  const el=$('transcript');
  if(initial && el) followTranscript(el,{immediate:true});
  else if(snapshot&&el) {
    const anchor=snapshot.anchor ? [...el.querySelectorAll('[data-message-id]')].find(item=>item.dataset.messageId===snapshot.anchor) : null;
    if(!transcriptMotion) {
      if(anchor) el.scrollTop+=anchor.getBoundingClientRect().top-el.getBoundingClientRect().top-snapshot.anchorTop;
      else el.scrollTop=snapshot.scroll;
    }
    if((snapshot.nearBottom&&!older)||follow){if(follow)transcriptScrollPause=null;followTranscript(el);}
    else cancelTranscriptMotion();
  }
  softenNewMessages(previous,{initial,older});
}
function activeSessionLabel(session) {const label=session?.hasActiveRun===true?'Running':session?.hasActiveSubagentRun===true?'Delegating':'No active run reported';return online()?label:'Stale · '+label;}
function workRow(session, statusText, child=true) {
  if(!session?.key||!session.agentId||!session.sessionId)return `<div class="work-link is-static" aria-disabled="true">${avatar(session?.agentId)}<span class="grow"><span class="work-title">${esc(session?.title || 'Conversation')}</span><span class="work-state">${esc(statusText)} · Exact session unavailable</span><span class="work-ident">${esc(nameFor(session?.agentId))}</span></span></div>`;
  return sessionButton(session,'work-link',`${avatar(session.agentId)}<span class="grow"><span class="work-title">${esc(session.title || 'Conversation')}</span><span class="work-state ${online()?'':'stale'}">${esc(statusText)}</span><span class="work-ident">${esc(nameFor(session.agentId))}</span></span>${icon('arrow')}`,child);
}
function processKey(process) { return JSON.stringify([process.id,process.instanceId || '']); }
function processRow(process) {
  const status=knownState(process.status);
  return btn('process',icon('terminal')+`<span class="grow"><span class="work-title">${esc(process.title || process.id || 'Process')}</span><span class="work-state ${online()?'':'stale'}">${esc(online()?status:`Stale · ${status}`)}</span></span>`,'process-link',`data-process="${esc(processKey(process))}" data-focus="process-${esc(processKey(process))}"`);
}
function workDetailHTML() {
  const process=state.work?.processes?.find(item=>processKey(item)===state.processId);
  if(!process) return btn('work-back','← Back to work','back-link')+'<p class="panel-note">This process is no longer returned by the source. Its outcome is unknown here.</p>';
  return `<div class="panel-details">${btn('work-back','← Back to work','back-link')}<h3 class="detail-title">${linkedText(process.title || process.id)}</h3><span class="pill">${esc(online()?knownState(process.status):'Stale · '+knownState(process.status))}</span><dl class="detail-grid"><dt>Process</dt><dd>${esc(process.id)}</dd><dt>Instance</dt><dd>${esc(process.instanceId || 'Not supplied')}</dd><dt>Session</dt><dd>${esc(state.workContext?.key)}</dd>${process.startedAt?`<dt>Started</dt><dd>${esc(stamp(process.startedAt))}</dd>`:''}${process.endedAt?`<dt>Ended</dt><dd>${esc(stamp(process.endedAt))}</dd>`:''}${process.exitCode!==undefined?`<dt>Exit code</dt><dd>${esc(process.exitCode)}</dd>`:''}</dl><div class="code process-tail">${linkedText(process.tail || 'No output was returned.')}</div>${process.truncated?'<p class="panel-note">OpenClaw marked this output as truncated.</p>':''}<p class="panel-note">Bounded output from OpenClaw. This view has no process-control actions.</p>${limitsHTML(state.work?.limitations)}</div>`;
}
function renderWork({force=false}={}) {
  if(!state.panel) return;
  syncActivityPanel();
  let html='';
  if(state.panelTab==='details') {
    const selected=state.selected;
    html=selected?`<div class="label">Selected session</div><dl class="detail-grid"><dt>Agent</dt><dd>${esc(nameFor(selected.agentId))} · ${esc(selected.agentId || 'Not supplied')}</dd><dt>Key</dt><dd>${esc(selected.key)}</dd><dt>Session</dt><dd>${esc(selected.sessionId || 'Not supplied')}</dd><dt>Gateway</dt><dd>${esc(state.connection.label)}</dd><dt>Runtime</dt><dd>${esc(state.connection.version || 'Not verified')}</dd><dt>Installed CLI</dt><dd>${esc(state.connection.installedVersion || 'Unknown')}</dd></dl><p class="panel-note">Session identity is supplied by OpenClaw. Display names do not establish execution ownership.</p>`:'<p class="panel-note">Choose a conversation to inspect its identity.</p>';
  } else if(state.processId) html=workDetailHTML();
  else {
    html=`<div class="segmented" aria-label="Work scope">${btn('scope','This conversation',state.scope==='conversation'?'active':'',`data-scope="conversation" aria-pressed="${state.scope==='conversation'}"`)}${btn('scope','All work',state.scope==='all'?'active':'',`data-scope="all" aria-pressed="${state.scope==='all'}"`)}</div>`;
    if(state.workContext) html+=`<div class="work-root"><strong>${esc(nameFor(state.workContext.agentId))} · ${esc(state.workContext.title || 'Conversation')}</strong><span class="small muted">${identity(state.workContext)!==identity(state.selected)?'Source context retained while viewing a delegate':'Observed conversation work'}</span></div>`;
    if(state.workError) html+=failure('Work could not be refreshed',state.workError,'refresh-work');
    if(state.workLoading&&!state.work) html+='<p class="panel-note">Loading observed work…</p>';
    const subagents=state.work?.subagents || [];
    const processes=state.work?.processes || [];
    if(subagents.length) html+='<div class="work-section-title">Delegated sessions</div>'+subagents.map(item=>workRow({key:item.sessionKey,sessionId:item.sessionId,agentId:item.agentId,title:item.title,parentKey:item.parentKey},online()?knownState(item.status):'Stale · '+knownState(item.status))).join('');
    if(processes.length) html+='<div class="work-section-title">Scripts & processes</div><div class="stack">'+processes.map(processRow).join('')+'</div>';
    if(state.work&&!subagents.length&&!processes.length) html+='<p class="panel-note">No child sessions or processes were returned for this conversation. This is not an OS-wide work inventory.</p>';
    if(!state.workContext) html+='<p class="panel-note">Choose a conversation to inspect its delegates and processes.</p>';
    if(state.scope==='all') {
      const linked=new Set(subagents.map(item=>identity({key:item.sessionKey,sessionId:item.sessionId,agentId:item.agentId})));
      const running=state.runningSessions.filter(item=>!linked.has(identity(item)));
      html+='<div class="work-other"><div class="label">Other active sessions</div>';
      html+=running.length?running.map(item=>workRow(item,activeSessionLabel(item))).join(''):'<p class="panel-note">No active sessions in the loaded gateway snapshot.</p>';
      html+=state.runningError?`<p class="limit-note">${esc(state.runningError)}</p>`:'';
      html+='<p class="limit-note">All work includes the gateway’s bounded active-session snapshot and this conversation’s supported delegates and processes. It does not inspect every session or the Mac’s process list.</p></div>';
    }
    html+=limitsHTML(state.work?.limitations);
  }
  replaceRegion('work-content',html,{force});
  $('work-freshness').textContent=`${online()?'Observed':'Stale observation'} · ${stamp(state.work?.updatedAt || state.runningUpdatedAt)}`;
}
function renderPage() {
  if(state.view==='Conversations') {renderHistory(); return;}
  mainShell();
  if(state.view==='Models'){
    if(!modelsView)modelsView=createModelsView({desktop,container:$('page-content'),onStatus:toast});
    modelsView.render($('page-content'));return;
  }
  if(state.view==='Settings'){renderSettings();return;}
  if(state.view==='Approvals'){renderApprovals();return;}
  let html='';
  if(state.view==='Agents') html=`<div class="page-intro"><div><h2>Your agents</h2><p>Existing identities from your connected OpenClaw gateway.</p></div><span class="pill">${state.agents.length} returned</span></div>`+(state.agents.length?`<div class="card-grid">${state.agents.map(agent=>`<article class="card"><div class="row">${avatar(agent.id)}<div class="grow"><h3>${esc(agent.name || agent.id)}</h3><span class="small muted">${esc(agent.id)}</span></div><span class="agent-activity" data-activity-agent="${esc(agent.id)}">${activityBadge(agentActivity(agent.id))}</span></div><p>Browse existing conversations without creating or changing this agent.</p>${btn('agent-sessions','Browse conversations →','button',`data-agent="${esc(agent.id)}" data-focus="agent-${esc(agent.id)}"`)}</article>`).join('')}</div>`:'<div class="empty"><p>No agent identities were returned. Check connection status and access before assuming the roster is empty.</p></div>')+limitsHTML(state.limits);
  else if(state.view==='Activity') html=`<div class="page-intro"><div><h2>Observed work</h2><p>Active sessions reported by OpenClaw. Coverage is bounded to the returned snapshot.</p></div>${btn('refresh-running','Refresh','button')}</div>`+(state.runningError?failure('Activity could not be refreshed',state.runningError,'refresh-running'):'')+(state.runningSessions.length?`<div class="list">${state.runningSessions.map(item=>sessionButton(item,'list-row',`${avatar(item.agentId)}<span class="grow"><strong>${esc(item.title || 'Conversation')}</strong><span>${esc(nameFor(item.agentId))} · ${esc(item.key)}</span></span><span class="inline-status">${esc(activeSessionLabel(item))}</span>${icon('arrow')}`,true)).join('')}</div>`:'<div class="empty"><h2>No active sessions returned</h2><p>Unobserved external work may still be running. This view does not infer idle or completed states.</p></div>')+`<p class="limit-note">Snapshot observed ${esc(stamp(state.runningUpdatedAt))}. Open a session’s Work panel for its supported scripts and delegated work.</p>`;
  else if(state.view==='Automations') {
    html='<div class="page-intro"><div><h2>Your automations</h2><p>Existing schedules and their returned execution history.</p></div>'+btn('refresh-automations','Refresh')+'</div>';
    if(state.automationError) html+=failure('Automations could not be refreshed',state.automationError,'refresh-automations');
    if(state.automationLoading&&!state.automations) html+='<p class="loading-text">Loading schedules…</p>';
    const jobs=state.automations?.jobs || [],runs=state.automations?.runs || [];
    html+='<h3 class="section-title">Schedules</h3>'+(jobs.length?`<div class="list">${jobs.map(job=>`<div class="list-row is-static">${icon('clock')}<div class="grow"><strong>${linkedText(job.name || job.id)}</strong><span>${esc(job.scheduleText || 'Schedule details unavailable')}</span><span>${esc(typeof job.state==='string'?job.state:job.state?.runningAtMs?'Run reported since '+stamp(job.state.runningAtMs):job.state?.lastStatus?'Last run: '+job.state.lastStatus:'No execution state supplied')}${job.state?.nextRunAtMs?' · Next '+esc(stamp(job.state.nextRunAtMs)):''}</span></div><span class="pill">${job.enabled===true?'Enabled':job.enabled===false?'Disabled':'State unknown'}</span></div>`).join('')}</div>`:'<p class="region-note">No schedules were returned.</p>');
    html+='<h3 class="section-title">Recent executions</h3>'+(runs.length?`<div class="list">${runs.map(run=>{
      const label=`${icon('activity')}<span class="grow"><strong>${esc(run.title || run.jobId || 'Automation run')}</strong><span>${esc(stamp(run.timestamp))}</span></span><span class="inline-status">${esc(knownState(run.status))}</span>`;
      const heading=run.sessionKey?sessionButton({key:run.sessionKey,sessionId:run.sessionId,agentId:run.agentId,title:run.title || run.jobId},'list-row',label,true):`<div class="list-row is-static">${label}</div>`;
      return `<div class="automation-result">${heading}${run.summary?`<div class="automation-summary">${reportText(run.summary)}</div>`:''}</div>`;
    }).join('')}</div>`:'<p class="region-note">No execution history was returned.</p>')+limitsHTML(state.automations?.limitations)+'<p class="limit-note">Enabled schedules are not necessarily running. Scheduling and delivery controls remain in the original interface. Approval requests are available in Approvals.</p>';
  } else html=`<div class="page-intro"><div><h2>${state.view==='Projects'?'Your workspaces stay in OpenClaw':'Existing capabilities, within reach'}</h2><p>Your existing OpenClaw environment remains the source of truth. The original interface preserves the full management surface.</p></div></div><div class="card"><h3>${state.view==='Projects'?'Projects, files and workspace configuration':'Models, tools, permissions and maintenance'}</h3><p>${state.view==='Projects'?'Workspace files, terminal access, Git and project settings are managed by OpenClaw. This view does not create a separate workspace catalog.':'Use the original interface for sending messages, approval decisions, agent configuration, skills, plugins, MCP, channels, devices, memory, updates and recovery.'}</p>${btn('original','Open original OpenClaw ↗','button')}</div><dl class="detail-grid connection-summary"><dt>Gateway</dt><dd>${esc(state.connection.label)}</dd><dt>Connection</dt><dd>${esc(state.connection.status)}</dd><dt>Runtime</dt><dd>${esc(state.connection.version || 'Not verified')}</dd><dt>Installed CLI</dt><dd>${esc(state.connection.installedVersion || 'Unknown')}</dd><dt>Protocol</dt><dd>${esc(state.connection.protocol || 'Unknown')}</dd><dt>Access</dt><dd>Gateway permissions apply</dd></dl>${limitsHTML(state.limits)}`;
  replaceRegion('page-content',html);
}
function layout() {
  document.body.classList.toggle('nav-hidden',state.navHidden&&viewWidth()>=1000);
  $('navigation').classList.toggle('drawer',state.navOpen&&viewWidth()<1000);
  const workVisible=state.panel&&state.view!=='Models';
  $('workspace').classList.toggle('no-panel',!workVisible);
  $('work-panel').hidden=!workVisible;
  $('toggle-work').hidden=state.view==='Models';
  $('toggle-terminal').hidden=state.view==='Models';
  $('toggle-work').setAttribute('aria-expanded',String(workVisible));
  const sheet=workVisible&&viewWidth()<1280;
  $('sheet-scrim').hidden=!sheet;
  for(const node of document.querySelectorAll('.titlebar,.nav,.page-header,#conversation-split')) node.inert=sheet;
  if(sheet)$('work-panel').setAttribute('aria-modal','true');else $('work-panel').removeAttribute('aria-modal');
  if(sheet) $('work-panel').setAttribute('role','dialog'); else $('work-panel').removeAttribute('role');
  $('app').inert=Boolean(state.modal);
  terminalView?.setContext(state.selected);terminalView?.layout();
  document.querySelectorAll('[data-action="work-tab"]').forEach(node=>{node.classList.toggle('active',node.dataset.tab===state.panelTab);node.setAttribute('aria-pressed',String(node.dataset.tab===state.panelTab));});
}
function render() {renderConnection();renderNavigation();heading();mainShell();renderPage();renderWork();layout();}
async function loadOverview({more=false,initial=false,poll=false}={}) {
  if(poll&&state.overviewLoading)return;
  if(poll&&state.page.offset>0){state.overviewStale=true;renderNavigation();return;}
  state.overviewStale=false;
  const generation=++requests.overview, query=state.query, agentId=state.agentId;
  const offset=more ? (state.page.nextOffset ?? state.page.offset+state.page.limit) : 0;
  state.overviewLoading=true; state.overviewError=''; renderNavigation();
  try {
    const data=await rpc('overview',{...(query?{query}:{}),...(agentId?{agentId}:{}),offset});
    if(generation!==requests.overview||query!==state.query||agentId!==state.agentId)return;
    setConnection(data.connection);
    state.agents=Array.isArray(data.agents)?data.agents:[];
    const sessions=(Array.isArray(data.sessions)?data.sessions:[]).filter(item=>item?.key);
    sessions.forEach(cacheSession);
    state.sessions=more?[...new Map([...state.sessions,...sessions].map(item=>[identity(item),item])).values()]:sessions;
    state.page={offset,limit:sessions.length || 50,...data.page};if(!Number.isFinite(state.page.total)&&Number.isFinite(state.page.totalCount))state.page.total=state.page.totalCount;
    state.limits=data.limitations || []; state.overviewReady=true;
    if(initial){loadRunning();loadApprovals();}
    if(initial&&!state.selected&&sessions.length) selectSession(sessions[0],{initial:true});
  } catch(error) {if(generation===requests.overview){state.overviewError=errorText(error);if(!state.overviewReady)setConnection({status:'disconnected',message:state.overviewError});}}
  finally {if(generation===requests.overview){state.overviewLoading=false;render();}}
}
async function loadHistory({older=false,initial=false,latest=false,animate=false}={}) {
  if(latest){state.historyExtended=false;state.historyStale=false;initial=!animate;}
  if(!state.selected)return;
  const selected={...state.selected}, selectionId=identity(selected), generation=++requests.history;
  const previous=state.history;
  const offset=older?(previous?.nextOffset ?? (previous?.offset || 0)+(previous?.pageSize || previous?.messages?.length || 0)):0;
  state.historyLoading=true;state.historyError='';renderHistory();
  try {
    const data=await rpc('history',{key:selected.key,...(selected.agentId?{agentId:selected.agentId}:{}),...(selected.sessionId?{sessionId:selected.sessionId}:{}),offset});
    if(generation!==requests.history||selectionId!==identity(state.selected))return;
    if((data.key&&data.key!==selected.key)||(selected.sessionId&&data.sessionId&&data.sessionId!==selected.sessionId))throw new Error('This session identity changed after selection. No replacement conversation was opened.');
    const messages=Array.isArray(data.messages)?data.messages:[];
    if(older&&previous){state.history={...data,pageSize:messages.length,messages:[...new Map([...messages,...previous.messages].map(item=>[item.id,item])).values()],hasActiveRun:data.hasActiveRun??previous.hasActiveRun,inFlight:data.inFlight??previous.inFlight};state.historyExtended=true;}
    else state.history={...data,pageSize:messages.length,messages};
    retainReadAloudReport();renderHistory({initial,older,follow:animate});
    if(state.restoreOrigin){const origin=state.restoreOrigin;state.restoreOrigin=null;requestAnimationFrame(()=>{cancelTranscriptMotion();$('transcript')?.scrollTo(0,origin.scroll);$('work-scroll')?.scrollTo(0,origin.workScroll);if(origin.focus)document.querySelector(origin.focus)?.focus({preventScroll:true});});}
  } catch(error){if(generation===requests.history&&selectionId===identity(state.selected))state.historyError=errorText(error);}
  finally {if(generation===requests.history&&selectionId===identity(state.selected)){state.historyLoading=false;renderHistory();}}
}
async function loadWork() {
  if(!state.workContext)return;
  const context={...state.workContext}, contextId=identity(context), generation=++requests.work;
  state.workLoading=true;state.workError='';renderWork();
  try {
    const data=await rpc('work',{key:context.key,...(context.agentId?{agentId:context.agentId}:{}),...(context.sessionId?{sessionId:context.sessionId}:{})});
    if(generation!==requests.work||contextId!==identity(state.workContext))return;
    state.work={...data,processes:Array.isArray(data.processes)?data.processes:[],subagents:Array.isArray(data.subagents)?data.subagents:[]};
  } catch(error){if(generation===requests.work){state.workError=errorText(error);if(error.code==='SESSION_CHANGED')state.work=null;}}
  finally{if(generation===requests.work){state.workLoading=false;renderWork();if(state.restoreWork){const origin=state.restoreWork;state.restoreWork=null;requestAnimationFrame(()=>{$('work-scroll').scrollTo(0,origin.workScroll);if(origin.focus)document.querySelector(origin.focus)?.focus({preventScroll:true});});}}}
}
async function loadRunning() {
  const generation=++requests.running;
  try {
    const data=await rpc('overview',{activeOnly:true}); if(generation!==requests.running)return;
    state.runningSessions=(data.sessions || []).filter(isActive);state.runningUpdatedAt=data.connection?.updatedAt || Date.now();state.runningError='';setConnection(data.connection);state.agents=data.agents || state.agents;
  }catch(error){if(generation===requests.running)state.runningError=errorText(error);}
  if(generation===requests.running){renderWork();if(state.view==='Activity')renderPage();}
}
async function loadAutomations() {
  const generation=++requests.automations;state.automationLoading=true;state.automationError='';if(state.view==='Automations')renderPage();
  try{const data=await rpc('automations',{});if(generation!==requests.automations)return;state.automations={...data,jobs:data.jobs || [],runs:data.runs || []};}
  catch(error){if(generation===requests.automations)state.automationError=errorText(error);}
  finally{if(generation===requests.automations){state.automationLoading=false;if(state.view==='Automations')renderPage();}}
}
function saveOrigin() {return {selected:state.selected?{...state.selected}:null,workContext:state.workContext?{...state.workContext}:null,scope:state.scope,panel:state.panel,panelTab:state.panelTab,processId:state.processId,scroll:$('transcript')?.scrollTop || 0,workScroll:$('work-scroll').scrollTop,focus:actionKey(document.activeElement)};}
function selectSession(item,{child=false,initial=false}={}) {
  cancelTranscriptMotion();transcriptScrollPause=null;
  if(!item?.key){toast('This work record has no exact session key. No conversation was opened.');return;}
  stopVoice();
  readAloud?.stop();
  if(child&&state.selected&&identity(item)!==identity(state.selected))state.stack.push(saveOrigin());
  else if(!child)state.stack=[];
  ++requests.history;++requests.plan;state.plan=null;state.planError='';state.planLoading=false;state.planReadKey=null;state.restoreOrigin=null;state.restoreWork=null;
  state.selected={...item};state.view='Conversations';state.history=null;state.historyExtended=false;state.historyStale=false;state.historyError='';state.historyLoading=true;state.processId=null;state.navOpen=false;
  if(!child||!state.workContext){++requests.work;state.workContext={...item};state.work=null;state.workError='';}
  pendingRegions.delete('messages');mainShell();replaceRegion('messages','',{force:true});render();
  loadHistory({initial:true});loadPlan();loadActivityForContexts();loadComposerOptions(state.selected);
  if(state.panel)loadWork();
  if(!initial){$('page-title')?.focus({preventScroll:true});announce(`Opened ${nameFor(item.agentId)}: ${item.title || 'conversation'}`);}
}
function back() {
  cancelTranscriptMotion();transcriptScrollPause=null;
  const origin=state.stack.pop();if(!origin?.selected)return;
  stopVoice();
  readAloud?.stop();
  ++requests.history;++requests.work;++requests.plan;state.plan=null;state.planError='';state.planLoading=false;state.planReadKey=null;
  Object.assign(state,{selected:origin.selected,workContext:origin.workContext,scope:origin.scope,panel:origin.panel,panelTab:origin.panelTab,processId:origin.processId,view:'Conversations',history:null,historyExtended:false,historyStale:false,historyError:'',work:null,restoreOrigin:origin,restoreWork:origin});
  replaceRegion('messages','',{force:true});render();loadHistory();loadPlan();loadActivityForContexts();loadComposerOptions(state.selected);if(state.panel)loadWork();announce(`Returned to ${nameFor(origin.selected.agentId)}`);
}
function openView(view) {if(view!=='Conversations'){readAloud?.stop();stopVoice();}state.view=view;state.navOpen=false;render();$('page-title')?.focus({preventScroll:true});if(view==='Automations')loadAutomations();if(view==='Activity')loadRunning();if(view==='Approvals')loadApprovals({explicit:true});if(view==='Agents')loadActivityForContexts();if(view==='Models')modelsView?.load();}
function setTheme(theme) {if(!['light','dark'].includes(theme))return;state.theme=theme;document.documentElement.dataset.theme=theme;desktop?.setAppearance?.(theme);terminalView?.setTheme();$('theme-toggle').innerHTML=icon(theme==='dark'?'sun':'moon');$('theme-toggle').setAttribute('aria-label',`Switch to ${theme==='dark'?'light':'dark'} theme`);}
function showDialog(title,body,{search=false}={}) {
  state.modalReturn=actionKey(document.activeElement);state.modal={title,search};
  $('overlay').innerHTML=`<div class="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal-head"><h2 id="dialog-title">${esc(title)}</h2>${btn('close-dialog',icon('close'),'icon-btn','aria-label="Close dialog"')}</div><div class="modal-body dialog-copy">${body}</div></section></div>`;
  layout();$('overlay').querySelector('input,button')?.focus();
}
function closeDialog() {const focus=state.modalReturn;state.modal=null;$('overlay').innerHTML='';layout();if(focus)document.querySelector(focus)?.focus({preventScroll:true});}
function quickOpen() {showDialog('Quick Open','<label class="sr-only" for="palette-search">Find a loaded conversation or view</label><input id="palette-search" class="session-search" placeholder="Find a loaded conversation or view…" autocomplete="off"><div id="palette-results" class="palette-items"></div><p class="limit-note">Searches the loaded session list. Use sidebar search to query the gateway.</p>',{search:true});renderPalette('');$('palette-search').focus();}
function renderPalette(query) {const q=query.toLowerCase();replaceRegion('palette-results',state.sessions.filter(item=>`${item.title} ${nameFor(item.agentId)}`.toLowerCase().includes(q)).map(item=>sessionButton(item,'palette-item',`${icon('chat')}<span class="grow">${esc(item.title || 'Conversation')}<span class="small muted">${esc(nameFor(item.agentId))}</span></span>`,true)).join('')+['Conversations','Agents','Projects','Activity','Automations','Approvals','Models','Settings'].filter(view=>view.toLowerCase().includes(q)).map(view=>btn('view',icon('settings')+esc(view),'palette-item',`data-view="${view}"`)).join('') || '<p class="region-note">No loaded matches.</p>');}
function connectionDialog() {showDialog('Connection',`<dl class="detail-grid"><dt>Gateway</dt><dd>${esc(state.connection.label)}</dd><dt>Status</dt><dd>${esc(state.connection.status)}</dd><dt>Runtime</dt><dd>${esc(state.connection.version || 'Not verified')}</dd><dt>Installed CLI</dt><dd>${esc(state.connection.installedVersion || 'Unknown')}</dd><dt>Protocol</dt><dd>${esc(state.connection.protocol || 'Unknown')}</dd><dt>Access</dt><dd>Gateway permissions apply</dd></dl><p>${esc(state.connection.message || 'The desktop reads your existing sessions and work through the OpenClaw gateway. Messages, approval decisions and configuration changes use your existing OpenClaw permissions.')}</p><div class="top-space">${btn('reconnect','Reconnect')}${btn('original','Open original OpenClaw ↗')}</div>`);}
async function reconnect() {readAloud?.stop();stopVoice();invalidatePermissionReview();state.reconnecting=true;renderPermissionDialog();renderConnection();try{const result=await rpc('reconnect',{});if(result?.connection)setConnection(result.connection);await loadOverview();if(state.selected){await loadHistory();await loadPlan();}await loadApprovals({explicit:true});if(state.panel)await loadWork();if(state.view==='Automations')await loadAutomations();}catch(error){setConnection({status:'disconnected',message:errorText(error)});}finally{state.reconnecting=false;render();}}
function scheduleRead(kind,fn) {clearTimeout(timers.get(kind));timers.set(kind,setTimeout(()=>{timers.delete(kind);fn();},250));}
function refreshSelectedHistory(){if(state.historyLoading)return;if(state.historyExtended){state.historyStale=true;renderHistory();}else loadHistory();}
function gatewayEvent(event) {
  if(event.kind==='activity'){loadActivityForContexts();if(state.view==='Models')modelsView?.load();return;}
  if(event.kind==='connection'){setConnection(event.connection);modelsView?.invalidateConnection(event.connection);if(state.view==='Models'&&event.connection?.status==='connected')modelsView?.load({force:true});renderHistory();renderWork();renderApprovals();renderSettings();if(online()){scheduleRead('approvals',()=>loadApprovals());if(state.selected)scheduleRead('plan',loadPlan);scheduleRead('overview',()=>loadOverview());if(state.selected)scheduleRead('history',()=>loadHistory());if(state.panel)scheduleRead('work',loadWork);if(state.view==='Automations')scheduleRead('automations',loadAutomations);}return;}
  if(event.kind==='approvals'){scheduleRead('approvals',()=>loadApprovals({explicit:true}));return;}
  if(event.kind==='plan'&&state.selected&&(!event.key||event.key===state.selected.key)){scheduleRead('plan',loadPlan);return;}
  if(event.kind==='sessions'){scheduleRead('approvals',()=>loadApprovals());if(state.view==='Conversations'&&state.selected)scheduleRead('plan',loadPlan);if(state.view==='Automations')scheduleRead('automations',loadAutomations);if(state.view==='Conversations'&&state.selected)scheduleRead('history',refreshSelectedHistory);if(state.panel&&state.workContext)scheduleRead('work',loadWork);scheduleRead('overview',()=>loadOverview({poll:true}));if(state.scope==='all'||state.view==='Activity')scheduleRead('running',loadRunning);}
  if(event.kind==='history'&&state.selected&&(!event.key||event.key===state.selected.key)){scheduleRead('history',refreshSelectedHistory);scheduleRead('plan',loadPlan);}
  if(event.kind==='work'&&state.workContext&&(!event.key||event.key===state.workContext.key)){if(state.panel)scheduleRead('work',loadWork);if(state.view==='Activity')scheduleRead('running',loadRunning);}
}
function toggleWork(force) {if(state.view==='Models')return;state.panel=force??!state.panel;layout();if(state.panel){renderWork();loadWork();loadActivityForContexts();if(viewWidth()<1280)$('close-work').focus();}else $('toggle-work').focus({preventScroll:true});}
function runCommand(command) {
  if(command.startsWith('theme:')){setTheme(command.slice(6));return;}
  if(state.modal||modelsView?.isDialogOpen()){toast('Close the current dialog before switching views.');return;}
  if(command==='new'){openView('Conversations');$('composer-input')?.focus();toast('Choose an existing conversation to send a message. New conversation creation remains available in original OpenClaw.');}
  else if(command==='quick-open')quickOpen();
  else if(command==='toggle-navigation'){if(viewWidth()<1000)state.navOpen=!state.navOpen;else state.navHidden=!state.navHidden;layout();}
  else if(command==='toggle-work')toggleWork();
  else if(command==='toggle-terminal'&&state.view!=='Models')terminalView?.toggle();
  else if(command==='settings')openView('Settings');
  else if(command.startsWith('view:')&&['Conversations','Agents','Projects','Activity','Automations','Approvals','Models'].includes(command.slice(5)))openView(command.slice(5));
}
async function handleAction(node) {
  const action=node.dataset.action;
  if(action==='activity-open'){if(!state.panel)toggleWork(true);state.panelTab='work';state.processId=null;layout();renderWork();$('activity-current')?.scrollIntoView({block:'nearest'});return;}
  if(action==='refresh-activity'){loadActivity(state.workContext||state.selected,{force:true});return;}
  if(action==='more-activity'){moreActivity();return;}
  if(action==='toggle-terminal'){terminalView?.toggle();return;}
  if(action==='voice-menu'){openVoiceMenu();return;}
  if(action==='voice-start'){startVoice(node.dataset.mode);return;}
  if(action==='voice-stop'){voiceView?.stop();return;}
  if(action==='voice-cancel'){stopVoice();return;}
  if(action==='read-aloud'){
    const key=readAloudKey(node.dataset.reportId);
    if(readAloud?.current?.key===key){readAloud.stop();announce('Reading stopped.');return;}
    if(!online()||state.view!=='Conversations')return;
    const message=state.history?.messages.find(item=>item.role==='assistant'&&String(item.id)===node.dataset.reportId);
    if(!message){toast('This report changed. Refresh the conversation before reading it aloud.');return;}
    stopVoice();
    readAloud?.start(key,reportTextFor(message));return;
  }
  if(action==='send'){sendMessage();return;}
  if(action==='prepare-async-reply'){prepareAsyncReply(node.dataset.asyncKey);return;}
  if(action==='attach-media'){pickMedia();return;}
  if(action==='permissions'){openPermissions();return;}
  if(action==='refresh-permissions'){loadPermissionOptions(state.modal?.operation);return;}
  if(action==='apply-permissions'){applyPermissions();return;}
  if(action==='remove-attachment'){removeMedia(node.dataset.attachment);return;}
  if(action==='refresh-composer'){loadComposerOptions(state.selected,{force:true});return;}
  if(action==='review-stop'){reviewStop(node);return;}
  if(action==='confirm-stop'){confirmStop(node);return;}
  if(action==='refresh-plan'){loadPlan({force:true});return;}
  if(action==='refresh-approvals'){loadApprovals({explicit:true});return;}
  if(action==='review-approval'){reviewApproval(node);return;}
  if(action==='confirm-approval'){confirmApproval(node);return;}
  if(action==='load-settings'){requestSettingsLoad();return;}
  if(action==='confirm-load-settings'){closeDialog();loadSettings();return;}
  if(action==='review-settings'){reviewSettings();return;}
  if(action==='confirm-save-settings'){saveSettings(node);return;}
  if(action==='appearance-light'||action==='appearance-dark'){setTheme(action.slice(11));renderSettings();return;}
  if(action==='copy-report'){
    const text=node.dataset.copyText;
    if(node.getAttribute('aria-busy')==='true')return;
    node.setAttribute('aria-busy','true');
    node.innerHTML=icon('copy')+' Copying…';
    try {
      await desktop.copyReport(text);
      node.innerHTML=icon('check')+' Copied';
      toast('Report copied.');
      setTimeout(()=>{if(node.isConnected)node.innerHTML=icon('copy')+' Copy';},2000);
    } catch(error){node.innerHTML=icon('copy')+' Copy';toast(errorText(error));}
    finally{node.removeAttribute('aria-busy');}
  }
  else if(action==='reveal-file'){
    try{await desktop.revealFile(node.dataset.path);announce('Sent to Finder.');}
    catch(error){toast(errorText(error));}
  }
  else if(action==='session'){const item=findSession(node.dataset.identity);const child=node.dataset.child==='true';if(state.modal)closeDialog();selectSession(item,{child});}
  else if(action==='view'){if(state.modal)closeDialog();openView(node.dataset.view);}
  else if(action==='back')back();
  else if(action==='original'){try{await rpc('original',{});}catch(error){toast(errorText(error));}}
  else if(action==='quick-open')quickOpen();
  else if(action==='theme')setTheme(state.theme==='dark'?'light':'dark');
  else if(action==='connection')connectionDialog();
  else if(action==='close-dialog')closeDialog();
  else if(action==='reconnect'){if(state.modal)closeDialog();reconnect();}
  else if(action==='toggle-navigation')runCommand(action);
  else if(action==='toggle-work')toggleWork();
  else if(action==='close-work')toggleWork(false);
  else if(action==='scope'){state.scope=node.dataset.scope;state.processId=null;if(state.scope==='conversation'&&identity(state.workContext)!==identity(state.selected)){state.workContext=state.selected?{...state.selected}:null;state.work=null;loadWork();loadActivityForContexts();}renderWork();if(state.scope==='all')loadRunning();}
  else if(action==='work-tab'){state.panelTab=node.dataset.tab;layout();renderWork({force:true});}
  else if(action==='process'){state.processOrigin={scroll:$('work-scroll').scrollTop,focus:actionKey(node)};state.processId=node.dataset.process;renderWork({force:true});$('work-content').querySelector('button')?.focus();}
  else if(action==='work-back'){const processId=state.processId,origin=state.processOrigin;state.processId=null;renderWork({force:true});if(origin)$('work-scroll').scrollTo(0,origin.scroll);document.querySelector(origin?.focus||`[data-process="${CSS.escape(processId)}"]`)?.focus({preventScroll:true});}
  else if(action==='agent-sessions'||action==='clear-filter'){state.agentId=action==='clear-filter'?'':node.dataset.agent;state.query='';$('session-search').value='';state.sessions=[];state.page={offset:0,limit:50,total:0,hasMore:false};state.view='Conversations';state.navOpen=false;render();loadOverview();}
  else if(action==='more-sessions')loadOverview({more:true});
  else if(action==='older-history')loadHistory({older:true});
  else if(action==='refresh-overview')loadOverview();
  else if(action==='refresh-history'){loadHistory({latest:true});loadPlan();}
  else if(action==='refresh-work')loadWork();
  else if(action==='refresh-running')loadRunning();
  else if(action==='refresh-automations')loadAutomations();
}

// Drafts and submitted requests are bound to the full, exact session identity.
const mutationRejected = error => error?.uncertain!==true&&['ACCESS','INVALID','CONFLICT','STALE','SESSION_CHANGED','DENIED','NOT_FOUND','EXPIRED','UNSUPPORTED','PROTECTED','BUSY','BRANCH_UNKNOWN','RUN_CHANGED'].includes(error?.code);
const sessionParams = selected => ({key:selected.key,...(selected.agentId?{agentId:selected.agentId}:{}),...(selected.sessionId?{sessionId:selected.sessionId}:{})});
function draftFor(selected=state.selected) {const key=identity(selected);if(!drafts.has(key))drafts.set(key,{text:'',revision:0,attachments:[]});return drafts.get(key);}
function composerRecord(selected=state.selected) {
  const key=identity(selected);if(!composerRecords.has(key))composerRecords.set(key,{options:null,loading:false,saving:false,picking:false,error:'',uncertain:false});return composerRecords.get(key);
}
function composerFrozen(selected=state.selected) {const send=sends.get(identity(selected));return ['sending','uncertain'].includes(send?.status);}
async function loadComposerOptions(selected,{force=false}={}) {
  if(!selected||!online())return;
  const context={...selected},record=composerRecord(context),key=identity(context);
  if(record.loading||record.saving||(!force&&record.options&&Date.now()-record.readAt<60000))return;
  record.loading=true;record.error='';if(identity(state.selected)===key)renderComposer();
  try{record.options=await rpc('composerOptions',sessionParams(context));record.readAt=Date.now();record.uncertain=false;}
  catch(error){record.error=errorText(error);}
  finally{record.loading=false;if(identity(state.selected)===key)renderComposer();}
}
async function changeComposerSetting(field,value) {
  if(!state.selected||!online()||composerFrozen())return;
  const context={...state.selected},key=identity(context),record=composerRecord(context),options=record.options;
  if(record.saving||record.loading||record.picking||record.uncertain||!options)return;
  const model=(options.models||[]).find(item=>item.value===options.current?.model);
  if(field==='model'&&(options.modelSelectionLocked||!(options.models||[]).some(item=>item.value===value&&item.available!==false&&item.manualSelectionAllowed!==false)))return;
  if(field==='thinkingLevel'&&!(model?.thinkingLevels||[]).some(item=>item.id===value))return;
  record.saving=true;record.error='';renderComposer();
  try{record.options=await rpc('setComposer',{...sessionParams(context),[field]:value});record.readAt=Date.now();record.uncertain=false;}
  catch(error){record.uncertain=!mutationRejected(error);record.error=(record.uncertain?'Setting outcome unconfirmed. Refresh options before making another change. ':'Setting was not changed. ')+errorText(error);}
  finally{record.saving=false;if(identity(state.selected)===key)renderComposer();}
}

const permissionToken = value => value===null?'default':value;
function validPermissionOptions(value) {
  const modes=[null,'read-only','guarded','workspace','full'];
  return value&&modes.includes(value.current)&&typeof value.pending==='boolean'&&typeof value.hasActiveRun==='boolean'
    &&(value.lifecycleRevision===undefined||typeof value.lifecycleRevision==='string'&&value.lifecycleRevision.length>0)&&Array.isArray(value.choices)&&value.choices.length>0&&value.choices.length<=5
    &&new Set(value.choices.map(choice=>choice?.value)).size===value.choices.length
    &&value.choices.every(choice=>choice&&modes.includes(choice.value)&&typeof choice.label==='string'&&typeof choice.description==='string');
}
function permissionContextCurrent(operation) {return operation?.kind==='permissions'&&state.modal?.operation===operation&&state.view==='Conversations'&&identity(state.selected)===operation.key;}
function invalidatePermissionReview() {
  const operation=state.modal?.operation;if(operation?.kind==='permissions'){operation.needsRefresh=true;operation.epoch++;}
}
function openPermissions() {
  if(!state.selected?.key||!state.selected?.agentId||!state.selected?.sessionId||!online())return;
  showDialog('Execution permissions','<div id="permission-dialog"></div>');
  const operation={kind:'permissions',context:{...state.selected},key:identity(state.selected),options:null,selected:undefined,loading:false,busy:false,needsRefresh:false,error:'',notice:'',fullConfirmed:false,epoch:0};
  state.modal.operation=operation;loadPermissionOptions(operation);
}
function renderPermissionDialog() {
  const operation=state.modal?.operation;if(operation?.kind!=='permissions'||!$('permission-dialog'))return;
  const options=operation.options,contextCurrent=permissionContextCurrent(operation),busy=operation.loading||operation.busy;
  const disabled=!contextCurrent||!online()||busy||operation.needsRefresh||!options||options.pending||composerFrozen(operation.context);
  const current=options?.choices.find(choice=>choice.value===options.current),selected=options?.choices.find(choice=>choice.value===operation.selected);
  const changed=Boolean(options&&selected&&operation.selected!==options.current);
  const currentLabel=current?.label||(options?.current===null?'Default (OpenClaw configuration)':options?.current||'Not read');
  const notice=!contextCurrent?'The selected conversation changed. Close this dialog and open permissions for the current conversation.':!online()?'Disconnected. Reconnect and refresh permissions before changing them.':operation.busy?'Applying this permission change through OpenClaw…':operation.loading?'Reading this exact session’s permissions…':operation.error||
    (operation.needsRefresh?'Refresh permissions to review the current state before applying another change.':options?.pending?'OpenClaw is still applying a permission change. Refresh to check its status.':operation.notice);
  const choices=options?`<fieldset class="permission-choices" ${disabled?'disabled':''}><legend>Choose a permission mode</legend>${options.choices.map(choice=>`<label class="permission-choice"><input type="radio" name="permission-mode" value="${esc(permissionToken(choice.value))}" data-focus="permission-${esc(permissionToken(choice.value))}" ${choice.value===operation.selected?'checked':''}><span><strong>${esc(choice.label)}</strong><span>${esc(choice.description)}</span></span></label>`).join('')}</fieldset>`:'';
  const review=changed?`<div class="permission-review"><strong>Review: ${esc(currentLabel)} → ${esc(selected.label)}</strong><p>Changing execution permissions can interrupt the current response and background terminals.${options.hasActiveRun?' An active response was reported when these permissions were read.':''}</p>${operation.selected===null?'<p>Default inherits your OpenClaw configuration. It does not guarantee a particular set of restrictions.</p>':''}${operation.selected==='full'?`<p class="permission-full-warning"><strong>Full access grants broad execution access.</strong> OpenClaw administrator authority is required. Apply only if you intend to permit that access for this conversation.</p><label class="permission-confirm"><input id="permission-full-confirm" type="checkbox" data-focus="permission-full-confirm" ${operation.fullConfirmed?'checked':''} ${disabled?'disabled':''}><span>I understand Full access grants broad execution access</span></label>`:''}</div>`:'';
  replaceRegion('permission-dialog',`<p class="permission-context">${esc(nameFor(operation.context.agentId))} · ${esc(operation.context.title||'Selected conversation')}</p><p class="permission-current"><strong>Current:</strong> ${esc(currentLabel)}</p>${options?.current===null?'<p class="limit-note">Default inherits OpenClaw configuration; it is not a guarantee of restrictions.</p>':''}${choices}${review}<p id="permission-status" class="${operation.error?'dialog-error':'permission-notice'}" role="status">${esc(notice||'Choose a mode, review its effect, then apply it explicitly.')}</p><div class="control-actions">${btn('close-dialog','Close')}${btn('refresh-permissions','Refresh permissions','button',`data-focus="refresh-permissions" ${busy||!online()||!contextCurrent?'disabled':''}`)}${btn('apply-permissions',operation.busy?'Applying…':'Apply permissions','button primary',`data-focus="apply-permissions" ${disabled||!changed||operation.selected==='full'&&!operation.fullConfirmed?'disabled':''}`)}</div>`);
}
async function loadPermissionOptions(operation) {
  if(!permissionContextCurrent(operation)||!online()||operation.loading||operation.busy)return;
  const epoch=operation.epoch;
  operation.loading=true;operation.error='';operation.notice='';renderPermissionDialog();
  try {
    const options=await rpc('permissionOptions',sessionParams(operation.context));
    if(!permissionContextCurrent(operation)||operation.epoch!==epoch)return;
    if(!validPermissionOptions(options))throw new Error('OpenClaw returned unsupported permission options. Use the original interface.');
    operation.options=options;operation.selected=options.current;operation.fullConfirmed=false;operation.needsRefresh=false;
  } catch(error){if(permissionContextCurrent(operation)){operation.error=errorText(error);operation.needsRefresh=true;}}
  finally{operation.loading=false;if(state.modal?.operation===operation)renderPermissionDialog();}
}
async function applyPermissions() {
  const operation=state.modal?.operation,options=operation?.options;
  if(!permissionContextCurrent(operation)||!online()||operation.loading||operation.busy||operation.needsRefresh||!options||options.pending||composerFrozen(operation.context)||operation.selected===options.current||
    !options.choices.some(choice=>choice.value===operation.selected)||operation.selected==='full'&&!operation.fullConfirmed)return;
  const permissionMode=operation.selected,epoch=operation.epoch;operation.busy=true;operation.error='';operation.notice='';renderPermissionDialog();
  try {
    const result=await rpc('setPermissions',{...sessionParams(operation.context),expectedPermissionMode:options.current,...(options.lifecycleRevision===undefined?{}:{expectedLifecycleRevision:options.lifecycleRevision}),permissionMode});
    if(!validPermissionOptions(result))throw new Error('The permission change was submitted but its current state could not be verified.');
    if(!permissionContextCurrent(operation))return;
    if(operation.epoch!==epoch)throw new Error('The connection changed after submission. Refresh permissions to verify the saved mode.');
    operation.options=result;operation.selected=result.current;operation.fullConfirmed=false;operation.needsRefresh=false;
    operation.notice=result.pending?'The mode was saved. OpenClaw is still applying the change; refresh to check its status.':'Session permissions updated.';
    announce(operation.notice);
  } catch(error) {
    if(state.modal?.operation===operation){operation.needsRefresh=true;operation.error=`${mutationRejected(error)?'Permissions were not changed.':'Permission change outcome is unconfirmed; it may already be saved.'} ${errorText(error)} Refresh permissions before applying another change.`;}
  } finally{operation.busy=false;if(state.modal?.operation===operation)renderPermissionDialog();}
}
function stopVoice() {if(voiceView?.current)voiceView.stop({discard:true,detach:true});}
function voiceControls(record) {
  const finishing=record.phase==='finalizing',ready=Boolean(record.id);
  return `${ready?btn('voice-stop',finishing?'Finishing…':record.mode==='dictation'?'Finish dictation':'Stop talking','button',`data-focus="voice-stop" ${finishing?'disabled':''}`):''}${record.mode==='dictation'||!ready?btn('voice-cancel','Cancel','text-btn','data-focus="voice-cancel"'):''}`;
}
function renderVoiceStatus() {
  const record=voiceView?.current,button=$('composer-voice');
  if(button){button.classList.toggle('is-active',Boolean(record));button.setAttribute('aria-pressed',String(Boolean(record)));}
  if(!$('voice-status'))return;
  if(!record){replaceRegion('voice-status','');return;}
  const labels={checking:'Checking voice availability',permission:'Waiting for microphone access',connecting:'Connecting voice',listening:record.mode==='dictation'?'Dictating':'Listening',speaking:`${nameFor(record.context.agentId)} is speaking`,finalizing:'Finishing dictation'};
  const note=record.mode==='dictation'?'Final dictation is added to this draft. Nothing sends automatically.':record.supportsBargeIn?'Live microphone and speaker conversation through OpenClaw.':'Take turns speaking. Microphone audio pauses while the agent speaks.';
  replaceRegion('voice-status',`<section class="voice-status-bar" data-voice-phase="${esc(record.phase)}" aria-label="Voice session"><div class="row spread"><span id="voice-state" role="status"><i class="dot" aria-hidden="true"></i>${esc(labels[record.phase]||'Voice active')}${record.stream?' · Microphone on':''}</span><div class="voice-actions">${voiceControls(record)}</div></div><p>${esc(note)}</p>${record.transcript?`<p class="voice-caption" aria-live="off"><strong>${record.transcriptRole==='assistant'?esc(nameFor(record.context.agentId)):'You'}:</strong> ${esc(record.transcript)}</p>`:''}</section>`);
}
function renderVoiceMenu() {
  const operation=state.modal?.operation;if(operation?.kind!=='voice'||!$('voice-menu-body'))return;
  const current=voiceView?.current,matching=identity(state.selected)===operation.key&&state.view==='Conversations',options=operation.options;
  const modes=[['dictation','Dictate','Record text into this conversation’s draft. Finish to keep it; Cancel discards unfinished dictation.'],['conversation',`Talk to ${nameFor(operation.context.agentId)}`,'Start a live microphone and speaker conversation through OpenClaw. This does not send your typed draft.']];
  replaceRegion('voice-menu-body',`<p class="permission-context">${esc(nameFor(operation.context.agentId))} · ${esc(operation.context.title||'Selected conversation')}</p>${current?`<div class="voice-menu-active"><p>Voice is active in ${esc(nameFor(current.context.agentId))}’s conversation.</p><div class="control-actions">${voiceControls(current)}</div></div>`:''}${modes.map(([mode,label,description])=>`<section class="voice-mode"><h3>${esc(label)}</h3><p>${esc(description)}</p>${options?.[mode]?.reason?`<p class="voice-unavailable">${esc(options[mode].reason)}</p>`:''}${mode==='conversation'&&options?.conversation?.available&&!options.conversation.supportsBargeIn?'<p class="limit-note">This provider uses turn taking. Wait while the agent speaks.</p>':''}${btn('voice-start',esc(label),'button',`data-mode="${mode}" data-focus="voice-start-${mode}" ${!matching||!online()||operation.loading||current||options?.[mode]?.available!==true?'disabled':''}`)}</section>`).join('')}<p class="permission-notice" role="status">${esc(!matching?'This conversation changed. Close voice options and open them again.':operation.loading?'Checking your configured OpenClaw voice providers…':operation.error||'Microphone access is requested only when you choose a voice mode.')}</p>${operation.error||options&&!options.dictation?.available&&!options.conversation?.available?btn('original','Open original OpenClaw ↗','text-btn'):''}`);
}
async function openVoiceMenu() {
  if(!voiceView||!online()||!state.selected?.sessionId)return;
  showDialog('Voice','<div id="voice-menu-body"></div>');
  const operation={kind:'voice',context:{...state.selected},key:identity(state.selected),options:null,loading:true,error:''};state.modal.operation=operation;renderVoiceMenu();
  try{const options=await voiceView.catalog(sessionParams(operation.context));if(state.modal?.operation===operation)operation.options=options;}
  catch(error){if(state.modal?.operation===operation)operation.error=errorText(error);}
  finally{operation.loading=false;if(state.modal?.operation===operation)renderVoiceMenu();}
}
function startVoice(mode) {
  const operation=state.modal?.operation;
  if(operation?.kind!=='voice'||operation.loading||voiceView?.current||!online()||identity(state.selected)!==operation.key||operation.options?.[mode]?.available!==true)return;
  const context=sessionParams(operation.context);closeDialog();voiceView.start(context,mode);
}
function appendDictation(context,value) {
  const draft=draftFor(context);draft.text=draft.text?draft.text+'\n\n'+value:value;draft.revision++;
  if(identity(state.selected)===identity(context)&&$('composer-input')){$('composer-input').value=draft.text;renderComposer();}
  toast(`Dictation added to ${nameFor(context.agentId)}’s draft. Review it before sending.`);announce('Dictation added to the draft. Nothing was sent.');
}
async function pickMedia() {
  if(!state.selected||!online()||composerFrozen())return;
  const context={...state.selected},key=identity(context),draft=draftFor(context),record=composerRecord(context);
  if(record.picking||record.saving||draft.attachments.length>=4||!desktop?.pickAttachments)return;
  record.picking=true;record.error='';renderComposer();
  try{const result=await desktop.pickAttachments(sessionParams(context));const items=Array.isArray(result?.items)?result.items:[];if(items.length){const known=new Set(draft.attachments.map(item=>item.id));draft.attachments.push(...items.filter(item=>item?.id&&!known.has(item.id)));draft.revision++;}}
  catch(error){record.error=errorText(error);}
  finally{record.picking=false;if(identity(state.selected)===key)renderComposer();}
}
async function removeMedia(id) {
  if(!state.selected||composerFrozen())return;
  const context={...state.selected},key=identity(context),draft=draftFor(context),record=composerRecord(context);
  if(record.picking||record.saving||!draft.attachments.some(item=>item.id===id))return;
  record.picking=true;record.error='';renderComposer();
  try{await desktop.removeAttachment({...sessionParams(context),id});draft.attachments=draft.attachments.filter(item=>item.id!==id);draft.revision++;}
  catch(error){record.error=errorText(error);}
  finally{record.picking=false;if(identity(state.selected)===key)renderComposer();}
}
function renderComposer() {
  const input=$('composer-input');if(!input)return;
  const key=identity(state.selected),draft=draftFor(),send=sends.get(key),record=composerRecord(),options=record.options;
  if(input.dataset.session!==key){input.dataset.session=key;input.value=draft.text;}
  input.disabled=!state.selected;
  input.placeholder=state.selected?`Message ${nameFor(state.selected.agentId)}…`:'Choose a conversation to write a message';
  const pending=send?.status==='sending',uncertain=send?.status==='uncertain',frozen=pending||uncertain;
  const runIds=Array.isArray(state.history?.activeRunIds)?state.history.activeRunIds:[];
  const busy=record.saving||record.picking;
  const canSend=online()&&Boolean(state.selected)&&Boolean(state.history)&&!state.historyLoading&&!pending&&!busy&&!record.uncertain&&(uncertain||Boolean(draft.text.trim())||draft.attachments.length>0);
  const disabled=!online()||!state.selected||frozen||busy;
  const models=options?.models||[],model=models.find(item=>item.value===options?.current?.model),levels=model?.thinkingLevels||[];
  const unavailableModel=options?.current?.model&&!model;
  const modelOptions=(model?'':`<option value="" disabled selected>${esc(record.loading?'Loading models…':unavailableModel?'Current model unavailable':'Model unavailable')}</option>`)+models.map(item=>`<option value="${esc(item.value)}" ${item.value===options?.current?.model?'selected':''} ${item.available===false||item.manualSelectionAllowed===false?'disabled':''}>${esc(item.label||item.value)}</option>`).join('');
  const currentLevel=options?.current?.thinkingLevel;
  const reasoningOptions=(levels.some(item=>item.id===currentLevel)?'':`<option value="" disabled selected>${esc(record.loading?'Loading…':'Reasoning unavailable')}</option>`)+levels.map(item=>`<option value="${esc(item.id)}" ${item.id===currentLevel?'selected':''}>${esc(item.label||item.id)}</option>`).join('');
  const lockReason=options?.modelSelectionLocked?'Model selection is locked by OpenClaw for this session.':'Choose this session’s model';
  replaceRegion('composer-attachments',draft.attachments.map(item=>`<span class="composer-attachment" data-attachment-id="${esc(item.id)}" title="${esc(item.name)} · ${Math.ceil(Number(item.sizeBytes||0)/1024)} KB">${icon('file')}<span>${esc(item.name)}</span>${btn('remove-attachment',icon('close'),'icon-btn',`data-attachment="${esc(item.id)}" data-focus="attachment-${esc(item.id)}" aria-label="Remove attachment ${esc(item.name)}" ${frozen||busy?'disabled':''}`)}</span>`).join(''));
  replaceRegion('composer-controls',`<div class="composer-tools">${btn('attach-media',icon('plus'),'icon-btn composer-attach',`id="attach-media" aria-label="Attach media" title="Attach files · up to 4 files, 12 MiB total (images up to 6 MiB each)" ${disabled||draft.attachments.length>=4||!desktop?.pickAttachments?'disabled':''}`)}${btn('permissions',icon('shield'),'icon-btn composer-permissions',`id="composer-permissions" aria-label="Execution permissions" title="Review execution permissions for this conversation" ${!online()||!state.selected?.sessionId||!state.selected?.agentId?'disabled':''}`)}${btn('voice-menu',icon('mic'),'icon-btn composer-voice',`id="composer-voice" aria-label="Voice options" title="Dictate or start a live voice conversation" ${!online()||!state.selected?.sessionId||!state.selected?.agentId||!voiceView?'disabled':''}`)}<label class="sr-only" for="composer-model">Model</label><select id="composer-model" class="composer-select" title="${esc(lockReason)}" ${disabled||record.loading||record.uncertain||options?.modelSelectionLocked||!models.length?'disabled':''}>${modelOptions}</select><label class="sr-only" for="composer-reasoning">Reasoning level</label><select id="composer-reasoning" class="composer-select" title="Reasoning level for this session" ${disabled||record.loading||record.uncertain||!levels.length?'disabled':''}>${reasoningOptions}</select></div><div class="row composer-send">${runIds.length===1?btn('review-stop','Stop response','text-btn',`data-run="${esc(runIds[0])}" ${online()?'':'disabled'}`):''}${btn('send',icon('up')+` ${pending?'Sending…':uncertain?'Retry same message':'Send'}`,'button primary',`${canSend?'':'disabled'} id="send-message" aria-label="${uncertain?'Retry the same message request':'Send message'}"`)}</div>`);
  const note=record.error||((options?.modelSelectionLocked?'Model selection is locked by OpenClaw for this session. ':'' )+(options?.limitations||[]).map(item=>typeof item==='string'?item:item.message||'').filter(Boolean).join(' '));
  replaceRegion('composer-options-error',note?`<p class="composer-option-note ${record.error?'is-error':''}">${esc(note)}${record.error?btn('refresh-composer','Refresh options','text-btn',`${record.loading||busy||!online()?'disabled':''}`):''}</p>`:'');
  let message=!online()?'Disconnected. Your draft stays here until the connection returns.':'';
  if(pending)message='Sending this message to OpenClaw…';
  if(uncertain)message=`Send outcome unconfirmed. ${send.error} Refresh the conversation to check for a response, or retry the same request. Your current draft is preserved.`;
  if(send?.status==='rejected')message=`Message was not sent. ${send.error} Your draft is preserved. Refresh the conversation if its state changed, then send again.`;
  if(send?.status==='accepted')message=send.receipt?.status==='stopped'?'Stop command handled by OpenClaw. Refreshing this conversation.':'Message accepted by OpenClaw. The response will appear when its history updates.';
  replaceRegion('composer-status',message?`<p class="composer-notice ${uncertain||send?.status==='rejected'?'is-error':''}">${esc(message)}${uncertain||send?.status==='rejected'?btn('refresh-history','Refresh conversation','text-btn'):''}</p>`:'');
  renderVoiceStatus();
}
async function sendMessage() {
  if(!state.selected||!online())return;
  const selected={...state.selected},key=identity(selected),draft=draftFor(selected);
  let request=sends.get(key);
  if(request?.status==='sending'||composerRecord(selected).saving||composerRecord(selected).picking||composerRecord(selected).uncertain)return;
  if(request?.status!=='uncertain') {
    if((!draft.text.trim()&&!draft.attachments.length)||!state.history||state.historyLoading)return;
    request={selected,message:draft.text,attachmentIds:draft.attachments.map(item=>item.id),draftRevision:draft.revision,requestId:crypto.randomUUID(),expectedLeafEntryId:state.history.leafEntryId,status:'sending'};
    sends.set(key,request);
  }
  request.status='sending';request.error='';renderComposer();
  try {
    const result=await rpc('send',{...sessionParams(request.selected),message:request.message,requestId:request.requestId,...(request.attachmentIds.length?{attachmentIds:request.attachmentIds}:{}),...(request.expectedLeafEntryId!==undefined?{expectedLeafEntryId:request.expectedLeafEntryId}:{})});
    request.status='accepted';request.receipt=result;request.runId=result.runId;
    const current=draftFor(request.selected);
    current.attachments=current.attachments.filter(item=>!request.attachmentIds.includes(item.id));
    if(current.revision===request.draftRevision&&current.text===request.message){current.text='';current.revision++;if(identity(state.selected)===key&&$('composer-input'))$('composer-input').value='';}
    if(identity(state.selected)===key){loadHistory({latest:true,animate:true});loadPlan();if(state.panel)loadWork();}
    scheduleRead('overview',()=>loadOverview({poll:true}));announce(result.status==='stopped'?'Stop command handled by OpenClaw.':'Message accepted by OpenClaw.');
  }catch(error){request.status=mutationRejected(error)?'rejected':'uncertain';request.error=errorText(error);}
  finally{if(identity(state.selected)===key)renderComposer();}
}
function reviewStop(node) {
  if(!state.selected)return;
  const selected={...state.selected},runId=node.dataset.run;
  showDialog('Stop this response?',`<p>Stop this exact run: <code>${esc(runId)}</code> in ${esc(nameFor(selected.agentId))}’s selected conversation. OpenClaw may also stop work delegated by it.</p><div class="dialog-error" id="mutation-status" role="status"></div><div class="control-actions">${btn('close-dialog','Keep running')}${btn('confirm-stop','Stop this response','button danger')}</div>`);
  state.modal.operation={kind:'stop',selected,runId};
}
async function confirmStop(node) {
  const operation=state.modal?.operation;if(operation?.kind!=='stop'||operation.busy)return;
  operation.busy=true;node.disabled=true;
  try{await rpc('abort',{...sessionParams(operation.selected),runId:operation.runId});if(state.modal?.operation===operation)closeDialog();if(identity(state.selected)===identity(operation.selected))loadHistory({latest:true});announce('Stop requested for this response.');}
  catch(error){if(state.modal?.operation===operation)$('mutation-status').textContent=`${mutationRejected(error)?'Stop was not applied.':'Stop was not confirmed.'} ${errorText(error)} Refresh the conversation before deciding what to do next.`;}
}
function renderPlan() {
  if(!$('plan-region'))return;
  const card=state.plan?.card;
  if(!state.selected){replaceRegion('plan-region','');return;}
  if(!card){replaceRegion('plan-region',`<div class="plan-empty">${esc(state.planError?'Task checklist unavailable. '+state.planError:state.planLoading&&!state.plan?'Reading the task checklist…':'No task checklist supplied for this conversation.')}${state.planError?btn('refresh-plan','Refresh','text-btn'):''}</div>`);return;}
  const steps=Array.isArray(card.steps)?card.steps:[];
  const labels={pending:'Remaining',in_progress:'In progress',completed:'Completed'};
  const current=steps.filter(item=>item.status==='in_progress');
  const currentText=current.length?`Current: ${current[0].step}${current.length>1?` (+${current.length-1} more in progress)`:''}`:'';
  replaceRegion('plan-region',`<details class="source-plan" data-plan-key="${esc(identity(state.selected))}" data-detail="source-plan-${esc(identity(state.selected))}" ${planDisclosure.get(identity(state.selected))===false?'':'open'}><summary><span class="grow"><span>Task checklist</span>${currentText?`<span class="plan-current">${esc(currentText)}</span>`:''}</span><span class="small muted">${steps.length} ${steps.length===1?'item':'items'}</span>${icon('down')}</summary><div class="plan-body"><ol>${steps.map(item=>`<li class="plan-step ${Object.hasOwn(labels,item.status)?esc(item.status):'unknown'}"><span class="plan-marker" aria-hidden="true">${item.status==='completed'?'✓':item.status==='in_progress'?'•':'○'}</span><span class="grow">${linkedText(item.step)}</span><span class="plan-state">${labels[item.status]||'State not supplied'}</span></li>`).join('')}</ol>${card.markdown?`<div class="plan-note">${reportText(card.markdown)}</div>`:''}<p class="limit-note">${card.source==='active-run'?'Current response plan':`Reported by ${esc(nameFor(state.selected.agentId))}`}${card.updatedAt?' · '+esc(stamp(card.updatedAt)):''}</p>${state.planError?failure('Checklist refresh unavailable',state.planError,'refresh-plan'):''}</div></details>`);
}
async function loadPlan({force=false}={}) {
  if(!state.selected)return;
  const selected={...state.selected},key=identity(selected);
  if(state.planReadKey===key&&(state.planLoading||!force&&Date.now()-state.planReadAt<5000))return;
  state.planReadKey=key;
  const generation=++requests.plan;
  state.planLoading=true;state.planError='';renderPlan();
  try{const data=await rpc('plan',sessionParams(selected));if(generation===requests.plan&&key===identity(state.selected))state.plan=data;}
  catch(error){if(generation===requests.plan&&key===identity(state.selected)){state.planError=errorText(error);if(['ACCESS','DENIED','SESSION_CHANGED'].includes(error.code))state.plan=null;}}
  finally{if(generation===requests.plan&&key===identity(state.selected)){state.planLoading=false;state.planReadAt=Date.now();renderPlan();}}
}
const approvalKey = item => JSON.stringify([item.kind,item.id]);
const pendingApprovals = () => state.approvals.filter(item=>item.status==='pending');
function approvalExpired(item) {return Boolean(item.expiresAt&&new Date(item.expiresAt).valueOf()<=Date.now());}
function approvalDetails(item) {
  const detail=value=>linkedText(typeof value==='string'?value:JSON.stringify(value,null,2));
  return `<p>${linkedText(item.description||'No description supplied.')}</p><div class="approval-scope"><strong>Execution scope</strong><dl class="detail-grid"><dt>Host</dt><dd>${item.host!==undefined?detail(item.host):'Not supplied'}</dd>${item.nodeId?`<dt>Node</dt><dd>${detail(item.nodeId)}</dd>`:''}<dt>Scope</dt><dd>${item.scope!==undefined?detail(item.scope):'Not supplied'}</dd>${item.externalResolution!==undefined?`<dt>External resolution</dt><dd>${detail(item.externalResolution)}</dd>`:''}</dl></div>${item.command?`<pre class="approval-command">${linkedText(item.command)}</pre>`:''}<dl class="detail-grid">${item.cwd?`<dt>Directory</dt><dd>${linkedText(item.cwd)}</dd>`:''}<dt>Kind</dt><dd>${esc(item.kind)}</dd>${item.agentId?`<dt>Agent</dt><dd>${esc(nameFor(item.agentId))}</dd>`:''}${item.sessionKey?`<dt>Session</dt><dd>${esc(item.sessionKey)}</dd>`:''}${item.expiresAt?`<dt>Expires</dt><dd>${esc(stamp(item.expiresAt))}</dd>`:''}</dl>${item.reviewDetails?`<details class="approval-review-details"><summary>Full review details</summary><pre class="approval-command">${detail(item.reviewDetails)}</pre></details>`:''}`;
}
function renderApprovals() {
  updateApprovalReview();
  if(state.view!=='Approvals')return;
  const cards=state.approvals.map(item=>{
    const mutation=approvalMutations.get(approvalKey(item)),available=item.status==='pending'&&!approvalExpired(item)&&online()&&Boolean(item.reviewToken)&&!state.approvalsLoading&&!state.approvalsError&&!mutation?.busy&&!mutation?.uncertain;
    return `<article class="card approval-card"><div class="row spread"><h3>${linkedText(item.title||'Approval request')}</h3><span class="pill">${esc(approvalExpired(item)?'Expired':item.status||'Unknown')}</span></div>${approvalDetails(item)}<div class="control-actions">${(item.allowedDecisions||[]).map(decision=>btn('review-approval',esc(decision.label),'button',`data-approval="${esc(approvalKey(item))}" data-decision="${esc(decision.id)}" ${available?'':'disabled'}`)).join('')}</div>${mutation?.error?`<p class="error-note">${esc(mutation.error)} Refresh approvals before deciding again.</p>`:''}</article>`;
  }).join('');
  replaceRegion('page-content',`<div class="page-intro"><div><h2>Approvals</h2><p>Review the exact action and choose a decision supported by OpenClaw.</p></div>${btn('refresh-approvals',state.approvalsLoading?'Refreshing…':'Refresh','button',state.approvalsLoading?'disabled':'')}</div>${state.approvalsError?failure('Approvals could not be refreshed',state.approvalsError,'refresh-approvals'):''}${!online()?'<p class="error-note">Disconnected. Approval decisions are disabled.</p>':''}${cards||`<div class="empty"><h2>${state.approvalsLoading?'Loading approvals…':state.approvalsLoaded?'No approvals returned':'Approvals unavailable'}</h2><p>Only requests returned by your connected gateway appear here.</p></div>`}${limitsHTML(state.approvalLimits)}`);
}
async function loadApprovals({explicit=false}={}) {
  if(state.approvalsLoading){if(explicit)state.approvalsRefreshQueued=true;return;}
  if(!explicit&&Date.now()-(state.approvalsReadAt||0)<10000)return;
  const generation=++requests.approvals;state.approvalsLoading=true;state.approvalsError='';renderApprovals();
  try{
    const data=await rpc('approvals',{});if(generation!==requests.approvals)return;
    state.approvals=Array.isArray(data.items)?data.items:[];state.approvalLimits=data.limitations||[];state.approvalsLoaded=true;state.approvalsReadAt=Date.now();
    if(explicit)for(const [key,mutation] of approvalMutations)if(!mutation.busy)approvalMutations.delete(key);
  }catch(error){if(generation===requests.approvals)state.approvalsError=errorText(error);}
  finally{
    if(generation===requests.approvals){
      state.approvalsLoading=false;
      const queued=state.approvalsRefreshQueued;state.approvalsRefreshQueued=false;
      // An explicit request made during an older read must complete a fresh read.
      // Start it before rendering so cached decision buttons never briefly enable.
      if(queued)loadApprovals({explicit:true});
      renderNavigation();renderApprovals();
    }
  }
}
function updateApprovalReview() {
  const operation=state.modal?.operation;if(operation?.kind!=='approval'||operation.busy)return;
  const node=$('overlay').querySelector('[data-action="confirm-approval"]');if(!node)return;
  const current=state.approvals.find(item=>approvalKey(item)===approvalKey(operation.item));
  const changed=!current||!operation.item.reviewToken||current.reviewToken!==operation.item.reviewToken||current.status!=='pending'||approvalExpired(current);
  if(changed)operation.stale=true;
  node.disabled=Boolean(operation.stale||state.approvalsLoading||state.approvalsError||!online());
  $('mutation-status').textContent=operation.stale?'This approval changed or is no longer pending. Close this review and review the latest request.':state.approvalsLoading?'Refreshing approval details before a decision can be submitted…':state.approvalsError?'Approval details could not be refreshed. Close this review and refresh approvals.':!online()?'Disconnected. Reconnect and review this request before deciding.':'';
}

function reviewApproval(node) {
  const item=state.approvals.find(item=>approvalKey(item)===node.dataset.approval),decision=item?.allowedDecisions?.find(decision=>decision.id===node.dataset.decision);
  if(!item||!decision||!item.reviewToken||state.approvalsLoading||state.approvalsError||item.status!=='pending'||approvalExpired(item)||!online())return;
  showDialog('Review approval decision',`<h3>${esc(item.title||'Approval request')}</h3>${approvalDetails(item)}<p><strong>Your decision: ${esc(decision.label)}</strong></p><p>This decision applies to this exact request. Existing OpenClaw permissions remain in force.</p><div class="dialog-error" id="mutation-status" role="status"></div><div class="control-actions">${btn('close-dialog','Cancel')}${btn('confirm-approval',esc(decision.label),'button primary')}</div>`);
  state.modal.operation={kind:'approval',item:{...item},decision:{...decision}};updateApprovalReview();
}
async function confirmApproval(node) {
  const operation=state.modal?.operation;if(operation?.kind!=='approval'||operation.busy||operation.stale||state.approvalsLoading||state.approvalsError||!online())return;
  const item=state.approvals.find(item=>approvalKey(item)===approvalKey(operation.item));
  if(!item||!operation.item.reviewToken||item.reviewToken!==operation.item.reviewToken||item.status!=='pending'||approvalExpired(item)||!item.allowedDecisions?.some(decision=>decision.id===operation.decision.id)){$('mutation-status').textContent='This request is no longer available for that decision. Refresh approvals.';node.disabled=true;return;}
  operation.busy=true;node.disabled=true;const mutation={busy:true};approvalMutations.set(approvalKey(item),mutation);renderApprovals();
  try{const result=await rpc('resolveApproval',{id:operation.item.id,kind:operation.item.kind,decision:operation.decision.id,reviewToken:operation.item.reviewToken});if(!result.applied&&!['allowed','denied','expired'].includes(result.approval?.status))throw new Error('OpenClaw did not confirm the recorded decision.');if(result.approval)state.approvals=state.approvals.map(record=>approvalKey(record)===approvalKey(item)?result.approval:record);approvalMutations.delete(approvalKey(item));if(state.modal?.operation===operation)closeDialog();loadApprovals({explicit:true});const message=result.applied?'Approval decision applied.':`Request already resolved: ${result.approval.status}.`;toast(message);announce(message);}
  catch(error){mutation.uncertain=true;mutation.error=`${mutationRejected(error)?'Decision was not applied.':'Decision outcome unconfirmed.'} ${errorText(error)}`;if(state.modal?.operation===operation)$('mutation-status').textContent=mutation.error+' Close this review and refresh approvals before deciding again.';}
  finally{mutation.busy=false;renderApprovals();}
}
function renderSettings() {
  if(state.view!=='Settings')return;
  const settings=state.settings;
  if(!$('settings-editor'))$('page-content').innerHTML=`<div class="page-intro"><div><h2>Settings</h2><p>Your desktop appearance and existing OpenClaw configuration.</p></div></div><section class="card"><h3>Appearance</h3><div class="control-actions">${btn('appearance-light','Light','button','data-focus="appearance-light"')}${btn('appearance-dark','Dark','button','data-focus="appearance-dark"')}</div></section><details class="card settings-advanced"><summary>Advanced OpenClaw configuration</summary><p>Load the current redacted JSON to edit supported configuration. Review your changes before saving. OpenClaw validates the configuration and may restart the gateway when it is applied.</p><div id="settings-load-controls"></div><label class="modal-label" for="settings-editor">OpenClaw configuration JSON</label><textarea id="settings-editor" class="settings-editor" rows="18" spellcheck="false" autocomplete="off" aria-describedby="settings-status"></textarea><div id="settings-status" role="status"></div><div id="settings-save-controls"></div><div id="settings-limits"></div></details><section class="card"><h3>More capabilities</h3><p>Use the original interface for capabilities that are not available here, including workspace management, integrations, devices and recovery.</p>${btn('original','Open original OpenClaw ↗')}</section>`;
  const editor=$('settings-editor');if(editor.value!==settings.raw&&document.activeElement!==editor)editor.value=settings.raw;editor.disabled=!settings.loaded||settings.loading||settings.saving;
  replaceRegion('settings-load-controls',btn('load-settings',settings.loading?'Loading…':settings.loaded?'Reload configuration':'Load configuration','button',settings.loading||settings.saving?'disabled':''));
  const status=settings.error||(!settings.loaded?'Configuration is not loaded.':settings.dirty?'Unsaved changes.':settings.notice||'Loaded configuration.');
  replaceRegion('settings-status',`<p class="${settings.error?'error-note':'region-note'}">${esc(status)}</p>`);
  replaceRegion('settings-save-controls',settings.loaded?`<div class="control-actions">${btn('review-settings',settings.saving?'Saving…':'Review changes','button primary',!settings.dirty||settings.saving||settings.uncertain||settings.valid===false||!online()?'disabled':'')}${settings.valid===false?'<span class="small muted">The current source configuration is invalid. Repair it in the original interface, then reload.</span>':settings.uncertain?'<span class="small muted">Reload before another save.</span>':''}</div>`:'');
  replaceRegion('settings-limits',limitsHTML(settings.limits));
  document.querySelectorAll('[data-action^="appearance-"]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.action===`appearance-${state.theme}`)));
}
function requestSettingsLoad() {
  if(state.settings.loading||state.settings.saving)return;
  if(state.settings.dirty){showDialog('Reload configuration?',`<p>Your unsaved edits will be discarded when the current configuration loads successfully. Keep this editor open to preserve them.</p><div class="control-actions">${btn('close-dialog','Keep editing')}${btn('confirm-load-settings','Discard edits and reload','button')}</div>`);return;}
  loadSettings();
}
async function loadSettings() {
  const generation=++requests.settings,settings=state.settings;settings.loading=true;settings.error='';renderSettings();
  try{const data=await rpc('settings',{});if(generation!==requests.settings)return;Object.assign(settings,{loaded:true,baseHash:data.baseHash,raw:String(data.raw??''),sourceRaw:String(data.raw??''),dirty:false,uncertain:false,valid:data.valid,limits:data.limitations||[],notice:data.valid===false?'OpenClaw reports that this configuration is invalid. Review it carefully.':'Loaded configuration.'});if($('settings-editor'))$('settings-editor').value=settings.raw;}
  catch(error){if(generation===requests.settings)settings.error=errorText(error);}
  finally{if(generation===requests.settings){settings.loading=false;renderSettings();}}
}
function reviewSettings() {
  const settings=state.settings;if(!settings.loaded||!settings.dirty||settings.saving||settings.uncertain||settings.valid===false||!online())return;
  try{const parsed=JSON.parse(settings.raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('The configuration must be a JSON object.');}catch(error){settings.error=`Cannot save this JSON: ${errorText(error)}`;renderSettings();return;}
  showDialog('Review configuration changes',`<p>Save these changes to your existing OpenClaw configuration. <strong>Applying configuration may restart the gateway and interrupt active work.</strong> The source version must still match the configuration you loaded.</p><details><summary>Previously loaded configuration</summary><pre class="configuration-review">${esc(settings.sourceRaw)}</pre></details><details open><summary>Configuration to save</summary><pre class="configuration-review">${esc(settings.raw)}</pre></details><div class="dialog-error" id="mutation-status" role="status"></div><div class="control-actions">${btn('close-dialog','Keep editing')}${btn('confirm-save-settings','Save configuration','button primary')}</div>`);
  state.modal.operation={kind:'settings',baseHash:settings.baseHash,raw:settings.raw};
}
async function saveSettings(node) {
  const operation=state.modal?.operation,settings=state.settings;if(operation?.kind!=='settings'||operation.busy||!online())return;
  operation.busy=true;settings.saving=true;node.disabled=true;renderSettings();
  try{const result=await rpc('saveSettings',{baseHash:operation.baseHash,raw:operation.raw});if(!result.saved)throw new Error(result.message||'OpenClaw did not confirm that the configuration was saved.');settings.dirty=false;settings.uncertain=true;settings.error='';settings.notice=(result.message||'Configuration saved.')+' Reload before making further changes.';if(state.modal?.operation===operation)closeDialog();announce('Configuration saved.');}
  catch(error){const rejected=mutationRejected(error);settings.uncertain=!rejected||['CONFLICT','STALE','SESSION_CHANGED','ACCESS','DENIED'].includes(error.code);settings.error=`${rejected?'Configuration was not saved.':'Save outcome unconfirmed.'} ${errorText(error)} Your edits are preserved.${settings.uncertain?' Reload the configuration before attempting another save.':''}`;if(state.modal?.operation===operation)$('mutation-status').textContent=settings.error;}
  finally{settings.saving=false;renderSettings();}
}


// Presentation and bounded UI pagination only; activity interpretation lives in the shared model.
// Current response facts are independent of tool-purpose classification and transcript pagination.
function selectedRunStatus() {
  if(!state.selected)return null;
  const key=identity(state.selected),record=activityRecords.get(key);
  const activity=record?.view?.runStatus;
  const history=state.history?.runStatus;
  const candidates=[history?{...history,...(state.historyError?{freshUntil:0}:{})}:null,activity?{...activity,...(record.error?{freshUntil:0}:{})}:null]
    .filter(status=>status?.context&&identity(status.context)===key&&Number.isFinite(status.observedAt));
  candidates.sort((a,b)=>b.observedAt-a.observedAt);
  return candidates.length?viewRunStatus(candidates[0],Date.now(),online()):null;
}
function runDuration(milliseconds) {
  const seconds=Math.max(0,Math.floor(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);
  return hours?`${hours}h ${minutes}m ${seconds%60}s`:minutes?`${minutes}m ${seconds%60}s`:`${seconds}s`;
}
function renderRunStatus() {
  if(!$('run-status'))return;
  const status=selectedRunStatus();
  const existing=$('run-status').querySelector('.run-status-bar');
  // Selection can defer text replacement, but an expired observation must stop animating now.
  if(existing&&!status?.active)existing.classList.remove('is-active');
  if(!status||status.state==='idle'||status.lastKnownState==='idle'){replaceRegion('run-status','');return;}
  const label=!online()?'Disconnected':status.stale?'Status stale':status.active?'Active':'Run status unavailable';
  const tokens=Number.isSafeInteger(status.outputTokens)&&status.outputTokens>=0&&!status.usageUnavailable?status.outputTokens:null;
  const count=tokens===null?'Tokens unavailable':`${new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(tokens)} output tokens`;
  const elapsed=Number.isFinite(status.elapsedMs)?`<span data-run-metric="elapsed">${esc(runDuration(status.elapsedMs))}</span>`:'';
  const tool=status.tool,title=typeof tool?.title==='string'?tool.title:typeof tool?.name==='string'?tool.name:'';
  const details=title?`<details class="run-current-tool" data-detail="run-tool-${esc(status.runId||'unknown')}"><summary data-focus="run-tool-${esc(status.runId||'unknown')}"><span>${esc(title)}</span><span class="run-tool-disclosure">Details</span></summary><pre>${esc(title)}</pre>${tool.status?`<span class="small muted">${esc(tool.status)}</span>`:''}</details>`:'';
  replaceRegion('run-status',`<div class="run-status-bar${status.active?' is-active':''}" data-run-id="${esc(status.runId||'')}" data-run-state="${esc(status.state)}" data-stale="${Boolean(status.stale)}"><div class="run-status-summary"><span class="run-status-phase"><i class="run-status-dot" aria-hidden="true"></i>${esc(label)}</span><span data-run-metric="tokens" ${tokens===null?'':`title="${esc(tokens.toLocaleString())} output tokens reported by OpenClaw"`}>${esc(count)}</span>${elapsed}</div>${details}${status.detail&&!status.active?`<p class="run-status-note">${esc(status.detail)}</p>`:''}</div>`);
}
const unknownActivity=()=>({state:'unknown',label:'Unknown',detail:'Activity has not been verified.',working:false,executionActive:false,current:[],blockers:[],recovery:'Unverified'});
function activityRecord(context) {
  if(!context?.key)return null;
  const key=identity(context);
  if(!activityRecords.has(key))activityRecords.set(key,{context:{...context},view:null,items:[],shown:3,cursor:null,loading:false,error:'',readAt:0,generation:0,pages:0});
  return activityRecords.get(key);
}
function observedActivity(record) {return record?.view?viewAtTime(record.error?{...record.view,freshUntil:0}:record.view,Date.now(),online()):null;}
function agentActivity(agentId) {
  const selected=state.selected?.agentId===agentId?observedActivity(activityRecords.get(identity(state.selected))):null;
  const selectedAgent=selected?.agents?.find(agent=>agent.agentId===agentId);if(selectedAgent)return selectedAgent;
  const roster=activityRoster?viewAtTime(activityRoster,Date.now(),online()):null;
  return roster?.agents?.find(agent=>agent.agentId===agentId)||(selected?.summary?.agentId===agentId?selected.summary:unknownActivity());
}
function activityPresentation(summary=unknownActivity()) {
  const labels={active:'Active',working:'Working',scheduled:summary.nextScheduled?'Scheduled':'Idle',completed:'Completed',paused:'Paused',blocked:'Blocked',unknown:'Unknown'};
  const status=!online()?'disconnected':Object.hasOwn(labels,summary.state)?summary.state:'unknown';
  const label=status==='disconnected'?'Disconnected':labels[status];
  let explanation=status==='disconnected'?'Live telemetry is unavailable.':summary.lastKnownState?'Current activity could not be verified; the last observation is stale.':summary.detail||'There is not enough evidence to establish current activity.';
  if(status==='working'&&summary.teamWorking){const agents=[...new Set((summary.current||[]).filter(item=>item.agentId&&!item.unverified&&['engineering','research'].includes(item.classification)).map(item=>nameFor(item.agentId)))];if(agents.length)explanation=`Confirmed work by ${agents.join(', ')}.`;}
  if(summary.nextScheduled)explanation+=` ${status==='disconnected'||summary.lastKnownState?'Last reported next run':'Next run'}: ${summary.nextScheduled.name||summary.nextScheduled.jobId} · ${stamp(summary.nextScheduled.at)}.`;
  return {status,label,explanation,active:online()&&(status==='working'&&summary.working===true||status==='active'&&summary.executionActive===true)};
}
function activityBadge(summary=unknownActivity(),tooltip) {
  const {status,label,explanation,active}=activityPresentation(summary);
  return `<span class="activity-badge state-${status}${active?(status==='active'?' is-active':' is-working'):''}" data-activity-state="${status}" title="${esc(tooltip||explanation)}"><span class="activity-mark" aria-hidden="true"></span><span>${esc(label)}</span></span>`;
}
function activityHeaderHTML() {
  const view=state.selected?observedActivity(activityRecords.get(identity(state.selected))):null;
  let summary=view?.summary||unknownActivity();
  const run=selectedRunStatus();
  if(run?.active&&(!view||run.observedAt>=view.observedAt)&&!['blocked','working'].includes(summary.state))summary={...summary,state:'active',executionActive:true,detail:'OpenClaw reports an active response in this exact conversation. Its work type may not be classified.'};
  const presentation=activityPresentation(summary);
  const tooltip=`Selected conversation${state.selected?' · '+nameFor(state.selected.agentId)+': '+(state.selected.title||'Untitled conversation'):''}. ${presentation.explanation}`;
  return btn('activity-open',activityBadge(summary,tooltip),'activity-header-button',`data-focus="activity-header" aria-label="${esc(state.selected?nameFor(state.selected.agentId)+' activity: ':'Activity: ')}${esc(presentation.label)}" title="${esc(tooltip)}"`);
}
function renderActivityIndicators() {
  if($('activity-header'))replaceRegion('activity-header',activityHeaderHTML());
  for(const node of document.querySelectorAll('[data-activity-agent]')){const html=activityBadge(agentActivity(node.dataset.activityAgent));if(node.innerHTML!==html)node.innerHTML=html;}
}
function ensureActivitySlots() {
  const scroll=$('work-scroll');if(!scroll)return;
  if(!$('activity-current')){const node=document.createElement('section');node.id='activity-current';node.className='activity-current';node.setAttribute('aria-label','Current agent activity');scroll.prepend(node);}
  if(!$('activity-timeline')){const node=document.createElement('section');node.id='activity-timeline';node.className='activity-timeline';node.setAttribute('aria-label','Agent activity timeline');scroll.insertBefore(node,$('work-content'));}
  if(!$('activity-facts')){const node=document.createElement('section');node.id='activity-facts';node.className='activity-facts';node.setAttribute('aria-label','Work summary and evidence');scroll.insertBefore(node,$('work-content'));}
}
function syncActivityPanel() {
  ensureActivitySlots();const hidden=state.panelTab!=='work'||Boolean(state.processId);
  $('activity-current').hidden=hidden;$('activity-timeline').hidden=hidden;$('activity-facts').hidden=hidden;
  const context=state.workContext||state.selected,key=identity(context);
  if($('activity-current').dataset.context!==key){$('activity-current').dataset.context=key;renderActivityCurrent();renderActivityTimeline();}
}
function eventText(event,includeResult=false) {return event?`${event.description||event.type||'Reported event'}${includeResult&&event.result?' · '+(typeof event.result==='string'?event.result:JSON.stringify(event.result)):''}${event.timestamp?' · '+stamp(event.timestamp):''}`:'Not reported';}
function elapsedActivity(startedAt) {const started=Number(startedAt);if(!Number.isFinite(started)||started<=0||started>Date.now())return '';const seconds=Math.floor((Date.now()-started)/1000);return seconds<60?`${seconds}s elapsed`:`${Math.floor(seconds/60)}m ${seconds%60}s elapsed`;}
function activityType(value) {return String(value||'event').replace(/[_-]+/g,' ');}
function activityAttention(view,summary,blockers) {
  if(!view||view.stale||!online()||summary.state==='unknown')return {text:'Attention status unknown.',approval:false};
  if(blockers.some(item=>item.kind==='authorization'))return {text:'Approval requested.',approval:true};
  if(blockers.some(item=>item.kind==='technical'))return {text:'Technical issue — no approval request confirmed.',approval:false};
  return {text:blockers.length?'Attention status unknown.':'No approval request reported.',approval:false};
}
function activityBrief(summary,view) {
  if(!online())return 'Live activity is unavailable until the connection returns.';
  if(view?.stale)return 'Current work could not be verified. Showing the last observation.';
  const descriptions={active:summary.detail||'OpenClaw confirms active execution. Its work type has not been classified.',working:summary.teamWorking?'Confirmed work is running in this agent’s team.':'Confirmed work is running.',scheduled:summary.nextScheduled?'The next automation is scheduled.':'No current work is reported in this conversation.',completed:'An execution finished. Project completion is not verified.',paused:'A pause or stop is recorded.',blocked:summary.working?'An issue is blocking some work. Other confirmed work is still running.':'An issue is preventing some work from progressing.',unknown:summary.detail||'Current work could not be verified.'};
  return descriptions[summary.state]||descriptions.unknown;
}
function renderActivityCurrent() {
  if(!$('activity-current'))return;
  const context=state.workContext||state.selected,record=context?activityRecords.get(identity(context)):null;
  const view=observedActivity(record),summary=view?.summary||unknownActivity();
  const current=Array.isArray(summary.current)?summary.current:[],blockers=Array.isArray(summary.blockers)?summary.blockers:[];
  const kind={authorization:!online()||view?.stale?'Last reported approval':'Approval needed',technical:'Technical issue',recorded:'Reported blocker',unknown:'Unverified issue'};
  const attention=activityAttention(view,summary,blockers);
  let html=`<div class="row spread"><h3 class="activity-heading">${esc(context?nameFor(context.agentId)+' · Activity':'Activity')}</h3>${btn('refresh-activity',icon('clock'),'icon-btn',`aria-label="Refresh activity" data-focus="refresh-activity" aria-busy="${Boolean(record?.loading)}" aria-disabled="${Boolean(record?.loading)}" ${!context?'disabled':''}`)}</div>${activityBadge(summary)}<p class="activity-detail">${esc(activityBrief(summary,view))}</p>`;
  if(record?.loading&&!record.view)html+='<p class="panel-note">Checking current activity…</p>';
  if(record?.error)html+=failure('Activity update unavailable',record.error,'refresh-activity');
  if(current.length)html+='<ul class="activity-current-list">'+current.slice(0,2).map(item=>`<li><strong>${linkedText(item.title||'Observed task')}</strong><span>${item.unverified?'Last observed · ':''}${esc(nameFor(item.agentId))}${!view?.stale&&!item.unverified&&item.startedAt?' · '+esc(elapsedActivity(item.startedAt)):''}</span></li>`).join('')+'</ul>';
  if(blockers.length)html+='<div class="activity-blockers">'+blockers.slice(0,2).map(item=>`<div><strong>${esc(kind[item.kind]||'Unverified issue')}</strong><p>${linkedText(item.reason||'No reason was reported.')}</p></div>`).join('')+'</div>';
  html+=`<p class="activity-attention">${esc(attention.text)}${attention.approval?' '+btn('view','Review approvals','text-btn',`data-view="Approvals" data-focus="activity-approvals"`):''}</p><p class="activity-next"><span>${!online()||view?.stale?'Last reported next run':'Next run'}</span> ${summary.nextScheduled?linkedText(`${summary.nextScheduled.name||summary.nextScheduled.jobId} · ${stamp(summary.nextScheduled.at)}`):'No schedule reported.'}</p><p class="activity-coverage">${view?`Last update ${esc(stamp(view.observedAt))}${!online()?' · Disconnected':view.stale?' · Stale':''}`:'No successful activity update yet.'}</p>`;
  replaceRegion('activity-current',html);
  if(!$('activity-facts'))return;
  let facts=`<dl class="detail-grid activity-summary-facts"><dt>Last engineering</dt><dd>${linkedText(eventText(summary.lastEngineering))}</dd><dt>Last completed</dt><dd>${linkedText(eventText(summary.lastCompleted,true))}</dd></dl><p class="activity-coverage">${!summary.recovery||summary.recovery==='Unverified'?'Recovery status unknown.':'Recovery: '+esc(summary.recovery)}</p>`;
  if(view?.project&&view.project.available!==false&&view.project.currentBlocker==='unselected')facts+='<p class="activity-project-gap">Project work status could not be verified.</p>';
  facts+=`<details class="activity-details" data-detail="activity-technical-${esc(identity(context))}"><summary>Execution details</summary><p class="panel-note">${linkedText(summary.detail||'No current execution evidence was supplied.')}</p>${summary.scope?`<p class="panel-note">Scope: ${linkedText(summary.scope)}</p>`:''}${current.map(item=>`<dl class="detail-grid"><dt>Agent</dt><dd>${esc(nameFor(item.agentId))}</dd><dt>Task</dt><dd>${linkedText(item.title||'Observed task')}</dd><dt>Run</dt><dd>${linkedText(item.runId||item.id||'Not supplied')}</dd><dt>Started</dt><dd>${esc(item.startedAt?stamp(item.startedAt):'Not reported')}</dd><dt>Evidence type</dt><dd>${esc(item.classification||'unknown')}</dd></dl>`).join('')}${blockers.map(item=>`<p class="panel-note">${linkedText(item.reason||'No blocker reason supplied.')} ${item.nextStep?'Next step: '+linkedText(item.nextStep)+' ':''}Source: ${linkedText(item.source||'Not supplied')}${item.at?' · '+esc(stamp(item.at)):''}</p>`).join('')}<p class="panel-note">Last status report: ${linkedText(eventText(summary.lastStatus))}</p></details>`;
  if(view?.project){const project=view.project;facts+=`<details class="activity-details" data-detail="activity-project-${esc(identity(context))}"><summary>Latest project update</summary><p class="panel-note">${linkedText(project.sourcePath||'Source path unavailable')}${project.updatedAt?' · '+esc(stamp(project.updatedAt)):''}</p><dl class="detail-grid">${(project.fields||[]).map(field=>`<dt>${esc(field.path)}</dt><dd>${linkedText(typeof field.value==='string'?field.value:JSON.stringify(field.value))}</dd>`).join('')}</dl><p class="panel-note">This project record is separate from the selected conversation. Its current work status has not been verified.</p>${limitsHTML(project.limitations)}</details>`;}
  facts+=`<details class="activity-details" data-detail="activity-sources-${esc(identity(context))}"><summary>Coverage and sources</summary><p class="panel-note">These observations cover the supplied records. Status reports do not establish engineering progress, and missing records do not prove idle.</p>${limitsHTML(view?.limitations)}</details>`;
  replaceRegion('activity-facts',facts);
}
function timelineTime(value) {if(!value)return 'Time not reported';const date=new Date(value);return Number.isNaN(date.valueOf())?'Time not reported':date.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'});}
function renderActivityTimeline() {
  if(!$('activity-timeline'))return;
  const context=state.workContext||state.selected,record=context?activityRecords.get(identity(context)):null;
  const items=record?.items||[],visible=items.slice(0,record?.shown||3);
  const more=record&&(record.shown<items.length||(items.length<500&&record.cursor));
  let html='<h3 class="work-section-title">Recent Activity</h3>';
  html+=visible.length?`<ol class="activity-events">${visible.map(item=>{
    const result=item.result?typeof item.result==='string'?item.result:JSON.stringify(item.result):item.outcome?activityType(item.outcome):'Outcome not reported';
    const compact=result.length>130?result.slice(0,127)+'…':result;
    return `<li data-activity-event="${esc(item.id)}"><div class="row spread"><span class="activity-event-kind">${esc(({status:'Status only',research:'Research / review',engineering:'Engineering'}[item.classification]||activityType(item.type)))}</span><time>${esc(timelineTime(item.timestamp))}</time></div><strong>${linkedText(item.description||'Reported activity')}</strong><p class="activity-event-outcome">${item.agentId?`<span>${esc(nameFor(item.agentId))}</span> · `:''}${linkedText(compact)}</p><details data-detail="activity-event-${esc(item.id)}"><summary>Details</summary><div class="activity-event-result">${linkedText(result)}</div><span class="activity-event-source">${linkedText(item.source||'Source not supplied')}</span></details></li>`;
  }).join('')}</ol>`:`<p class="panel-note">${record?.loading&&!record.view?'Loading recent activity…':record?.view?'No recent events were returned.':'No activity timeline has been received yet.'}</p>`;
  if(more)html+=btn('more-activity',record.loading?'Loading…':'Show older activity','button activity-more',`data-focus="more-activity" ${record.loading?'disabled':''}`);
  if(items.length>=500)html+='<p class="panel-note">This view retains at most 500 events.</p>';
  replaceRegion('activity-timeline',html);
}
function scheduleActivityFreshness() {
  clearTimeout(activityFreshnessTimer);
  const now=Date.now(),status=selectedRunStatus(),deadlines=[...activityRecords.values()].map(record=>Number(record.view?.freshUntil)).filter(value=>Number.isFinite(value)&&value>now);
  if(status?.freshUntil>now)deadlines.push(status.freshUntil);
  const expiresAt=deadlines.length?Math.min(...deadlines):Infinity;
  // The one-second clock repaints only this small status region; it never performs a read.
  if(status?.active&&state.view==='Conversations'&&!document.hidden)deadlines.push(now+1000);
  if(deadlines.length)activityFreshnessTimer=setTimeout(()=>{if(Date.now()>=expiresAt){renderActivityIndicators();renderActivityCurrent();}renderRunStatus();scheduleActivityFreshness();},Math.max(1,Math.min(...deadlines)-now+1));
}
async function loadActivity(context,{force=false,more=false}={}) {
  const record=activityRecord(context);if(!record||record.loading)return;
  if(!force&&!more&&record.readAt&&Date.now()-record.readAt<14000)return;
  if(more&&!record.cursor)return;
  const key=identity(context),generation=++record.generation,cursor=more?record.cursor:undefined;
  record.loading=true;record.readAt=Date.now();
  renderActivityIndicators();if(identity(state.workContext||state.selected)===key){renderActivityCurrent();if(more)renderActivityTimeline();}
  try{
    const data=await rpc('activity',{...sessionParams(record.context),...(cursor?{cursor}:{})});
    if(generation!==record.generation)return;
    if(data.context&&identity(data.context)!==key)throw new Error('Activity belongs to a different session. Refresh this exact conversation.');
    const incoming=Array.isArray(data.timeline?.items)?data.timeline.items:[];
    record.items=mergeTimeline(record.items,incoming);
    record.cursor=data.timeline?.nextCursor||null;record.error='';
    record.pages=more?record.pages+1:Math.max(1,record.pages);
    if(more)record.shown=Math.min(record.shown+10,record.items.length);
    record.view=data;
    if(!activityRoster||Number(data.observedAt)>=Number(activityRoster.observedAt))activityRoster=data;
    while(activityRecords.size>100){const candidate=[...activityRecords].find(([id,item])=>id!==identity(state.selected)&&id!==identity(state.workContext)&&!item.loading);if(!candidate)break;activityRecords.delete(candidate[0]);}
  }catch(error){if(generation===record.generation){record.error=errorText(error);if(['ACCESS','DENIED','SESSION_CHANGED'].includes(error.code)){record.view=null;record.items=[];record.cursor=null;}}}
  finally{if(generation===record.generation){record.loading=false;renderActivityIndicators();renderRunStatus();if(identity(state.workContext||state.selected)===key){renderActivityCurrent();renderActivityTimeline();}scheduleActivityFreshness();}}
}
function loadActivityForContexts() {
  const contexts=[state.selected,...(state.panel?[state.workContext]:[])].filter(Boolean);
  for(const context of new Map(contexts.map(item=>[identity(item),item])).values())loadActivity(context);
}
function moreActivity() {
  const context=state.workContext||state.selected,record=context?activityRecords.get(identity(context)):null;if(!record||record.loading)return;
  if(record.shown<record.items.length){record.shown=Math.min(record.shown+10,record.items.length);renderActivityTimeline();}
  else if(record.items.length<500&&record.cursor)loadActivity(context,{more:true});
}

document.addEventListener('click',event=>{const node=event.target.closest('[data-action]');if(node&&!node.disabled){event.preventDefault();handleAction(node);}else if(event.target.classList.contains('backdrop'))closeDialog();});
document.addEventListener('input',event=>{
  if(event.target.matches('[data-async-other]')){updateAsyncReplyInput(event.target);return;}
  if(event.target.id==='session-search'){state.query=event.target.value;requests.overview++;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadOverview(),300);}
  if(event.target.id==='palette-search')renderPalette(event.target.value);
  if(event.target.id==='composer-input'){const draft=draftFor();draft.text=event.target.value;draft.revision++;renderComposer();}
  if(event.target.id==='settings-editor'){state.settings.raw=event.target.value;state.settings.dirty=event.target.value!==state.settings.sourceRaw;state.settings.error='';renderSettings();}
});
document.addEventListener('change',event=>{if(event.target.name==='permission-mode'||event.target.id==='permission-full-confirm'){const operation=state.modal?.operation;if(!permissionContextCurrent(operation)||operation.loading||operation.busy)return;if(event.target.id==='permission-full-confirm')operation.fullConfirmed=event.target.checked;else{const choice=operation.options?.choices.find(item=>permissionToken(item.value)===event.target.value);if(!choice)return;operation.selected=choice.value;operation.fullConfirmed=false;operation.notice='';}renderPermissionDialog();return;}if(event.target.matches('[data-async-choice]')){updateAsyncReplyInput(event.target);return;}if(event.target.id==='composer-model')changeComposerSetting('model',event.target.value);if(event.target.id==='composer-reasoning')changeComposerSetting('thinkingLevel',event.target.value);});
document.addEventListener('toggle',event=>{if(event.target.matches?.('.source-plan[data-plan-key]'))planDisclosure.set(event.target.dataset.planKey,event.target.open);},true);
function interruptTranscript(event) {
  const el=event.target.closest?.('#transcript');if(!el)return;
  cancelTranscriptMotion();
  if(!event.target.closest?.('button,a,summary'))transcriptScrollPause={el,lowest:el.scrollTop};
}
for(const event of ['wheel','touchstart','pointerdown'])document.addEventListener(event,interruptTranscript,{passive:true});
document.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))interruptTranscript(event);});
document.addEventListener('scroll',event=>{
  const pause=transcriptScrollPause,el=event.target;if(!pause||pause.el!==el)return;
  pause.lowest=Math.min(pause.lowest,el.scrollTop);
  if(el.scrollHeight-el.clientHeight-el.scrollTop<2&&el.scrollTop>pause.lowest+1)transcriptScrollPause=null;
},true);
document.addEventListener('selectionchange',()=>{if(getSelection()?.isCollapsed)for(const [id,html]of [...pendingRegions]){if(id==='messages'){pendingRegions.delete(id);renderHistory();}else replaceRegion(id,html);}});
document.addEventListener('keydown',event=>{
  if(event.isComposing||event.target.closest?.('#terminal-mount'))return;
  if(event.target.id==='composer-input'&&event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();sendMessage();return;}
  if(event.key==='Escape'){event.preventDefault();if(state.modal)closeDialog();else if(state.processId&&state.view!=='Models'){state.processId=null;renderWork();}else if(state.panel&&state.view!=='Models'&&viewWidth()<1280)toggleWork(false);else if(state.navOpen){state.navOpen=false;layout();}else if(state.stack.length)back();return;}
  const dialog=state.modal ? $('overlay').querySelector('[role="dialog"]') : state.panel&&state.view!=='Models'&&viewWidth()<1280 ? $('work-panel') : null;
  if(event.key==='Tab'&&dialog){const focusables=[...dialog.querySelectorAll('button:not([disabled]),input,select,textarea,a[href]')].filter(node=>!node.hidden);const first=focusables[0],last=focusables.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  if(state.modal?.search&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const list=[...$('palette-results').querySelectorAll('button')];const index=list.indexOf(document.activeElement);list[(index+(event.key==='ArrowDown'?1:-1)+list.length)%list.length]?.focus();}
  if(state.modal?.search&&event.key==='Enter'&&event.target.id==='palette-search'){event.preventDefault();$('palette-results').querySelector('button')?.click();}
  if(!desktop?.isDesktop&&(event.metaKey||event.ctrlKey)){const key=event.key.toLowerCase();const command=key==='k'?'quick-open':key==='n'?'new':key==='b'?'toggle-navigation':key===','?'settings':event.altKey&&key==='i'?'toggle-work':/^[1-5]$/.test(key)?'view:'+['Conversations','Agents','Projects','Activity','Automations'][+key-1]:null;if(command){event.preventDefault();runCommand(command);}}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopVoice();renderRunStatus();scheduleActivityFreshness();});
addEventListener('pagehide',()=>{readAloud?.stop();stopVoice();});
addEventListener('beforeunload',()=>{readAloud?.stop();voiceView?.destroy();modelsView?.destroy();});
addEventListener('resize',()=>{scheduleRead('layout',()=>{layout();if(state.panel&&state.view!=='Models'&&viewWidth()<1280&&!state.modal&&!$('work-panel').contains(document.activeElement))$('close-work').focus({preventScroll:true});});});
function beforeTerminalLayout() {
  const el=$('transcript'),snapshot=transcriptSnapshot();cancelTranscriptMotion();
  return el&&snapshot?{el,snapshot,key:identity(state.selected)}:null;
}
function afterTerminalLayout(saved) {
  if(!saved||saved.el!==$('transcript')||saved.key!==identity(state.selected))return;
  const {el,snapshot}=saved;
  if(snapshot.nearBottom&&!transcriptScrollPause)el.scrollTop=el.scrollHeight;
  else{const anchor=[...el.querySelectorAll('[data-message-id]')].find(node=>node.dataset.messageId===snapshot.anchor);if(anchor)el.scrollTop+=anchor.getBoundingClientRect().top-el.getBoundingClientRect().top-snapshot.anchorTop;else el.scrollTop=snapshot.scroll;}
}
function appendTerminalSelection(context,selection,snapshot) {
  const draft=draftFor(context),runs=selection.match(/`+/g)||[],fence='`'.repeat(Math.max(3,...runs.map(run=>run.length+1)));
  const heading=['Terminal output',snapshot.cwd?`Terminal opened in: ${snapshot.cwd}`:''].filter(Boolean).join('\n');
  const reply=`${heading}\n\n${fence}text\n${selection}\n${fence}`;
  draft.text=draft.text?draft.text+'\n\n'+reply:reply;draft.revision++;
  if(identity(context)===identity(state.selected)){if(state.view!=='Conversations')openView('Conversations');if($('composer-input'))$('composer-input').value=draft.text;renderComposer();$('composer-input')?.focus();}
  toast(`Selected terminal output added to ${nameFor(context.agentId)}’s draft. Review it and send when ready.`);
}
readAloud=createReadAloud({rpc,onChange:()=>syncReadAloudButtons(),onError:error=>{toast(errorText(error));announce('Read aloud could not continue.');}});
if(desktop?.voice&&desktop?.onVoiceEvent)voiceView=createVoiceController({desktop,onChange:()=>{renderVoiceStatus();renderVoiceMenu();},onError:error=>{toast(errorText(error));announce('Voice stopped. '+errorText(error));},onDictation:appendDictation,stopOtherAudio:()=>readAloud?.stop()});
terminalView=createTerminalView({desktop,split:$('conversation-split'),mount:$('terminal-mount'),separator:$('terminal-separator'),toggleButton:$('toggle-terminal'),nameFor,onShare:appendTerminalSelection,onBeforeLayout:beforeTerminalLayout,onAfterLayout:afterTerminalLayout,notify:toast});
$('toggle-terminal').innerHTML=icon('terminal')+' Terminal';$('toggle-navigation').innerHTML=icon('sidebar');$('toggle-work').innerHTML=icon('panel')+' Work';$('close-work').innerHTML=icon('close');
if(desktop?.isDesktop)document.documentElement.classList.add('desktop');
setTheme(state.theme);render();desktop?.onCommand?.(runCommand);desktop?.onGatewayEvent?.(gatewayEvent);loadOverview({initial:true});
