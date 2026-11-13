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
