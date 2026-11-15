'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const content = import('../desktop/ui/content.mjs');
test('Local references retain punctuation, Unicode and line positions', async () => {
  const {linkedText}=await content;
  const result=linkedText('Read /Users/example/report.md:12:3, then ~/Documents/報告.txt.');
  assert.match(result,/data-path="\/Users\/example\/report.md:12:3"/);
  assert.match(result,/<\/a>, then /);
  assert.match(result,/data-path="~\/Documents\/報告.txt"/);
  assert.ok(result.endsWith('</a>.'));
});
test('Explicit spaced paths, Markdown labels and local file URLs become safe links', async () => {
  const {linkedText}=await content;
  for (const text of ['`/tmp/My report.md`','"/tmp/My report.md"','</tmp/My report.md>',"'/tmp/My report.md'"])
    assert.match(linkedText(text),/data-path="\/tmp\/My report.md"/);
  assert.match(linkedText('[Report](</tmp/My report.md:12>)'),/>Report<\/a>/);
  assert.match(linkedText('[Report](/tmp/report.md)'),/data-path="\/tmp\/report.md"/);
  assert.match(linkedText('file:///tmp/My%20report.md'),/data-path="file:\/\/\/tmp\/My%20report.md"/);
  assert.match(linkedText('/Volumes/Example Archive/file.md'),/data-path="\/Volumes\/Example Archive\/file.md"/);
});
test('URLs, relative paths and remote file hosts do not become local links', async () => {
  const {linkedText}=await content;
  for (const text of ['https://example.com/tmp/file','[Web](https://example.com/tmp/file)','file://remote/tmp/file','//host/share/file','./src/app.js','src/app.js','javascript:alert(1)','file:///tmp/file?q=1'])
    assert.ok(!linkedText(text).includes('<a '),text);
});
test('Untrusted markup and link attributes stay escaped', async () => {
  const {linkedText}=await content;
  const result=linkedText('<script>window.bad=true</script> [<img onerror=bad>](</tmp/a&b.md>)');
  assert.ok(!result.includes('<script>'));assert.ok(!result.includes('<img'));
  assert.equal((result.match(/<a /g)||[]).length,1,'HTML closing tags are not file references');
  assert.match(result,/data-path="\/tmp\/a&amp;b.md"/);
  assert.match(result,/&lt;img onerror=bad&gt;<\/a>/);
});
test('Filename parentheses and prose delimiters are distinguished', async () => {
  const {linkedText}=await content;
  assert.match(linkedText('See (/tmp/report.md).'),/data-path="\/tmp\/report.md"/);
  assert.match(linkedText('/tmp/report(v2).md'),/data-path="\/tmp\/report\(v2\).md"/);
  assert.match(linkedText('[Report](/tmp/report(v2).md)'),/data-path="\/tmp\/report\(v2\).md"/);
  assert.equal((linkedText('/tmp/a.md /tmp/b.md').match(/<a /g)||[]).length,2);
});

test('Report progress reconstructs a labeled native bar and preserves ordinary file links', async () => {
  const {reportText}=await content;
  const result=reportText('Result: <progress aria-label="Fixture checks passed · 12/12" value="12" max="12"></progress>\nReport: /tmp/result.md');
  assert.match(result,/<span class="report-progress-label">Fixture checks passed · 12\/12<\/span>/);
  assert.match(result,/<progress aria-label="Fixture checks passed · 12\/12" value="12" max="12"><\/progress>/);
  assert.match(result,/data-path="\/tmp\/result.md"/);
  assert.match(reportText("<progress max='1' aria-label='Half complete' value='0.5'></progress>"),/value="0.5" max="1"/);
  assert.match(reportText('<progress aria-label="Empty" value="0" max="10"></progress>'),/<progress /);
});
test('Progress rejects extra, duplicate, malformed or missing attributes and all child content', async () => {
  const {reportText}=await content;
  const invalid=[
    '<progress aria-label="x" value="1" max="2" onclick="alert(1)"></progress>',
    '<progress aria-label="x" value="1" max="2" style="width:100%"></progress>',
    '<progress aria-label="x" value="1" max="2" data-action="send"></progress>',
    '<progress aria-label="x" value="1" VALUE="1" max="2"></progress>',
    '<progress value="1" max="2"></progress>',
    '<progress aria-label="x" value="1" max="2">text</progress>',
    '<progress aria-label="x" value="1" max="2"><img src=x onerror=bad></progress>',
    '<progress aria-label="x" value="1" max="2"><progress aria-label="y" value="1" max="2"></progress></progress>',
    '<progress aria-label="x" value="1" max="2"/>',
    '<progress aria-label="x" value=1 max="2"></progress>',
  ];
  for(const input of invalid){const result=reportText(input);assert.ok(!result.includes('<progress '),input);assert.ok(!result.includes('<img'),input);assert.ok(result.includes('&lt;progress'),input);}
});
test('Progress numeric values are finite, bounded and ordered', async () => {
  const {reportText}=await content;
  for(const [value,max] of [['-1','10'],['11','10'],['0','0'],['1','Infinity'],['NaN','10'],['1e2','100'],['0x1','2'],['1','1000000000001'],['1','-2'],['1" onmouseover="bad','2']])
    assert.ok(!reportText(`<progress aria-label="x" value="${value}" max="${max}"></progress>`).includes('<progress '),`${value}/${max}`);
});
test('Progress labels and surrounding HTML remain escaped', async () => {
  const {reportText}=await content;
  const result=reportText('<img src=x onerror=bad><progress aria-label="Checks & review" value="1" max="2"></progress><script>bad()</script>');
  assert.ok(!result.includes('<img'));assert.ok(!result.includes('<script>'));
  assert.match(result,/aria-label="Checks &amp; review"/);
  assert.match(result,/>Checks &amp; review<\/span>/);
  assert.ok(!reportText('<progress aria-label="<img>" value="1" max="2"></progress>').includes('<progress '));
});
test('Fenced and inline code retain literal progress markup, including unfinished fences', async () => {
  const {reportText}=await content;
  const bar='<progress aria-label="Checks" value="1" max="2"></progress>';
  for(const input of ['`'+bar+'`','``'+bar+'``','```html\n'+bar+'\n```','~~~html\n'+bar+'\n~~~','```\n'+bar]){
    const result=reportText(input);assert.ok(!result.includes('<progress '),input);assert.ok(result.includes('&lt;progress'),input);
  }
  const mixed=reportText('```html\n'+bar+'\n```\n'+bar+'\n`'+bar+'`');
  assert.equal((mixed.match(/<progress /g)||[]).length,1);
});

