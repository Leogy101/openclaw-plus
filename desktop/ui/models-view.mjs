import { createProfileView } from './profile-view.mjs';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const array = value => Array.isArray(value) ? value : [];
const label = value => typeof value === 'string' ? value : '';
const stamp = value => { const date = new Date(value); return value && Number.isFinite(date.valueOf()) ? date.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Not observed'; };
const roles = ['Coding','Independent review','Research','Orchestration / planning'];
const button = (action, text, classes = 'mm-button', attributes = '') => `<button type="button" class="${classes}" data-models-action="${action}" ${attributes}>${text}</button>`;
const pill = (text, kind = '') => `<span class="mm-pill ${kind}">${escapeHTML(text)}</span>`;
const table = rows => `<table class="mm-review-table"><tbody>${rows.map(([key,value])=>`<tr><th scope="row">${escapeHTML(key)}</th><td>${escapeHTML(value)}</td></tr>`).join('')}</tbody></table>`;

// This view owns presentation and temporary form drafts. OpenClaw and the local
// main-process registry own their respective state; no runtime policy lives here.
export function createModelsView({desktop, container, onStatus = () => {}}) {
  let host = container, active = false, destroyed = false, generation = 0, loadId = 0, pendingLoad = null;
  let dialog = null, dialogContext = null, returnFocus = null, dialogSequence = 0;
  const state = {view:'Catalog',snapshot:null,loading:false,error:'',selectedRef:'',query:'',provider:'',limit:60,writing:false,
    draft:{modelRef:'',reasoning:''},providerSelection:null,mutationUncertain:false};
  const report = message => { if(typeof onStatus === 'function') onStatus(message); };
  const rows = () => {
    const map = new Map(array(state.snapshot?.catalog?.models).filter(model=>label(model.modelRef)).map(model=>[model.modelRef,{...model,native:true}]));
    for(const record of registrations()) if(!map.has(record.modelRef)) map.set(record.modelRef,{modelRef:record.modelRef,provider:record.provider,id:record.modelId,name:record.name||record.modelRef,native:false,available:null,manualSelectionAllowed:null,thinkingLevels:[],input:[]});
    return [...map.values()];
  };
  const registrations = () => array(state.snapshot?.registry?.items);
  const providerOptions = () => {
    const choices=[],ids=new Set(),mapped=new Set();
    for(const item of array(state.snapshot?.providerSetup?.items)) {
      if(!label(item.id)||!label(item.label)||ids.has(item.id))continue;
      const providerIds=[...new Set(array(item.providerIds).filter(label))];
      choices.push({id:item.id,label:item.label,providerIds,methods:array(item.methods),setup:true});
      ids.add(item.id);for(const id of providerIds)mapped.add(id);
    }
    const catalogs=new Map(array(state.snapshot?.catalog?.providers).filter(item=>label(item.id)).map(item=>[item.id,item.name||item.id]));
    for(const model of rows())if(model.provider&&!catalogs.has(model.provider))catalogs.set(model.provider,model.provider);
    for(const [id,name] of catalogs)if(!mapped.has(id)) {
      const key=ids.has(id)?'catalog:'+id:id;
      choices.push({id:key,label:name,providerIds:[id],methods:[],setup:false});ids.add(key);
    }
    if(state.provider&&!ids.has(state.provider)&&state.providerSelection)choices.push({...state.providerSelection,retained:true});
    return choices;
  };
  const selectedProvider = () => providerOptions().find(item=>item.id===state.provider)||null;
  const providerRows = () => {const choice=state.provider?selectedProvider():null;return rows().filter(model=>!state.provider||choice?.providerIds.includes(model.provider)===true);};
  const filteredRows = () => providerRows().filter(model=>`${model.name||''} ${model.modelRef}`.toLowerCase().includes(state.query.toLowerCase()));
  const current = () => providerRows().find(model=>model.modelRef===state.selectedRef) || null;
  function preserveSelection() {
    const choices=providerOptions(),choice=choices.find(item=>item.id===state.provider);
    if(choice&&!choice.retained)state.providerSelection=choice;
    if(!providerRows().some(model=>model.modelRef===state.selectedRef))state.selectedRef=filteredRows()[0]?.modelRef||'';
  }
  const registered = model => registrations().filter(item=>item.modelRef===model?.modelRef);
  const connected = () => state.snapshot?.connection?.status === 'connected' && !state.error && !state.snapshot?.catalog?.stale;
  const canRegister = () => connected() && state.snapshot?.actions?.canRegister === true && !state.writing && !state.mutationUncertain;
  const node = name => host?.querySelector(`[data-models-region="${name}"]`);
  const renderedMarkup=new WeakMap();
  function setHTML(target,html){if(target&&renderedMarkup.get(target)!==html){target.innerHTML=html;renderedMarkup.set(target,html);}}
  function refocus(saved) {
    if(!saved || dialog?.open || !active)return;
    const target = host?.querySelector(`[data-models-focus="${CSS.escape(saved)}"]`);
    target?.focus({preventScroll:true});
  }
  async function rpc(operation, params = {}) {
    if(typeof desktop?.models !== 'function') throw Object.assign(new Error('Model management is unavailable in this application build.'),{code:'UNAVAILABLE'});
    const reply = await desktop.models(operation, params);
    if(reply?.ok !== true) throw Object.assign(new Error(reply?.error?.message || 'The model request could not be completed.'), {code:reply?.error?.code || 'UNAVAILABLE',uncertain:reply?.error?.uncertain === true});
    return reply.data;
  }
  const profiles = createProfileView({rpc,onStatus:report});
  function bind(next) {
    if(next && next !== host) { host?.removeEventListener('click',click);host?.removeEventListener('input',input);host?.removeEventListener('change',change);host=next; }
    if(!host || destroyed)return false;
    if(!host.classList.contains('models-workspace') || !node('body')) {
      host.classList.add('models-workspace');
      host.innerHTML=`<div class="mm-toolbar"><nav class="mm-tabs" aria-label="Model Manager views" data-models-region="tabs"></nav><div class="mm-actions">${button('refresh','Refresh snapshot','mm-button','data-models-focus="refresh"')}${button('add','Register model','mm-button primary','data-models-focus="add"')}</div></div><div class="mm-status" data-models-region="status" role="status"></div><div class="mm-notice" data-models-region="notice" role="status"></div><div data-models-region="body"></div>`;
      host.addEventListener('click',click);host.addEventListener('input',input);host.addEventListener('change',change);
    }
    return true;
  }
  function render(nextContainer) {
    if(!bind(nextContainer))return;
    active=true;
    const focus=document.activeElement?.dataset.modelsFocus;renderChrome();renderBody();refocus(focus);
  }
  function renderChrome() {
    if(!active || !host?.isConnected)return;
    setHTML(node('tabs'),['Catalog','Checks','Personal routing'].map(view=>button('tab',escapeHTML(view),'mm-tab',`data-view="${view}" data-models-focus="tab-${view}" ${state.view===view?'aria-current="page"':''}`)).join(''));
    const refresh=host.querySelector('[data-models-action="refresh"]'),add=host.querySelector('[data-models-action="add"]');
    refresh.disabled=state.loading;refresh.textContent=state.loading?'Refreshing…':'Refresh snapshot';add.disabled=!canRegister()||!providerRows().some(model=>model.native);
    const connection=state.snapshot?.connection,observed=state.snapshot?.catalog?.observedAt||connection?.observedAt;
    node('status').dataset.state=state.error?'disconnected':connection?.status||'loading';
    setHTML(node('status'),`<span class="mm-dot" aria-hidden="true"></span><span>${state.loading&&!state.snapshot?'Reading the published model catalog…':`${connection?.status==='connected'&&!state.error?'Published catalog':connection?.status==='unsupported'?'Catalog unavailable':'Last available snapshot'} · ${escapeHTML(stamp(observed))}`}</span><span>${state.view==='Catalog'?'Authentication and inference are not tested by this view.':'Benchmark usage is reviewed separately in GCB. Live routing remains inactive.'}</span>`);
    const notes=[];
    if(state.error)notes.push(state.error+' Loaded records are retained.');
    if(connection?.status==='unsupported')notes.push(connection.message||'This gateway does not advertise the model catalog needed by this workspace.');
    else if(connection?.status==='disconnected')notes.push(connection.message||'The gateway is disconnected. Current model availability is unverified.');
    if(state.snapshot?.catalog?.stale)notes.push('Catalog data is stale. Refresh before reviewing a registration.');
    if(state.snapshot?.registry?.readOnly || state.snapshot?.registry?.status==='unavailable')notes.push('Personal registration storage is unavailable or read-only. Catalog browsing remains available.');
    else if(state.snapshot?.registry?.status==='recovered')notes.push('Personal registrations were recovered from their last valid snapshot.');
    if(state.mutationUncertain)notes.push('The last change is unconfirmed. Refresh the snapshot before preparing another action.');
    node('notice').textContent=notes.join(' ');
  }
  function renderBody() {
    if(!active || !node('body'))return;
    const focus=document.activeElement?.dataset.modelsFocus;
    if(state.view==='Catalog') {
      profiles.close();
      const body=node('body');
      if(body.dataset.view!=='Catalog') {
        body.dataset.view='Catalog';
        body.innerHTML=`<div class="mm-layout"><section class="mm-library" aria-label="Model catalog"><div class="mm-library-head"><h2>Models</h2><p data-models-region="count"></p><div class="mm-filter"><input class="mm-search" type="search" aria-label="Find a model" placeholder="Find a model…" data-models-input="search" data-models-focus="search"><select aria-label="Filter models by provider" data-models-input="provider" data-models-focus="provider"></select></div><div data-models-region="provider-coverage"></div></div><div class="mm-list" data-models-region="list"></div></section><section class="mm-detail" data-models-region="detail" aria-label="Selected model"></section></div>`;
        host.querySelector('[data-models-input="search"]').value=state.query;
      }
      renderList();renderDetail();
    } else {
      node('body').dataset.view=state.view;profiles.render(node('body'),state.view);
    }
    refocus(focus);
  }
  function renderList() {
    if(!node('list'))return;
    const all=rows(),providers=providerOptions(),setup=state.snapshot?.providerSetup;
    const select=host.querySelector('[data-models-input="provider"]');
    const complete=setup?.status==='available';
    const options=`<option value="">${complete?'All providers':'All listed providers'}</option>`+providers.map(item=>`<option value="${escapeHTML(item.id)}">${escapeHTML(item.label)}${item.retained?' · previously listed':''}</option>`).join('');
    if(select.innerHTML!==options)select.innerHTML=options;
    select.value=state.provider;
    const source=node('provider-coverage'),expanded=source?.querySelector('details')?.open;
    const incomplete=state.snapshot&&!complete;
    setHTML(source,`${incomplete?`<p class="mm-provider-note">${setup?.status==='partial'?'Provider setup choices are incomplete.':'Provider setup choices are unavailable; catalog providers are still listed.'}</p>`:''}<details class="mm-provider-source"><summary>About this provider list</summary><p>${setup?.source==='installed-openclaw-metadata'?'Setup choices come from your installed OpenClaw metadata'+(label(setup.version)?' ('+escapeHTML(setup.version)+')':'')+'.':'Native setup metadata has not been returned.'} Published catalog providers are included separately when needed.</p><p>Provider choices are setup options, not proof of authentication or available models.</p>${array(setup?.limitations).length?`<ul>${array(setup.limitations).map(item=>`<li>${escapeHTML(item)}</li>`).join('')}</ul>`:''}</details>`);
    if(expanded&&source?.querySelector('details'))source.querySelector('details').open=true;
    const filtered=filteredRows();
    node('count').textContent=`${registrations().length} personal reference${registrations().length===1?'':'s'} · ${all.length} catalog record${all.length===1?'':'s'}`;
    setHTML(node('list'),filtered.length?filtered.slice(0,state.limit).map(model=>button('select',`<strong>${escapeHTML(model.name||model.id||model.modelRef)}</strong><small>${escapeHTML(model.modelRef)}</small>${pill(registered(model).length?'Registered':'Not registered',registered(model).length?'green':'')}`,'mm-model',`data-model-ref="${escapeHTML(model.modelRef)}" data-models-focus="model-${escapeHTML(model.modelRef)}" ${state.selectedRef===model.modelRef?'aria-current="true"':''}`)).join('')+(filtered.length>state.limit?button('more',`Show more (${filtered.length-state.limit} remaining)`,'mm-more','data-models-focus="more"'):''):`<p class="mm-list-note">${state.loading&&!state.snapshot?'Loading published models…':state.query?'No models match this search.':state.provider?'No published models for this provider in the current catalog.':'No model rows were returned. This does not prove that no providers are configured.'}</p>`);
  }
  function renderDetail() {
    const region=node('detail');if(!region)return;
    const disclosures=new Set([...region.querySelectorAll('details[open]')].map(item=>item.dataset.disclosure));
    const model=current();
    if(!model&&state.provider) {
      const choice=selectedProvider(),matching=providerRows(),name=choice?.label||state.provider;
      setHTML(region,`<p class="mm-eyebrow">Provider setup</p><h2>${escapeHTML(name)}</h2><div class="mm-chips">${pill(choice?.setup&&!choice.retained?'Available in OpenClaw setup':choice?.retained?'Previously listed setup choice':'Catalog provider',choice?.retained?'amber':'')}${pill('Authentication not checked')}</div><p class="mm-intro">${matching.length&&state.query?'No published models match your search. Clear the search or choose another provider to continue.':'No published models for this provider in the current catalog. Open OpenClaw setup to add or connect a model, then return and refresh this view.'}</p>${choice?.retained?'<p class="mm-provider-note">This provider was retained from your previous selection. Its current setup availability is unverified.</p>':''}<div class="mm-detail-actions">${matching.length&&state.query?button('clear-search','Clear model search','mm-button','data-models-focus="clear-search"'):''}${button('onboard','Open provider setup','mm-button primary','data-models-focus="empty-provider-setup"')}</div><p class="mm-footnote">Choosing a provider here does not configure it, test a model, or change an agent assignment. Provider setup remains an explicit action in OpenClaw.</p>${array(choice?.methods).length?`<details class="mm-advanced"><summary>Available setup methods</summary><div class="mm-card"><ul>${choice.methods.map(method=>`<li>${escapeHTML(method.label||method.id)}</li>`).join('')}</ul></div></details>`:''}`);return;
    }
    if(!model) {
      setHTML(region,`<div class="mm-empty"><h2>${state.loading&&!state.snapshot?'Loading your model catalog':'Your models stay in OpenClaw'}</h2><p>${state.loading&&!state.snapshot?'Reading published metadata only. No provider test or model request is started.':'Choose a published model, or connect a provider in the original OpenClaw interface. This workspace saves personal references without changing agent defaults.'}</p><div class="mm-actions">${button('onboard','Connect in OpenClaw','mm-button','data-models-focus="empty-onboard"')}</div></div>`);return;
    }
    const items=registered(model),changed=items.some(item=>item.status==='stale'),blocked=items.some(item=>item.status==='blocked');
    const availability=model.available===true?'Advertised available':model.available===false?'Advertised unavailable':'Availability not reported';
    const provider=array(state.snapshot?.catalog?.providers).find(item=>item.id===model.provider);
    const providerAvailability=provider?.availability==='available'?'Catalog includes available models':provider?.availability==='unavailable'?'Catalog reports unavailable models':'Availability not reported';
    setHTML(region,`<p class="mm-eyebrow">Model details</p><h2>${escapeHTML(model.name||model.id||model.modelRef)}</h2><p class="mm-reference">${escapeHTML(model.modelRef)}</p><div class="mm-chips">${pill(items.length?'Registered':'Not registered',items.length?'green':'')}${pill('Admission not checked')}${pill('Not admitted')}${changed?pill('Reference changed','amber'):blocked?pill('Reference unavailable','amber'):''}</div><p class="mm-intro">${items.length?'This personal reference is saved. Qualification and role admission are separate steps.':'Save a personal reference to track this model. Registration does not select it for a conversation or change OpenClaw configuration.'}</p><div class="mm-steps"><div class="mm-step"><strong>1 · Registration</strong><span>${items.length?'Saved personal reference':'Not registered'}</span></div><div class="mm-step"><strong>2 · Capability profile</strong><span>See GCB Checks</span></div><div class="mm-step"><strong>3 · Admission</strong><span>No role is approved</span></div></div><div class="mm-detail-actions">${button('add',items.length?'Review another variant':'Register this model','mm-button primary',`data-models-focus="register-selected" ${!canRegister()||!model.native?'disabled':''}`)}${button('profile-model','Research and benchmark','mm-button','data-models-focus="profile-selected"')}${button('onboard','Provider setup in OpenClaw','mm-button','data-models-focus="onboard"')}</div><p class="mm-footnote">${escapeHTML(availability)} · Authentication not checked. Catalog availability is not proof that inference succeeds.</p><div class="mm-section-heading"><h3>Role admission</h3>${pill('Not available yet')}</div><table class="mm-role-table"><thead><tr><th scope="col">Role</th><th scope="col">Admission review</th><th scope="col">Admission</th></tr></thead><tbody>${roles.map(role=>`<tr><td>${escapeHTML(role)}</td><td>Not checked</td><td>Not admitted</td></tr>`).join('')}</tbody></table><div class="mm-section-heading"><h3>Scope and evidence</h3></div><div class="mm-card"><h3>No role admission record</h3><p>Use Checks to build a GCB capability bio for a prepared target. Profiling evidence and live role admission remain separate.</p><dl class="mm-metadata"><dt>Model</dt><dd>${escapeHTML(model.modelRef)}</dd><dt>Reasoning</dt><dd>${items.length?escapeHTML([...new Set(items.map(item=>item.reasoning||'No preference recorded'))].join(' · ')):'No registered preference'}</dd><dt>Environment</dt><dd>Not qualified</dd><dt>Tools / workload</dt><dd>Not admitted for any role</dd></dl></div><details class="mm-advanced" data-disclosure="source"><summary>Advertised capabilities and source details</summary><div class="mm-card"><dl class="mm-metadata"><dt>Provider</dt><dd>${escapeHTML(model.provider||'Not reported')}</dd><dt>Provider catalog</dt><dd>${escapeHTML(providerAvailability)}</dd><dt>Manual selection</dt><dd>${model.manualSelectionAllowed===true?'Advertised allowed; native policy still applies':model.manualSelectionAllowed===false?'Not allowed by the native catalog':'Not reported'}</dd><dt>Input types</dt><dd>${escapeHTML(array(model.input).join(', ')||'Not reported')}</dd><dt>Reasoning choices</dt><dd>${escapeHTML(array(model.thinkingLevels).map(level=>level.label||level.id).join(', ')||'Not reported')}</dd><dt>Context window</dt><dd>${Number.isFinite(model.contextWindow)?escapeHTML(model.contextWindow.toLocaleString()+' tokens advertised'):'Not reported'}</dd><dt>Runtime</dt><dd>${escapeHTML(model.runtimeId||'Not reported')}</dd><dt>Location</dt><dd>${model.local===true?'Native metadata labels this model local':model.local===false?'Native metadata labels this model remote':'Not reported'}</dd><dt>Observed</dt><dd>${escapeHTML(stamp(state.snapshot?.catalog?.observedAt))}</dd></dl><p>These are native catalog declarations. Any GCB profiling evidence, reasoning comparisons and role recommendations are shown separately in Checks and Personal routing.</p>${array(state.snapshot?.catalog?.limitations).length?`<ul>${array(state.snapshot.catalog.limitations).map(item=>`<li>${escapeHTML(item)}</li>`).join('')}</ul>`:''}<div class="mm-actions">${button('onboard','Open provider setup','mm-button','data-models-focus="provider-setup"')}</div><p>Provider discovery and sign-in stay in OpenClaw setup. Refreshing this view rereads the prepared catalog only.</p></div></details><p class="mm-footnote">Personal routing remains preview-only. Native enforcement of an approved model set has not been verified.</p>`);
    for(const details of region.querySelectorAll('details'))if(disclosures.has(details.dataset.disclosure))details.open=true;
  }
  async function load({force=false}={}) {
    if(destroyed || !active)return;
    if(pendingLoad&&!force)return pendingLoad;
    const token=++loadId,epoch=generation;state.loading=true;renderChrome();
    const promise=(async()=>{try {
      const snapshot=await rpc(force?'modelsRefresh':'modelsOverview',{});
      if(!active||destroyed||generation!==epoch||loadId!==token)return;
      state.snapshot=snapshot;state.error='';state.mutationUncertain=false;
      preserveSelection();
      renderBody();
    }catch(error){if(active&&!destroyed&&generation===epoch&&loadId===token){state.error=error.message;renderBody();}}
    finally{if(generation===epoch&&loadId===token){state.loading=false;pendingLoad=null;renderChrome();}}})();
    pendingLoad=promise;return promise;
  }
  function ensureDialog() {
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='mm-dialog';dialog.setAttribute('aria-labelledby','models-dialog-title');
    dialog.innerHTML=`<div class="mm-dialog-head"><h2 id="models-dialog-title"></h2>${button('close-dialog','×','mm-close','aria-label="Close model dialog"')}</div><div class="mm-dialog-body"><div class="mm-dialog-error" role="alert" data-mm-error></div><div data-mm-body></div></div>`;
    document.body.append(dialog);dialog.addEventListener('click',click);dialog.addEventListener('change',change);dialog.addEventListener('keydown',dialogKeydown);
    dialog.addEventListener('close',()=>{dialogContext=null;dialogSequence++;if(active){const target=returnFocus?.node?.isConnected?returnFocus.node:returnFocus?.key?host?.querySelector(`[data-models-focus="${CSS.escape(returnFocus.key)}"]`):null;target?.focus({preventScroll:true});}returnFocus=null;});
  }
  function showDialog(title,html,context={}) {
    ensureDialog();
    if(!dialog.open)returnFocus={node:document.activeElement,key:document.activeElement?.dataset.modelsFocus};
    dialogContext=context;dialogSequence++;dialog.querySelector('h2').textContent=title;dialog.querySelector('[data-mm-error]').textContent='';dialog.querySelector('[data-mm-body]').innerHTML=html;
    if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
  }
  function dismissDialog(){if(dialog?.open)dialog.close();}
  function dialogError(error){if(dialog?.open){dialog.querySelector('[data-mm-error]').textContent=error.message||String(error);}}
  function dialogKeydown(event) {
    event.stopPropagation();
    if(event.key!=='Tab'||event.ctrlKey||event.metaKey||event.altKey)return;
    const controls=[...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(item=>item.tabIndex>=0&&!item.matches(':disabled')&&!item.closest('[hidden],[inert]')&&item.getClientRects().length&&getComputedStyle(item).visibility!=='hidden');
    const first=controls[0],last=controls.at(-1);
    if(first&&(!controls.includes(document.activeElement)||(event.shiftKey?document.activeElement===first:document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}
  }
  function addDialog() {
    if(!canRegister())return report('Refresh the catalog and local registration state before registering a model.');
    const available=providerRows().filter(model=>model.native),saved=state.draft;
    if(!available.length)return report('No published model is available for this provider. Open OpenClaw provider setup, then refresh this view.');
    if(!available.some(model=>model.modelRef===saved.modelRef)){saved.modelRef=current()?.native?current().modelRef:available[0]?.modelRef||'';saved.reasoning='';}
    const model=available.find(item=>item.modelRef===saved.modelRef),levels=array(model?.thinkingLevels);
    if(saved.reasoning&&!levels.some(level=>level.id===saved.reasoning))saved.reasoning='';
    showDialog('Register a personal model reference',`<p class="mm-dialog-copy">Choose a published native model. Saving this reference does not configure a provider, change a conversation, run checks, or admit a model.</p><div class="mm-field"><label for="mm-registration-model">Published model</label><select id="mm-registration-model" data-models-input="registration-model">${available.map(item=>`<option value="${escapeHTML(item.modelRef)}" ${item.modelRef===saved.modelRef?'selected':''}>${escapeHTML(item.name||item.id)} · ${escapeHTML(item.modelRef)}</option>`).join('')}</select></div><div class="mm-field"><label for="mm-registration-reasoning">Reasoning preference for this reference</label><select id="mm-registration-reasoning" data-models-input="registration-reasoning"><option value="">No preference recorded</option>${levels.map(level=>`<option value="${escapeHTML(level.id)}" ${level.id===saved.reasoning?'selected':''}>${escapeHTML(level.label||level.id)}</option>`).join('')}</select></div><p class="mm-dialog-note">Only advertised reasoning choices are shown. This records a preference; it does not set provider-internal effort or session settings.</p><div class="mm-actions">${button('onboard','Need another provider? Open OpenClaw setup','mm-text-button')}</div><div class="mm-dialog-actions">${button('close-dialog','Cancel')}${button('plan-registration','Review registration','mm-button primary',model?'':'disabled')}</div>`,{kind:'add'});
  }
  async function planRegistration() {
    if(dialogContext?.kind!=='add'||state.writing)return;
    const epoch=generation,sequence=dialogSequence,params={modelRef:state.draft.modelRef,...(state.draft.reasoning?{reasoning:state.draft.reasoning}:{})};
    const control=dialog.querySelector('[data-models-action="plan-registration"]');control.disabled=true;control.textContent='Preparing review…';
    try {
      const plan=await rpc('modelsPlanRegistration',params);
      if(!active||generation!==epoch||dialogSequence!==sequence)return;
      if(!label(plan?.reviewToken)||plan.registryRevision===undefined)throw new Error('OpenClaw+ did not return a reviewable registration. Refresh and try again.');
      const review=plan.review||{};
      showDialog('Review local registration',`<p class="mm-dialog-copy">${escapeHTML(review.description||'Save this exact model reference in your private personal registry. Native OpenClaw configuration remains unchanged.')}</p>${table([['Model',review.modelRef||params.modelRef],['Provider',review.provider||'Not reported'],['Name',review.name||'Not reported'],['Reasoning',review.reasoning||'No preference recorded'],['Qualification','Not checked'],['Admission','Not approved']])}<p class="mm-dialog-note">This local record grants no execution permission and starts no model task.</p><div class="mm-dialog-actions">${button('back-add','Back')}${button('register','Save personal reference','mm-button primary')}</div>`,{kind:'registration',plan,epoch});
    }catch(error){if(active&&generation===epoch&&dialogSequence===sequence){dialogError(error);control.disabled=false;control.textContent='Review registration';}}
  }
  async function registerReference() {
    const operation=dialogContext;if(operation?.kind!=='registration'||!canRegister()||operation.epoch!==generation)return;
    state.writing=true;const epoch=generation,sequence=dialogSequence;const control=dialog.querySelector('[data-models-action="register"]');control.disabled=true;control.textContent='Saving…';renderChrome();
    try {
      const response=await rpc('modelsRegister',{reviewToken:operation.plan.reviewToken,registryRevision:operation.plan.registryRevision});
      if(!response?.registered)throw Object.assign(new Error('The saved reference was not confirmed. Refresh before trying again.'),{code:'UNCERTAIN',uncertain:true});
      if(active&&generation===epoch&&dialogSequence===sequence){state.selectedRef=response.registered.modelRef||operation.plan.review?.modelRef||state.draft.modelRef;dismissDialog();report('Personal model reference saved. No native configuration or model selection changed.');await load({force:true});}
    }catch(error){if(error.uncertain||error.code==='UNCERTAIN')state.mutationUncertain=true;if(active&&generation===epoch&&dialogSequence===sequence){dialogError(error);control.textContent=state.mutationUncertain?'Refresh before another attempt':'Save personal reference';control.disabled=true;}}
    finally{state.writing=false;if(active){renderChrome();renderDetail();}}
  }
  async function onboarding() {
    const epoch=generation;
    try{const response=await rpc('modelsOnboarding',{});if(active&&generation===epoch){if(response?.opened!==true)throw new Error('The original setup interface could not be opened.');report('Provider setup opened in OpenClaw. Sign-in and discovery require separate actions there; return and refresh this view afterward.');if(dialog?.open)dialog.querySelector('[data-mm-error]').textContent='Provider setup is open in OpenClaw. Your reference draft is retained. Sign-in and discovery remain separate native actions; return and refresh this view afterward.';}}
    catch(error){if(active&&generation===epoch){if(dialog?.open)dialogError(error);else report(error.message);}}
  }
  function click(event) {
    const target=event.target.closest('[data-models-action]');if(!target||target.disabled||destroyed)return;
    const action=target.dataset.modelsAction;
    if(action==='tab'||action==='catalog'){state.view=target.dataset.view||'Catalog';renderChrome();renderBody();}
    else if(action==='refresh'){load({force:true});if(state.view!=='Catalog')profiles.load();}
    else if(action==='profile-model'){state.view='Checks';renderChrome();node('body').dataset.view=state.view;profiles.render(node('body'),'Checks',current()?.modelRef||'');}
    else if(action==='select'){const focus=target.dataset.modelsFocus;state.selectedRef=target.dataset.modelRef;state.draft={modelRef:state.selectedRef,reasoning:''};renderList();renderDetail();refocus(focus);}
    else if(action==='more'){state.limit+=60;renderList();}
    else if(action==='clear-search'){state.query='';host.querySelector('[data-models-input="search"]').value='';preserveSelection();renderList();renderDetail();}
    else if(action==='add'||action==='back-add')addDialog();
    else if(action==='plan-registration')planRegistration();
    else if(action==='register')registerReference();
    else if(action==='onboard')onboarding();
    else if(action==='close-dialog')dismissDialog();
  }
  function input(event){if(event.target.dataset.modelsInput==='search'){state.query=event.target.value;state.limit=60;renderList();}}
  function change(event) {
    const kind=event.target.dataset.modelsInput;
    if(kind==='provider'){state.provider=event.target.value;state.providerSelection=selectedProvider();state.limit=60;preserveSelection();renderChrome();renderList();renderDetail();}
    else if(kind==='registration-model'){state.draft.modelRef=event.target.value;state.draft.reasoning='';addDialog();dialog.querySelector('[data-models-input="registration-model"]')?.focus();}
    else if(kind==='registration-reasoning')state.draft.reasoning=event.target.value;
  }
  function invalidateConnection(connection = {}) {
    generation++;loadId++;pendingLoad=null;state.loading=false;
    if(state.snapshot)state.snapshot={...state.snapshot,connection:{...state.snapshot.connection,...connection},catalog:{...state.snapshot.catalog,stale:true}};
    if(connection.status!=='connected')state.error=connection.message||'The gateway connection changed. Current catalog availability is unverified.';
    if(state.writing)state.mutationUncertain=true;
    profiles.invalidateConnection();
    if(dialog?.open){
      dialog.querySelector('[data-mm-error]').textContent=state.writing?'The connection changed after submission. The outcome may be unconfirmed; close and refresh before another attempt.':'The connection changed. Your draft is retained; close and refresh before preparing a new review.';
      for(const control of dialog.querySelectorAll('[data-models-action="plan-registration"],[data-models-action="register"]'))control.disabled=true;
    }
    if(active){renderChrome();renderDetail();}
  }
  function close() {profiles.close();active=false;generation++;loadId++;pendingLoad=null;state.loading=false;dismissDialog();}
  function destroy(){if(destroyed)return;close();profiles.destroy();destroyed=true;host?.removeEventListener('click',click);host?.removeEventListener('input',input);host?.removeEventListener('change',change);dialog?.remove();dialog=null;}
  return {render,load,close,destroy,invalidateConnection,dismissDialog:()=>{dismissDialog();profiles.dismissDialog();},isDialogOpen:()=>Boolean(dialog?.open)||profiles.isDialogOpen()};
}
