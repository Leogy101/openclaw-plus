'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const unavailable=message=>{throw new Error(message);};
const inside=(root,file)=>file.startsWith(root+path.sep);
const LIMITATIONS=[
  'These are source-labeled project declarations, not live execution status or permission to act.',
  'This record has no explicit general current-blocker selector. Historical fields may conflict; no current blocker is inferred.'
];

async function readBounded(file,limit,device) {
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    if(!before.isFile()||before.size>limit||(device!==undefined&&before.dev!==device)) unavailable('A selected project file is unavailable or outside its allowed size or volume.');
    const bytes=Buffer.alloc(before.size+1);
    let length=0;
    while(length<bytes.length) {
      const read=await handle.read(bytes,length,bytes.length-length,length);
      if(!read.bytesRead)break;
      length+=read.bytesRead;
    }
    const after=await handle.stat();
    if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs) unavailable('The selected project record changed during observation. Refresh to read a consistent snapshot.');
    return bytes.subarray(0,length);
  } finally {await handle.close();}
}

// Constructor options are main-process test/dependency injection, never renderer input.
// The public application has no implicit project paths or disk authority.
function createProjectObserver({indexPath,allowedRoot,volumeCheck,expectedScope='ISOLATED_PROJECT_ENGINEERING_ONLY',now=Date.now}={}) {
  const configured=typeof indexPath==='string'&&path.isAbsolute(indexPath)&&typeof allowedRoot==='string'&&path.isAbsolute(allowedRoot)
    &&typeof volumeCheck==='function'&&typeof expectedScope==='string'&&expectedScope.length>0&&expectedScope.length<=128;
  const root=configured?path.resolve(allowedRoot):null,cursorPath=configured?path.join(root,'PROJECT_STATUS.json'):null;
  let volumeCache=null,inFlight=null;
  async function selectedPath(input) {
    if(typeof input!=='string'||!path.isAbsolute(input)||input.length>4096||/[\x00-\x1f\x7f]/.test(input)||!inside(root,path.resolve(input))) unavailable('The selected project path is outside the allowed project.');
    const resolved=await fs.realpath(input);
    if(!inside(root,resolved)) unavailable('The selected project path resolves outside the allowed project.');
    return resolved;
  }
  async function observe() {
    const observedAt=new Date(now()).toISOString();
    const result={available:false,sourcePath:cursorPath,observedAt,updatedAt:null,sha256:null,selectionVerified:false,fields:[],currentBlocker:'unselected',limitations:[...LIMITATIONS]};
    if(!configured) {
      result.limitations.push('Project status observation is not configured. No local project files were read.');
      return result;
    }
    try {
      if(await fs.realpath(root)!==root) unavailable('The selected project root is unavailable or redirected.');
      const rootStat=await fs.stat(root);
      if(!rootStat.isDirectory())unavailable('The selected project root is unavailable.');
      const identity=`${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeMs}`;
      if(!volumeCache||volumeCache.identity!==identity||now()-volumeCache.at>=60000||now()<volumeCache.at) {
        volumeCache={identity,at:now(),verified:false};
        volumeCache.verified=(await volumeCheck({device:rootStat.dev}))===true;
      }
      if(!volumeCache.verified) unavailable('The selected project volume could not be authenticated.');
      const indexBytes=await readBounded(indexPath,262144),index=JSON.parse(indexBytes.toString('utf8'));
      const selection=index?.development_workflow,descriptor=selection?.charter;
      if(!object(selection)||selection.selection_state!=='ACTIVE_FROZEN'||selection.scope!==expectedScope
        ||!object(descriptor)||!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>65536
        ||typeof descriptor.sha256!=='string'||!/^[a-f0-9]{64}$/.test(descriptor.sha256)) unavailable('The project selection is unavailable or not a supported active frozen selection.');
      if(selection.task_cursor!==cursorPath)unavailable('The selected project cursor does not match the allowed project record.');
      const charter=await readBounded(await selectedPath(descriptor.path),65536,rootStat.dev);
      if(charter.length!==descriptor.bytes||hash(charter)!==descriptor.sha256)unavailable('The selected charter does not match its recorded bytes and hash.');
      const cursor=await readBounded(await selectedPath(cursorPath),8388608,rootStat.dev),document=JSON.parse(cursor.toString('utf8'));
      if(!object(document)||document.schema!==1)unavailable('The selected project record schema is unsupported.');
      if(!indexBytes.equals(await readBounded(indexPath,262144)))unavailable('The project selection changed during observation. Refresh to read its new selection.');
      for(const key of ['current_state','current_task','next_action']) {
        if(typeof document[key]!=='string'||!document[key].trim())continue;
        const value=document[key].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
        result.fields.push({path:key,value:value.length>1200?value.slice(0,1199)+'…':value});
      }
      if(typeof document.updated_utc==='string'&&document.updated_utc.length<=64&&Number.isFinite(Date.parse(document.updated_utc)))result.updatedAt=document.updated_utc;
      else result.limitations.push('The project record has no usable recorded update timestamp.');
      result.available=true;result.selectionVerified=true;result.sha256=hash(cursor);
      if(!result.fields.length)result.limitations.push('No supported top-level status declarations are present.');
      return result;
    } catch(error) {
      // Never forward filesystem/JSON bodies, raw paths from failed selections, or child-process output.
      const safe=error?.code?'The selected project record is unavailable. Check its volume and file access.':error instanceof SyntaxError?'The selected project record is not valid JSON.':error?.message;
      result.limitations.push(typeof safe==='string'&&safe.length<=200?safe:'The selected project record is unavailable.');
      return result;
    }
  }
  return function readProjectObservation() {
    if(!inFlight)inFlight=observe().finally(()=>{inFlight=null;});
    return inFlight;
  };
}

const readProjectObservation=createProjectObserver();
module.exports={createProjectObserver,readProjectObservation};
