const MAX_REPORT = 262144;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const AUDIO_TYPES = new Set(['audio/mpeg','audio/wav','audio/ogg','audio/mp4','audio/webm']);

// Speech uses prose from the visible report, never tools, hidden reasoning or directives.
export function speechText(value) {
  if (typeof value !== 'string' || value.length > MAX_REPORT || !value.isWellFormed()) throw new Error('This report is too large or cannot be read aloud.');
  const lines=[];let fence=null;
  for(const line of value.split(/\r?\n/)) {
    const marker=line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;continue;}
    if(!fence)lines.push(line);
  }
  return lines.join('\n')
    .replace(/\[\[\/?tts(?::[^\]]*)?\]\]/gi,'')
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g,'$1')
    .replace(/<[^>\n]*>/g,'')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]*|[-+*][ \t]+|\d+[.)][ \t]+)/gm,'')
    .replace(/(`+)([^`]+)\1/g,'$2')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g,'$1')
    .replace(/__([^_\n]+)__/g,'$1')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')
    .replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}

export function speechChunks(text,limit) {
  if(!Number.isSafeInteger(limit)||limit<2||limit>4000)throw new Error('OpenClaw did not provide a usable speech text limit.');
  const chunks=[];let remaining=text.trim();
  while(remaining.length) {
    if(remaining.length<=limit){chunks.push(remaining);break;}
    let end=limit;
    if(/[\uD800-\uDBFF]/.test(remaining[end-1]))end--;
    const head=remaining.slice(0,end),minimum=Math.floor(end/2);
    const sentence=[...head.matchAll(/[.!?](?:["')\]]*)\s+|\n+/g)].at(-1);
    if(sentence&&sentence.index+sentence[0].length>=minimum)end=sentence.index+sentence[0].length;
    else {const space=head.search(/\s+\S*$/);if(space>=minimum)end=space;}
    const chunk=remaining.slice(0,end).trim();if(chunk)chunks.push(chunk);
    remaining=remaining.slice(end).trimStart();
  }
  return chunks;
}

function audioBlob(result) {
  if(!result||!AUDIO_TYPES.has(result.mimeType)||typeof result.audioBase64!=='string'||!result.audioBase64.length||result.audioBase64.length>4*Math.ceil(MAX_AUDIO_BYTES/3)||
    result.audioBase64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.audioBase64))throw new Error('OpenClaw returned unsupported audio.');
  const decoded=atob(result.audioBase64);
  if(decoded.length>MAX_AUDIO_BYTES||btoa(decoded)!==result.audioBase64)throw new Error('OpenClaw returned unsupported audio.');
  return new Blob([Uint8Array.from(decoded,c=>c.charCodeAt(0))],{type:result.mimeType});
}

export function createReadAloud({rpc,onChange=()=>{},onError=()=>{},createAudio=()=>new Audio(),createURL=blob=>URL.createObjectURL(blob),revokeURL=url=>URL.revokeObjectURL(url)}) {
  let current=null;
  function stop() {
    const previous=current;if(!previous)return;
    current=null;previous.cancelled=true;previous.release?.();onChange(null);
  }
  async function play(record,result) {
    const blob=audioBlob(result),audio=createAudio();
    if(!audio.canPlayType(blob.type))throw new Error('This audio format cannot be played on this Mac.');
    const url=createURL(blob);let settle;
    const finished=new Promise((resolve,reject)=>{
      const ended=()=>resolve(),failed=()=>reject(new Error('Audio playback failed. Choose Read aloud to try again.'));
      audio.addEventListener('ended',ended);audio.addEventListener('error',failed);
      record.release=()=>{
        audio.removeEventListener('ended',ended);audio.removeEventListener('error',failed);
        audio.pause();audio.removeAttribute('src');audio.load();revokeURL(url);record.release=null;resolve();
      };
      settle={reject};
    });
    try {
      audio.preload='auto';audio.src=url;
      Promise.resolve(audio.play()).then(()=>{
        if(current===record){record.phase='playing';onChange(record);}
      },()=>settle.reject(new Error('Audio could not start. Choose Read aloud to try again.')));
      await finished;
    } finally {record.release?.();}
  }
  async function start(key,text) {
    stop();const record={key,text,phase:'loading',cancelled:false,chunk:0,total:0};current=record;onChange(record);
    try {
      const prose=speechText(text);if(!prose)throw new Error('This report has no prose to read aloud.');
      const options=await rpc('speechOptions',{});if(current!==record)return;
      if(options?.available!==true)throw new Error(options?.reason||'Read aloud is unavailable. Configure speech in original OpenClaw.');
      const chunks=speechChunks(prose,Math.min(options.maxTextLength,4000));record.total=chunks.length;
      for(const [index,chunk]of chunks.entries()) {
        if(current!==record)return;
        record.chunk=index+1;record.phase='loading';onChange(record);
        const result=await rpc('speak',{text:chunk});if(current!==record)return;
        await play(record,result);
      }
      if(current===record)stop();
    } catch(error) {
      if(current!==record)return;
      stop();onError(error);
    }
  }
  return {get current(){return current;},start,stop};
}