test('Async replies use the official quoted-question framing with each explicit answer',async()=>{
  const {formatAsyncReply}=await content;
  assert.equal(formatAsyncReply([{title:'Which path?',options:['First','Second']},{title:'Why?'}],['Second','My reason\nwith detail']),
    '> Which path?\n\nSecond\n\n> Why?\n\nMy reason\nwith detail');
  assert.equal(formatAsyncReply([{title:'One\r\ntwo'}],['Custom answer']),'> One  two\n\nCustom answer');
});
test('Async reply titles are clipped at 512 UTF-8 bytes without breaking codepoints',async()=>{
  const {formatAsyncReply}=await content;
  const title='a'.repeat(509)+'😀'+'more';
  assert.equal(formatAsyncReply([{title}],['Yes']),'> '+'a'.repeat(509)+'\n\nYes');
  assert.equal(formatAsyncReply([{title:'😀'.repeat(129)}],['Yes']),'> '+'😀'.repeat(128)+'\n\nYes');
});
test('Async reply preparation rejects incomplete or oversized answers instead of choosing defaults',async()=>{
  const {formatAsyncReply}=await content;
  for(const [questions,answers] of [[[],[]],[[{title:'x'}],[]],[[{title:'x'}],[' ']],[[{title:'x'}],[undefined]],
    [[{title:'x'}],['a'.repeat(4097)]],[[{title:' '}],['Yes']],[[{title:'a'.repeat(4097)}],['Yes']],
    [Array(13).fill({title:'x'}),Array(13).fill('Yes')]])assert.throws(()=>formatAsyncReply(questions,answers),TypeError);
});

test('Transcript grouping preserves normalized call/result order between assistant reports',async()=>{
  const {groupTranscriptMessages}=await content;
  const {normalizeMessage}=require('../desktop/src/gateway-service.cjs');
  const messages=[
    {id:'intro',role:'assistant',content:'I will inspect the sample.'},
    {id:'call-a',role:'assistant',content:[{type:'toolCall',name:'read',arguments:{path:'sample.txt'}}]},
    {id:'call-b',role:'assistant',content:[{type:'thinking',thinking:'Compare the returned values.'},{type:'tool_use',name:'inspect',input:{}}]},
    {id:'result-b',role:'toolResult',content:'Second result arrives first.'},
    {id:'result-a',role:'tool',content:'First result arrives second.'},
    {id:'report',role:'assistant',content:'The sample is consistent.'},
  ].map(normalizeMessage);
  const grouped=groupTranscriptMessages(messages);
  assert.deepEqual(grouped.map(row=>row.kind),['message','tools','message']);
  assert.deepEqual(grouped[1].entries.map(entry=>entry.index),[1,2,3,4]);
  assert.deepEqual(grouped[1].entries.map(entry=>entry.message.id),messages.slice(1,5).map(message=>message.id));
  assert.equal(grouped[0].message,messages[0]);assert.equal(grouped[2].message,messages[5]);
  assert.deepEqual(grouped.flatMap(row=>row.kind==='tools'?row.entries:[row]).map(row=>row.message),messages);
});

