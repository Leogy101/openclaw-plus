// Presentation only: GCB owns research, plans, execution, evidence and ranking.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const list = value => Array.isArray(value) ? value : [];
const human = value => String(value ?? '').replace(/[_ .]+/g, ' ').replace(/^./, char => char.toUpperCase());
const amount = (value, suffix = '') => Number.isFinite(value) ? `${value.toLocaleString(undefined, {maximumFractionDigits:2})}${suffix}` : 'Unknown';
const pill = (text, kind = '') => `<span class="mm-pill ${kind}">${esc(text)}</span>`;
const button = (action, text, attributes = '', primary = false) => `<button type="button" class="mm-button${primary?' primary':''}" data-profile-action="${action}" data-profile-focus="${action}" ${attributes}>${esc(text)}</button>`;
const statusOf = target => typeof target?.status === 'string' ? target.status : target?.status?.status || 'not_started';
const modeLabel = target => target?.mode==='offline'?'Offline example':target?.mode==='ollama'?'Local Ollama':'OpenClaw';
const evidenceKey = target => JSON.stringify([target?.metadata?.metadata_id,target?.plan?.plan_id,target?.status,
  list(target?.bio?.configurations).map(({configuration_id,categories,latency_ms,usage})=>({configuration_id,categories,latency_ms,usage}))]);
const nativeName = native => {
  if (!native || typeof native !== 'object' || !Object.keys(native).length) return 'Provider default';
  return Object.entries(native).map(([key,value]) => `${human(key)}: ${typeof value === 'object'?JSON.stringify(value):value}`).join(' · ');
};
const table = rows => `<table class="mm-review-table"><tbody>${rows.map(([key,value])=>`<tr><th scope="row">${esc(key)}</th><td>${esc(value)}</td></tr>`).join('')}</tbody></table>`;
const textList = values => `<ul>${list(values).map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`;
const evidenceText = value => {
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)??'Unavailable';
  return `<pre class="mm-recorded-text" tabindex="0">${esc(text.slice(0,8192))}</pre>${text.length>8192?'<p class="mm-profile-caption">Display limited to 8,192 characters. The stored evidence is unchanged.</p>':''}`;
};

