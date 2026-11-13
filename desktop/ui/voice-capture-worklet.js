// Fixed local processor. Eight unacknowledged 50 ms frames bound the capture backlog.
class OpenClawVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();this.frame=new Float32Array(Math.round(sampleRate*.05));this.offset=0;this.pending=0;this.stopped=false;
    this.port.onmessage=event=>{if(event.data?.type==='ack')this.pending=Math.max(0,this.pending-1);if(event.data?.type==='stop')this.stopped=true;};
  }
  process(inputs) {
    if(this.stopped)return false;
    const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++) {
      let sample=0;for(const channel of channels)sample+=channel[i]||0;
      this.frame[this.offset++]=sample/channels.length;
      if(this.offset===this.frame.length) {
        if(this.pending>=8){this.stopped=true;this.port.postMessage({type:'overflow'});return false;}
        this.pending++;this.port.postMessage({type:'frame',samples:this.frame},[this.frame.buffer]);
        this.frame=new Float32Array(Math.round(sampleRate*.05));this.offset=0;
      }
    }
    return true;
  }
}
registerProcessor('openclaw-voice-capture',OpenClawVoiceCapture);
