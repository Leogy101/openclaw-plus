'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {AttachmentStore,MAX_IMAGE_BYTES,MAX_RETAINED_BYTES}=require('../desktop/src/attachments.cjs');
const selected={key:'agent:main:main',agentId:'main',sessionId:'physical-1'};
async function files(t,entries){const root=path.resolve(__dirname,'../.cache');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'attachments-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const result=[];for(const[name,content]of entries){const file=path.join(dir,name);await fs.writeFile(file,content);result.push(file);}return result;}
test('picker bytes become opaque exact-session tokens with immutable content',async t=>{
 const [file]=await files(t,[['note.txt','original']]),store=new AttachmentStore();const [item]=await store.addFiles(selected,[file]);
 assert.deepEqual(Object.keys(item).sort(),['id','mimeType','name','sizeBytes']);assert.equal(item.mimeType,'text/plain');
 await fs.writeFile(file,'changed');assert.throws(()=>store.snapshot({...selected,sessionId:'other'},[item.id],'r1'),{code:'INVALID'});
 const snapshot=store.snapshot(selected,[item.id],'r1');assert.equal(Buffer.from(snapshot[0].content,'base64').toString(),'original');
 assert.throws(()=>store.remove(selected,item.id),{code:'BUSY'});assert.throws(()=>store.snapshot(selected,[item.id],'other-submission'),{code:'INVALID'});
 store.settle([item.id],'r1',true);assert.equal(store.retainedBytes,0);assert.equal(store.items.size,0);
});
test('unsupported selection is atomic and cancellation preserves existing drafts',async t=>{
 const [good,bad]=await files(t,[['good.txt','valid'],['pretend.png','not an image']]),store=new AttachmentStore();const [item]=await store.addFiles(selected,[good]);
 assert.deepEqual(await store.addFiles(selected,[]),[]);await assert.rejects(store.addFiles(selected,[good,bad]),{code:'INVALID'});
 assert.equal(store.items.size,1);store.remove(selected,item.id);assert.equal(store.retainedBytes,0);
});
test('per-file image and combined draft byte limits reject before publishing tokens',async t=>{
 const largeImage=Buffer.alloc(MAX_IMAGE_BYTES+1);Buffer.from([137,80,78,71,13,10,26,10]).copy(largeImage);
 const largePdf=Buffer.alloc(5*1024*1024,32);Buffer.from('%PDF-1.7').copy(largePdf);
 const [image,a,b,c]=await files(t,[['large.png',largeImage],['a.pdf',largePdf],['b.pdf',largePdf],['c.pdf',largePdf]]),store=new AttachmentStore();
 await assert.rejects(store.addFiles(selected,[image]),{code:'INVALID'});await assert.rejects(store.addFiles(selected,[a,b,c]),{code:'INVALID'});assert.equal(store.items.size,0);
});
test('concurrent selections recheck four-file draft capacity at commit',async t=>{
 const [file]=await files(t,[['a.txt','fixture']]),store=new AttachmentStore();
 const results=await Promise.allSettled([store.addFiles(selected,[file,file,file]),store.addFiles(selected,[file,file,file])]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(store.items.size,3);
});
test('uncertain-send media counts toward global cap until acknowledged or unlocked',async t=>{
 const pdf=Buffer.alloc(12*1024*1024,32);Buffer.from('%PDF-1.7').copy(pdf);const [file]=await files(t,[['a.pdf',pdf]]),store=new AttachmentStore();
 for(let i=0;i<4;i++){const ctx={...selected,sessionId:'session-'+i};const[item]=await store.addFiles(ctx,[file]);store.snapshot(ctx,[item.id],'request-'+i);}
 assert.equal(store.retainedBytes,MAX_RETAINED_BYTES);await assert.rejects(store.addFiles({...selected,sessionId:'overflow'},[file]),{code:'BUSY'});
 const [id,item]=store.items.entries().next().value;store.settle([id],item.lock,false);store.remove({...selected,sessionId:'session-0'},id);assert.equal(store.retainedBytes,MAX_RETAINED_BYTES-12*1024*1024);
});