export function createProfileView({rpc, onStatus = () => {}}) {
  let host = null, active = false, destroyed = false, view = 'Checks', epoch = 0, timer = null, pending = null;
  let snapshot = null, selected = '', requestedRef = '', error = '', pollError = '', busy = false, routes = null;
  const contrasts = new Map();
  let dialog = null, review = null, returnFocus = null, dialogSequence = 0, connectionEpoch = 0;
  let recorded = null, evidenceSequence = 0;
  const targets = () => list(snapshot?.targets);
  const target = () => targets().find(item=>item.id===selected) || null;
  const enabled = () => snapshot?.engine?.status === 'ready';
  const contrastFor = item => item?.mode==='ollama'?false:item?.plan && statusOf(item)!=='complete'
    ? list(item.plan.configuration_ids).length>1
    : contrasts.get(item?.id) ?? (item?.plan?list(item.plan.configuration_ids).length>1:true);
  const focus = () => document.activeElement?.dataset.profileFocus;
  function restoreFocus(key) { if(key&&active&&!dialog?.open)host?.querySelector(`[data-profile-focus="${CSS.escape(key)}"]`)?.focus({preventScroll:true}); }
  function setHTML(node, html) { if(node && node.__profileHTML!==html){node.innerHTML=html;node.__profileHTML=html;} }
  function selectDefault() {
    const matching = requestedRef && targets().find(item=>item.modelRef===requestedRef);
    if(matching){selected=matching.id;requestedRef='';}
    if(requestedRef.startsWith('ollama/')){selected='';return;}
    if(!targets().some(item=>item.id===selected))selected=targets()[0]?.id||'';
  }
  function schedule() {
    clearTimeout(timer);timer=null;
    if(active&&!destroyed&&view==='Checks')timer=setTimeout(()=>load(),1000);
  }
  async function load() {
    if(!active||destroyed)return;
    if(pending)return pending;
    const generation=epoch;
    const promise=(async()=>{
      try {
        const data=await rpc('modelsProfileOverview',{});
        if(!active||destroyed||generation!==epoch)return;
        snapshot=data;pollError='';selectDefault();
        if(recorded&&(recorded.targetId!==target()?.id||recorded.key!==evidenceKey(target()))){
          const details=host.querySelector('[data-profile-disclosure="responses"]');if(details)details.open=false;
          recorded=null;evidenceSequence++;
        }
        if(routes&&routes.evidence!==evidenceKey(targets().find(item=>item.id===routes.targetId)))routes=null;
        paint();
      } catch(failure) {if(active&&generation===epoch){pollError=failure.message;paint();}}
      finally {if(pending===promise)pending=null;if(generation===epoch)schedule();}
    })();
    pending=promise;return promise;
  }
  function render(container, nextView, modelRef = '') {
    const changed=!active||view!==nextView||host!==container;
    if(host!==container){host?.removeEventListener('click',click);host?.removeEventListener('change',change);host?.removeEventListener('toggle',toggle,true);host=container;host?.addEventListener('click',click);host?.addEventListener('change',change);host?.addEventListener('toggle',toggle,true);}
    active=true;view=nextView;
    if(modelRef&&modelRef!==requestedRef&&!targets().some(item=>item.id===selected&&item.modelRef===modelRef))requestedRef=modelRef;
    selectDefault();
    if(!host.querySelector('[data-profile-region="detail"]')){
      host.innerHTML='<section class="mm-profiles"><div data-profile-region="heading"></div><div data-profile-region="notice" class="mm-notice" role="status"></div><div class="mm-profile-layout"><aside class="mm-library" aria-label="Profiling targets"><div class="mm-library-head"><h2>Profile a model</h2><p>Choose an offline demo or a prepared OpenClaw target.</p></div><div class="mm-list" data-profile-region="targets"></div></aside><section class="mm-profile-detail" aria-label="Model capability profile" data-profile-region="detail"></section></div></section>';
    }
    paint();if(changed)load();else if(!timer&&!pending)schedule();
  }
  const region = name => host?.querySelector(`[data-profile-region="${name}"]`);
  function paint() {
    if(!active||!host?.isConnected)return;
    const key=focus(),disclosures=new Set([...host.querySelectorAll('details[open][data-profile-disclosure]')].map(node=>node.dataset.profileDisclosure));
    const connecting=busy||snapshot?.active?'disabled':'';
    setHTML(region('heading'),`<div class="mm-profile-heading"><div><p class="mm-eyebrow">${view==='Checks'?'Powered by GCB':'Personal routing'}</p><h2>${view==='Checks'?'Know what your model can do':'Find the right model for a role'}</h2><p>${view==='Checks'?'Research its configuration, review a small benchmark, and build a capability bio.':'GCB explains its recommendations using the available evidence. These are previews only.'}</p></div><div class="mm-actions">${button('connect','Connect GCB',connecting)}${button('import','Add OpenClaw target',`${connecting} ${!enabled()?'disabled':''}`)}</div></div>${!enabled()?'<details class="mm-advanced mm-profile-install"><summary>Set up the GCB connection</summary><p>Install the reviewed governed-capability-broker package in a Python 3.11+ virtual environment using its README offline quickstart. Run <code>gcb doctor</code>, then choose the installed <code>.venv/bin/gcb</code> executable with Connect GCB.</p><p>GCB needs no background service for offline examples. Subscription-backed OpenClaw profiling also needs the optional bridge and reviewed host snapshot described in <code>integrations/openclaw-host/README.md</code>.</p></details>':''}`);
    const notes=[error,pollError];
    if(snapshot?.engine?.status!=='ready')notes.push(snapshot?.engine?.message||'Connect an independently installed GCB executable to start.');
    if(requestedRef)notes.push(requestedRef.startsWith('ollama/')
      ? `Prepare a one-attempt local smoke test for ${requestedRef}. OpenClaw availability and permissions are checked before GCB research or execution.`
      : `No prepared GCB target matches ${requestedRef}. Add its reviewed OpenClaw host snapshot to profile that exact model. You can explore the offline examples below.`);
    region('notice').textContent=notes.filter(Boolean).join(' ');
    setHTML(region('targets'),targets().length?targets().map(item=>`<button type="button" class="mm-model" data-profile-action="select" data-target-id="${esc(item.id)}" data-profile-focus="target-${esc(item.id)}" ${selected===item.id?'aria-current="true"':''}><strong>${esc(item.name||item.modelRef||item.id)}</strong><small>${esc(item.modelRef||item.id)}</small>${pill(modeLabel(item),item.mode==='offline'?'':'blue')} ${pill(item.mode==='ollama'&&item.limitReached?'Smoke limit reached':human(statusOf(item)),statusOf(item)==='complete'&&item.mode!=='ollama'?'green':'')}</button>`).join(''):'<p class="mm-list-note">No targets are loaded yet. Connect GCB, then explore the offline examples or add a prepared OpenClaw target.</p>');
    setHTML(region('detail'),view==='Checks'?checksHTML():routesHTML());
    for(const node of host.querySelectorAll('details[data-profile-disclosure]'))if(disclosures.has(node.dataset.profileDisclosure))node.open=true;
    restoreFocus(key);
  }
  function checksHTML() {
    if(requestedRef.startsWith('ollama/'))return `<div class="mm-profile-title"><div><h3>Prepare a local smoke test</h3><p>${esc(requestedRef)}</p></div>${pill('Local Ollama','blue')}</div><div class="mm-card"><h3>One small check before a larger profile</h3><p>GCB will use the configured local Ollama runtime for this exact model, with thinking disabled, a 4,096-token context and a requested 128-token output cap. Preparation and research do not start inference.</p><p>Review the exact configuration and authorize one attempt before it runs. This smoke test produces a partial capability bio.</p>${button('prepare-local','Prepare local smoke test',!enabled()||busy||snapshot?.active?'disabled':'',true)}</div>`;
    const item=target();
    if(!item)return `<div class="mm-empty"><h2>Start with an offline example</h2><p>GCB’s synthetic models demonstrate the complete workflow without provider access or paid model calls.</p>${button('connect','Choose installed GCB','',true)}<p class="mm-footnote">GCB remains a separate, independently installable package.</p><details class="mm-advanced mm-profile-install"><summary>Install and connect GCB</summary><p>Use Python 3.11 or newer and the reviewed governed-capability-broker source repository. Follow its README offline quickstart: create a virtual environment, install the package, and run <code>gcb doctor</code>. Then choose the installed <code>.venv/bin/gcb</code> executable here.</p><p>For subscription-backed OpenClaw targets, follow GCB’s <code>integrations/openclaw-host/README.md</code> and add the reviewed nonsecret host snapshot. This app does not install the optional host bridge.</p></details></div>`;
    const state=statusOf(item),local=item.mode==='ollama',running=snapshot?.active===item.id,otherActive=snapshot?.active&&snapshot.active!==item.id;
    const metadata=item.metadata,plan=item.plan,status=typeof item.status==='object'?item.status:{};
    const counts=status.cells||{},total=status.total_cells||list(plan?.cells).length;
    const observed=Number(counts.observed)||0,settled=Object.entries(counts).filter(([name])=>!['pending','running'].includes(name)).reduce((sum,[,count])=>sum+(Number(count)||0),0);
    const canResume=item.canResume===true;
    const canPlan=enabled()&&!busy&&!running&&!otherActive&&Boolean(metadata)&&!item.limitReached&&state!=='partial_unknown'&&(state!=='cancelled'||canResume);
    const paused=canResume||['paused','interrupted','resource_limited','cooldown','rate_limited'].includes(state);
    const researched=metadata?.model||item.bio?.documented_capabilities;
    const progress=plan?`<div class="mm-profile-progress" role="status" aria-live="polite"><div class="mm-profile-progress-title"><strong>${running?(local?'Running one smoke check':'Profiling in progress'):local&&item.limitReached?(state==='partial_unknown'?'Uncertain smoke attempt · review required':'Smoke limit reached · partial evidence'):human(state)}</strong><span>${settled} of ${total} checks settled</span></div><progress max="${total||1}" value="${settled}" aria-label="Profile check progress"></progress><p>${observed} measured · ${Number(counts.not_applicable)||0} not applicable · ${amount(status.attempts)} attempts${Number(counts.unknown_completion)?` · ${counts.unknown_completion} unknown`:''}</p>${status.error_code?`<p class="mm-profile-error">${esc(human(status.error_code))}</p>`:''}${running?`<div class="mm-actions">${button('pause','Pause after this check',busy?'disabled':'')}${button('cancel','Cancel remaining checks',busy?'disabled':'')}</div><p>Pause keeps completed evidence. Cancellation cannot undo an accepted provider request.</p>`:''}</div>`:'';
    return `<div class="mm-profile-title"><div><h3>${esc(item.name||item.modelRef||item.id)}</h3><p>${esc(item.modelRef||item.id)}</p></div>${pill(item.mode==='offline'?'Synthetic example · no spending':local?'Local Ollama · one-attempt smoke':'Native OpenClaw runtime',item.mode==='offline'?'':'blue')}</div>
      <p class="mm-intro">${item.mode==='offline'?'Explore GCB using deterministic mock responses. These results describe the example, not a real model.':local?'Research and one explicitly authorized check use GCB’s existing local Ollama adapter. OpenClaw verifies model availability and selection permissions; inference goes directly to the configured local runtime.':'Research comes from the reviewed host snapshot. Profiling uses the configured OpenClaw runtime and its existing permissions.'}</p>
      <div class="mm-profile-steps"><span class="${metadata?'done':''}">1 · Research</span><span class="${plan?'done':''}">2 · Review usage</span><span class="${state==='complete'&&!local?'done':''}">3 · ${local?'Partial capability bio':'Capability bio'}</span></div>
      ${item.error?`<p class="mm-notice" role="alert">${esc(typeof item.error==='string'?item.error:item.error.message||'The target could not complete this action.')}</p>`:''}
      ${researched?researchHTML(item):`<div class="mm-card"><h3>Learn the exact configuration</h3><p>Ask GCB to resolve documented capabilities and supported reasoning settings before preparing a benchmark.</p></div>`}
      <div class="mm-detail-actions">${button('research',metadata?'Refresh research':'Research capabilities',`${!enabled()||busy||running||otherActive?'disabled':''}`)}${button('plan',local?(item.limitReached?'Smoke request limit reached':'Review local smoke test'):paused?'Review and resume':state==='complete'?'Review completed scope':'Review benchmark',canPlan?'':'disabled',true)}</div>
      <label class="mm-profile-option"><input type="checkbox" data-profile-input="contrast" data-profile-focus="contrast" ${contrastFor(item)?'checked':''} ${local||plan&&state!=='complete'||busy||running?'disabled':''}> Compare supported reasoning configurations <span>GCB selects applicable contrast checks.</span></label>
      ${local?'<p class="mm-footnote">One attempt only · thinking disabled · no reasoning contrasts. This is a smoke check, not a completed capability profile.</p><details class="mm-advanced" data-profile-disclosure="local-runtime"><summary>Local runtime and resource limits</summary><p>A cold model load may take time and consume substantial memory. GCB uses the existing runtime; this workspace does not manage model residency. The 128-token output cap is requested, not independently verified enforcement. A timeout or cancellation cannot prove inference has stopped.</p></details>':''}${progress}${state==='partial_unknown'||state==='cancelled'&&!canResume?'<p class="mm-notice">GCB has not confirmed a safe resumption for this run. Completed evidence is retained; unknown in-flight requests require review outside this workspace.</p>':''}
      ${bioHTML(item.bio,local)}${plan?recordedHTML(item):''}<p class="mm-footnote">Registration, benchmark authorization and live routing are separate. No agent assignment or Gateway configuration changes here.</p>`;
  }
  function recordedHTML(item) {
    const current=recorded?.targetId===item.id&&recorded.key===evidenceKey(item)?recorded:null;
    let content='<p>Open to inspect the response retained by GCB for each benchmark check.</p>';
    if(current?.loading)content='<p role="status">Loading recorded evidence…</p>';
    else if(current?.error)content=`<p role="alert">${esc(current.error)} Close and reopen these details to try reading again.</p>`;
    else if(current?.data){
      const data=current.data;
      content=`<p>Retained responses are shown separately from scores and expected answers. GCB retains only allowlisted structured output; original response formatting and other output may be unavailable.</p>${list(data.records).length?list(data.records).map(record=>{
        const attempts=list(record.attempts),last=attempts.at(-1),response=record.response||{};
        const missing=response.availability==='pending'?'Not measured — no response has been recorded.':response.availability==='not_applicable'?'Not applicable — this check did not produce a response.':'Response unavailable or not retained by GCB. It is not reconstructed from the expected answer.';
        return `<article class="mm-card mm-recorded-check"><h4>${esc(human(record.caseId))}</h4>${table([['Model',last?.servedModel||data.modelRef||item.modelRef],['Requested reasoning and settings',record.requestedNative?JSON.stringify(record.requestedNative):'Unavailable'],['Benchmark score',record.score===true?'Passed':record.score===false?'Did not pass':'Not measured'],['Recorded status',human(record.status)],['Input / output tokens',`${amount(last?.usage?.input_tokens)} / ${amount(last?.usage?.output_tokens)}`],['Elapsed',amount(last?.latencyMs,' ms')]])}<h5>Recorded response</h5>${response.availability==='retained'&&response.value!=null?`<p class="mm-profile-caption">Actual retained structured response (formatted for display).</p>${evidenceText(response.value)}`:`<p>${esc(missing)}</p>`}${record.criterion!=null?`<details class="mm-advanced"><summary>Expected answer / scoring criterion</summary>${evidenceText(record.criterion)}</details>`:''}${last?`<p class="mm-profile-caption">${last.effectiveNativeKnown===true?'Effective native settings were confirmed by the backend.':'Settings are recorded requests; the backend did not confirm effective settings.'}</p>`:''}</article>`;
      }).join(''):'<p>No recorded checks are available for this plan.</p>'}${textList(data.limitations)}`;
    }
    return `<details class="mm-advanced mm-recorded" data-profile-disclosure="responses"><summary data-profile-focus="responses">Recorded response</summary><div class="mm-recorded-body">${content}</div></details>`;
  }
  async function toggle(event) {
    if(event.target.dataset.profileDisclosure!=='responses'||!active)return;
    if(!event.target.open){if(recorded?.error)recorded=null;return;}
    const item=target();if(!item?.plan)return;
    const key=evidenceKey(item);
    if(recorded?.targetId===item.id&&recorded.key===key)return;
    const sequence=++evidenceSequence,generation=epoch;
    recorded={targetId:item.id,key,loading:true};paint();
    try {
      const data=await rpc('modelsProfileEvidence',{targetId:item.id});
      if(active&&generation===epoch&&sequence===evidenceSequence&&target()?.id===item.id&&evidenceKey(target())===key){recorded={targetId:item.id,key,data};paint();}
    } catch(failure){if(active&&generation===epoch&&sequence===evidenceSequence&&target()?.id===item.id){recorded={targetId:item.id,key,error:failure.message};paint();}}
  }
  function researchHTML(item) {
    const metadata=item.metadata,model=metadata?.model||item.bio?.documented_capabilities||{},reasoning=model.reasoning||{};
    const limits=model.execution_limits||item.bio?.execution_limits,host=item.mode==='openclaw';
    const intrinsicContext=limits?limits.intrinsic_context_window:model.context_window;
    const intrinsicOutput=limits?limits.intrinsic_max_output:model.max_output;
    const source=model.source;
    return `<div class="mm-card mm-profile-research"><div class="mm-section-heading"><h3>Researched capabilities</h3>${pill('GCB metadata','green')}</div><dl class="mm-metadata"><dt>Advertised context</dt><dd>${amount(intrinsicContext,' tokens')}</dd><dt>Input types</dt><dd>${esc(list(model.modalities).join(', ')||'Unknown')}</dd><dt>Reasoning</dt><dd>${esc(human(reasoning.semantics)||'Unknown')}</dd><dt>${host?'Requested settings':'Configurations'}</dt><dd>${list(reasoning.native_configurations).map(value=>`<span class="mm-native-setting">${esc(nativeName(value))}</span>`).join('')||'Unknown'}</dd>${host?'<dt>Effective effort</dt><dd>Unknown · not echoed by the native runtime</dd>':''}<dt>Tool support</dt><dd>${typeof model.native_tools==='boolean'?(model.native_tools?'Documented':host?'Disabled by isolation':'Not documented'):'Unknown'}</dd></dl><details class="mm-advanced" data-profile-disclosure="research"><summary>Research source and execution limits</summary><p>${esc(model.default_behavior||'Default behavior is not reported.')}</p>${table([['Source',typeof source==='object'?source?.title||'GCB research snapshot':source||'GCB research snapshot'],['Source URL',source?.url||'Not supplied'],['Checked at',source?.checked_at||'Not supplied'],['Metadata version',metadata?.metadata_version||item.bio?.metadata_version||'Unknown'],['Intrinsic maximum output',amount(intrinsicOutput,' tokens')],...(limits?[['Local prompt guard',amount(model.context_window)+' · '+human(limits.context_window_scope)],['Output request hint',amount(model.max_output)+' · '+human(limits.max_output_scope)]]:[]),['Evidence kind',human(metadata?.evidence_kind||item.bio?.evidence_kind||'unknown')]])}<p>Documented capabilities are claims to test. Requested reasoning settings may not be echoed as effective provider settings.</p></details></div>`;
  }
  function bioHTML(bio,local=false) {
    if(!bio||!list(bio.configurations).length)return '';
    const configurations=list(bio.configurations),hasEvidence=configurations.some(config=>config.attempt_count>0);
    if(!hasEvidence)return '';
    const categories=[...new Set(configurations.flatMap(config=>Object.keys(config.categories||{})))];
    const cells=(value)=>value?.observed?`${value.correct} / ${value.observed} passed`:value?.not_applicable?'Not applicable':value?.unknown_completion?'Unknown completion':value?.technical_errors?'Technical error':'Not measured';
    return `<section class="mm-profile-bio" aria-label="Capability bio"><div class="mm-section-heading"><h3>${local?'Partial capability bio':'Capability bio'}</h3>${pill(local?'Partial smoke evidence':bio.evidence_kind==='synthetic_fixture'?'Synthetic evidence':'Measured evidence',local||bio.evidence_kind==='synthetic_fixture'?'':'green')}</div><p class="mm-profile-caption">${esc(bio.uncertainty||'Small fixture results describe only the tested scope.')}</p><div class="mm-profile-table-scroll" tabindex="0" role="region" aria-label="Scrollable reasoning comparison"><table class="mm-comparison"><caption>Reasoning configuration comparison</caption><thead><tr><th scope="col">Capability</th>${configurations.map(config=>`<th scope="col">${esc(nativeName(config.native))}</th>`).join('')}</tr></thead><tbody>${categories.map(category=>`<tr><th scope="row">${esc(human(category))}</th>${configurations.map(config=>`<td>${esc(cells(config.categories?.[category]))}</td>`).join('')}</tr>`).join('')}<tr><th scope="row">Median latency</th>${configurations.map(config=>`<td>${amount(config.latency_ms?.median,' ms')}</td>`).join('')}</tr><tr><th scope="row">Reported input tokens</th>${configurations.map(config=>`<td>${amount(config.usage?.input_tokens)}</td>`).join('')}</tr><tr><th scope="row">Reported output tokens</th>${configurations.map(config=>`<td>${amount(config.usage?.output_tokens)}</td>`).join('')}</tr><tr><th scope="row">Billed cost</th>${configurations.map(config=>`<td>${config.usage?.billed_cost_usd==null?'Unknown':`$${amount(config.usage.billed_cost_usd)}`}</td>`).join('')}</tr></tbody></table></div>
      <div class="mm-profile-observations">${configurations.map(config=>`<div class="mm-card"><h4>${esc(nativeName(config.native))}</h4><h5>Observed strengths</h5>${list(config.strengths).length?textList(config.strengths):'<p>No passing evidence yet.</p>'}<h5>Observed limits</h5>${list(config.weaknesses).length?textList(config.weaknesses):'<p>No missed criteria in the measured checks. Untested work remains unknown.</p>'}${list(config.untested_categories).length?`<p>Not measured: ${esc(config.untested_categories.map(human).join(', '))}.</p>`:''}</div>`).join('')}</div><details class="mm-advanced" data-profile-disclosure="bio"><summary>Evidence sources and limitations</summary>${textList(bio.limitations)}${list(bio.research_sources).map(source=>`<p>${esc(source.title||source.kind||'GCB research source')}${source.url||source.uri||source.locator?`<br>${esc(source.url||source.uri||source.locator)}`:''}${source.checked_at?` · ${esc(source.checked_at)}`:''}</p>`).join('')}${table([['Suite',bio.suite_version||'Unknown'],['Scorer',bio.scorer_version||'Unknown']])}</details></section>`;
  }
  function routesHTML() {
    const item=target();
    if(!item)return '<div class="mm-empty"><h2>No profile selected</h2><p>Connect GCB and choose a target to preview its role suitability.</p></div>';
    const output=routes?.targetId===item.id?routes.values:null;
    const configs=list(item.bio?.configurations);
    return `<div class="mm-profile-title"><div><h3>${esc(item.name||item.modelRef||item.id)}</h3><p>${esc(item.modelRef||item.id)}</p></div>${pill('Preview-only','blue')}</div><p class="mm-intro">Compare eligibility for coding, independent review, research and planning. GCB’s policy explains every selection or rejection.</p>${item.mode==='offline'?'<p class="mm-notice">This is a synthetic example. Its recommendations do not qualify any real model.</p>':''}<div class="mm-actions">${button('preview','Preview recommendations',!enabled()||busy||!item.metadata?'disabled':'',true)}</div>${output?`<div class="mm-route-cards">${output.map(({role,preview})=>{
      const candidates=list(preview?.candidates),chosen=candidates.find(candidate=>candidate.configuration_id===preview?.selected_configuration_id),config=configs.find(value=>value.configuration_id===preview?.selected_configuration_id);
      return `<article class="mm-card"><div class="mm-section-heading"><h3>${esc(human(role))}</h3>${pill(chosen?'Suggested configuration':'No eligible configuration',chosen?'green':'amber')}</div><p>${chosen?esc(config?nativeName(config.native):chosen.model_id):'GCB did not find an eligible configuration for this role.'}</p><p class="mm-profile-caption">${esc(human(preview?.ranking||'No ranking returned'))}</p>${chosen?`<p>${amount(chosen.comparable_correct)} / ${amount(chosen.comparable_observed)} comparable checks passed · ${amount(chosen.comparable_latency_ms,' ms')} comparable latency</p>`:''}<details class="mm-advanced" data-profile-disclosure="route-${esc(role)}"><summary>Why this recommendation?</summary>${candidates.map(candidate=>`<div class="mm-route-reason"><strong>${esc(configs.find(config=>config.configuration_id===candidate.configuration_id)?nativeName(configs.find(config=>config.configuration_id===candidate.configuration_id).native):candidate.model_id)}</strong><p>${candidate.eligible?'Meets GCB’s current role policy.':'Does not meet GCB’s current role policy.'}</p>${list(candidate.reasons).length?textList(candidate.reasons.map(human)):''}</div>`).join('')||'<p>No candidates were returned.</p>'}</details></article>`;
    }).join('')}</div>`:'<div class="mm-card mm-routing-empty"><h3>Explainable recommendations</h3><p>Research a target and run the lightweight profile in Checks. Then preview which exact configuration fits each role, with the evidence and reasons behind it.</p></div>'}<div class="mm-card"><h3>Existing assignments stay yours</h3><p>Pre-inference enforcement is unsupported here. Recommendations do not admit a model, change an agent, activate routing, or restart the Gateway.</p>${button('unavailable-route','Activate live routing','disabled aria-describedby="mm-routing-preview-only"')}<p id="mm-routing-preview-only">Live routing remains unavailable in this milestone.</p></div>`;
  }
  async function action(operation, params = {}) {
    if(busy)return;
    busy=true;error='';const generation=epoch;paint();
    try {const result=await rpc(operation,params);if(active&&generation===epoch){if(operation!=='modelsProfilePreview')routes=null;await load();}return result;}
    catch(failure){if(active&&generation===epoch){error=failure.message;paint();}return null;}
    finally{busy=false;if(active&&generation===epoch)paint();}
  }
  function ensureDialog() {
    if(dialog)return;
    dialog=document.createElement('dialog');dialog.className='mm-dialog mm-profile-dialog';dialog.setAttribute('aria-labelledby','profile-dialog-title');
    dialog.addEventListener('click',click);dialog.addEventListener('change',change);
    dialog.addEventListener('keydown',event=>{
      event.stopPropagation();if(event.key!=='Tab'||event.ctrlKey||event.metaKey||event.altKey)return;
      const controls=[...dialog.querySelectorAll('button,input,summary')].filter(node=>!node.disabled&&node.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(first&&(!controls.includes(document.activeElement)||(event.shiftKey?document.activeElement===first:document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}
    });
    dialog.addEventListener('close',()=>{review=null;dialogSequence++;if(active)returnFocus?.isConnected?returnFocus.focus({preventScroll:true}):restoreFocus('plan');returnFocus=null;});document.body.append(dialog);
  }
  async function planReview() {
    const item=target();if(!item||busy)return;
    const generation=epoch,id=item.id,connection=connectionEpoch;
    const result=await action('modelsProfilePlan',{targetId:id,contrast:contrastFor(item)});
    if(!result||!active||generation!==epoch||selected!==id)return;
    if(item.mode!=='offline'&&connection!==connectionEpoch){error='The OpenClaw connection changed. Review this target again before authorizing usage.';paint();return;}
    if(!result.reviewToken||!result.plan){error='GCB did not return a reviewable benchmark plan.';paint();return;}
    const reviewed=result.target||target(),plan=result.plan,hostRuntime=reviewed?.mode==='openclaw',local=reviewed?.mode==='ollama';
    const configurations=list(plan.configuration_ids).map(id=>list(reviewed?.bio?.configurations).find(config=>config.configuration_id===id));
    if(!['offline','openclaw','ollama'].includes(reviewed?.mode)||!configurations.length||configurations.some(config=>!config?.native||typeof config.native!=='object'||Array.isArray(config.native))){
      error='The exact native settings for this plan are unavailable. Research the target again before authorizing usage.';paint();return;
    }
    ensureDialog();review={...result,target:reviewed};returnFocus=document.activeElement;dialogSequence++;
    const rows=[['Model',reviewed.modelRef||reviewed.name||reviewed.id],
      [local?'GCB cases in scope (one attempt only)':'Checks',list(plan.cells).length],
      ['Reasoning configurations',configurations.length],
      ...configurations.map((config,index)=>['Exact native settings '+(index+1),JSON.stringify(config.native)]),
      [hostRuntime?'Maximum host invocations':local?'Maximum local attempts':'Maximum requests',plan.max_requests??'Unknown'],
      [local?'Requested output cap':'Output hint per request',amount(plan.max_output_tokens,' tokens')],
      ['Concurrency',plan.concurrency??'Unknown'],['Per-call wait limit',amount(plan.call_timeout_seconds,' seconds')],
      ['Total time budget',amount(plan.total_timeout_seconds,' seconds')],
      ['Estimated cost',plan.estimated_cost_usd==null?'Unknown':`$${amount(plan.estimated_cost_usd)}`],['Billed cost','Unknown']];
    const intro=hostRuntime?'Run this exact scope through native OpenClaw. Provider usage or subscription limits may apply.':local
      ?'Run at most one attempt directly through the configured local Ollama runtime. This uses local compute and produces a partial bio, not a full capability profile.'
      :'Run GCB’s deterministic offline example. No provider is contacted and no paid usage is incurred.';
    const limits=hostRuntime?'The output value is an advisory hint and may be ignored by the native runtime; it is not a verified output or billing cap. Underlying provider request counts, native retries and billing can be unknown. Registration does not authorize this usage.':local
      ?'Thinking is disabled and reasoning contrasts are excluded. The output cap is requested, not independently verified enforcement. One attempt can leave most GCB cases unmeasured. Cold loading may consume time and memory; cancellation does not prove the local runtime has stopped.'
      :'Synthetic usage and latency are demonstration data. They do not describe a real provider.';
    dialog.innerHTML=`<div class="mm-dialog-head"><h2 id="profile-dialog-title">${local?'Review local smoke usage':result.resumed?'Review remaining benchmark':'Review benchmark usage'}</h2>${button('close-review','×','aria-label="Close benchmark review"')}</div><div class="mm-dialog-body"><div class="mm-dialog-error" data-profile-error role="alert"></div><p class="mm-dialog-copy">${esc(intro)}</p>${table(rows)}<p class="mm-dialog-note">${esc(limits)}${result.resumed?' Completed checks are retained; only safely resumable work continues.':''}</p><details class="mm-advanced"><summary>Included checks and configuration identities</summary>${textList([...new Set(list(plan.cells).map(cell=>human(cell.case_id)))])}${table(configurations.map((config,index)=>['Configuration '+(index+1),config.configuration_id]))}</details><label class="mm-confirm"><input type="checkbox" data-profile-input="approve-usage"> <span>${hostRuntime?'I authorize this displayed benchmark scope and its possible provider or subscription usage.':local?'I authorize this one-attempt smoke test and its local compute usage.':'I approve this offline benchmark scope.'}</span></label>${hostRuntime?'<label class="mm-confirm"><input type="checkbox" data-profile-input="approve-host"> <span>I authorize the native OpenClaw host runtime for this benchmark. Existing OpenClaw permissions still apply.</span></label>':''}<div class="mm-dialog-actions">${button('close-review','Cancel')}${button('start',local?'Authorize local smoke test':result.resumed?'Authorize and resume':'Authorize and start','disabled',true)}</div></div>`;
    dialog.showModal();
  }
  async function start() {
    if(!review||busy||!dialog?.querySelector('[data-profile-input="approve-usage"]')?.checked)return;
    const hostRuntime=review.target.mode==='openclaw',hostApproved=dialog.querySelector('[data-profile-input="approve-host"]')?.checked===true;
    if(hostRuntime&&!hostApproved)return;
    const sequence=dialogSequence;busy=true;dialog.querySelector('[data-profile-action="start"]').disabled=true;
    try {routes=null;await rpc('modelsProfileStart',{reviewToken:review.reviewToken,approveUsage:true,approveHostRuntime:hostApproved});if(dialogSequence===sequence){dismissDialog();onStatus('GCB profiling started. Progress and partial evidence appear in Checks.');}await load();}
    catch(failure){if(dialogSequence===sequence){review=null;dialog.querySelector('[data-profile-error]').textContent=failure.message+' Close this review and prepare a new plan before another attempt.';}}
    finally{busy=false;paint();}
  }
  async function click(event) {
    // Clear failed reads on the user's close action, before native toggle events
    // can coalesce during a quick keyboard close/reopen.
    if(event.target.closest('[data-profile-disclosure="responses"] > summary')&&recorded?.error){recorded=null;}
    const control=event.target.closest('[data-profile-action]');if(!control||control.disabled||destroyed)return;
    const name=control.dataset.profileAction,item=target();
    if(name==='select'){const details=host.querySelector('[data-profile-disclosure="responses"]');if(details)details.open=false;recorded=null;evidenceSequence++;selected=control.dataset.targetId;requestedRef='';error='';routes=null;paint();}
    else if(name==='connect')await action('modelsProfileConnect');
    else if(name==='import')await action('modelsProfileImport');
    else if(name==='prepare-local'&&requestedRef.startsWith('ollama/'))await action('modelsProfileLocal',{modelRef:requestedRef});
    else if(name==='research'&&item)await action('modelsProfileResearch',{targetId:item.id});
    else if(name==='plan')await planReview();
    else if(name==='start')await start();
    else if(name==='pause'&&item)await action('modelsProfilePause',{targetId:item.id});
    else if(name==='cancel'&&item)await action('modelsProfileCancel',{targetId:item.id});
    else if(name==='preview'&&item){const id=item.id,generation=epoch,connection=connectionEpoch,evidence=evidenceKey(item),result=await action('modelsProfilePreview',{targetId:id});if(result&&active&&generation===epoch&&selected===id&&evidence===evidenceKey(target())&&(item.mode==='offline'||connection===connectionEpoch)){routes={targetId:id,evidence,values:list(result.routes)};paint();}}
    else if(name==='close-review')dismissDialog();
  }
  function change(event) {
    if(event.target.dataset.profileInput==='contrast'&&target())contrasts.set(target().id,event.target.checked);
    if(['approve-usage','approve-host'].includes(event.target.dataset.profileInput)&&review){
      const approved=dialog.querySelector('[data-profile-input="approve-usage"]')?.checked&&(review.target.mode!=='openclaw'||dialog.querySelector('[data-profile-input="approve-host"]')?.checked);
      dialog.querySelector('[data-profile-action="start"]').disabled=!approved||busy;
    }
  }
  function dismissDialog(){if(dialog?.open)dialog.close();}
  function close(){active=false;epoch++;pending=null;recorded=null;evidenceSequence++;clearTimeout(timer);timer=null;dismissDialog();}
  function invalidateConnection(){connectionEpoch++;if(target()?.mode!=='offline')routes=null;if(review?.target?.mode!=='offline')dismissDialog();if(active)load();}
  function destroy(){close();destroyed=true;host?.removeEventListener('click',click);host?.removeEventListener('change',change);host?.removeEventListener('toggle',toggle,true);dialog?.remove();}
  return {render,load,close,destroy,dismissDialog,invalidateConnection,isDialogOpen:()=>Boolean(dialog?.open)};
}
