import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('setInterval(()=>')[0];
function stream(kind) {
  const listeners={};
  const track={kind,readyState:'live',enabled:true,muted:false,stop(){this.readyState='ended';},addEventListener(event,fn){listeners[event]=fn;}};
  return {track,listeners,getTracks:()=>[track]};
}
function fixture(capture=async({audio})=>stream(audio?'audio':'video')) {
  const timers=[],events={},elements=new Map();
  const panel={innerHTML:''};elements.set('#device-checks',panel);
  const context=vm.createContext({
    navigator:{userAgent:'KAKAOTALK',mediaDevices:{getUserMedia:capture}},
    document:{querySelector:id=>elements.get(id)||null,querySelectorAll:()=>[],addEventListener:(event,fn)=>events[event]=fn},
    setTimeout(fn,ms){const timer={fn,ms};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cancelled=true;},
    addEventListener:(event,fn)=>events[event]=fn,
  });
  vm.runInContext(`${source}\n globalThis.api={state,deviceChecks,toggleDeviceCheck,stopDeviceChecks,deviceCheckConnected,deviceCheckMarkup,render,browserNotice,connectionNotice};gameView=()=>{};`,context);
  return {...context.api,context,timers,events,elements,panel};
}
test('independent captures update check marks without enabling gameplay media',async()=>{
  const requests=[];const f=fixture(async options=>{requests.push(options);return stream(options.audio?'audio':'video');});
  await f.toggleDeviceCheck('video');await f.toggleDeviceCheck('audio');
  assert.equal(requests[0].audio,false);assert.equal(requests[1].video,false);
  for(const kind of ['audio','video']){assert.equal(f.deviceCheckConnected(kind),true);assert.match(f.deviceCheckMarkup(kind),/✓/);}
  assert.equal(f.state.localStream,null);assert.equal(f.state.micOn,false);assert.equal(f.state.cameraOn,false);assert.equal(f.state.peers.size,0);
  const video=f.deviceChecks.video.stream;await f.toggleDeviceCheck('video');
  assert.equal(video.track.readyState,'ended');assert.equal(f.deviceCheckConnected('audio'),true);assert.match(f.deviceCheckMarkup('video'),/✕/);
});
for(const [name,message] of [['NotAllowedError','접근이 차단'],['NotFoundError','찾지 못했습니다'],['NotReadableError','다른 앱']]){
  test(`${name} leaves a red status and permits a successful retry`,async()=>{
    let rejected=true;const f=fixture(async()=>{if(rejected)throw {name};return stream('audio');});
    await f.toggleDeviceCheck('audio');assert.equal(f.deviceCheckConnected('audio'),false);assert.match(f.deviceChecks.audio.error,new RegExp(message));
    rejected=false;await f.toggleDeviceCheck('audio');assert.equal(f.deviceCheckConnected('audio'),true);assert.equal(f.deviceChecks.audio.error,'');
  });
}
test('cancel and retry discard the old permission response without stopping the new stream',async()=>{
  const responses=[];const f=fixture(()=>new Promise(resolve=>responses.push(resolve)));
  const old=f.toggleDeviceCheck('video');await f.toggleDeviceCheck('video');const current=f.toggleDeviceCheck('video');
  const newStream=stream('video');responses[1](newStream);await current;
  const oldStream=stream('video');responses[0](oldStream);await old;
  assert.equal(oldStream.track.readyState,'ended');assert.equal(newStream.track.readyState,'live');assert.equal(f.deviceChecks.video.stream,newStream);
});
test('unanswered capture times out and a late granted stream is released',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>resolve=done));const pending=f.toggleDeviceCheck('audio');
  f.timers.find(timer=>timer.ms===20000).fn();assert.equal(f.deviceChecks.audio.pending,false);assert.match(f.deviceChecks.audio.error,/응답이 없습니다/);
  const late=stream('audio');resolve(late);await pending;assert.equal(late.track.readyState,'ended');assert.equal(f.deviceChecks.audio.stream,null);
});
test('entering a room closes both previews and rejects a pending capture',async()=>{
  let resolve;const f=fixture(async options=>options.audio?new Promise(done=>resolve=done):stream('video'));
  await f.toggleDeviceCheck('video');const video=f.deviceChecks.video.stream;
  const pending=f.toggleDeviceCheck('audio');f.state.room={phase:'lobby'};f.render();
  assert.equal(video.track.readyState,'ended');const late=stream('audio');resolve(late);await pending;assert.equal(late.track.readyState,'ended');
  assert.equal(f.deviceChecks.audio.pending,false);
});
test('track mute, disconnect, page hide, and tab background update actual connection state',async()=>{
  const f=fixture();await f.toggleDeviceCheck('audio');let audio=f.deviceChecks.audio.stream;
  audio.track.muted=true;audio.listeners.mute();assert.equal(f.deviceCheckConnected('audio'),false);
  audio.track.muted=false;audio.listeners.unmute();assert.equal(f.deviceCheckConnected('audio'),true);
  audio.track.readyState='ended';audio.listeners.ended();assert.match(f.deviceChecks.audio.error,/끊겼습니다/);
  await f.toggleDeviceCheck('audio');audio=f.deviceChecks.audio.stream;f.events.pagehide();assert.equal(audio.track.readyState,'ended');
  await f.toggleDeviceCheck('video');const video=f.deviceChecks.video.stream;f.context.document.visibilityState='hidden';f.events.visibilitychange();assert.equal(video.track.readyState,'ended');
});
test('microphone meter measures input without connecting it to speakers and closes on exit',async()=>{
  const f=fixture();let closed=false,connections=0;
  f.context.AudioContext=class {
    resume(){return Promise.resolve();}close(){closed=true;return Promise.resolve();}
    createAnalyser(){return {fftSize:256,getByteTimeDomainData(data){data.fill(160);}};}
    createMediaStreamSource(){return {connect(){connections++;}};}
  };
  const meter={value:0};f.elements.set('#device-mic-level',meter);await f.toggleDeviceCheck('audio');
  assert.ok(meter.value>0);assert.equal(connections,1);f.stopDeviceChecks();assert.equal(closed,true);
});
test('guidance is limited to home/lobby, including paused and result screens',()=>{
  const f=fixture();assert.match(f.browserNotice(),/Safari/);assert.equal(f.connectionNotice(),'');
  f.state.room={phase:'lobby'};assert.match(f.connectionNotice(),/화면을 켜/);
  for(const phase of ['role_reveal','night','discussion','voting','paused','result']){
    f.state.room.phase=phase;assert.equal(f.browserNotice(),'');assert.equal(f.connectionNotice(),'');
  }
});
