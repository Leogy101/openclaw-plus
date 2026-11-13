// One bounded terminal viewer per exact conversation. OpenClaw owns every shell.
const keyOf=context=>JSON.stringify([context?.agentId||'',context?.key||'',context?.sessionId||'']);
const contextOf=context=>({key:context.key,agentId:context.agentId,sessionId:context.sessionId});
const messageOf=error=>error?.message||String(error);
// A maximum-size replay includes the ordered two-character terminal reset.
const MAX_PENDING_OUTPUT=2*1024*1024+2;
let libraries;
const loadLibraries=()=>libraries??=Promise.all([import('./vendor/xterm.mjs'),import('./vendor/addon-fit.mjs')]);

export function createTerminalView({desktop,split,mount,separator,toggleButton,nameFor,onShare,onBeforeLayout,onAfterLayout,notify}) {
  const records=new Map();let current=null,visible=false,preferred='below',sizeBelow=240,sizeBeside=400,frame=0,layoutKey='',composer=null,drag=null;
  mount.innerHTML='<div class="terminal-toolbar"><div class="terminal-heading"><h2>Terminal</h2><span id="terminal-context"></span></div><div class="terminal-actions"><label class="sr-only" for="terminal-orientation">Terminal position</label><select id="terminal-orientation" aria-label="Terminal position"><option value="below">Below chat</option><option value="beside">Beside chat</option></select><button class="text-btn" data-terminal-action="hide" aria-label="Hide terminal">Hide</button></div></div><div class="terminal-status-row"><span id="terminal-status" role="status"></span><div class="terminal-actions"><button class="button" data-terminal-action="start">Start terminal</button><button class="button" data-terminal-action="attach">Reconnect terminal</button><button class="text-btn" data-terminal-action="detach">Disconnect terminal</button></div></div><div id="terminal-meta" class="terminal-meta"></div><div id="terminal-notice" class="terminal-notice" role="status"></div><div id="terminal-surface" class="terminal-surface"><div id="terminal-empty" class="terminal-empty">Start a terminal for this exact conversation.</div></div><div class="terminal-footer"><button class="button" data-terminal-action="share" disabled>Add selection to message</button><span id="terminal-selection">Select output to prepare a message. Sending stays explicit.</span></div>';
  const query=selector=>mount.querySelector(selector),surface=query('#terminal-surface'),empty=query('#terminal-empty'),orientation=query('#terminal-orientation');
  const button=action=>query(`[data-terminal-action="${action}"]`);
  const recordFor=(context,create=false)=>{
    if(!context?.key||!context?.sessionId)return null;const key=keyOf(context);
    if(!records.has(key)&&create){
      if(records.size>=4){const victim=[...records].find(([id,record])=>id!==key&&!record.attached&&!record.busy);if(victim){victim[1].terminal?.dispose();victim[1].element?.remove();records.delete(victim[0]);}}
      if(records.size>=4)return null;
      records.set(key,{context:contextOf(context),snapshot:null,terminal:null,fit:null,element:null,attached:false,busy:false,listed:false,error:'',limitations:[],resizePending:null,resizing:false,dimensions:null,pendingOutput:0,overflow:false});
    }
    return records.get(key)||null;
  };
  const active=()=>current?recordFor(current):null;
  const ready=record=>record?.attached&&record.snapshot?.status==='ready'&&!record.busy;
  const request=(action,record,extra={})=>{
    if(!desktop?.terminal)throw new Error('The native terminal bridge is unavailable.');
    return desktop.terminal(action,{...record.context,...extra});
  };
  const theme=()=>{const style=getComputedStyle(document.documentElement);return {background:style.getPropertyValue('--bg').trim()||'#161314',foreground:style.getPropertyValue('--text').trim()||'#f4f0f3',cursor:style.getPropertyValue('--accent').trim()||'#ff6975',selectionBackground:style.getPropertyValue('--selection-bg').trim()||'#74313f',selectionForeground:style.getPropertyValue('--text').trim()||'#f4f0f3'};};
  function update() {
    const record=active(),snapshot=record?.snapshot,status=record?.busy?'connecting':snapshot?.status||'empty';
    query('#terminal-context').textContent=current?`${nameFor(current.agentId)} · ${current.title||'Conversation'}`:'Choose a conversation';
    const labels={empty:'Not started',ready:record?.attached?'Connected':'Available to reconnect',connecting:'Connecting…',disconnected:'Disconnected',detached:'Viewer disconnected',exited:'Shell exited',stale:'Conversation changed',unavailable:'Unavailable'};
    query('#terminal-status').textContent=labels[status]||'Status unavailable';query('#terminal-status').dataset.state=status;
    query('#terminal-meta').textContent=[snapshot?.cwd?`Opened in ${snapshot.cwd}`:'',snapshot?.shell].filter(Boolean).join(' · ');
    query('#terminal-notice').textContent=record?.error||snapshot?.message||(!snapshot?.terminalId?(record?.limitations||[]).join(' '):'')||(!record&&current?'Four terminal views are retained. Exit an existing shell, then reopen this pane.':'');
    button('start').hidden=Boolean(snapshot?.terminalId&&!['exited','stale'].includes(status));
    button('start').textContent=['exited','stale'].includes(status)?'Start new terminal':'Start terminal';
    button('start').disabled=!record||record.busy||!current?.sessionId;
    button('attach').hidden=!snapshot?.terminalId||!['ready','detached','disconnected'].includes(status)||Boolean(record?.attached);
    button('attach').disabled=!record||record.busy;
    button('detach').hidden=!record?.attached;button('detach').disabled=Boolean(record?.busy);
    for(const item of records.values()){if(item.element)item.element.hidden=item!==record;if(item.terminal)item.terminal.options.disableStdin=!ready(item);}
    empty.hidden=Boolean(record?.terminal);empty.textContent=current?'Start a terminal for this exact conversation. Commands run in OpenClaw; only selected output is added to chat.':'Choose a conversation before starting a terminal.';
    selectionChanged();
  }
  function selectionChanged() {
    const record=active(),selection=record?.terminal?.getSelection()||'';
    button('share').disabled=!selection||!record||keyOf(record.context)!==keyOf(current);
    const sharing=current?`Shared with ${nameFor(current.agentId)} through this conversation; existing OpenClaw permissions apply.`:'Select a conversation to use its terminal.';
    query('#terminal-selection').textContent=(selection?`${selection.length.toLocaleString()} characters selected · `:'')+sharing;
  }
  async function ensureTerminal(record) {
    if(record.terminal)return;
    const [{Terminal},{FitAddon}]=await loadLibraries();
    const terminal=new Terminal({scrollback:2000,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12,cursorBlink:true,disableStdin:true,theme:theme(),linkHandler:{activate(){}},screenReaderMode:true});
    const fit=new FitAddon();terminal.loadAddon(fit);
    const element=document.createElement('div');element.className='terminal-instance';element.hidden=record!==active();surface.append(element);
    Object.assign(record,{terminal,fit,element});terminal.open(element);
    terminal.onSelectionChange(()=>{if(record===active())selectionChanged();});
    terminal.onData(data=>{
      if(record!==active()||!visible||!ready(record)||!data)return;
      if(new TextEncoder().encode(data).length>16384){record.error='That input is too large. Paste a smaller selection.';update();return;}
      request('input',record,{terminalId:record.snapshot.terminalId,data}).catch(error=>{record.error=`Input was not confirmed. ${messageOf(error)} No input was retried.`;record.attached=false;record.snapshot={...record.snapshot,status:'disconnected'};if(record===active())update();});
    });
    update();scheduleLayout();
  }
  function applySnapshot(record,snapshot) {
    if(!snapshot||keyOf(snapshot.context)!==keyOf(record.context))throw new Error('Terminal response belongs to a different conversation.');
    record.snapshot={...snapshot};
    if(['disconnected','detached','exited','stale','unavailable'].includes(snapshot.status))record.attached=false;
  }
  async function list(record) {
    if(!record||record.listed||record.busy)return;record.listed=true;
    try{const result=await request('list',record);record.limitations=result.limitations||[];const snapshot=(result.terminals||[]).find(item=>keyOf(item.context)===keyOf(record.context));if(snapshot&&!record.busy&&!record.attached)applySnapshot(record,snapshot);}
    catch(error){record.error=messageOf(error);}
    if(record===active())update();
  }
  async function operate(action) {
    const record=active();if(!record||record.busy)return;
    const terminalId=record.snapshot?.terminalId;if(action!=='open'&&!terminalId)return;
    record.busy=true;record.operation=action;if(action!=='detach')record.overflow=false;record.error='';update();
    try{
      if(action!=='detach'){await ensureTerminal(record);record.fit.fit();}
      const extra=action==='open'?{cols:record.terminal.cols,rows:record.terminal.rows}:{terminalId};
      const snapshot=await request(action,record,extra);applySnapshot(record,snapshot);
      record.attached=action!=='detach'&&snapshot.status==='ready'&&!record.overflow;
      if(record===active()&&visible&&record.attached)record.terminal.focus();
    }catch(error){record.error=messageOf(error);record.attached=false;}
    finally{record.busy=false;record.operation=null;if(record===active()){update();scheduleLayout();}}
  }
  async function flushResize(record) {
    if(record.resizing||!record.resizePending||!ready(record))return;
    const dimensions=record.resizePending;record.resizePending=null;record.resizing=true;
    try{await request('resize',record,{terminalId:record.snapshot.terminalId,...dimensions});record.dimensions=dimensions;}
    catch(error){record.error=`Terminal resize unavailable. ${messageOf(error)}`;if(record===active())update();}
    finally{record.dimensions=dimensions;record.resizing=false;if(record.resizePending)flushResize(record);}
  }
  function fitActive() {
    const record=active();if(!visible||!record?.terminal||!surface.clientWidth||!surface.clientHeight)return;
    try{record.fit.fit();const dimensions={cols:record.terminal.cols,rows:record.terminal.rows};if(ready(record)&&JSON.stringify(dimensions)!==JSON.stringify(record.dimensions)){record.resizePending=dimensions;flushResize(record);}}
    catch(error){record.error=messageOf(error);update();}
  }
  function applyLayout() {
    frame=0;
    const width=split.clientWidth,height=split.clientHeight,effective=preferred==='beside'&&width>=860?'beside':'below';
    const nextComposer=split.querySelector('.composer-wrap');if(nextComposer!==composer){if(composer)observer.unobserve(composer);composer=nextComposer;if(composer)observer.observe(composer);}
    const minChat=Math.max(250,(composer?.offsetHeight||0)+120),terminalSize=effective==='beside'?Math.max(320,Math.min(sizeBeside,width-400-6)):Math.max(180,Math.min(sizeBelow,Math.max(180,height-minChat-6)));
    const chatHeight=Math.max(minChat,height-terminalSize-6);
    const key=visible?JSON.stringify([width,height,effective,terminalSize,effective==='below'?chatHeight:0]):'hidden';
    if(key!==layoutKey){const saved=onBeforeLayout?.();layoutKey=key;
      split.classList.toggle('terminal-open',visible);split.classList.toggle('terminal-beside',visible&&effective==='beside');
      split.style.gridTemplateColumns=visible&&effective==='beside'?`minmax(400px,1fr) 6px ${terminalSize}px`:'minmax(0,1fr)';
      split.style.gridTemplateRows=visible&&effective==='below'?`${chatHeight}px 6px ${terminalSize}px`:'minmax(0,1fr)';
      mount.hidden=!visible;separator.hidden=!visible;toggleButton.setAttribute('aria-expanded',String(visible));
      separator.setAttribute('aria-orientation',effective==='below'?'horizontal':'vertical');separator.setAttribute('aria-valuenow',String(Math.round(terminalSize)));separator.setAttribute('aria-valuemin',effective==='below'?'180':'320');separator.setAttribute('aria-valuemax',String(Math.max(terminalSize,effective==='below'?height-minChat-6:width-406)));
      orientation.querySelector('[value="beside"]').disabled=width<860;orientation.value=effective;
      requestAnimationFrame(()=>onAfterLayout?.(saved));
    }
    fitActive();
  }
  function scheduleLayout(){if(!frame)frame=requestAnimationFrame(applyLayout);}
  const observer=new ResizeObserver(scheduleLayout);observer.observe(split);observer.observe(surface);
  function setVisible(value) {visible=Boolean(value);if(visible){const record=recordFor(current,true);update();list(record);}scheduleLayout();if(!visible)toggleButton.focus({preventScroll:true});}
  mount.addEventListener('click',event=>{
    const target=event.target.closest('[data-terminal-action]');if(!target||target.disabled)return;
    const action=target.dataset.terminalAction;
    if(action==='hide')setVisible(false);
    if(action==='start')operate('open');
    if(action==='attach')operate('attach');
    if(action==='detach')operate('detach');
    if(action==='share'){
      const record=active(),selection=record?.terminal?.getSelection()||'';if(!selection||keyOf(record.context)!==keyOf(current))return;
      if(selection.length>32768){notify('Select a smaller output range (up to 32,768 characters).');return;}
      onShare({...record.context},selection,{...record.snapshot});
    }
  });
  orientation.addEventListener('change',()=>{preferred=orientation.value;scheduleLayout();});
  separator.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();separator.focus();separator.setPointerCapture(event.pointerId);drag={id:event.pointerId,x:event.clientX,y:event.clientY,size:mount.getBoundingClientRect()[separator.getAttribute('aria-orientation')==='horizontal'?'height':'width'],vertical:separator.getAttribute('aria-orientation')==='vertical'};});
  separator.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;if(drag.vertical)sizeBeside=drag.size+drag.x-event.clientX;else sizeBelow=drag.size+drag.y-event.clientY;scheduleLayout();});
  separator.addEventListener('pointerup',()=>drag=null);separator.addEventListener('pointercancel',()=>drag=null);
  separator.addEventListener('keydown',event=>{const vertical=separator.getAttribute('aria-orientation')==='vertical';if(![vertical?'ArrowLeft':'ArrowUp',vertical?'ArrowRight':'ArrowDown'].includes(event.key))return;event.preventDefault();const delta=['ArrowLeft','ArrowUp'].includes(event.key)?24:-24;if(vertical)sizeBeside=mount.clientWidth+delta;else sizeBelow=mount.clientHeight+delta;scheduleLayout();});
  const unsubscribe=desktop?.onTerminalEvent?.(event=>{
    const record=recordFor(event?.context);if(!record)return;
    try{
      if(event.kind==='status'){if(record.snapshot?.terminalId&&event.snapshot?.terminalId!==record.snapshot.terminalId&&record.operation!=='open')return;applySnapshot(record,event.snapshot);}
      if(event.kind==='data'){
        if(record.snapshot?.terminalId&&event.terminalId!==record.snapshot.terminalId&&record.operation!=='open')return;
        if(!record.terminal||typeof event.data!=='string'||record.overflow)return;
        const output=(event.reset?'\x1bc':'')+event.data;
        if(record.pendingOutput+output.length>MAX_PENDING_OUTPUT){
          record.overflow=true;record.attached=false;record.terminal.options.disableStdin=true;
          record.error='Output could not keep up. This viewer is disconnected; reconnect to replay the terminal. The shell was not stopped.';
          record.snapshot={...record.snapshot,context:record.context,terminalId:event.terminalId,status:'disconnected'};
          request('detach',record,{terminalId:event.terminalId}).catch(()=>{});
        }else{record.pendingOutput+=output.length;record.terminal.write(output,()=>{record.pendingOutput=Math.max(0,record.pendingOutput-output.length);});}
      }
      if(record===active())update();
    }catch(error){record.error=messageOf(error);if(record===active())update();}
  });
  return {
    setContext(context){const changed=keyOf(current)!==keyOf(context);current=context?.key?{...context}:null;if(visible){const record=recordFor(current,true);if(changed){update();list(record);}}scheduleLayout();},
    toggle(){setVisible(!visible);},setVisible,
    setTheme(){for(const record of records.values())if(record.terminal)record.terminal.options.theme=theme();},
    layout:scheduleLayout,
    dispose(){unsubscribe?.();observer.disconnect();cancelAnimationFrame(frame);for(const record of records.values())record.terminal?.dispose();records.clear();}
  };
}
