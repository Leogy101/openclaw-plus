'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {SpeechService,normalizeAudio,MAX_AUDIO_BYTES}=require('../desktop/src/gateway-speech.cjs');
const {CliTransport}=require('../desktop/src/gateway-cli.cjs');
const {validateRequest}=require('../desktop/src/composer-rpc.cjs');
const wav=Buffer.alloc(46);wav.write('RIFF');wav.write('WAVE',8);
const audio={audioBase64:wav.toString('base64'),mimeType:'audio/wav',provider:'fixture'};
function setup({provider=true,max=4096,write=async()=>audio}={}) {
 const calls=[];const base={generation:0,assertCurrent(g){if(g!==this.generation)throw Object.assign(Error('changed'),{code:'STALE'});},
 async read(method){calls.push(method);return method==='tts.status'?{auto:'off',enabled:false,provider:'fixture',fallbackProviders:[],providerStates:[{id:'fixture',configured:provider}]}:{valid:true,config:{tts:{maxTextLength:max}}};},
 transport:{async write(method,params){calls.push([method,params]);return write();}}};
 return {service:new SpeechService(base),base,calls};
}
test('manual reading respects configured provider and limit without enabling automatic speech',async()=>{
 const {service,calls}=setup({max:500});assert.deepEqual(await service.handle('speechOptions',{}),{available:true,maxTextLength:500});
 assert.deepEqual(await service.handle('speak',{text:'A fixture report.'}),{audioBase64:audio.audioBase64,mimeType:'audio/wav'});
 assert.deepEqual(calls,['tts.status','config.get',['tts.speak',{text:'A fixture report.'}]]);
});
test('unconfigured speech and malformed or oversized input never synthesize',async()=>{
 const {service,calls}=setup({provider:false});assert.equal((await service.handle('speechOptions')).available,false);
 await assert.rejects(service.handle('speak',{text:'hello'}),/No speech provider/);
 for(const input of [{text:''},{text:'x'.repeat(4001)},{text:'ok',provider:'override'},{text:'bad\0input'}])await assert.rejects(service.handle('speak',input),{code:'INVALID'});
 assert.ok(calls.every(call=>typeof call==='string'));
 const short=setup({max:4});await assert.rejects(short.service.handle('speak',{text:'too long'}),{code:'INVALID'});assert.ok(short.calls.every(call=>typeof call==='string'));
});
test('one pending synthesis is bounded and a retired connection never publishes its audio',async()=>{
 let resolve;const {service,base,calls}=setup({write:()=>new Promise(r=>{resolve=r;})});await service.handle('speechOptions');
 const pending=service.handle('speak',{text:'one'});await Promise.resolve();
 await assert.rejects(service.handle('speak',{text:'two'}),{code:'BUSY'});base.generation++;resolve(audio);
 await assert.rejects(pending,{code:'STALE'});assert.equal(calls.filter(Array.isArray).length,1);assert.equal(service.busy,false);
});
test('audio is canonical, bounded, signature checked and never interpreted as a URL or path',()=>{
 assert.deepEqual(normalizeAudio({...audio,audioPath:'/private/file',url:'https://invalid'}),{audioBase64:audio.audioBase64,mimeType:'audio/wav'});
 for(const reply of [{audioPath:'/private/file'},{...audio,audioBase64:'a'},{...audio,audioBase64:'AAAA===='},{...audio,mimeType:'text/html'},
  {...audio,audioBase64:Buffer.from('<script>bad</script>').toString('base64')},{...audio,audioBase64:'A'.repeat(4*Math.ceil(MAX_AUDIO_BYTES/3)+4)}])assert.throws(()=>normalizeAudio(reply),{code:'UNAVAILABLE'});
 const large=Buffer.alloc(1024*1024);wav.copy(large);assert.equal(normalizeAudio({...audio,audioBase64:large.toString('base64')}).mimeType,'audio/wav');
});
test('speech failures are sanitized, never automatically retried and do not expose provider errors',async()=>{
 const {service,calls}=setup({write:async()=>{throw Object.assign(Error('SECRET_PRIVATE_URL'),{code:'UNCERTAIN'});}});
 await assert.rejects(service.handle('speak',{text:'fixture'}),e=>e.code==='UNAVAILABLE'&&!e.message.includes('SECRET'));
 assert.equal(calls.filter(Array.isArray).length,1);
});
test('speech uses fixed stdin transport and write scope without content in argv or environment',async()=>{
 let seen;const cli=new CliTransport({home:'/fixture',target:{url:'ws://127.0.0.1:19999',configPath:'/fixture/config'},execute(node,args,options,done){
  seen={node,args,options};return {kill(){},stdin:{on(){},end(value){seen.input=value;queueMicrotask(()=>done(null,JSON.stringify(audio)));}}};
 }});
 await assert.rejects(cli.request('tts.speak',{text:'fixture'}),{code:'DENIED'});
 await cli.write('tts.speak',{text:'PRIVATE_SPEECH_TEXT'});
 assert.match(seen.args[0],/composer-rpc\.cjs$/);assert.doesNotMatch(JSON.stringify([seen.args,seen.options.env]),/PRIVATE_SPEECH_TEXT/);
 assert.deepEqual(JSON.parse(seen.input),{text:'PRIVATE_SPEECH_TEXT'});assert.deepEqual(validateRequest('tts.speak',{text:'fixture'}),['operator.write']);
 assert.throws(()=>validateRequest('tts.speak',{text:'fixture',provider:'override'}));cli.close();
});
