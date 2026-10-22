import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split('setInterval(()=>')[0];
function fixture() {
  const sent = [], sockets = [], peers = [], timers = [];
  class Socket {
    static OPEN=1; static CONNECTING=0; static CLOSED=3;
    constructor(url) { this.url=url; this.readyState=0; this.listeners={}; sockets.push(this); }
    addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
    fire(event, data) { for (const fn of this.listeners[event] || []) fn(data); }
    close() { this.readyState=3; this.fire('close'); }
    send(data) { sent.push(JSON.parse(data)); }
  }
  class Peer {
    constructor(config) { this.config=config; this.connectionState='new'; this.transceivers=[]; peers.push(this); }
    addTransceiver(kind) { this.transceivers.push({ receiver:{track:{kind}}, sender:{track:null,replaceTrack:async()=>{}}, direction:'sendrecv' }); }
    getTransceivers() { return this.transceivers; }
    setConfiguration(config) { this.config=config; }
    restartIce() { this.restarts=(this.restarts||0)+1; }
    close() { this.connectionState='closed'; }
  }
  const context=vm.createContext({
    navigator:{userAgent:'Mozilla KAKAOTALK'},document:{visibilityState:'visible',querySelector:()=>null,querySelectorAll:()=>[]},
    location:{protocol:'https:',host:'example.test',pathname:'/games/wolf/'},WebSocket:Socket,RTCPeerConnection:Peer,
    setTimeout(fn,ms){const timer={fn,ms};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cancelled=true;},
    localStorage:{getItem:()=>'{"code":"ROOM","token":"secret"}',removeItem(){}},
    MediaStream:class{},
  });
  vm.runInContext(`${source}
    render=()=>{};notify=()=>{};
    globalThis.api={state,connect,checkConnection,syncPeers,loadIceConfig,handleMessage,browserNotice,retryMedia,rejoin};
  `,context);
  const api=context.api;
  api.state.room={code:'ROOM',phase:'discussion',players:[{id:'A',connected:true},{id:'B',connected:true}]};api.state.playerId='A';
  api.connect();sockets[0].readyState=1;sockets[0].fire('open');
  return {...api,context,sockets,peers,sent,timers};
}

test('peer creation waits for server credentials and shares a pending request', async () => {
  const f=fixture();
  assert.equal(f.sockets[0].url,'wss://example.test/games/wolf/signal');
  const a=f.syncPeers(), b=f.syncPeers();
  assert.equal(f.peers.length,0);
  assert.equal(f.sent.filter(m=>m.event==='rtc:config').length,1);
  f.handleMessage('rtc:config',{iceServers:[{urls:'turn:test:3478',username:'u',credential:'p'}],iceTransportPolicy:'relay',expiresAt:Date.now()+3600000});
  await Promise.all([a,b]);
  assert.equal(f.peers.length,1);
  assert.equal(f.peers[0].config.iceServers[0].credential,'p');
  assert.equal(f.peers[0].config.iceTransportPolicy,'relay');
});

test('TURN failure does not create a STUN-only peer and a later retry can recover', async () => {
  const f=fixture();const first=f.syncPeers();
  f.handleMessage('rtc:config-error',{message:'temporary failure'});await first;
  assert.equal(f.peers.length,0);
  const retry=f.syncPeers();
  f.handleMessage('rtc:config',{iceServers:[],iceTransportPolicy:'all',expiresAt:Date.now()+3600000});await retry;
  assert.equal(f.peers.length,1);
});

test('credential refresh updates an existing peer without duplicating it', async () => {
  const f=fixture();const first=f.syncPeers();
  f.handleMessage('rtc:config',{iceServers:[{urls:'turn:test',credential:'old'}],iceTransportPolicy:'all',expiresAt:Date.now()+3600000});await first;
  const retry=f.retryMedia();
  f.handleMessage('rtc:config',{iceServers:[{urls:'turn:test',credential:'new'}],iceTransportPolicy:'all',expiresAt:Date.now()+3600000});await retry;
  assert.equal(f.peers.length,1);assert.equal(f.peers[0].config.iceServers[0].credential,'new');assert.equal(f.peers[0].restarts,1);
});

test('page recovery detects a stale socket and avoids duplicate connecting sockets', () => {
  const f=fixture();vm.runInContext('lastServerMessage=Date.now()-60000;',f.context);
  f.checkConnection();assert.equal(f.sockets[0].readyState,3);
  f.timers.at(-1).fn();assert.equal(f.sockets.length,2);
  f.connect();assert.equal(f.sockets.length,2);
  assert.equal(f.browserNotice(),'');
  f.state.room.phase='lobby';assert.match(f.browserNotice(),/Safari/);
});

test('server restart clears an expired room session instead of rejoining forever', () => {
  const f=fixture();f.rejoin();
  f.handleMessage('error',{message:'재접속 정보를 찾을 수 없습니다.'});
  assert.equal(f.state.room,null);assert.equal(f.state.ws,null);
});
