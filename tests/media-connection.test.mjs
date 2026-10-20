import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function fixture(getUserMedia=async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});},document={querySelector:()=>null,querySelectorAll:()=>[]}) {
  const notices=[],sent=[];
  const context=vm.createContext({
    document,CSS:{escape:value=>value},
    navigator:{mediaDevices:{getUserMedia}},setTimeout,clearTimeout,
    MediaStream:class{constructor(tracks=[]){this.tracks=tracks;}},
    record:text=>notices.push(text),sendSignal:(event,data)=>sent.push({event,data}),
  });
  vm.runInContext(`${source}
    render=()=>{};notify=record;send=sendSignal;
    state.playerId='A';state.room={phase:'discussion',players:[{id:'A'},{id:'B'}]};
    globalThis.api={state,syncLocalMediaToPeer,handleSignal,toggleMic,mediaInputError,bindAudio,bindMediaElements};
  `,context);
  const transceivers=['audio','video'].map(kind=>({
    direction:'recvonly',receiver:{track:{kind}},
    sender:{track:null,async replaceTrack(track){this.track=track;}}
  }));
  const order=[];
  const pc={
    connectionState:'connected',signalingState:'stable',polite:true,makingOffer:false,pendingCandidates:[],
    getTransceivers:()=>transceivers,
    async setRemoteDescription(description){this.remoteDescription=description;order.push('description');},
    async setLocalDescription(){this.localDescription={type:'answer'};},
    async addIceCandidate(){assert.ok(this.remoteDescription);order.push('ice');}
  };
  context.api.state.peers.set('B',pc);
  return {...context.api,context,pc,transceivers,notices,sent,order};
}
test('answering participant reserves audio and video sendrecv even before enabling devices',async()=>{
  const f=fixture();
  await f.handleSignal('webrtc:offer',{from:'B',payload:{type:'offer'}});
  assert.ok(f.transceivers.every(t=>t.direction==='sendrecv'));
  assert.equal(f.sent.at(-1).event,'webrtc:answer');
  const audio={kind:'audio'},video={kind:'video'};
  f.state.micOn=true;f.state.cameraOn=true;
  f.state.audioStream={getAudioTracks:()=>[audio]};
  f.state.videoStream={getVideoTracks:()=>[video]};
  await f.syncLocalMediaToPeer(f.pc);
  assert.equal(f.transceivers[0].sender.track,audio);assert.equal(f.transceivers[1].sender.track,video);
});
test('early ICE is retained until remote SDP is installed; async offer processing is serialized',async()=>{
  const f=fixture();
  await f.handleSignal('webrtc:ice-candidate',{from:'B',payload:{candidate:'first'}});
  assert.equal(f.pc.pendingCandidates.length,1);assert.equal(f.order.length,0);
  let release;const gate=new Promise(resolve=>release=resolve);
  f.pc.setRemoteDescription=async description=>{await gate;f.pc.remoteDescription=description;f.order.push('description');};
  const offer=f.handleSignal('webrtc:offer',{from:'B',payload:{type:'offer'}});
  const ice=f.handleSignal('webrtc:ice-candidate',{from:'B',payload:{candidate:'second'}});
  await Promise.resolve();assert.equal(f.order.length,0);
  release();await Promise.all([offer,ice]);
  assert.deepEqual(f.order,['description','ice','ice']);assert.equal(f.notices.length,0);
});
test('signals from a departed player do not recreate a peer',async()=>{
  const f=fixture();f.state.room.players=[{id:'A'}];
  await f.handleSignal('webrtc:offer',{from:'B',payload:{type:'offer'}});
  assert.equal(f.sent.length,0);assert.equal(f.order.length,0);
});
test('microphone permission denial is reported distinctly without enabling the mic',async()=>{
  const f=fixture();await f.toggleMic();
  assert.equal(f.state.micOn,false);assert.match(f.notices[0],/접근이 차단/);
});
test('late microphone permission response after discussion ends releases the acquired stream',async()=>{
  let release,stopped=false;
  const f=fixture(()=>new Promise(resolve=>release=resolve));
  const pending=f.toggleMic();f.state.room.phase='voting';
  release({getTracks:()=>[{stop(){stopped=true;}}]});await pending;
  assert.equal(stopped,true);assert.equal(f.state.micOn,false);assert.equal(f.state.audioStream,null);
});
test('successful device capture with a failed sender is not misreported as permission denial',async()=>{
  const track={kind:'audio',readyState:'live',enabled:false};
  const f=fixture(async()=>({getAudioTracks:()=>[track],getTracks:()=>[track]}));
  vm.runInContext('syncPeers=()=>{};',f.context);
  f.transceivers[0].sender.replaceTrack=async()=>{throw new Error('sender closed');};
  await f.toggleMic();
  assert.equal(f.state.micOn,true);assert.equal(track.enabled,true);
  assert.ok(f.notices.some(message=>message.includes('일부 참가자')));
  assert.ok(f.notices.every(message=>!message.includes('권한')));
});
test('blocked remote autoplay exposes an explicit replay action and hides it after success',async()=>{
  let hidden=true,replay;
  const button={classList:{remove(){hidden=false;},toggle(name,value){hidden=value;}},addEventListener(event,fn){replay=fn;}};
  const video={classList:{add(){}},async play(){throw Object.assign(new Error(),{name:'NotAllowedError'});}};
  const f=fixture(undefined,{
    querySelector:selector=>selector==='#video-B'?video:selector==='#play-remote-audio'?button:null,
    querySelectorAll:selector=>selector==='.remote-video'?[video]:[]
  });
  f.state.remoteStreams.set('B',{});
  f.bindMediaElements();await Promise.resolve();
  assert.equal(video.muted,false);assert.equal(hidden,false);
  f.bindAudio();video.play=async()=>{};await replay();
  assert.equal(hidden,true);
});