test('Users, system messages and unknown roles separate consecutive tool groups',async()=>{
  const {groupTranscriptMessages}=await content;
  const messages=[
    {id:'result-1',role:'tool',text:'Output'},
    {id:'user',role:'user',text:'Pause and explain.'},
    {id:'result-2',role:'toolResult',text:'More output'},
    {id:'system',role:'system',text:'Context changed.'},
    {id:'function',role:'function',text:'Returned value'},
    {id:'unknown',role:'new-role',blocks:[{type:'tool',text:'Unsupported role'}]},
    {id:'function-result',role:'function_result',text:''},
  ];
  const grouped=groupTranscriptMessages(messages);
  assert.deepEqual(grouped.map(row=>row.kind),['tools','message','tools','message','tools','message','tools']);
  assert.deepEqual(grouped.filter(row=>row.kind==='message').map(row=>row.index),[1,3,5]);
  assert.equal(grouped.at(-1).entries[0].message,messages.at(-1),'Even empty native tool results remain available inside the group.');
});

test('Assistant reports, async questions, media and unsupported or empty messages remain visible boundaries',async()=>{
  const {groupTranscriptMessages}=await content;
  const boundaries=[
    {text:'Visible report',blocks:[{type:'tool',text:'Call'}]},
    {text:'',blocks:[{type:'text',text:'Text block report'},{type:'thinking',text:'Details'}]},
    {blocks:[{type:'markdown',text:'## Report'},{type:'tool',text:'Result'}]},
    {blocks:[{type:'tool',text:'Call'}],asyncQuestion:{id:'question',questions:[{title:'Continue?'}]}},
    ...['image','audio','video','file','new-content-type','function_call'].map(type=>({blocks:[{type:'tool',text:'Call'},{type,text:'Preserve this item'}]})),
    {text:'',blocks:[]}, {}, {blocks:[null]}, {blocks:[{}]}, {blocks:Array(1)},
    {blocks:[{type:'text',text:''},{type:'tool',text:'Empty text block is still an unsupported group member.'}]},
  ];
  for(const [index,boundary] of boundaries.entries()) {
    const middle={id:`boundary-${index}`,role:'assistant',...boundary};
    const messages=[{id:'before',role:'tool',text:'Before'},middle,{id:'after',role:'tool',text:'After'}];
    const grouped=groupTranscriptMessages(messages);
    assert.deepEqual(grouped.map(row=>row.kind),['tools','message','tools'],JSON.stringify(boundary));
    assert.equal(grouped[1].message,middle);assert.equal(grouped[1].index,1);
  }
});

test('Every recognized assistant detail type groups without discarding whitespace or inferring execution state',async()=>{
  const {groupTranscriptMessages}=await content;
  const types=['tool','tool_use','tool_call','tool_result','toolResult','toolCall','reasoning','thinking'];
  const messages=types.map((type,index)=>({id:`detail-${index}`,role:'assistant',text:' \n ',blocks:[{type,text:`Original ${type} content`}]}));
  const grouped=groupTranscriptMessages(messages);
  assert.equal(grouped.length,1);assert.equal(grouped[0].kind,'tools');
  assert.deepEqual(Object.keys(grouped[0]).sort(),['entries','id','kind']);
  grouped[0].entries.forEach((entry,index)=>{assert.equal(entry.message,messages[index]);assert.equal(entry.message.text,' \n ');});
});

test('Appending a tool result retains the group identity without mutating input rows or earlier output',async()=>{
  const {groupTranscriptMessages}=await content;
  const call=Object.freeze({id:'call:fixture',role:'assistant',text:'',blocks:Object.freeze([Object.freeze({type:'tool',text:'Original call'})])});
  const original=Object.freeze([call]);
  const before=groupTranscriptMessages(original),result=Object.freeze({id:'result:fixture',role:'toolResult',text:'Original result'});
  const after=groupTranscriptMessages(Object.freeze([...original,result]));
  assert.equal(after[0].id,before[0].id);assert.notEqual(after[0].id,call.id);
  assert.equal(before[0].entries.length,1);assert.equal(after[0].entries.length,2);
  assert.equal(after[0].entries[0].message,call);assert.equal(after[0].entries[1].message,result);
  const preceded=groupTranscriptMessages([{id:'earlier-report',role:'assistant',text:'Earlier report'},call,result]);
  assert.equal(preceded[1].id,before[0].id,'A stable native ID is independent of its transcript index.');
  assert.deepEqual(groupTranscriptMessages([]),[]);
  const missing=groupTranscriptMessages([{role:'tool',text:'Unidentified output'},{role:'user',text:'Boundary'},{id:'index:0',role:'tool',text:'Identified output'}]);
  assert.notEqual(missing[0].id,missing[2].id,'The index fallback has a separate identity namespace.');
});
