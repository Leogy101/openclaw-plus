'use strict';
const { ReadError } = require('./gateway-cli.cjs');
const MAX_TEXT = 4000;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new ReadError(code, message); };
const formats = new Map([['mp3','audio/mpeg'],['mpeg','audio/mpeg'],['wav','audio/wav'],['wave','audio/wav'],['ogg','audio/ogg'],['opus','audio/ogg'],['webm','audio/webm'],['m4a','audio/mp4'],['mp4','audio/mp4']]);
const mimes = new Map([['audio/mpeg','audio/mpeg'],['audio/mp3','audio/mpeg'],['audio/wav','audio/wav'],['audio/x-wav','audio/wav'],['audio/ogg','audio/ogg'],['audio/mp4','audio/mp4'],['audio/webm','audio/webm']]);
function normalizeAudio(reply) {
  if (!object(reply) || typeof reply.audioBase64 !== 'string' || reply.audioBase64.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3) ||
      reply.audioBase64.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.audioBase64)) fail('UNAVAILABLE','OpenClaw returned unsupported or oversized audio.');
  const bytes = Buffer.from(reply.audioBase64,'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString('base64') !== reply.audioBase64) fail('UNAVAILABLE','OpenClaw returned invalid audio.');
  const mimeType = reply.mimeType === undefined
    ? formats.get(String(reply.fileExtension || reply.outputFormat || '').toLowerCase().replace(/^\./,''))
    : mimes.get(reply.mimeType);
  const valid = mimeType === 'audio/wav' ? bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WAVE'
    : mimeType === 'audio/mpeg' ? bytes.toString('ascii',0,3)==='ID3' || bytes.length>1 && bytes[0]===255 && (bytes[1]&224)===224
    : mimeType === 'audio/ogg' ? bytes.toString('ascii',0,4)==='OggS'
    : mimeType === 'audio/mp4' ? bytes.toString('ascii',4,8)==='ftyp'
    : mimeType === 'audio/webm' ? bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) : false;
  if (!valid) fail('UNAVAILABLE','The configured speech provider returned an audio format this app cannot play.');
  // Return only bounded audio bytes and a fixed MIME. Never return or open a URL or local path.
  return {audioBase64:reply.audioBase64,mimeType};
}
class SpeechService {
  constructor(base) { this.base=base; this.busy=false; this.options=null; }
  async handle(operation, params={}) {
    if (!object(params) || Object.keys(params).some(key=>operation==='speak' ? key!=='text' : true)) fail('INVALID','Invalid speech request.');
    if (operation==='speechOptions') return this.getOptions();
    if (operation!=='speak' || typeof params.text!=='string' || !params.text.trim() || params.text.length>MAX_TEXT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(params.text)) fail('INVALID','This text cannot be read aloud.');
    if (this.busy) fail('BUSY','Previous audio is still being prepared. Try again shortly.');
    this.busy=true;
    const generation=this.base.generation;
    try {
      const options=this.options?.generation===generation && Date.now()-this.options.at<30000 ? this.options.value : await this.getOptions();
      this.base.assertCurrent(generation);
      if (!options.available) fail('UNAVAILABLE',options.reason);
      if (params.text.length>options.maxTextLength) fail('INVALID','This speech segment exceeds the configured OpenClaw limit.');
      let reply;
      try { reply=await this.base.transport.write('tts.speak',{text:params.text}); }
      catch(error) {
        if(error?.code==='ACCESS') fail('ACCESS','OpenClaw did not authorize Read aloud. Check speech access in the original interface.');
        fail('UNAVAILABLE','OpenClaw could not prepare the audio. Check the configured speech provider in the original interface, then try again.');
      }
      this.base.assertCurrent(generation);
      return normalizeAudio(reply);
    } finally { this.busy=false; }
  }
  async getOptions() {
    const generation=this.base.generation;
    const [status,snapshot]=await Promise.all([this.base.read('tts.status',{},30000),this.base.read('config.get',{},30000)]);
    this.base.assertCurrent(generation);
    if (!object(status)||!Array.isArray(status.providerStates)||snapshot?.valid!==true||!object(snapshot.config)) fail('UNAVAILABLE','Speech settings could not be verified. Check the original OpenClaw interface.');
    const configured=new Set(status.providerStates.filter(row=>object(row)&&row.configured===true&&typeof row.id==='string').map(row=>row.id));
    const chain=[status.provider,...(Array.isArray(status.fallbackProviders)?status.fallbackProviders:[])];
    const max=snapshot.config.tts?.maxTextLength ?? 4096;
    if (!Number.isSafeInteger(max)||max<1) fail('UNAVAILABLE','OpenClaw returned an unsupported speech text limit.');
    // Automatic delivery can be off while explicit, one-shot reading is available.
    const available=chain.some(id=>typeof id==='string'&&id.length>0&&configured.has(id));
    const value={available,maxTextLength:Math.min(MAX_TEXT,max),...(!available?{reason:'No speech provider is configured. Set up text-to-speech in the original OpenClaw interface to use Read aloud.'}:{})};
    this.options={generation,at:Date.now(),value};return value;
  }
}
module.exports={SpeechService,normalizeAudio,MAX_AUDIO_BYTES,MAX_TEXT};
