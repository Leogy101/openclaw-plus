import test from 'node:test';
import assert from 'node:assert/strict';
import { speechText, speechChunks, createReadAloud } from '../desktop/ui/read-aloud.mjs';

const audio={mimeType:'audio/wav',audioBase64:Buffer.from('fixture audio').toString('base64')};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(handler) {
  const calls=[],players=[],created=[],revoked=[],errors=[],changes=[];
  class Player extends EventTarget {
    canPlayType(){return 'probably';}
    play(){this.played=true;return Promise.resolve();}
    pause(){this.paused=true;}
    removeAttribute(name){if(name==='src')this.src='';}
    load(){this.loaded=true;}
  }
  const player=createReadAloud({rpc:async(method,params)=>{calls.push({method,params});return handler?handler(method,params):method==='speechOptions'?{available:true,maxTextLength:80}:audio;},
    createAudio:()=>{const item=new Player();players.push(item);return item;},
    createURL:blob=>{const url='blob:fixture-'+created.length;created.push({url,blob});return url;},revokeURL:url=>revoked.push(url),
    onChange:state=>changes.push(state?{key:state.key,phase:state.phase}:null),onError:error=>errors.push(error)});
  return {player,calls,players,created,revoked,errors,changes};
}

test('speech preprocessing keeps readable report prose without executing markup or TTS directives',()=>{
  assert.equal(speechText('# Report\n\n**Passed** [checks](/tmp/report.md).\n[[tts:voice=untrusted]]\n```bash\nsecret_command\n```\n> Next item.'),'Report\n\nPassed checks.\n\nNext item.');
  assert.equal(speechText('~~~\ncode only\n~~~'),'');
  assert.throws(()=>speechText('x'.repeat(262145)));
  assert.throws(()=>speechText('\ud800'));
});

test('chunks honor the provider ceiling, sentence/word boundaries and complete Unicode characters',()=>{
  const text='First sentence. Then a second sentence with words. '+('😀'.repeat(40));
  const chunks=speechChunks(text,24);
  assert.equal(chunks[0],'First sentence.');
  assert.ok(chunks.every(chunk=>chunk.length<=24&&chunk.isWellFormed()&&chunk.trim()));
  assert.equal(chunks.join('').replace(/\s/g,''),text.replace(/\s/g,''));
  assert.throws(()=>speechChunks('text',NaN));assert.throws(()=>speechChunks('text',1));
});

test('one explicit start queries options once and generates sequentially without prefetch',async()=>{
  const f=fixture();const done=f.player.start('report','A sentence. '.repeat(20));await tick();
  assert.equal(f.calls.filter(call=>call.method==='speechOptions').length,1);
  assert.equal(f.calls.filter(call=>call.method==='speak').length,1);
  assert.equal(f.players.length,1);assert.equal(f.player.current.phase,'playing');
  for(let guard=0;f.player.current&&guard<30;guard++) {f.players.at(-1).dispatchEvent(new Event('ended'));await tick();}
  await done;assert.equal(f.player.current,null);assert.equal(f.errors.length,0);
  assert.ok(f.calls.filter(call=>call.method==='speak').every(call=>call.params.text.length<=80));
  assert.equal(f.created.length,f.revoked.length);assert.equal(new Set(f.revoked).size,f.revoked.length);
  assert.ok(f.players.every(item=>item.paused&&item.src===''));
});

test('Stop during options or synthesis ignores late replies and never starts audio',async()=>{
  for(const heldMethod of ['speechOptions','speak']) {
    const hold=deferred();const f=fixture(method=>method===heldMethod?hold.promise:method==='speechOptions'?{available:true,maxTextLength:80}:audio);
    const done=f.player.start('report','A report to read.');await tick();f.player.stop();
    hold.resolve(heldMethod==='speechOptions'?{available:true,maxTextLength:80}:audio);await done;
    assert.equal(f.player.current,null);assert.equal(f.players.length,0);assert.equal(f.created.length,0);assert.equal(f.errors.length,0);
    assert.equal(f.calls.length,heldMethod==='speechOptions'?1:2);
  }
});

test('starting another report stops current playback and releases its object URL',async()=>{
  const f=fixture();const first=f.player.start('first','First report.');await tick();
  const old=f.players[0],second=f.player.start('second','Second report.');await tick();
  assert.equal(old.paused,true);assert.equal(old.src,'');assert.deepEqual(f.revoked,['blob:fixture-0']);
  assert.equal(f.player.current.key,'second');assert.equal(f.players.length,2);
  f.player.stop();await Promise.all([first,second]);assert.equal(f.revoked.length,2);
});

test('invalid audio, unavailable provider and unsupported playback fail without automatic retries',async()=>{
  for(const result of [{mimeType:'text/html',audioBase64:'PHNjcmlwdD4='},{mimeType:'audio/wav',audioBase64:'https://example.com/audio'},
    {mimeType:'audio/wav',audioBase64:'file:///tmp/audio'},{mimeType:'audio/wav',audioBase64:'YQ=A'},
    {mimeType:'audio/wav',audioBase64:'YR=='},{mimeType:'audio/wav',audioBase64:'A'.repeat(4*Math.ceil(12*1024*1024/3)+4)}]) {
    const f=fixture(method=>method==='speechOptions'?{available:true,maxTextLength:80}:result);
    await f.player.start('report','Fixture report.');assert.equal(f.errors.length,1);assert.equal(f.players.length,0);assert.equal(f.created.length,0);assert.equal(f.calls.length,2);
  }
  const unavailable=fixture(()=>({available:false,reason:'Speech is not configured.'}));await unavailable.player.start('report','Fixture report.');
  assert.equal(unavailable.calls.length,1);assert.equal(unavailable.errors[0].message,'Speech is not configured.');
});

test('audio errors clean up the player and stop all remaining chunks',async()=>{
  const f=fixture();const done=f.player.start('report','A sentence. '.repeat(30));await tick();
  f.players[0].dispatchEvent(new Event('error'));await done;
  assert.equal(f.errors.length,1);assert.equal(f.calls.filter(call=>call.method==='speak').length,1);
  assert.equal(f.player.current,null);assert.deepEqual(f.revoked,['blob:fixture-0']);
});
