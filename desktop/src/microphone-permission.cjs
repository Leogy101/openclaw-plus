'use strict';
// A short, explicit capture gesture permits only this app's main-frame microphone.
// It never grants camera, display, network, clipboard or persistent web permissions.
class MicrophonePermission {
  constructor({entry,contents,now=Date.now}) {this.entry=entry;this.contents=contents;this.now=now;this.epoch=0;this.until=0;}
  cancel() {this.epoch++;this.until=0;}
  async request(ask) {
    this.cancel();const epoch=this.epoch;
    const granted=await ask();
    if(epoch!==this.epoch||granted!==true)return {granted:false};
    this.until=this.now()+30000;return {granted:true};
  }
  trusted(contents,permission,details) {
    return this.until>this.now() && contents===this.contents() && contents!=null && permission==='media' &&
      details?.isMainFrame===true && details.requestingUrl===this.entry;
  }
  check(contents,permission,origin,details) {
    return this.trusted(contents,permission,details) && /^openclaw-plus:\/\/ui\/?$/.test(origin) && details.mediaType==='audio';
  }
  allow(contents,permission,details) {
    return this.trusted(contents,permission,details) && Array.isArray(details.mediaTypes) && details.mediaTypes.length===1 && details.mediaTypes[0]==='audio';
  }
}
module.exports={MicrophonePermission};
