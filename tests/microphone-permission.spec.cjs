'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MicrophonePermission}=require('../desktop/src/microphone-permission.cjs');
const entry='openclaw-plus://ui/index.html';
test('microphone access requires an explicit fresh grant and the exact main frame',async()=>{
 let now=100;const contents={},gate=new MicrophonePermission({entry,contents:()=>contents,now:()=>now});
 const request={isMainFrame:true,requestingUrl:entry,mediaTypes:['audio']};
 assert.equal(gate.allow(contents,'media',request),false);
 assert.deepEqual(await gate.request(async()=>true),{granted:true});
 assert.equal(gate.allow(contents,'media',request),true);
 for(const [sender,permission,details]of [[{},'media',request],[contents,'display-capture',request],[contents,'media',{...request,isMainFrame:false}],
  [contents,'media',{...request,requestingUrl:'https://example.invalid'}],[contents,'media',{...request,mediaTypes:['video']}],
  [contents,'media',{...request,mediaTypes:['audio','video']}],[contents,'media',{...request,mediaTypes:undefined}]])assert.equal(gate.allow(sender,permission,details),false);
 now+=30001;assert.equal(gate.allow(contents,'media',request),false);
});
test('permission checks reject camera, unknown media, foreign origins and missing frame identity',async()=>{
 const contents={},gate=new MicrophonePermission({entry,contents:()=>contents});await gate.request(async()=>true);
 const details={isMainFrame:true,requestingUrl:entry,mediaType:'audio'};
 assert.equal(gate.check(contents,'media','openclaw-plus://ui',details),true);
 for(const [origin,changed]of [['https://example.invalid',{}],['openclaw-plus://ui.evil',{}],['openclaw-plus://ui',{mediaType:'video'}],['openclaw-plus://ui',{mediaType:'unknown'}],['openclaw-plus://ui',{isMainFrame:false}]])assert.equal(gate.check(contents,'media',origin,{...details,...changed}),false);
 gate.cancel();assert.equal(gate.check(contents,'media','openclaw-plus://ui',details),false);
});
test('cancellation supersedes a pending operating-system permission result',async()=>{
 let resolve;const gate=new MicrophonePermission({entry,contents:()=>({})});
 const pending=gate.request(()=>new Promise(r=>{resolve=r;}));gate.cancel();resolve(true);
 assert.deepEqual(await pending,{granted:false});assert.equal(gate.until,0);
 assert.deepEqual(await gate.request(async()=>false),{granted:false});
});
