
// App state and signaling live in a separate window for each participant.
render=()=>{};notify=text=>parent.record(state.playerId,text);
send=(event,data)=>{parent.route(state.playerId,event,data);return true;};
let audioContext,oscillator,paintTimer;
window.peerTest={
  state,
  init(id,ids){
    // Local synthetic transport test; production gets credentials via the server.
    rtcConfig={iceServers:[],iceTransportPolicy:'all',expiresAt:Date.now()+3600000};
    state.playerId=id;
    state.room={phase:'discussion',players:ids.map(id=>({id,name:id,connected:true}))};
  },
  receive:handleSignal,
  connect:syncPeers,
  async enableAudio(){
    audioContext=new AudioContext();await audioContext.resume();
    const output=audioContext.createMediaStreamDestination();
    oscillator=audioContext.createOscillator();oscillator.connect(output);oscillator.start();
    state.audioStream=output.stream;state.micOn=true;makeLocalStream();
    syncPeers(true);await syncLocalMediaToPeers();
  },
  async enableVideo(){
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=120;
    const ctx=canvas.getContext('2d');let frame=0;
    paintTimer=setInterval(()=>{ctx.fillStyle=frame++%2?'#999':'#333';ctx.fillRect(0,0,160,120);},60);
    state.videoStream=canvas.captureStream(15);state.cameraOn=true;makeLocalStream();
    syncPeers(true);await syncLocalMediaToPeers();
  },
  async counts(){
    const result={};
    for(const [id,pc] of state.peers){
      result[id]={audio:0,video:0,directions:pc.getTransceivers().map(t=>t.currentDirection),connection:pc.connectionState};
      for(const stat of (await pc.getStats()).values())
        if(stat.type==='inbound-rtp')result[id][stat.kind]=stat.kind==='video'?(stat.framesDecoded||0):(stat.packetsReceived||0);
    }
    return result;
  },
  async stop(){
    for(const pc of state.peers.values())pc.close();state.peers.clear();state.remoteStreams.clear();
    for(const stream of [state.audioStream,state.videoStream])for(const track of stream?.getTracks()||[])track.stop();
    clearInterval(paintTimer);oscillator?.stop();await audioContext?.close();
    state.audioStream=null;state.videoStream=null;state.micOn=false;state.cameraOn=false;
  }
};
