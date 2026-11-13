'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ReadError } = require('./gateway-cli.cjs');
const MAX_FILES = 4, MAX_BYTES = 12 * 1024 * 1024, MAX_IMAGE_BYTES = 6 * 1024 * 1024, MAX_RETAINED_BYTES = 48 * 1024 * 1024;
const EXTENSIONS = ['png','jpg','jpeg','gif','webp','pdf','txt','md','csv','json','mp3','wav','ogg','mp4','m4a','mov','webm'];
const fail = (code, message) => { throw new ReadError(code, message); };
function attachmentContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ['key','agentId','sessionId'].some(key =>
    typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 1024 || /[\x00-\x1f\x7f]/u.test(input[key]))) fail('INVALID','Select an exact session before attaching files.');
  return { key: input.key, agentId: input.agentId, sessionId: input.sessionId };
}
const binding = input => JSON.stringify(attachmentContext(input));
function mimeFor(bytes, name) {
  const ext = path.extname(name).slice(1).toLowerCase(), ascii = (start, end) => bytes.toString('ascii', start, end);
  if (ext === 'png' && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (['jpg','jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ext === 'gif' && ['GIF87a','GIF89a'].includes(ascii(0,6))) return 'image/gif';
  if (ext === 'webp' && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return 'image/webp';
  if (ext === 'pdf' && ascii(0,5) === '%PDF-') return 'application/pdf';
  if (ext === 'wav' && ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE') return 'audio/wav';
  if (ext === 'mp3' && (ascii(0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (ext === 'ogg' && ascii(0,4) === 'OggS') return 'audio/ogg';
  if (['mp4','m4a','mov'].includes(ext) && ascii(4,8) === 'ftyp') return ext === 'm4a' ? 'audio/mp4' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  if (ext === 'webm' && bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return 'video/webm';
  if (['txt','md','csv','json'].includes(ext)) {
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(content)) return undefined;
      if (ext === 'json') JSON.parse(content);
      return ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'md' ? 'text/markdown' : 'text/plain';
    } catch { return undefined; }
  }
}
class AttachmentStore {
  constructor() { this.items = new Map(); this.retainedBytes = 0; }
  async addFiles(input, paths) {
    const context = binding(input);
    if (!Array.isArray(paths) || paths.length > MAX_FILES) fail('INVALID','Choose at most four attachments.');
    const existing = [...this.items.values()].filter(item => item.context === context && !item.lock);
    if (existing.length + paths.length > MAX_FILES) fail('INVALID','A draft can contain at most four attachments. Remove one before adding more.');
    const staged = [];
    for (const file of paths) {
      if (typeof file !== 'string' || !path.isAbsolute(file)) fail('INVALID','Choose a local file in the file picker.');
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) fail('INVALID','Choose a nonempty file of at most 12 MiB.');
        const bytes = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < bytes.length) { const part = await handle.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
        const after = await handle.stat();
        if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('INVALID','A selected file changed while it was being read. Choose it again.');
        const content = bytes.subarray(0,count), name = path.basename(file).replace(/[\x00-\x1f\x7f]/gu,'').slice(0,255), mimeType = mimeFor(content,name);
        if (!mimeType) fail('INVALID','One selected file has an unsupported type or does not match its file extension. No attachments were added.');
        if (mimeType.startsWith('image/') && count > MAX_IMAGE_BYTES) fail('INVALID','Images must be at most 6 MiB each. No attachments were added.');
        staged.push({ id: randomUUID(), context, name, mimeType, sizeBytes: count, content: content.toString('base64') });
      } catch (error) { if (error instanceof ReadError) throw error; fail('UNAVAILABLE','A selected file could not be read. Existing attachments are unchanged.'); }
      finally { await handle?.close(); }
    }
    const bytes = staged.reduce((sum,item) => sum + item.sizeBytes,0);
    const current = [...this.items.values()].filter(item => item.context === context && !item.lock);
    if (current.length + staged.length > MAX_FILES) fail('INVALID','A draft can contain at most four attachments.');
    if (bytes + current.reduce((sum,item) => sum + item.sizeBytes,0) > MAX_BYTES) fail('INVALID','Attachments must total at most 12 MiB per draft.');
    if (this.retainedBytes + bytes > MAX_RETAINED_BYTES) fail('BUSY','Attachment memory is full. Remove unused draft files or reconcile pending sends before adding more.');
    for (const item of staged) this.items.set(item.id,item);
    this.retainedBytes += bytes;
    return staged.map(({id,name,mimeType,sizeBytes}) => ({id,name,mimeType,sizeBytes}));
  }
  snapshot(input, ids, requestId) {
    const context = binding(input);
    if (!Array.isArray(ids) || ids.length > MAX_FILES || new Set(ids).size !== ids.length) fail('INVALID','Invalid attachment selection.');
    const items = ids.map(id => this.items.get(id));
    if (items.some(item => !item || item.context !== context || item.lock && item.lock !== requestId)) fail('INVALID','An attachment is unavailable or belongs to another submission. Choose it again.');
    if (items.reduce((sum,item) => sum + item.sizeBytes,0) > MAX_BYTES) fail('INVALID','Attachments exceed the draft size limit.');
    for (const item of items) item.lock = requestId;
    return items.map(item => ({ type: item.mimeType.startsWith('image/') ? 'image' : 'file', mimeType: item.mimeType,
      fileName: item.name, origin: 'file', sizeBytes: item.sizeBytes, content: item.content }));
  }
  settle(ids, requestId, accepted) {
    for (const id of ids || []) {
      const item = this.items.get(id); if (!item || item.lock !== requestId) continue;
      if (accepted) { this.items.delete(id); this.retainedBytes -= item.sizeBytes; }
      else delete item.lock;
    }
  }
  remove(input, id) {
    const item = this.items.get(id);
    if (!item || item.context !== binding(input)) fail('INVALID','This attachment is no longer available in this draft.');
    if (item.lock) fail('BUSY','This attachment belongs to an unconfirmed send. Reconcile that send before changing its files.');
    this.items.delete(id); this.retainedBytes -= item.sizeBytes;
  }
}
module.exports = { AttachmentStore, attachmentContext, EXTENSIONS, MAX_FILES, MAX_BYTES, MAX_IMAGE_BYTES, MAX_RETAINED_BYTES, mimeFor };
